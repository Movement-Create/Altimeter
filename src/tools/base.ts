/**
 * Base tool interface.
 *
 * Design principles:
 * - Each tool is a self-contained module: schema + permission level + execute
 * - Zod schema is the source of truth for input validation
 * - Tools self-register by importing the registry
 * - Tool execute() receives ToolExecutionContext, not raw process env
 *
 * Adding a new tool:
 * 1. Create a file in src/tools/
 * 2. Implement the Tool interface
 * 3. Call registry.register(myTool) at the bottom
 * 4. Import the file in tools/registry.ts
 */

import { z } from "zod";
import type { PermissionLevel, SessionConfig } from "../core/types.js";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export interface Tool<TInput = unknown> {
  /** Unique name, e.g. "bash", "file_read" */
  name: string;
  /** One-line description for the LLM */
  description: string;
  /** Zod schema for input validation (use z.ZodTypeAny for flexibility with defaults) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodType<TInput, any, any>;
  /** Permission level required to run this tool */
  permission_level: PermissionLevel;
  /** Execute the tool. Returns a string result (success or error). */
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolExecuteResult>;
}

// ---------------------------------------------------------------------------
// Execution context — everything a tool needs to run
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
  session: SessionConfig;
  /** Current working directory */
  cwd: string;
  /** Environment variables (not the full process.env — only allowlisted ones) */
  env: Record<string, string>;
  /** Whether we're in plan (dry-run) mode */
  plan_mode: boolean;
  /**
   * FIX(iteration-1): Sub-agent recursion depth. 0 = top-level agent.
   * Incremented by the `agent` tool when spawning a child. The agent tool
   * refuses to spawn beyond MAX_SUBAGENT_DEPTH to prevent unbounded recursion.
   */
  subagent_depth?: number;
}

// ---------------------------------------------------------------------------
// Tool result
// ---------------------------------------------------------------------------

export interface ToolExecuteResult {
  /** String output passed back to the LLM */
  output: string;
  /** True if this was an error (LLM sees it as error context) */
  is_error: boolean;
  /** Optional metadata (not sent to LLM) */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helper: create a successful result
// ---------------------------------------------------------------------------

export function ok(output: string, meta?: Record<string, unknown>): ToolExecuteResult {
  return { output, is_error: false, meta };
}

// ---------------------------------------------------------------------------
// Helper: create an error result
// ---------------------------------------------------------------------------

export function err(message: string, meta?: Record<string, unknown>): ToolExecuteResult {
  return { output: message, is_error: true, meta };
}

// ---------------------------------------------------------------------------
// Type helper for extracting Zod inferred type
// ---------------------------------------------------------------------------

export type ToolInput<T extends Tool<unknown>> = T extends Tool<infer I> ? I : never;
