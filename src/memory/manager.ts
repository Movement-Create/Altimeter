/**
 * Memory manager — pure Markdown memory store.
 *
 * Design philosophy (AIMastermind):
 * "Pure Markdown files — no vector DBs, no PostgreSQL"
 *
 * Files:
 * - memory/facts.md     : Curated persistent facts about the user/project
 * - memory/YYYY-MM-DD.md: Daily conversation logs
 * - memory/index.md     : Searchable index with timestamps
 *
 * Why not vectors?
 * - Markdown is human-readable and git-trackable
 * - LLMs are good at reading their own notes
 * - Keyword search works well enough for personal memory
 * - No infrastructure dependencies
 */

import { readFile, writeFile, mkdir, appendFile, stat } from "fs/promises";
import { resolve, join } from "path";

const DEFAULT_MEMORY_DIR = "./memory";

export class MemoryManager {
  private memoryDir: string;

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir ?? DEFAULT_MEMORY_DIR;
  }

  setMemoryDir(dir: string): void {
    this.memoryDir = dir;
  }

  /**
   * Load facts.md — the persistent fact store.
   * Returns null if not found.
   */
  async loadFacts(): Promise<string | null> {
    try {
      return await readFile(resolve(this.memoryDir, "facts.md"), "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Save or update facts.md.
   */
  async saveFacts(content: string): Promise<void> {
    await this.ensureDir();
    await writeFile(resolve(this.memoryDir, "facts.md"), content, "utf-8");
  }

  /**
   * Append a fact to facts.md.
   */
  async appendFact(fact: string): Promise<void> {
    await this.ensureDir();
    const factsPath = resolve(this.memoryDir, "facts.md");

    const timestamp = new Date().toISOString().slice(0, 10);
    const entry = `\n- [${timestamp}] ${fact}`;

    try {
      await stat(factsPath);
      await appendFile(factsPath, entry, "utf-8");
    } catch {
      // Create new facts.md
      await writeFile(
        factsPath,
        `# Persistent Facts\n\nThis file contains curated facts that persist across sessions.\n${entry}`,
        "utf-8"
      );
    }
  }

  /**
   * Log a conversation to today's daily log.
   */
  async logConversation(
    prompt: string,
    response: string,
    sessionId: string
  ): Promise<void> {
    await this.ensureDir();

    const today = new Date().toISOString().slice(0, 10);
    const logPath = resolve(this.memoryDir, `${today}.md`);

    const timestamp = new Date().toISOString();
    const entry = `
## Session ${sessionId} — ${timestamp}

**Prompt:** ${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}

**Response:** ${response.slice(0, 500)}${response.length > 500 ? "..." : ""}

---
`;

    try {
      await stat(logPath);
      await appendFile(logPath, entry, "utf-8");
    } catch {
      await writeFile(logPath, `# Daily Log — ${today}\n${entry}`, "utf-8");
    }

    // Update index
    await this.updateIndex(today, prompt, sessionId);
  }

  /**
   * Search memory for a keyword.
   * Returns relevant lines from facts.md + daily logs.
   */
  async search(query: string): Promise<string> {
    const results: string[] = [];
    const lowerQuery = query.toLowerCase();

    // Search facts.md
    try {
      const facts = await readFile(
        resolve(this.memoryDir, "facts.md"),
        "utf-8"
      );
      const matchingLines = facts
        .split("\n")
        .filter((l) => l.toLowerCase().includes(lowerQuery))
        .slice(0, 10);

      if (matchingLines.length > 0) {
        results.push("**From facts.md:**\n" + matchingLines.join("\n"));
      }
    } catch {
      // No facts file
    }

    // Search recent daily logs (last 7 days)
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      const logPath = resolve(this.memoryDir, `${dateStr}.md`);

      try {
        const log = await readFile(logPath, "utf-8");
        const matchingLines = log
          .split("\n")
          .filter((l) => l.toLowerCase().includes(lowerQuery))
          .slice(0, 5);

        if (matchingLines.length > 0) {
          results.push(`**From ${dateStr}.md:**\n` + matchingLines.join("\n"));
        }
      } catch {
        // No log for this day
      }
    }

    if (results.length === 0) {
      return `No memory found for query: "${query}"`;
    }

    return results.join("\n\n");
  }

  /**
   * Load the memory index.
   */
  async loadIndex(): Promise<string | null> {
    try {
      return await readFile(resolve(this.memoryDir, "index.md"), "utf-8");
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async ensureDir(): Promise<void> {
    await mkdir(resolve(this.memoryDir), { recursive: true });
  }

  private async updateIndex(
    date: string,
    prompt: string,
    sessionId: string
  ): Promise<void> {
    const indexPath = resolve(this.memoryDir, "index.md");
    const entry = `- [${date}] Session ${sessionId}: ${prompt.slice(0, 80)}...\n`;

    try {
      await stat(indexPath);
      await appendFile(indexPath, entry, "utf-8");
    } catch {
      await writeFile(
        indexPath,
        `# Memory Index\n\nSearchable index of all conversations.\n\n${entry}`,
        "utf-8"
      );
    }
  }
}

// Singleton
export const memoryManager = new MemoryManager();
