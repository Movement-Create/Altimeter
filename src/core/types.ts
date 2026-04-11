/**
 * Core type definitions for Altimeter.
 *
 * Design principles:
 * - All messages follow the Anthropic/OpenAI message format (role + content)
 * - Tool calls are provider-agnostic: normalized to ToolCall/ToolResult
 * - Session state is append-only (JSONL-friendly)
 * - Effort levels map to model selection and token budgets
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Effort / Quality levels (maps to model routing + max_tokens budget)
// ---------------------------------------------------------------------------

export type EffortLevel = "low" | "medium" | "high" | "max";

export const EFFORT_TOKEN_BUDGET: Record<EffortLevel, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  max: 65536,
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ImageContent {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export type MessageContent =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | ImageContent
  | string; // convenience alias for { type: "text", text: string }

export interface Message {
  role: MessageRole;
  content: MessageContent | MessageContent[];
  /** ISO timestamp, auto-set during session logging */
  timestamp?: string;
}

// Normalized tool call (provider-agnostic)
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Normalized tool result
export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

// ---------------------------------------------------------------------------
// LLM Response
// ---------------------------------------------------------------------------

export interface LLMResponse {
  /** The raw text response (if no tool calls) */
  text: string | null;
  /** Tool calls requested by the model */
  tool_calls: ToolCall[];
  /** Stop reason: "end_turn", "tool_use", "max_tokens", "stop_sequence" */
  stop_reason: string;
  /** Token usage */
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  /** Raw provider response for debugging */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Tool Permission System
// ---------------------------------------------------------------------------

/**
 * Permission levels for tools, in ascending order of risk.
 * - "read"    : Safe. Reads data without side effects.
 * - "write"   : Moderate. Writes files or state on the local machine.
 * - "execute" : High. Runs arbitrary commands or code.
 * - "network" : High. Makes outbound HTTP requests.
 * - "agent"   : Highest. Spawns sub-agents with their own tool access.
 */
export type PermissionLevel = "read" | "write" | "execute" | "network" | "agent";

/**
 * Permission mode for the session.
 * - "default"           : Ask before high-risk tools; allow read/network freely.
 * - "auto"              : Never ask. Allow everything in allowed_tools.
 * - "plan"              : Dry-run: log tools, never execute.
 * - "bypassPermissions" : Dangerous. Ignore all permission gates.
 */
export type PermissionMode = "default" | "auto" | "plan" | "bypassPermissions";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionConfig {
  id: string;
  /** Human-readable title */
  title?: string;
  /** ISO 8601 creation time */
  created_at: string;
  /** Model identifier, e.g. "claude-3-5-sonnet-20241022" */
  model: string;
  /** Provider id, e.g. "anthropic" */
  provider: string;
  /** System prompt override */
  system_prompt?: string;
  /** Allowed tool names (empty = all allowed) */
  allowed_tools: string[];
  /** Disallowed tool names (override allowed_tools) */
  disallowed_tools: string[];
  /** Permission mode */
  permission_mode: PermissionMode;
  /** Effort level */
  effort: EffortLevel;
  /** Max agent loop turns before stopping */
  max_turns: number;
  /** Max cumulative USD spend */
  max_budget_usd: number;
  /** Path to JSONL session file */
  file_path: string;
}

export interface SessionEvent {
  type:
    | "session_start"
    | "user_message"
    | "assistant_message"
    | "tool_call"
    | "tool_result"
    | "session_end"
    | "error"
    | "compaction";
  timestamp: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Agent Run Options
// ---------------------------------------------------------------------------

export interface AgentRunOptions {
  /** The user prompt to start with */
  prompt: string;
  /** Session configuration */
  session: SessionConfig;
  /** Override system prompt */
  system_prompt?: string;
  /** Initial message history (for resume) */
  history?: Message[];
  /** Called on each assistant text chunk (streaming) */
  onText?: (chunk: string) => void;
  /** Called before each tool execution */
  onToolCall?: (call: ToolCall) => void | Promise<void>;
  /** Called after each tool result */
  onToolResult?: (result: ToolResult) => void | Promise<void>;
}

export interface AgentRunResult {
  /** Final text response */
  text: string;
  /** Total turns taken */
  turns: number;
  /** Total tokens used */
  usage: { input: number; output: number };
  /** Total estimated USD cost */
  cost_usd: number;
  /** Stop reason */
  stop_reason: "text" | "max_turns" | "max_budget" | "error";
  /** Full message history */
  messages: Message[];
}

// ---------------------------------------------------------------------------
// Config Schema (ALTIMETER.md + altimeter.json5)
// ---------------------------------------------------------------------------

export const AltimeterConfigSchema = z.object({
  /** Default model to use */
  model: z.string().default("claude-3-5-sonnet-20241022"),
  /** Default provider */
  provider: z.string().default("anthropic"),
  /** Default effort level */
  effort: z.enum(["low", "medium", "high", "max"]).default("medium"),
  /** Default max turns */
  max_turns: z.number().default(50),
  /** Default max budget USD */
  max_budget_usd: z.number().default(1.0),
  /** Default permission mode */
  permission_mode: z
    .enum(["default", "auto", "plan", "bypassPermissions"])
    .default("default"),
  /** Allowed tool names (empty = all) */
  allowed_tools: z.array(z.string()).default([]),
  /** Disallowed tool names */
  disallowed_tools: z.array(z.string()).default([]),
  /** System prompt */
  system_prompt: z.string().optional(),
  /** Skills directory */
  skills_dir: z.string().default("./skills"),
  /** Memory directory */
  memory_dir: z.string().default("./memory"),
  /** Sessions directory */
  sessions_dir: z.string().default("./sessions"),
  /** Hook definitions */
  hooks: z
    .object({
      PreToolUse: z.array(z.string()).default([]),
      PostToolUse: z.array(z.string()).default([]),
      Stop: z.array(z.string()).default([]),
    })
    .default({}),
  /** Heartbeat / cron jobs */
  cron: z
    .array(
      z.object({
        name: z.string(),
        schedule: z.string(),
        prompt: z.string(),
        enabled: z.boolean().default(true),
      })
    )
    .default([]),
});

export type AltimeterConfig = z.infer<typeof AltimeterConfigSchema>;

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export interface SkillDefinition {
  name: string;
  description: string;
  tools_required: string[];
  trigger_patterns: string[];
  content: string; // raw SKILL.md content
  file_path: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";

export interface HookContext {
  event: HookEvent;
  session_id: string;
  turn: number;
  /** Present for PreToolUse/PostToolUse */
  tool_call?: ToolCall;
  /** Present for PostToolUse */
  tool_result?: ToolResult;
  /** Present for Stop */
  final_text?: string;
}

export interface HookResult {
  /** "allow" = proceed normally */
  action: "allow" | "block" | "modify";
  /** Modified input (PreToolUse only, action="modify") */
  modified_input?: Record<string, unknown>;
  /** Modified output (PostToolUse only, action="modify") */
  modified_output?: string;
  /** Block reason (action="block") */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ProviderOptions {
  api_key?: string;
  base_url?: string;
  /** Additional provider-specific options */
  [key: string]: unknown;
}
