/**
 * Memory manager — pure Markdown memory store.
 *
 * Design philosophy (AIMastermind):
 * "Pure Markdown files — no vector DBs, no PostgreSQL"
 *
 * Files:
 * - memory/facts.md     : Curated persistent facts about the user/project
 * - memory/lessons.md   : Short lessons learned from past mistakes (tag-indexed)
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

    // Search lessons.md
    const lessons = await this.loadLessons();
    const lessonMatches = lessons.filter((l) => {
      const hay = (l.content + " " + l.tags.join(" ")).toLowerCase();
      return hay.includes(lowerQuery);
    });
    if (lessonMatches.length > 0) {
      const rendered = lessonMatches
        .slice(0, 10)
        .map((l) => {
          const tagStr = l.tags.length ? ` [${l.tags.join(", ")}]` : "";
          return `- ${l.date}${tagStr}: ${l.content}`;
        })
        .join("\n");
      results.push("**From lessons.md:**\n" + rendered);
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
   * Load lessons as structured entries from lessons.md.
   * Each entry: { date, tags, content }.
   */
  async loadLessons(): Promise<Lesson[]> {
    const path = resolve(this.memoryDir, "lessons.md");
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return [];
    }
    return parseLessons(raw);
  }

  /**
   * Append a lesson to lessons.md. Creates the file if missing.
   */
  async appendLesson(content: string, tags: string[] = []): Promise<void> {
    await this.ensureDir();
    const path = resolve(this.memoryDir, "lessons.md");
    const date = new Date().toISOString().slice(0, 10);
    const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    const entry = `\n## ${date}${tagStr}\n${content.trim()}\n`;

    try {
      await stat(path);
      await appendFile(path, entry, "utf-8");
    } catch {
      await writeFile(
        path,
        `# Lessons Learned\n\nShort, dated notes the agent writes after mistakes or non-obvious wins.\n${entry}`,
        "utf-8"
      );
    }
  }

  /**
   * Overwrite lessons.md atomically, backing up the original to lessons.md.bak.
   * Used by the `memory prune` CLI command.
   */
  async writeLessons(content: string): Promise<void> {
    await this.ensureDir();
    const path = resolve(this.memoryDir, "lessons.md");
    try {
      const original = await readFile(path, "utf-8");
      await writeFile(resolve(this.memoryDir, "lessons.md.bak"), original, "utf-8");
    } catch {
      // No original to back up
    }
    await writeFile(path, content, "utf-8");
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

// ---------------------------------------------------------------------------
// Lessons types + parser
// ---------------------------------------------------------------------------

export interface Lesson {
  date: string;
  tags: string[];
  content: string;
}

/**
 * Parse lessons.md into structured entries.
 * Expected format per entry:
 *   ## YYYY-MM-DD [tag1, tag2]
 *   lesson body (one or more lines)
 */
function parseLessons(raw: string): Lesson[] {
  const lessons: Lesson[] = [];
  const lines = raw.split("\n");
  let current: Lesson | null = null;

  const headerRe = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s*\[([^\]]*)\])?\s*$/;

  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      if (current) lessons.push(finalizeLesson(current));
      current = {
        date: m[1],
        tags: m[2]
          ? m[2].split(",").map((t) => t.trim()).filter(Boolean)
          : [],
        content: "",
      };
      continue;
    }
    if (current) {
      current.content += (current.content ? "\n" : "") + line;
    }
  }
  if (current) lessons.push(finalizeLesson(current));
  return lessons;
}

function finalizeLesson(l: Lesson): Lesson {
  return { ...l, content: l.content.trim() };
}
