/**
 * Tracer — OTel-shaped spans written to the existing session JSONL.
 *
 * Design:
 * - One event stream (the session JSONL) is the source of truth. The detail
 *   tier, the live printer, and the story-tier summary are all derived from it.
 * - AsyncLocalStorage tracks the "current span" across async boundaries so
 *   nested instrumentation points can infer parent_span_id automatically.
 * - No OTel SDK. Just the vocabulary. A real exporter can be added later.
 * - Failures in the tracer NEVER crash the agent — observability must not
 *   become a new failure mode.
 */

import { AsyncLocalStorage } from "async_hooks";
import { randomBytes } from "crypto";
import { EventEmitter } from "events";
import type { Span, SpanStatus, SessionConfig } from "../core/types.js";
import { sessionManager } from "../core/session.js";

export type ObservabilityLevel = "off" | "summary" | "full";

interface TraceContext {
  trace_id: string;
  span_id: string;
  session: SessionConfig;
}

const als = new AsyncLocalStorage<TraceContext>();

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export const newTraceId = (): string => hex(16);
export const newSpanId = (): string => hex(8);

export interface ActiveSpan {
  readonly span: Span;
  readonly session: SessionConfig;
  setAttribute(key: string, value: unknown): void;
  setAttributes(attrs: Record<string, unknown>): void;
  setStatus(status: SpanStatus): void;
  recordError(err: unknown): void;
}

class Tracer {
  private level: ObservabilityLevel = "full";
  public readonly events: EventEmitter = new EventEmitter();

  setLevel(level: ObservabilityLevel): void {
    this.level = level;
  }

  getLevel(): ObservabilityLevel {
    return this.level;
  }

  isEnabled(): boolean {
    return this.level !== "off";
  }

  /**
   * Start a root span. Used by runAgent for `agent.session`. If
   * `parentTraceId` / `parentSpanId` are provided the new root joins that
   * trace (subagent case).
   *
   * The returned `run` callback must be used to execute the body of work so
   * nested `startSpan` calls inherit parent linkage via AsyncLocalStorage.
   */
  startRootSpan(
    name: string,
    session: SessionConfig,
    attributes: Record<string, unknown> = {},
    parentTraceId?: string,
    parentSpanId?: string
  ): {
    active: ActiveSpan | null;
    run: <T>(fn: () => Promise<T>) => Promise<T>;
  } {
    if (!this.isEnabled()) {
      return {
        active: null,
        run: <T>(fn: () => Promise<T>) => fn(),
      };
    }

    const trace_id = parentTraceId ?? newTraceId();
    const span_id = newSpanId();
    const span: Span = {
      trace_id,
      span_id,
      parent_span_id: parentSpanId,
      name,
      session_id: session.id,
      start_time: new Date().toISOString(),
      status: "in_progress",
      attributes: { ...attributes },
    };

    void this.emitStart(session, span);
    const active = this.makeActive(session, span);

    const ctx: TraceContext = { trace_id, span_id, session };
    const run = <T>(fn: () => Promise<T>) => als.run(ctx, fn);
    return { active, run };
  }

  /**
   * Start a child span. Parent is inferred from AsyncLocalStorage.
   * Returns null (no-op) if the tracer is disabled or we're outside any
   * root context.
   */
  startSpan(
    name: string,
    attributes: Record<string, unknown> = {}
  ): ActiveSpan | null {
    if (!this.isEnabled()) return null;

    const ctx = als.getStore();
    if (!ctx) return null;

    const span: Span = {
      trace_id: ctx.trace_id,
      span_id: newSpanId(),
      parent_span_id: ctx.span_id,
      name,
      session_id: ctx.session.id,
      start_time: new Date().toISOString(),
      status: "in_progress",
      attributes: { ...attributes },
    };

    void this.emitStart(ctx.session, span);
    return this.makeActive(ctx.session, span);
  }

  /**
   * Run `fn` with `active` as the current parent in AsyncLocalStorage so
   * anything it starts becomes a child. Does NOT end the span — caller is
   * responsible for calling `tracer.end(active)` on all exit paths. Use this
   * when a span brackets work that has multiple early-return paths (e.g.
   * the agent loop's turn span).
   */
  runInSpan<T>(active: ActiveSpan | null, fn: () => Promise<T>): Promise<T> {
    if (!active) return fn();
    const childCtx: TraceContext = {
      trace_id: active.span.trace_id,
      span_id: active.span.span_id,
      session: active.session,
    };
    return als.run(childCtx, fn);
  }

  /**
   * Convenience: start a child span, run `fn` with the span as parent, end
   * the span on resolution. Errors are recorded on the span and re-thrown.
   */
  async withSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (active: ActiveSpan | null) => Promise<T>
  ): Promise<T> {
    const active = this.startSpan(name, attributes);
    if (!active) return fn(null);

    const childCtx: TraceContext = {
      trace_id: active.span.trace_id,
      span_id: active.span.span_id,
      session: active.session,
    };

    try {
      const result = await als.run(childCtx, () => fn(active));
      this.end(active);
      return result;
    } catch (e) {
      active.recordError(e);
      this.end(active);
      throw e;
    }
  }

  /**
   * End an active span. Safe to call on null. Stamps end_time / duration_ms
   * and emits a span_end event. Idempotent.
   */
  end(active: ActiveSpan | null): void {
    if (!active) return;
    const span = active.span;
    if (span.end_time) return;
    const end_time = new Date().toISOString();
    span.end_time = end_time;
    span.duration_ms =
      new Date(end_time).getTime() - new Date(span.start_time).getTime();
    if (span.status === "in_progress") span.status = "ok";
    void this.emitEnd(active.session, span);
  }

  /**
   * Current trace/span IDs (for propagating into subagents).
   */
  currentContext(): { trace_id: string; span_id: string } | null {
    const ctx = als.getStore();
    if (!ctx) return null;
    return { trace_id: ctx.trace_id, span_id: ctx.span_id };
  }

  // ---------------------------------------------------------------------

  private makeActive(session: SessionConfig, span: Span): ActiveSpan {
    return {
      span,
      session,
      setAttribute(key, value) {
        span.attributes[key] = value;
      },
      setAttributes(attrs) {
        Object.assign(span.attributes, attrs);
      },
      setStatus(status) {
        span.status = status;
      },
      recordError(err) {
        span.status = "error";
        span.error = {
          type: err instanceof Error ? err.constructor.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        };
      },
    };
  }

  private async emitStart(session: SessionConfig, span: Span): Promise<void> {
    this.events.emit("span_start", span);
    try {
      await sessionManager.appendEvent(session, {
        type: "span_start",
        timestamp: span.start_time,
        data: { span },
      });
    } catch {
      // Observability must never crash the agent.
    }
  }

  private async emitEnd(session: SessionConfig, span: Span): Promise<void> {
    this.events.emit("span_end", span);
    try {
      await sessionManager.appendEvent(session, {
        type: "span_end",
        timestamp: span.end_time ?? new Date().toISOString(),
        data: { span },
      });
    } catch {
      // Silent.
    }
  }
}

export const tracer = new Tracer();
