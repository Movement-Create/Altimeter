/**
 * Story-tier summary — deterministic reducer over a session JSONL.
 *
 * Reads `sessions/<id>.jsonl`, groups spans by name, computes counts,
 * durations, errors, token/cost totals, and renders a short Markdown story
 * to `sessions/<id>.summary.md`.
 *
 * No LLM call. No flakiness. Runs in milliseconds. LLM narration (if
 * `narrate: true` in config) is a separate opt-in step handled elsewhere.
 */

import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import type { Span, SessionEvent } from "../core/types.js";

interface ToolStat {
  name: string;
  count: number;
  errors: number;
  total_ms: number;
}

interface ErrorRow {
  span_name: string;
  tool_name?: string;
  message: string;
}

export interface SessionSummary {
  session_id: string;
  outcome: "ok" | "error" | "unknown";
  turns: number;
  llm_calls: number;
  tool_stats: Record<string, ToolStat>;
  subagents: number;
  reflection_fired: boolean;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  wall_clock_ms: number;
  errors: ErrorRow[];
  models: string[];
  stop_reason?: string;
}

const SESSIONS_DIR_DEFAULT = "./sessions";

/**
 * Read a session JSONL and reduce it into a structured summary + markdown.
 * Writes `sessions/<id>.summary.md` as a side effect.
 */
export async function summarize(
  sessionId: string,
  sessionsDir: string = SESSIONS_DIR_DEFAULT
): Promise<{ summary: SessionSummary; markdown: string; path: string }> {
  const filePath = join(sessionsDir, `${sessionId}.jsonl`);
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);

  const spans: Span[] = [];
  let stopReason: string | undefined;

  for (const line of lines) {
    let event: SessionEvent;
    try {
      event = JSON.parse(line) as SessionEvent;
    } catch {
      continue;
    }
    if (event.type === "span_start" || event.type === "span_end") {
      const span = (event.data as { span: Span } | undefined)?.span;
      if (!span) continue;
      // Keep only ended spans to avoid double-counting (end carries the
      // full picture including duration + final status).
      if (event.type === "span_end") spans.push(span);
    }
    if (event.type === "session_end") {
      const d = event.data as { stop_reason?: string };
      stopReason = d?.stop_reason;
    }
  }

  const summary = reduceSpans(sessionId, spans, stopReason);
  const markdown = renderMarkdown(summary);

  const outPath = join(sessionsDir, `${sessionId}.summary.md`);
  await writeFile(outPath, markdown, "utf-8");
  return { summary, markdown, path: outPath };
}

