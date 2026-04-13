# Altimeter Observability — Two-Tier Plan

## Context

Altimeter today has the *raw materials* for observability but no unified observability layer:

- [src/core/session.ts](src/core/session.ts) writes JSONL events (`session_start`, `user_message`, `assistant_message`, `tool_call`, `tool_result`, `session_end`, `error`, `compaction`) but events lack span/trace correlation, durations, or hierarchy.
- [src/security/audit.ts](src/security/audit.ts) exists as an audit logger but only fires when `ALTIMETER_AUDIT=1`, writes to a *separate* daily file, and duplicates fields rather than enriching session events.
- [src/core/cost-tracker.ts](src/core/cost-tracker.ts) appends per-LLM-call cost rows to `sessions/cost-ledger.jsonl` — also disconnected from sessions.
- [src/index.ts](src/index.ts) prints tool calls/results to stderr via `chalk` callbacks but the rendering is ad-hoc and there is no end-of-session summary.
- Subagents ([src/tools/agent.ts](src/tools/agent.ts)) get a new session file with a `_sub_` suffix but no parent→child link is recorded inside the events themselves — you can guess from the filename, nothing more.
- No correlation IDs, no span model, no story-tier output.

**Goal:** a single, unified observability system with two tiers serving one philosophy: *"deploy it, play with it, then read a clear short story of what happened — and if anything failed, drop straight into the detail logs and debug to the line."*

