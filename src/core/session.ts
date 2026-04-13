/**
 * Session management — JSONL-based append-only session store.
 *
 * Design (from OpenCode):
 * - Sessions are stored as JSONL files: one event per line
 * - JSONL is append-only = O(1) writes, crash-safe
 * - Session resume = read JSONL → replay message history
 * - Session fork = copy JSONL file → new session id
 *
 * File layout:
 *   sessions/<session-id>.jsonl
 *
 * Each line: JSON-encoded SessionEvent (see types.ts)
 */

import { appendFile, readFile, mkdir, readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import type { SessionConfig, SessionEvent, Message, AgentRunResult } from "./types.js";
import type { AltimeterConfig } from "./types.js";

const DEFAULT_SESSIONS_DIR = "./sessions";

export class SessionManager {
  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? DEFAULT_SESSIONS_DIR;
  }

  /**
   * Create a new session from config + options.
   */
  async createSession(
    config: AltimeterConfig,
    overrides: Partial<SessionConfig> = {}
  ): Promise<SessionConfig> {
    const id = overrides.id ?? randomUUID();
    const timestamp = new Date().toISOString();

    await mkdir(resolve(this.sessionsDir), { recursive: true });

    const sessionFile = join(this.sessionsDir, `${id}.jsonl`);

    const session: SessionConfig = {
      id,
      title: overrides.title ?? `Session ${timestamp.slice(0, 10)}`,
      created_at: timestamp,
      model: overrides.model ?? config.model,
      provider: overrides.provider ?? config.provider,
      system_prompt: overrides.system_prompt ?? config.system_prompt,
      allowed_tools: overrides.allowed_tools ?? config.allowed_tools,
      disallowed_tools: overrides.disallowed_tools ?? config.disallowed_tools,
      permission_mode: overrides.permission_mode ?? config.permission_mode,
      effort: overrides.effort ?? config.effort,
      max_turns: overrides.max_turns ?? config.max_turns,
      max_budget_usd: overrides.max_budget_usd ?? config.max_budget_usd,
      file_path: sessionFile,
    };

    await this.appendEvent(session, {
      type: "session_start",
      timestamp,
      data: { config: session },
    });

    return session;
  }

  /**
   * Append a SessionEvent to the session JSONL file.
   * O(1) — just appends a line.
   */
  async appendEvent(session: SessionConfig, event: SessionEvent): Promise<void> {
    const line = JSON.stringify({ ...event, timestamp: event.timestamp ?? new Date().toISOString() }) + "\n";
    await appendFile(session.file_path, line, "utf-8");
  }

  /**
   * Log a user message to the session.
   */
  async logUserMessage(session: SessionConfig, content: string): Promise<void> {
    await this.appendEvent(session, {
      type: "user_message",
      timestamp: new Date().toISOString(),
      data: { content },
    });
  }

  /**
   * Log an assistant message to the session.
   */
  async logAssistantMessage(session: SessionConfig, content: string): Promise<void> {
    await this.appendEvent(session, {
      type: "assistant_message",
      timestamp: new Date().toISOString(),
      data: { content },
    });
  }

  /**
   * Log an agent result to the session.
   */
  async logResult(session: SessionConfig, result: AgentRunResult): Promise<void> {
    await this.appendEvent(session, {
      type: "session_end",
      timestamp: new Date().toISOString(),
      data: {
        text: result.text,
        turns: result.turns,
        usage: result.usage,
        cost_usd: result.cost_usd,
        stop_reason: result.stop_reason,
      },
    });
  }

  /**
   * Resume a session from its JSONL file.
   * Returns the session config and message history.
   */
  async resumeSession(sessionId: string): Promise<{
    session: SessionConfig;
    messages: Message[];
  } | null> {
    const filePath = join(this.sessionsDir, `${sessionId}.jsonl`);

    let rawContent: string;
    try {
      rawContent = await readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    const lines = rawContent.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    let session: SessionConfig | null = null;
    const messages: Message[] = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as SessionEvent;

        if (event.type === "session_start") {
          session = (event.data as { config: SessionConfig }).config;
        }

        if (event.type === "user_message") {
          messages.push({
            role: "user",
            content: (event.data as { content: string }).content,
            timestamp: event.timestamp,
          });
        }

        if (event.type === "assistant_message") {
          messages.push({
            role: "assistant",
            content: (event.data as { content: string }).content,
            timestamp: event.timestamp,
          });
        }
      } catch {
        // Corrupted line, skip
      }
    }

    if (!session) return null;
    return { session, messages };
  }

  /**
   * Fork a session: copy its state, assign new id.
   */
  async forkSession(sessionId: string): Promise<SessionConfig | null> {
    const resumed = await this.resumeSession(sessionId);
    if (!resumed) return null;

    const newId = randomUUID();
    const newFile = join(this.sessionsDir, `${newId}.jsonl`);

    const newSession: SessionConfig = {
      ...resumed.session,
      id: newId,
      title: `Fork of ${resumed.session.title ?? sessionId}`,
      created_at: new Date().toISOString(),
      file_path: newFile,
    };

    // Write all existing events + new session_start
    await this.appendEvent(newSession, {
      type: "session_start",
      timestamp: new Date().toISOString(),
      data: {
        config: newSession,
        forked_from: sessionId,
      },
    });

    // Re-append history
    for (const msg of resumed.messages) {
      await this.appendEvent(newSession, {
        type: msg.role === "user" ? "user_message" : "assistant_message",
        timestamp: msg.timestamp ?? new Date().toISOString(),
        data: { content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) },
      });
    }

    return newSession;
  }

  /**
   * List all sessions, sorted by creation date (newest first).
   */
  async listSessions(): Promise<Array<{ id: string; title?: string; created_at: string }>> {
    try {
      await mkdir(resolve(this.sessionsDir), { recursive: true });
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });

      const sessions: Array<{ id: string; title?: string; created_at: string }> = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

        const id = entry.name.replace(".jsonl", "");
        const filePath = join(this.sessionsDir, entry.name);

        try {
          const content = await readFile(filePath, "utf-8");
          const firstLine = content.split("\n")[0];
          if (firstLine) {
            const event = JSON.parse(firstLine) as SessionEvent;
            if (event.type === "session_start") {
              const config = (event.data as { config: SessionConfig }).config;
              sessions.push({
                id,
                title: config.title,
                created_at: config.created_at,
              });
            }
          }
        } catch {
          sessions.push({ id, created_at: new Date(0).toISOString() });
        }
      }

      return sessions.sort((a, b) =>
        b.created_at.localeCompare(a.created_at)
      );
    } catch {
      return [];
    }
  }

  /**
   * Delete a session file.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const { unlink } = await import("fs/promises");
    try {
      await unlink(join(this.sessionsDir, `${sessionId}.jsonl`));
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton
export const sessionManager = new SessionManager();
