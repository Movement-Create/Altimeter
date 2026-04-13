/**
 * Context assembly and compression.
 *
 * Three-layer compression strategy (inspired by Claude Code):
 *
 * Layer 1 — MicroCompact: trim old tool result outputs to a summary line.
 *   Applied when context > 70% of model limit.
 *
 * Layer 2 — Summarize: replace old messages with an LLM-generated summary.
 *   Applied when context > 85% of model limit.
 *
 * Layer 3 — Truncate: hard-cut oldest messages.
 *   Applied as last resort when context > 95%.
 *
 * Context assembly:
 * 1. Load ALTIMETER.md (always injected into system prompt)
 * 2. Inject relevant skills (based on prompt keyword matching)
 * 3. Inject memory/facts.md (if exists)
 */

import { readFile, stat } from "fs/promises";
import { resolve, join } from "path";
import type { AgentRunOptions, Message, ToolResultContent } from "./types.js";
import { skillLoader } from "../skills/loader.js";
import { memoryManager, type Lesson } from "../memory/manager.js";

const MAX_LESSONS_INJECTED = 5;

// Approximate token counts (rough: 1 token ≈ 4 chars)
const CHARS_PER_TOKEN = 4;
const MICRO_COMPACT_THRESHOLD = 0.70;
const SUMMARIZE_THRESHOLD = 0.85;
const TRUNCATE_THRESHOLD = 0.95;

// ---------------------------------------------------------------------------
// Dynamic context limits per model
// ---------------------------------------------------------------------------

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-6": 200_000,
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "o1-preview": 128_000,
  "o1": 200_000,
  // Google
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash-lite": 1_000_000,
  // Ollama (conservative defaults)
  "llama3.1": 128_000,
  "llama3.2": 128_000,
  "llama3.1:70b": 128_000,
};

const DEFAULT_CONTEXT_LIMIT = 128_000;

export function getContextLimit(model: string, provider?: string): number {
  // Exact match first
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];

  // Prefix match
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(key.split("-").slice(0, 2).join("-"))) return limit;
  }

  return DEFAULT_CONTEXT_LIMIT;
}

export async function assembleContext(
  options: AgentRunOptions,
  messages: Message[]
): Promise<string> {
  const parts: string[] = [];

  // 1. Base system prompt
  const base = options.system_prompt ?? options.session.system_prompt;
  if (base) {
    parts.push(base);
  }

  // 2. ALTIMETER.md (project-level config, like CLAUDE.md)
  const altimeterMd = await loadAltimeterMd();
  if (altimeterMd) {
    parts.push("---\n# Project Configuration (ALTIMETER.md)\n" + altimeterMd);
  }

  // 3. Relevant skills
  const relevantSkills = await skillLoader.getRelevantSkills(options.prompt);
  if (relevantSkills.length > 0) {
    const skillContent = relevantSkills
      .map((s) => `## Skill: ${s.name}\n${s.content}`)
      .join("\n\n---\n\n");
    parts.push("---\n# Available Skills\n" + skillContent);
  }

  // 4. Relevant lessons (scored against the current user prompt)
  const relevantLessons = await getRelevantLessons(options.prompt);
  if (relevantLessons.length > 0) {
    const rendered = relevantLessons
      .map((l) => {
        const tagStr = l.tags.length > 0 ? ` [${l.tags.join(", ")}]` : "";
        return `- ${l.date}${tagStr}: ${l.content}`;
      })
      .join("\n");
    parts.push(
      "---\n# Lessons (relevant to this turn)\nCheck these before acting — they are notes you wrote after prior mistakes or non-obvious wins.\n" +
        rendered
    );
  }

  // 5. Memory facts
  const facts = await memoryManager.loadFacts();
  if (facts) {
    parts.push("---\n# Memory (Persistent Facts)\n" + facts);
  }

  // 5. Default instructions
  parts.push(DEFAULT_AGENT_INSTRUCTIONS);

  return parts.join("\n\n");
}

const DEFAULT_AGENT_INSTRUCTIONS = `---
# Agent Instructions

You are Altimeter, an AI agent. Use the available tools to complete tasks.

Rules:
- Think step by step before calling tools
- Prefer surgical file edits (file_edit) over full rewrites (file_write) for existing files
- Use todo_write to track multi-step tasks
- When spawning subagents (agent tool), give them complete, self-contained instructions
- If a tool call fails, analyze the error and try a different approach
- When done, provide a clear summary of what was accomplished
`;

// ---------------------------------------------------------------------------
// Lesson relevance scoring
// ---------------------------------------------------------------------------

