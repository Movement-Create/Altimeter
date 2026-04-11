/**
 * Hook type definitions.
 *
 * Hooks run in the app process (not a subprocess) and can:
 * - Observe events (for logging/audit)
 * - Block tool execution (security/policy)
 * - Modify tool inputs (preprocessing)
 * - Modify tool outputs (postprocessing)
 *
 * Hook events:
 * - PreToolUse:  Before each tool execution. Can block or modify input.
 * - PostToolUse: After each tool execution. Can modify output.
 * - Stop:        When agent finishes. Can block or modify final response.
 *
 * Hook handlers are async functions registered programmatically,
 * or shell commands configured in ALTIMETER.md / altimeter.json5.
 */

import type { HookContext, HookResult } from "../core/types.js";

// A hook handler function
export type HookHandler = (
  context: HookContext
) => HookResult | Promise<HookResult>;

// Hook registration entry
export interface HookRegistration {
  event: "PreToolUse" | "PostToolUse" | "Stop";
  /** Optional: only fire for specific tool names */
  tool_filter?: string[];
  handler: HookHandler;
  /** Hook identifier for audit trail */
  id: string;
}
