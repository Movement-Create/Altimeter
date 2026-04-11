/**
 * Audit trail logger.
 *
 * Records all tool calls, hook events, and session events to an audit log.
 * The audit log is append-only JSONL, separate from session logs.
 *
 * Use case: compliance, debugging, replay.
 */

import { appendFile, mkdir } from "fs/promises";
import { resolve, join } from "path";
import type { HookContext } from "../core/types.js";

const DEFAULT_AUDIT_DIR = "./audit";

class AuditLogger {
  private auditDir: string;
  private enabled: boolean;

  constructor() {
    this.auditDir = DEFAULT_AUDIT_DIR;
    this.enabled = process.env.ALTIMETER_AUDIT === "1";
  }

  setDir(dir: string): void {
    this.auditDir = dir;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async log(event: string, context: HookContext): Promise<void> {
    if (!this.enabled) return;

    try {
      await mkdir(resolve(this.auditDir), { recursive: true });

      const entry = JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        session_id: context.session_id,
        turn: context.turn,
        tool: context.tool_call?.name,
        tool_input: context.tool_call?.input,
        has_result: !!context.tool_result,
        result_error: context.tool_result?.is_error,
      });

      const today = new Date().toISOString().slice(0, 10);
      await appendFile(
        join(this.auditDir, `audit-${today}.jsonl`),
        entry + "\n",
        "utf-8"
      );
    } catch {
      // Never crash the agent due to audit failures
    }
  }

  /**
   * Log a raw event (not a hook context).
   */
  async logRaw(event: string, data: unknown): Promise<void> {
    if (!this.enabled) return;

    try {
      await mkdir(resolve(this.auditDir), { recursive: true });

      const entry = JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        data,
      });

      const today = new Date().toISOString().slice(0, 10);
      await appendFile(
        join(this.auditDir, `audit-${today}.jsonl`),
        entry + "\n",
        "utf-8"
      );
    } catch {
      // Silent
    }
  }
}

export const auditLogger = new AuditLogger();
