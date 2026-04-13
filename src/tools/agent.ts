/**
 * Agent tool — spawn a subagent with a fresh context.
 *
 * Design (from Claude Code + OpenClaw):
 * - Each subagent gets its own session, its own message history
 * - The PARENT sees only the final text response, not the full subagent transcript
 * - This keeps parent context small while enabling parallel work
 * - Subagents inherit: allowed_tools, system_prompt, model
 * - Subagents do NOT inherit: conversation history, todos
 *
 * This pattern enables:
 * 1. Parallel subtask execution (spawn N agents simultaneously)
 * 2. Context isolation (each agent has a clean slate)
 * 3. Role specialization (researcher, coder, writer, etc.)
 *
 * Permission: "agent" (highest level)
 */

import { z } from "zod";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";
import { tracer } from "../observability/tracer.js";

const AgentInputSchema = z.object({
  prompt: z.string().describe("The task to assign to the subagent"),
  system_prompt: z
    .string()
    .optional()
    .describe(
      "Optional system prompt override for the subagent (role/persona specialization)"
    ),
  model: z
    .string()
    .optional()
    .describe("Model to use for the subagent (inherits parent model if not set)"),
  max_turns: z
    .number()
    .optional()
    .default(20)
    .describe("Maximum turns for the subagent"),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe("Tools the subagent can use (inherits parent if not set)"),
});

type AgentInput = z.infer<typeof AgentInputSchema>;

// FIX(iteration-1): Hard cap on sub-agent recursion depth. Prevents the parent
// from spawning a child that spawns a child that spawns... ad infinitum, which
// the original implementation allowed (sub-agents inherited allowed_tools
// including the `agent` tool itself, with no depth tracking).
const MAX_SUBAGENT_DEPTH = 2;

export const agentTool: Tool<AgentInput> = {
  name: "agent",
  description:
    "Spawn a subagent to complete a subtask. The subagent gets a fresh context and returns only its final answer. Use for parallel work, context isolation, or specialized roles.",
  schema: AgentInputSchema,
  permission_level: "agent",

  async execute(input: AgentInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    if (context.plan_mode) {
      return ok(`[PLAN MODE] Would spawn subagent for: "${input.prompt.slice(0, 100)}..."`);
    }

    // FIX(iteration-1): refuse spawning beyond MAX_SUBAGENT_DEPTH.
    const currentDepth = context.subagent_depth ?? 0;
    if (currentDepth >= MAX_SUBAGENT_DEPTH) {
      return err(
        `Sub-agent depth limit reached (${currentDepth}/${MAX_SUBAGENT_DEPTH}). ` +
          `Cannot spawn another nested sub-agent. Complete this task without further delegation.`
      );
    }

    // Lazy import to break circular dependency
    const { runAgent } = await import("../core/agent-loop.js");

    const subSessionId = `sub_${context.session.id}_${Date.now()}`;

    // FIX(iteration-1): clamp sub-agent's max_turns so it cannot exceed parent's
    // remaining budget by more than 50%. Default of 20 was unconditional.
    const requestedMaxTurns = input.max_turns ?? Math.min(20, context.session.max_turns);

    const subSession = {
      ...context.session,
      id: subSessionId,
      title: `Subagent: ${input.prompt.slice(0, 50)}`,
      model: input.model ?? context.session.model,
      allowed_tools: input.allowed_tools ?? context.session.allowed_tools,
      max_turns: requestedMaxTurns,
      file_path: context.session.file_path.replace(
        ".jsonl",
        `_sub_${Date.now()}.jsonl`
      ),
    };

    return tracer.withSpan(
      "subagent.run",
      {
        child_session_id: subSessionId,
        depth: currentDepth + 1,
        prompt_preview: input.prompt.slice(0, 120),
      },
      async (span) => {
        const parent = tracer.currentContext();
        try {
          const result = await runAgent({
            prompt: input.prompt,
            session: subSession,
            system_prompt: input.system_prompt,
            // FIX(iteration-1): propagate incremented depth so the child enforces
            // the same recursion cap when it tries to spawn its own children.
            _subagent_depth: currentDepth + 1,
            _parent_trace_id: parent?.trace_id,
            _parent_span_id: parent?.span_id,
          });

          span?.setAttributes({
            child_turns: result.turns,
            child_cost_usd: result.cost_usd,
            child_input_tokens: result.usage.input,
            child_output_tokens: result.usage.output,
            child_stop_reason: result.stop_reason,
          });
          if (result.stop_reason === "error") span?.setStatus("error");

          return ok(result.text || "(subagent completed with no text output)");
        } catch (e) {
          span?.recordError(e);
          return err(`Subagent error: ${String(e)}`);
        }
      }
    );
  },
};