function reduceSpans(
  sessionId: string,
  spans: Span[],
  stopReason?: string
): SessionSummary {
  const toolStats: Record<string, ToolStat> = {};
  const errors: ErrorRow[] = [];
  const modelSet = new Set<string>();

  let turns = 0;
  let llm_calls = 0;
  let subagents = 0;
  let reflection_fired = false;
  let input_tokens = 0;
  let output_tokens = 0;
  let cost_usd = 0;
  let wall_clock_ms = 0;
  let rootErrorSeen = false;
  let rootSeen = false;

  for (const span of spans) {
    switch (span.name) {
      case "agent.session": {
        // Only count the top-level (not subagents — they're separate roots).
        if (!span.parent_span_id) {
          rootSeen = true;
          wall_clock_ms = span.duration_ms ?? 0;
          if (span.status === "error") rootErrorSeen = true;
        }
        break;
      }
      case "agent.turn":
        turns++;
        break;
      case "llm.call": {
        llm_calls++;
        const attrs = span.attributes ?? {};
        if (typeof attrs.input_tokens === "number") input_tokens += attrs.input_tokens;
        if (typeof attrs.output_tokens === "number")
          output_tokens += attrs.output_tokens;
        if (typeof attrs.cost_usd === "number") cost_usd += attrs.cost_usd;
        if (typeof attrs.model === "string") modelSet.add(attrs.model);
        if (span.status === "error") {
          errors.push({
            span_name: "llm.call",
            message: span.error?.message ?? "unknown LLM error",
          });
        }
        break;
      }
      case "tool.execute": {
        const toolName =
          (span.attributes?.tool_name as string | undefined) ?? "unknown";
        const stat =
          toolStats[toolName] ??
          (toolStats[toolName] = {
            name: toolName,
            count: 0,
            errors: 0,
            total_ms: 0,
          });
        stat.count++;
        stat.total_ms += span.duration_ms ?? 0;
        if (span.status === "error") {
          stat.errors++;
          errors.push({
            span_name: "tool.execute",
            tool_name: toolName,
            message:
              span.error?.message ??
              (span.attributes?.error_message as string | undefined) ??
              "tool returned is_error",
          });
        }
        break;
      }
      case "subagent.run":
        subagents++;
        break;
      case "agent.reflection":
        reflection_fired = true;
        break;
    }
  }

  let outcome: SessionSummary["outcome"] = "unknown";
  if (rootSeen) outcome = rootErrorSeen || errors.length > 0 ? "error" : "ok";

  return {
    session_id: sessionId,
    outcome,
    turns,
    llm_calls,
    tool_stats: toolStats,
    subagents,
    reflection_fired,
    input_tokens,
    output_tokens,
    cost_usd,
    wall_clock_ms,
    errors,
    models: [...modelSet],
    stop_reason: stopReason,
  };
}

function renderMarkdown(s: SessionSummary): string {
  const icon = s.outcome === "ok" ? "✅" : s.outcome === "error" ? "❌" : "❔";
  const wall = formatDuration(s.wall_clock_ms);
  const totalTokens = s.input_tokens + s.output_tokens;

  const toolRows = Object.values(s.tool_stats)
    .sort((a, b) => b.count - a.count)
    .map(
      (t) =>
        `| ${t.name} | ${t.count} | ${t.errors} | ${formatDuration(t.total_ms)} |`
    );

  const lines: string[] = [];
  lines.push(`# Session Summary ${icon}`);
  lines.push("");
  lines.push(`- **Session:** \`${s.session_id}\``);
  lines.push(`- **Outcome:** ${outcomeLabel(s.outcome)}`);
  if (s.stop_reason) lines.push(`- **Stop reason:** ${s.stop_reason}`);
  lines.push(`- **Turns:** ${s.turns}`);
  lines.push(`- **LLM calls:** ${s.llm_calls}`);
  if (s.models.length) lines.push(`- **Model(s):** ${s.models.join(", ")}`);
  lines.push(
    `- **Tokens:** ${totalTokens} (in ${s.input_tokens} / out ${s.output_tokens})`
  );
  lines.push(`- **Cost:** $${s.cost_usd.toFixed(4)}`);
  lines.push(`- **Wall clock:** ${wall}`);
  if (s.subagents > 0) lines.push(`- **Subagents spawned:** ${s.subagents}`);
  if (s.reflection_fired) lines.push(`- **Reflection fired:** yes`);
  lines.push("");

  if (toolRows.length > 0) {
    lines.push("## Tools");
    lines.push("");
    lines.push("| Tool | Calls | Errors | Total time |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(...toolRows);
    lines.push("");
  }

  if (s.errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const err of s.errors) {
      const who = err.tool_name ? `${err.span_name} (${err.tool_name})` : err.span_name;
      lines.push(`- **${who}** — ${truncate(err.message, 300)}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `_Generated by Altimeter observability. Full trace: \`${s.session_id}.jsonl\`._`
  );
  lines.push("");
  return lines.join("\n");
}

function outcomeLabel(o: SessionSummary["outcome"]): string {
  if (o === "ok") return "success ✅";
  if (o === "error") return "failure ❌";
  return "unknown ❔";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// Silence lint for currently-unused helper path
void dirname;
