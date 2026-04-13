/**
 * Audit trail logger — now a thin shim over the observability tracer.
 *
 * Historically this wrote to a separate ./audit/audit-YYYY-MM-DD.jsonl file
 * when ALTIMETER_AUDIT=1. After the observability rewrite, all audit data is
 * captured as spans in the session JSONL (one source of truth — see
 * src/observability/tracer.ts), so this file exists only for backwards
 * compatibility with callers that still import `auditLogger`.
 *
 * The agent-loop and hook engine have been rewired to spans directly; this
 * shim is kept so external code / tests that import auditLogger still work.
 */

import type { HookContext } from "../core/types.js";

class AuditLoggerShim {
  setDir(_dir: string): void {
    // no-op — spans live in sessions/<id>.jsonl
  }

  setEnabled(_enabled: boolean): void {
    // no-op
  }

  async log(_event: string, _context: HookContext): Promise<void> {
    // No-op. Hook spans are now emitted by src/hooks/engine.ts via the tracer.
  }

  async logRaw(_event: string, _data: unknown): Promise<void> {
    // No-op. Session lifecycle is covered by agent.session spans.
  }
}

export const auditLogger = new AuditLoggerShim();
