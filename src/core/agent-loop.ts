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
import { assembleContext, compressContext, estimateContextTokens, getContextLimit } from "./context.js";
import { withRetry } from "./retry.js";
import { auditLogger } from "../security/audit.js";
import { costTracker } from "./cost-tracker.js";
import { tracer } from "../observability/tracer.js";

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { session } = options;
  const { provider, model: resolvedModel } = router.resolve(
    session.model,
    session.provider
  );

  // ── Observability: root span for the whole session ──
  const { active: sessionSpan, run: runInTrace } = tracer.startRootSpan(
    "agent.session",
    session,
    {
      session_id: session.id,
      model: resolvedModel,
      provider: session.provider,
      permission_mode: session.permission_mode,
      max_turns: session.max_turns,
      subagent_depth: options._subagent_depth ?? 0,
    },
    options._parent_trace_id,
    options._parent_span_id
  );

  try {
    return await runInTrace(() => runAgentInner(options, resolvedModel, sessionSpan));
  } catch (e) {
    sessionSpan?.recordError(e);
    tracer.end(sessionSpan);
    throw e;
  }
}

async function runAgentInner(
  options: AgentRunOptions,
  resolvedModel: string,
  sessionSpan: import("../observability/tracer.js").ActiveSpan | null
): Promise<AgentRunResult> {
  const { session } = options;
  const { provider } = router.resolve(session.model, session.provider);

  const cwd = process.cwd();
  const toolContext: ToolExecutionContext = {
    session,
    cwd,
    env: {},
    plan_mode: session.permission_mode === "plan",
    // FIX(iteration-1): propagate sub-agent depth so the `agent` tool can
    // enforce MAX_SUBAGENT_DEPTH against the actual call-tree depth.
    subagent_depth: options._subagent_depth ?? 0,
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

  // Audit: session start
  await auditLogger.logRaw("SessionStart", {
    session_id: session.id,
    model: resolvedModel,
    provider: session.provider,
    permission_mode: session.permission_mode,
  });

  // ──────────────────────────────────────────────────
  // THE LOOP
  // ──────────────────────────────────────────────────
  while (turns < session.max_turns) {
    turns++;

    const turnSpan = tracer.startSpan("agent.turn", {
      turn_number: turns,
    });

    // Everything the turn does must nest under turnSpan, so run the body
    // inside its ALS context. The body returns either `null` to continue
    // the loop, or an AgentRunResult to return from runAgentInner.
    const turnOutcome: AgentRunResult | null = await tracer.runInSpan(turnSpan, async (): Promise<AgentRunResult | null> => {
    // Get tool definitions for this session
    const tools = registry.getToolDefinitions(session);

    // Compress context if approaching window limit
    const compressedMessages = compressContext(messages, resolvedModel, session.provider);

    // Call the LLM with retry logic (wrapped in llm.call span)
    const response = await tracer.withSpan(
      "llm.call",
      {
        provider: session.provider,
        model: resolvedModel,
        tool_count: tools.length,
      },
      async (llmSpan) => {
        let retryCount = 0;
        const resp = await withRetry(
          () => provider.complete({
            model: resolvedModel,
            messages: compressedMessages,
            system: systemPrompt,
            tools: tools.length > 0 ? tools : undefined,
            max_tokens: 8192,
            stream: options.streaming ?? false,
          }),
          {
            maxRetries: 3,
            onRetry: (attempt, error, delayMs) => {
              retryCount = attempt;
              if (options.onText) {
                options.onText(`\n[Retry ${attempt}/3 after ${Math.round(delayMs / 1000)}s: ${String(error).slice(0, 100)}]\n`);
              }
            },
          }
        );
        llmSpan?.setAttributes({
          input_tokens: resp.usage.input_tokens,
          output_tokens: resp.usage.output_tokens,
          cost_usd: provider.estimateCost(
            resolvedModel,
            resp.usage.input_tokens,
            resp.usage.output_tokens
          ),
          stop_reason: resp.stop_reason,
          retries: retryCount,
          tool_calls_requested: resp.tool_calls.length,
        });
        return resp;
      }
    );

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
      await auditLogger.logRaw("SessionEnd", {
        session_id: session.id,
        turns,
        cost_usd: estimatedCost,
        stop_reason: "max_budget",
      });
      await costTracker.record({
        timestamp: new Date().toISOString(),
        session_id: session.id,
        model: resolvedModel,
        provider: session.provider,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cost_usd: estimatedCost,
        turns,
      });
      turnSpan?.setAttribute("exit", "max_budget");
      tracer.end(turnSpan);
      sessionSpan?.setAttributes({
        turns,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cost_usd: estimatedCost,
        stop_reason: "max_budget",
      });
      sessionSpan?.setStatus("error");
      tracer.end(sessionSpan);
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

      await auditLogger.logRaw("SessionEnd", {
        session_id: session.id,
        turns,
        cost_usd: estimatedCost,
        stop_reason: "text",
      });
      await costTracker.record({
        timestamp: new Date().toISOString(),
        session_id: session.id,
        model: resolvedModel,
        provider: session.provider,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cost_usd: estimatedCost,
        turns,
      });

      turnSpan?.setAttributes({
        has_tool_calls: false,
        exit: "text",
      });
      tracer.end(turnSpan);
      sessionSpan?.setAttributes({
        turns,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cost_usd: estimatedCost,
        stop_reason: "text",
      });
      tracer.end(sessionSpan);
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
          name: call.name,
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

      // Audit log
      await auditLogger.log("ToolExecution", {
        event: "PostToolUse",
        session_id: session.id,
        turn: turns,
        tool_call: effectiveCall,
        tool_result: {
          tool_use_id: call.id,
          content: toolResult.output.slice(0, 500),
          is_error: toolResult.is_error,
        },
      });

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
        name: effectiveCall.name,
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

    turnSpan?.setAttributes({
      has_tool_calls: true,
      tool_call_count: response.tool_calls.length,
      tool_error_count: toolResultBlocks.filter((b) => b.is_error).length,
    });
    tracer.end(turnSpan);
    return null; // continue the outer loop
    });

    if (turnOutcome) return turnOutcome;
  }

  // Hit max_turns
  const maxTurnsCost = provider.estimateCost(resolvedModel, totalInputTokens, totalOutputTokens);
  await auditLogger.logRaw("SessionEnd", {
    session_id: session.id,
    turns,
    cost_usd: maxTurnsCost,
    stop_reason: "max_turns",
  });
  await costTracker.record({
    timestamp: new Date().toISOString(),
    session_id: session.id,
    model: resolvedModel,
    provider: session.provider,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cost_usd: maxTurnsCost,
    turns,
  });

  sessionSpan?.setAttributes({
    turns,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cost_usd: maxTurnsCost,
    stop_reason: "max_turns",
  });
  sessionSpan?.setStatus("error");
  tracer.end(sessionSpan);

  return buildResult(
    lastText || "[Max turns reached without a final response]",
    turns,
    totalInputTokens,
    totalOutputTokens,
    maxTurnsCost,
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
