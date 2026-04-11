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

    // Lazy import to break circular dependency
    const { runAgent } = await import("../core/agent-loop.js");

    const subSessionId = `sub_${context.session.id}_${Date.now()}`;

    const subSession = {
      ...context.session,
      id: subSessionId,
      title: `Subagent: ${input.prompt.slice(0, 50)}`,
      model: input.model ?? context.session.model,
      allowed_tools: input.allowed_tools ?? context.session.allowed_tools,
      max_turns: input.max_turns ?? 20,
      file_path: context.session.file_path.replace(
        ".jsonl",
        `_sub_${Date.now()}.jsonl`
      ),
    };

    try {
      const result = await runAgent({
        prompt: input.prompt,
        session: subSession,
        system_prompt: input.system_prompt,
      });

      return ok(result.text || "(subagent completed with no text output)");
    } catch (e) {
      return err(`Subagent error: ${String(e)}`);
    }
  },
};