/**
 * Score each lesson against the current user prompt and return the top matches.
 * Scoring signals:
 *  - tag substring match in the prompt (weight 3)
 *  - lesson content word overlap with the prompt (weight 1)
 * Only lessons with score > 0 are returned. Capped at MAX_LESSONS_INJECTED.
 */
async function getRelevantLessons(prompt: string): Promise<Lesson[]> {
  const all = await memoryManager.loadLessons();
  if (all.length === 0) return [];

  const lowerPrompt = prompt.toLowerCase();
  const promptWords = new Set(
    lowerPrompt
      .split(/[^a-z0-9_./-]+/i)
      .filter((w) => w.length >= 3)
  );

  const scored = all.map((lesson) => {
    let score = 0;

    for (const tag of lesson.tags) {
      if (lowerPrompt.includes(tag.toLowerCase())) score += 3;
    }

    const contentWords = lesson.content
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/i)
      .filter((w) => w.length >= 3);
    for (const w of contentWords) {
      if (promptWords.has(w)) {
        score += 1;
        break; // one hit per lesson is enough signal
      }
    }

    return { lesson, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LESSONS_INJECTED)
    .map((s) => s.lesson);
}

// ---------------------------------------------------------------------------
// Load ALTIMETER.md from cwd (survives context compaction)
// ---------------------------------------------------------------------------

async function loadAltimeterMd(): Promise<string | null> {
  const paths = [
    resolve(process.cwd(), "ALTIMETER.md"),
    resolve(process.cwd(), ".altimeter.md"),
  ];

  for (const p of paths) {
    try {
      await stat(p);
      const content = await readFile(p, "utf-8");
      return content;
    } catch {
      // Not found, try next
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Context compression
// ---------------------------------------------------------------------------

/**
 * Estimate the token count of a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate total context tokens from a message array.
 */
export function estimateContextTokens(messages: Message[]): number {
  return messages.reduce((acc, m) => {
    const content = typeof m.content === "string"
      ? m.content
      : JSON.stringify(m.content);
    return acc + estimateTokens(content);
  }, 0);
}

/**
 * Apply context compression if needed.
 * Returns the (potentially modified) messages array.
 */
export function compressContext(
  messages: Message[],
  model?: string,
  provider?: string
): Message[] {
  const contextLimit = getContextLimit(model ?? "", provider);
  const totalTokens = estimateContextTokens(messages);
  const ratio = totalTokens / contextLimit;

  if (ratio < MICRO_COMPACT_THRESHOLD) {
    return messages; // No compression needed
  }

  if (ratio < SUMMARIZE_THRESHOLD) {
    return microCompact(messages);
  }

  if (ratio < TRUNCATE_THRESHOLD) {
    return truncateOld(messages, 0.5);
  }

  // Hard truncate: keep first 5 + last 20 messages
  return truncateOld(messages, 0.8);
}

/**
 * MicroCompact: Replace long tool results with summaries.
 * Keeps the tool result structure but truncates content.
 */
function microCompact(messages: Message[]): Message[] {
  const MAX_TOOL_RESULT_CHARS = 500;

  return messages.map((msg): Message => {
    if (msg.role !== "tool") return msg;

    const rawContent = msg.content;
    const content = Array.isArray(rawContent) ? rawContent : [rawContent];
    const compacted = content.map((block) => {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "tool_result"
      ) {
        const b = block as ToolResultContent;
        if (b.content && b.content.length > MAX_TOOL_RESULT_CHARS) {
          const result: ToolResultContent = {
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            content:
              b.content.slice(0, MAX_TOOL_RESULT_CHARS) +
              ` ...[compacted: ${b.content.length} chars total]`,
            is_error: b.is_error,
          };
          return result;
        }
      }
      return block;
    });

    return { ...msg, content: compacted };
  });
}

/**
 * Truncate oldest messages (keep system context + recent messages).
 * fraction = what fraction of messages to remove from the middle.
 */
function truncateOld(messages: Message[], fraction: number): Message[] {
  // Keep: first 2 messages (user prompt context) + last 30 messages
  const keepRecent = 30;
  const keepFirst = 2;

  if (messages.length <= keepRecent + keepFirst) {
    return messages;
  }

  const first = messages.slice(0, keepFirst);
  const recent = messages.slice(-keepRecent);

  const notice: Message = {
    role: "user",
    content: `[Context compacted: ${Math.round(fraction * 100)}% of conversation history removed to fit context window]`,
  };

  return [...first, notice, ...recent];
}
