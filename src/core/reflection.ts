/**
 * Reflection wrapper around runAgent.
 *
 * Runs the agent normally, then — only if the task was long or hit tool errors —
 * asks the agent one bounded follow-up question: "anything future-you should
 * remember?" The agent can respond with a memory_note call or just say "done".
 *
 * This is the entire "learning" mechanism. No background loops, no continuous
 * reflection, no surprise behavior. One extra turn, triggered conditionally.
 */

import type {
  AgentRunOptions,
  AgentRunResult,
  Message,
  ToolResultContent,
} from "./types.js";
import { runAgent } from "./agent-loop.js";
import { tracer } from "../observability/tracer.js";

const LONG_TASK_TURN_THRESHOLD = 5;

const REFLECTION_PROMPT =
  "Before finishing: is there anything future-you should remember from this task? " +
  "If you made a mistake, hit an unexpected error, or learned a non-obvious gotcha, " +
  "call memory_note with kind='lesson' and short relevant tags (file paths, tool names, topics). " +
  "If nothing is worth saving, reply with just 'done'.";

/**
 * Run the agent with conditional post-task reflection.
 * Delegates to runAgent for the primary call, then fires one reflection
 * turn if the trigger conditions are met.
 */
export async function runAgentWithReflection(
  options: AgentRunOptions
): Promise<AgentRunResult> {
  const result = await runAgent(options);

  const willReflect = shouldReflect(result);
  if (process.env.ALTIMETER_DEBUG_REFLECTION) {
    process.stderr.write(
      `[reflection] willReflect=${willReflect} stop_reason=${result.stop_reason} turns=${result.turns} hasErr=${hasToolError(result.messages)}\n`
    );
  }
  if (!willReflect) return result;

  const triggerReason =
    result.turns >= LONG_TASK_TURN_THRESHOLD ? "turns>=5" : "tool_error";

  // Reflection span — a fresh root in its own trace. The child runAgent's
  // agent.session joins this trace via _parent_trace_id/_parent_span_id.
  const { active: reflSpan, run: runInReflectionTrace } = tracer.startRootSpan(
    "agent.reflection",
    options.session,
    { trigger_reason: triggerReason, original_turns: result.turns }
  );

  const reflectionResult = await runInReflectionTrace(async () => {
    const parent = tracer.currentContext();
    try {
      const r = await runAgent({
        ...options,
        prompt: REFLECTION_PROMPT,
        history: result.messages,
        // Reflection is noisy for the primary output stream — swallow it.
        onText: undefined,
        _parent_trace_id: parent?.trace_id,
        _parent_span_id: parent?.span_id,
      });
      reflSpan?.setAttributes({
        reflection_turns: r.turns,
        reflection_cost_usd: r.cost_usd,
      });
      tracer.end(reflSpan);
      return r;
    } catch (e) {
      reflSpan?.recordError(e);
      tracer.end(reflSpan);
      throw e;
    }
  });

  // Return the original result's text, but the extended history + combined usage.
  return {
    text: result.text,
    turns: result.turns + reflectionResult.turns,
    usage: {
      input: result.usage.input + reflectionResult.usage.input,
      output: result.usage.output + reflectionResult.usage.output,
    },
    cost_usd: result.cost_usd + reflectionResult.cost_usd,
    stop_reason: result.stop_reason,
    messages: reflectionResult.messages,
  };
}

/**
 * Trigger reflection if the task was long OR any tool result errored.
 */
function shouldReflect(result: AgentRunResult): boolean {
  if (result.stop_reason !== "text") return false;
  if (result.turns >= LONG_TASK_TURN_THRESHOLD) return true;
  return hasToolError(result.messages);
}

function hasToolError(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of blocks) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "tool_result" &&
        (block as ToolResultContent).is_error === true
      ) {
        return true;
      }
    }
  }
  return false;
}