- **Detail tier** — every turn, LLM call, tool call, hook, and subagent emits a structured span event with `trace_id`, `span_id`, `parent_span_id`, `duration_ms`, `status`, `error`, `tokens`, `cost`. Written to the existing session JSONL (extended), so one file = full debug truth.
- **Story tier** — at session end, a deterministic reducer reads the spans and emits `sessions/<id>.summary.md`: outcome ✅/❌, turns, tools used (with counts + error counts), total tokens, total cost, wall-clock time, error highlights, subagent tree. Optional LLM-narrated paragraph behind a flag.
- **Live tier** (bonus) — the existing stderr printer ([src/index.ts:140-160](src/index.ts#L140-L160)) is rewired to consume the same span stream so the live terminal view, the JSONL, and the summary are all derived from one source.

One writer, one event stream, multiple readers. No drift.

## Design Decisions

1. **Extend, don't replace.** Add new event types to the existing `SessionEvent` union in [src/core/types.ts:163-175](src/core/types.ts#L163-L175). Keep the old events. The session JSONL becomes the trace store.
2. **OTel-shaped, not OTel-bound.** Use OpenTelemetry's *span vocabulary* (`trace_id`, `span_id`, `parent_span_id`, `start_time`, `end_time`, `status`, `attributes`) so the format is familiar and a future OTel exporter is a thin adapter — but no SDK dependency in v1. (See open question Q1.)
3. **Wrap, don't scatter.** Add one `Tracer` helper (`src/observability/tracer.ts`) with `startSpan(name, attrs)` and `endSpan(span, status, attrs)`. Every instrumentation point calls these two methods. No `console.log` sprinkles.
4. **Story is deterministic.** Default summary is computed from spans via `summarize(sessionId)` — no LLM call, no flakiness, runs in milliseconds. LLM narration is a `--narrate` flag that adds one extra Anthropic call.
5. **Audit logger merges in.** `auditLogger` becomes a thin wrapper that emits spans via the tracer instead of writing a parallel file. The `ALTIMETER_AUDIT` env var becomes a no-op (kept for backwards compat), replaced by a config field.
6. **Cost ledger merges in.** Cost rows still write to `cost-ledger.jsonl` (cross-session aggregation is useful), but each `record()` call also stamps `tokens`/`cost`/`model` onto the active `llm.call` span so single-session debugging needs only one file.
7. **Subagent linkage.** When [src/tools/agent.ts:98-105](src/tools/agent.ts#L98-L105) calls `runAgent()` for a child, it passes the parent's current span ID. The child's first event (`session_start`) records `parent_span_id` and `parent_trace_id`. The summary reducer can then render the subagent tree.

## Span Taxonomy

| Span name | Where started | Where ended | Key attributes |
|---|---|---|---|
| `agent.session` | [agent-loop.ts:69](src/core/agent-loop.ts#L69) | [agent-loop.ts:173 / 317](src/core/agent-loop.ts#L173) | session_id, model, max_turns, parent_span_id (if subagent) |
| `agent.turn` | [agent-loop.ts:79](src/core/agent-loop.ts#L79) (top of while) | end of each loop iteration | turn_number, has_tool_calls |
| `llm.call` | [agent-loop.ts:89](src/core/agent-loop.ts#L89) (around `provider.complete`) | after `withRetry` resolves | provider, model, input_tokens, output_tokens, cost_usd, retries, stop_reason |
| `tool.execute` | [registry.ts:131](src/tools/registry.ts#L131) (top of `executeTool`) | [registry.ts:172-179](src/tools/registry.ts#L172-L179) | tool_name, permission_level, allowed, blocked_reason?, is_error, error_message? |
| `hook.pre` / `hook.post` / `hook.stop` | [hooks/engine.ts:44/64/86](src/hooks/engine.ts#L44) | end of each fire method | hook_id, action (allow/block/modify) |
| `subagent.run` | [tools/agent.ts:98](src/tools/agent.ts#L98) | after child `runAgent` returns | child_session_id, depth, child_turns, child_cost |
| `agent.reflection` | [reflection.ts:47](src/core/reflection.ts#L47) | after second `runAgent` returns | trigger_reason ("turns>=5" / "tool_error") |

Every span ID is a 16-byte hex; trace ID is 32-byte. One trace = one root `agent.session` and all its descendants (including subagents — they share the trace).

## Implementation Steps

### 1. New module: `src/observability/`
Create three files:
- `tracer.ts` — `Tracer` class with `startSpan`, `endSpan`, `currentSpan()` (AsyncLocalStorage-backed for parent inference). Spans emit via the existing `sessionManager.appendEvent` so output goes to the same JSONL.
- `summarize.ts` — `summarize(sessionId): Promise<string>` reads `sessions/<id>.jsonl`, groups spans by name, computes counts/durations/errors, renders Markdown to `sessions/<id>.summary.md`. Pure function over the JSONL — no live state.
- `printer.ts` — `LivePrinter` consumes spans and renders the chalk output that [src/index.ts:140-160](src/index.ts#L140-L160) does today, plus an end-of-run mini-summary. Replaces the inline callbacks.

### 2. Extend session event types
[src/core/types.ts:163-175](src/core/types.ts#L163-L175): add `"span_start"` and `"span_end"` to the `SessionEvent` union, with a `Span` shape:
```ts
interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  start_time: string;
  end_time?: string;
  duration_ms?: number;
  status: "ok" | "error" | "in_progress";
  attributes: Record<string, unknown>;
  error?: { type: string; message: string; stack?: string };
}
```
Old event types remain — no break.

### 3. Instrument the loop
[src/core/agent-loop.ts](src/core/agent-loop.ts):
- Wrap the whole `runAgent` body in `tracer.startSpan("agent.session", ...)` and `endSpan` in both return paths (lines 173 and 317).
- Wrap the `while` body (line 79) in `agent.turn`.
- Wrap `provider.complete` call (lines 89-106) in `llm.call`. Pull `usage` and `cost` from the result and stamp them on the span before `endSpan`.
- Wrap the for-loop body at line 226-305: not needed directly — tool spans are started inside the registry. But emit a `turn` attribute `tool_call_count`.
- On the catch path of the retry wrapper, mark `llm.call` span as `status: "error"` with the exception.

### 4. Instrument tool dispatch
[src/tools/registry.ts:131-180](src/tools/registry.ts#L131): wrap `executeTool` in `tool.execute`. Stamp `is_error` from the catch result onto the span. Permission denials (lines 141-160) also emit a span with `status: "error"`, `blocked_reason: "permission"`.

### 5. Instrument hooks
[src/hooks/engine.ts:44-101](src/hooks/engine.ts#L44): each `firePreToolUse` / `firePostToolUse` / `fireStop` becomes a single span. Move the existing `auditLogger.log` calls inside `endSpan` so audit becomes a span attribute.

### 6. Instrument providers (cost/tokens)
Providers don't need their own spans — `llm.call` (started one frame up) is enough. Just ensure `provider.complete` returns `usage` reliably (it already does per [providers/anthropic.ts:177-180](src/providers/anthropic.ts#L177)). The agent-loop stamps it onto the span.

### 7. Instrument subagents
[src/tools/agent.ts:98-105](src/tools/agent.ts#L98): start `subagent.run` span before the recursive `runAgent` call. Pass `parent_trace_id` and `parent_span_id` through `_subagent_depth`-style hidden context fields so the child's `agent.session` span inherits the trace and links to the parent. End the span after `runAgent` returns; stamp `child_turns` and `child_cost` from the result.

### 8. Instrument reflection
[src/core/reflection.ts:47-53](src/core/reflection.ts#L47): wrap the conditional second `runAgent` call in `agent.reflection`. Trigger reason is already known at line 38-44 — stamp it as an attribute.

### 9. Rewire CLI output
[src/index.ts:140-160](src/index.ts#L140-L160): replace the inline `onText` / `onToolCall` / `onToolResult` with a `LivePrinter` instance subscribed to the tracer. After `runAgent` returns, call `summarize(session.id)` and print the path of the generated `summary.md` (and optionally tail it to stdout if `--summary` flag is set).

### 10. Config + flags
[src/core/types.ts:225-249](src/core/types.ts#L225) (`AltimeterConfigSchema`): add
```ts
observability: {
  enabled: boolean (default true),
  level: "off" | "summary" | "full" (default "full"),
  narrate: boolean (default false),  // LLM narration in summary
  otel_endpoint?: string,             // future hook, unused in v1
}
```
Env vars: `ALTIMETER_OBS_LEVEL`, `ALTIMETER_OBS_NARRATE`. CLI flags: `--summary` (print summary at end), `--no-trace` (disable detail tier).

### 11. Backwards compat
- `auditLogger` becomes a no-op shim that forwards to the tracer; existing `ALTIMETER_AUDIT=1` is silently honored as `level: "full"`.
- Old session JSONL files (without span events) still resume cleanly because `resumeSession` ([src/core/session.ts:122-171](src/core/session.ts#L122)) ignores unknown event types — verify this and add a test if not.

## Files to Modify

| File | Change |
|---|---|
| [src/observability/tracer.ts](src/observability/tracer.ts) | **NEW** — Tracer class, AsyncLocalStorage span context |
| [src/observability/summarize.ts](src/observability/summarize.ts) | **NEW** — deterministic span → markdown reducer |
| [src/observability/printer.ts](src/observability/printer.ts) | **NEW** — live stderr printer subscribed to tracer |
| [src/core/types.ts](src/core/types.ts) | Add `Span`, `span_start`/`span_end` events, `observability` config |
| [src/core/session.ts](src/core/session.ts) | Tracer hooks into `appendEvent`; verify resume tolerates new types |
| [src/core/agent-loop.ts](src/core/agent-loop.ts) | Wrap session/turn/llm.call spans; stamp errors |
| [src/tools/registry.ts](src/tools/registry.ts) | Wrap `executeTool` in `tool.execute` span |
| [src/hooks/engine.ts](src/hooks/engine.ts) | Convert audit calls to spans |
| [src/tools/agent.ts](src/tools/agent.ts) | Start `subagent.run` span; propagate parent IDs |
| [src/core/reflection.ts](src/core/reflection.ts) | Wrap reflection call in span |
| [src/security/audit.ts](src/security/audit.ts) | Shim → tracer (keep file, gut implementation) |
| [src/index.ts](src/index.ts) | Replace inline callbacks with `LivePrinter`; call `summarize` at end |
| [src/config/loader.ts](src/config/loader.ts) | Load new env vars |

## Verification

End-to-end smoke test after implementation:

1. **Happy path detail tier**
   ```bash
   altimeter run "list files in src/ and tell me what each does"
   jq -c 'select(.type=="span_start" or .type=="span_end")' sessions/<id>.jsonl | head
   ```
   Expect: nested spans for `agent.session > agent.turn > llm.call`, `agent.turn > tool.execute (bash)`, etc., with parent IDs forming a tree.

2. **Story tier**
   ```bash
   cat sessions/<id>.summary.md
   ```
   Expect: outcome ✅, turn count, table of tools used with counts, total tokens & cost, wall-clock duration, no errors section.

3. **Failure path**
   ```bash
   altimeter run "run the bash command 'exit 7'"
   ```
   Expect: summary.md shows ❌ in the tools section with the exit code; the matching `tool.execute` span in the JSONL has `status: "error"` with the stderr.

4. **Subagent trace continuity**
   ```bash
   altimeter run "spawn a subagent to summarize README.md"
   jq '.data.span | select(.name=="subagent.run" or .name=="agent.session")' sessions/<id>.jsonl
   ```
   Expect: child `agent.session` span carries the same `trace_id` as parent and `parent_span_id` matches the parent's `subagent.run` span.

5. **Reflection trigger**
   Force a 6-turn run; expect `agent.reflection` span with `trigger_reason: "turns>=5"` and the reflection's own `llm.call` nested inside it.

6. **No regression**
   ```bash
   altimeter resume <old-session-id>
   ```
   Old JSONL files (pre-span) must still resume.

7. **Disable path**
   ```bash
   ALTIMETER_OBS_LEVEL=off altimeter run "hello"
   ```
   Expect: no `span_*` events in the JSONL; legacy events still present.

## Open Question

**Q1 — OTel compatibility:** the plan above is local-file only (spans live in the session JSONL, no SDK). It uses OTel's *vocabulary* so a thin exporter could be added later, but v1 ships zero new dependencies. The alternative is to depend on `@opentelemetry/api` + `@opentelemetry/sdk-node` from day one, which lets you pipe spans to Jaeger / Honeycomb / Tempo / Grafana for free but adds ~5 packages and a meaningful startup cost. I'll ask you which you want before exiting plan mode.
