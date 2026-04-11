/**
 * The Agent Loop — core of Altimeter.
 *
 * "A simple while loop combined with disciplined tools delivers
 *  controllable autonomy." — Claude Code philosophy
 *
 * Algorithm:
 * 1. Assemble context (system prompt + history + skills + memory)
 * 2. Call LLM → get response
 * 3. If response has tool_calls → execute each tool, append results, GOTO 2
 * 4. If response is text-only → we're done
 *
 * That's it. The simplicity is the point.
 *
 * Safety valves: max_turns, max_budget_usd, hook interception.
 */

import type {
  AgentRunOptions,
  AgentRunResult,
  Message,
  ToolCall,
  ToolResult,
  ToolResultContent,
} from "./types.js";
import { registry } from "../tools/registry.js";
import { hookEngine } from "../hooks/engine.js";
import { router } from "../providers/router.js";
import type { ToolExecutionContext } from "../tools/base.js";
import { assembleContext } from "./context.js";

// Inject agent runner into the agent tool (avoids circular import at module load)
import { setAgentRunner } from "../tools/agent.js";

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  // Break circular dep: inject self as the subagent runner
  setAgentRunner(runAgent);

  const { session } = options;
  const { provider, model: resolvedModel } = router.resolve(
    session.model,
    session.provider
  );

  const cwd = process.cwd();
  const toolContext: ToolExecutionContext = {
    session,
    cwd,
    env: {},
    plan_mode: session.permission_mode === "plan",
  };

  // Build initial message history
  const messages: Message[] = [...(options.history ?? [])];

  // Add user prompt
  messages.push({ role: "user", content: options.prompt });

  // Assemble system prompt + skill injections
  const systemPrompt = await assembleContext(options, messages);

  let turns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastText = "";

  // ──────────────────────────────────────────────────
  // THE LOOP
  // ──────────────────────────────────────────────────
  while (turns < session.max_turns) {
    turns++;

    // Get tool definitions for this session
    const tools = registry.getToolDefinitions(session);

    // Call the LLM
    const response = await provider.complete({
      model: resolvedModel,
      messages,
      system: systemPrompt,
      tools: tools.length > 0 ? tools : undefined,
      max_tokens: 8192,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // Stream text to caller if provided
    if (response.text && options.onText) {
      options.onText(response.text);
    }

    if (response.text) lastText = response.text;

    // Budget check
    const estimatedCost = provider.estimateCost(
      resolvedModel,
      totalInputTokens,
      totalOutputTokens
    );

    if (estimatedCost > session.max_budget_usd) {
      return buildResult(
        `[Budget exceeded: $${estimatedCost.toFixed(4)} > $${session.max_budget_usd}]\n\n${lastText}`,
        turns,
        totalInputTokens,
        totalOutputTokens,
        estimatedCost,
        "max_budget",
        messages
      );
    }

    // ── Text-only response → done ──
    if (response.tool_calls.length === 0) {
      // Fire Stop hook
      const stopHook = await hookEngine.fireStop({
        session_id: session.id,
        turn: turns,
        final_text: lastText,
      });

      if (stopHook.action === "block") {
        lastText = `[Stopped by hook: ${stopHook.reason}]`;
      }

      // Append assistant message to history
      messages.push({
        role: "assistant",
        content: lastText,
        timestamp: new Date().toISOString(),
      });

      return buildResult(
        lastText,
        turns,
        totalInputTokens,
        totalOutputTokens,
        estimatedCost,
        "text",
        messages
      );
    }

    // ── Tool calls → execute each, loop back ──

    // Build assistant message with tool use blocks
    const assistantContent = [];
    if (response.text) {
      assistantContent.push({ type: "text" as const, text: response.text });
    }
    for (const call of response.tool_calls) {
      assistantContent.push({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }

    messages.push({
      role: "assistant",
      content: assistantContent,
      timestamp: new Date().toISOString(),
    });

    // Execute tools and collect results
    const toolResultBlocks: ToolResultContent[] = [];

    for (const call of response.tool_calls) {
      // PreToolUse hook
      const preHook = await hookEngine.firePreToolUse({
        session_id: session.id,
        turn: turns,
        tool_call: call,
      });

      if (preHook.action === "block") {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `[Blocked by hook: ${preHook.reason ?? "hook policy"}]`,
          is_error: true,
        });
        continue;
      }

      // Apply hook modification to input
      const effectiveCall: ToolCall = preHook.modified_input
        ? { ...call, input: preHook.modified_input }
        : call;

      // Notify caller
      if (options.onToolCall) await options.onToolCall(effectiveCall);

      // Execute
      const toolResult = await registry.executeTool(
        effectiveCall.name,
        effectiveCall.input,
        toolContext
      );

      const result: ToolResult = {
        tool_use_id: call.id,
        content: toolResult.output,
        is_error: toolResult.is_error,
      };

      // PostToolUse hook
      const postHook = await hookEngine.firePostToolUse({
        session_id: session.id,
        turn: turns,
        tool_call: effectiveCall,
        tool_result: result,
      });

      const finalContent =
        postHook.modified_output ?? result.content;

      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: finalContent,
        is_error: result.is_error,
      });

      // Notify caller
      if (options.onToolResult) {
        await options.onToolResult({
          ...result,
          content: finalContent,
        });
      }
    }

    // Append tool results as user message (Anthropic style)
    messages.push({
      role: "tool",
      content: toolResultBlocks,
      timestamp: new Date().toISOString(),
    });
  }

  // Hit max_turns
  return buildResult(
    lastText || "[Max turns reached without a final response]",
    turns,
    totalInputTokens,
    totalOutputTokens,
    provider.estimateCost(resolvedModel, totalInputTokens, totalOutputTokens),
    "max_turns",
    messages
  );
}

// ---------------------------------------------------------------------------
// Build the final result object
// ---------------------------------------------------------------------------

function buildResult(
  text: string,
  turns: number,
  inputTokens: number,
  outputTokens: number,
  cost: number,
  stopReason: AgentRunResult["stop_reason"],
  messages: Message[]
): AgentRunResult {
  return {
    text,
    turns,
    usage: { input: inputTokens, output: outputTokens },
    cost_usd: cost,
    stop_reason: stopReason,
    messages,
  };
}
