/**
 * LivePrinter — consumes tracer span events and renders to stderr.
 *
 * Replaces the ad-hoc onToolCall / onToolResult chalk sprinkles in index.ts.
 * One source of truth (tracer.events) feeds both the JSONL and this live
 * view, so what you see live matches what lands in the trace file.
 *
 * Verbosity tiers:
 *   - "off"     — silent
 *   - "summary" — only errors + end-of-session stats
 *   - "full"    — every tool call, tool result, subagent, reflection
 */

import chalk from "chalk";
import type { Span } from "../core/types.js";
import { tracer } from "./tracer.js";

export type PrinterLevel = "off" | "summary" | "full";

export class LivePrinter {
  private level: PrinterLevel;
  private onStart: (span: Span) => void;
  private onEnd: (span: Span) => void;
  private attached = false;

  constructor(level: PrinterLevel = "full") {
    this.level = level;
    this.onStart = (span) => this.handleStart(span);
    this.onEnd = (span) => this.handleEnd(span);
  }

  attach(): void {
    if (this.attached) return;
    tracer.events.on("span_start", this.onStart);
    tracer.events.on("span_end", this.onEnd);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    tracer.events.off("span_start", this.onStart);
    tracer.events.off("span_end", this.onEnd);
    this.attached = false;
  }

  setLevel(level: PrinterLevel): void {
    this.level = level;
  }

  // ---------------------------------------------------------------------

  private handleStart(span: Span): void {
    if (this.level === "off") return;

    if (this.level === "full") {
      switch (span.name) {
        case "tool.execute": {
          const tool = (span.attributes?.tool_name as string) ?? "?";
          process.stderr.write(chalk.cyan(`\n[tool] ${tool}\n`));
          const input = span.attributes?.tool_input;
          if (input !== undefined) {
            const s = JSON.stringify(input, null, 2);
            if (s.length < 240) process.stderr.write(chalk.dim(s) + "\n");
          }
          return;
        }
        case "subagent.run":
          process.stderr.write(chalk.magenta(`\n[subagent] spawning…\n`));
          return;
        case "agent.reflection":
          process.stderr.write(
            chalk.yellow(
              `\n[reflection] trigger=${span.attributes?.trigger_reason ?? "?"}\n`
            )
          );
          return;
      }
    }
  }

  private handleEnd(span: Span): void {
    if (this.level === "off") return;

    // Errors always print — even in summary mode.
    if (span.status === "error") {
      const msg =
        span.error?.message ??
        (span.attributes?.error_message as string | undefined) ??
        "(no message)";
      const label = errorLabel(span);
      process.stderr.write(chalk.red(`[error:${label}] ${truncate(msg, 200)}\n`));
      return;
    }

    if (this.level !== "full") return;

    switch (span.name) {
      case "tool.execute": {
        const tool = (span.attributes?.tool_name as string) ?? "?";
        const d = span.duration_ms ?? 0;
        process.stderr.write(
          chalk.dim(`[tool done] ${tool} · ${formatDuration(d)}\n`)
        );
        return;
      }
      case "llm.call": {
        const inT = (span.attributes?.input_tokens as number) ?? 0;
        const outT = (span.attributes?.output_tokens as number) ?? 0;
        const cost = (span.attributes?.cost_usd as number) ?? 0;
        process.stderr.write(
          chalk.dim(
            `[llm] ${inT}→${outT} toks · $${cost.toFixed(4)} · ${formatDuration(
              span.duration_ms ?? 0
            )}\n`
          )
        );
        return;
      }
      case "subagent.run": {
        const turns = span.attributes?.child_turns ?? "?";
        const cost = span.attributes?.child_cost_usd;
        const costStr = typeof cost === "number" ? ` · $${cost.toFixed(4)}` : "";
        process.stderr.write(
          chalk.magenta(`[subagent done] ${turns} turns${costStr}\n`)
        );
        return;
      }
    }
  }
}

function errorLabel(span: Span): string {
  if (span.name === "tool.execute") {
    return `tool:${span.attributes?.tool_name ?? "?"}`;
  }
  return span.name;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m${r}s`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
