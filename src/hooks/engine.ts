/**
 * Hook execution engine.
 *
 * Design:
 * - Hooks run sequentially (first hook that blocks stops the chain)
 * - Hook failures don't crash the agent (logged + allow)
 * - Audit trail: every hook invocation is logged
 *
 * Built-in hooks added by default:
 * - None (hooks are opt-in)
 *
 * Useful hooks to add:
 * - Audit: log all tool calls to a file
 * - Budget guard: block bash if cost > $X
 * - Sensitive data: block if tool input contains secrets
 */

import type { HookContext, HookResult, ToolCall, ToolResult } from "../core/types.js";
import type { HookRegistration } from "./types.js";
import { auditLogger } from "../security/audit.js";

export class HookEngine {
  private hooks: HookRegistration[] = [];

  /**
   * Register a hook handler.
   */
  register(hook: HookRegistration): void {
    this.hooks.push(hook);
  }

  /**
   * Unregister a hook by id.
   */
  unregister(id: string): void {
    this.hooks = this.hooks.filter((h) => h.id !== id);
  }

  /**
   * Fire PreToolUse hooks.
   * Returns the result from the first blocking/modifying hook,
   * or { action: "allow" } if all hooks pass.
   */
  async firePreToolUse(context: {
    session_id: string;
    turn: number;
    tool_call: ToolCall;
  }): Promise<HookResult> {
    const hookContext: HookContext = {
      event: "PreToolUse",
      session_id: context.session_id,
      turn: context.turn,
      tool_call: context.tool_call,
    };

    await auditLogger.log("PreToolUse", hookContext);

    return this.runHooks(hookContext, "PreToolUse", context.tool_call.name);
  }

  /**
   * Fire PostToolUse hooks.
   */
  async firePostToolUse(context: {
    session_id: string;
    turn: number;
    tool_call: ToolCall;
    tool_result: ToolResult;
  }): Promise<HookResult> {
    const hookContext: HookContext = {
      event: "PostToolUse",
      session_id: context.session_id,
      turn: context.turn,
      tool_call: context.tool_call,
      tool_result: context.tool_result,
    };

    await auditLogger.log("PostToolUse", hookContext);

    return this.runHooks(hookContext, "PostToolUse", context.tool_call.name);
  }

  /**
   * Fire Stop hooks.
   */
  async fireStop(context: {
    session_id: string;
    turn: number;
    final_text: string;
  }): Promise<HookResult> {
    const hookContext: HookContext = {
      event: "Stop",
      session_id: context.session_id,
      turn: context.turn,
      final_text: context.final_text,
    };

    await auditLogger.log("Stop", hookContext);

    return this.runHooks(hookContext, "Stop");
  }

  /**
   * List all registered hooks.
   */
  listHooks(): Array<{ id: string; event: string; tool_filter?: string[] }> {
    return this.hooks.map((h) => ({
      id: h.id,
      event: h.event,
      tool_filter: h.tool_filter,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async runHooks(
    context: HookContext,
    event: "PreToolUse" | "PostToolUse" | "Stop",
    toolName?: string
  ): Promise<HookResult> {
    const relevant = this.hooks.filter((h) => {
      if (h.event !== event) return false;
      if (h.tool_filter && toolName) {
        return h.tool_filter.includes(toolName);
      }
      return true;
    });

    for (const hook of relevant) {
      try {
        const result = await hook.handler(context);

        if (result.action === "block") {
          return result;
        }

        if (result.action === "modify") {
          return result;
        }

        // action === "allow": continue to next hook
      } catch (e) {
        // Hook error: log and continue (don't crash agent)
        console.error(`[Hook ${hook.id}] Error:`, e);
      }
    }

    return { action: "allow" };
  }
}

// Singleton
export const hookEngine = new HookEngine();

// ---------------------------------------------------------------------------
// Built-in hook factories (commonly useful)
// ---------------------------------------------------------------------------

/**
 * Create an audit-only hook (logs all tool calls, never blocks).
 */
export function createAuditHook(logPath: string): HookRegistration {
  return {
    id: `audit_${Date.now()}`,
    event: "PreToolUse",
    handler: async (ctx) => {
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        session: ctx.session_id,
        tool: ctx.tool_call?.name,
        input: ctx.tool_call?.input,
      });

      try {
        const { appendFile } = await import("fs/promises");
        await appendFile(logPath, line + "\n");
      } catch {
        // Ignore audit failures
      }

      return { action: "allow" };
    },
  };
}

/**
 * Create a blocklist hook that blocks specific tool+pattern combinations.
 */
export function createBlocklistHook(rules: Array<{
  tool: string;
  pattern: RegExp;
  reason: string;
}>): HookRegistration {
  return {
    id: `blocklist_${Date.now()}`,
    event: "PreToolUse",
    handler: async (ctx) => {
      const call = ctx.tool_call;
      if (!call) return { action: "allow" };

      for (const rule of rules) {
        if (call.name !== rule.tool) continue;

        const inputStr = JSON.stringify(call.input);
        if (rule.pattern.test(inputStr)) {
          return { action: "block", reason: rule.reason };
        }
      }

      return { action: "allow" };
    },
  };
}
