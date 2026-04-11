/**
 * Memory index builder — maintains a searchable index of memory files.
 *
 * Runs periodically to rebuild index.md from all daily logs.
 * This is a maintenance utility, not used in the hot path.
 */

import { readFile, writeFile, readdir, stat } from "fs/promises";
import { join, resolve } from "path";

export async function rebuildMemoryIndex(memoryDir: string): Promise<void> {
  const dir = resolve(memoryDir);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const logFiles = entries
    .filter(
      (e) => e.isFile() && e.name.match(/^\d{4}-\d{2}-\d{2}\.md$/)
    )
    .sort((a, b) => b.name.localeCompare(a.name)); // newest first

  const indexLines: string[] = [
    "# Memory Index",
    "",
    "Auto-generated index of all conversation logs.",
    `Last rebuilt: ${new Date().toISOString()}`,
    "",
    "## Conversations",
    "",
  ];

  for (const entry of logFiles) {
    const filePath = join(dir, entry.name);
    try {
      const content = await readFile(filePath, "utf-8");
      const date = entry.name.replace(".md", "");

      // Extract session headers
      const sessionMatches = content.matchAll(
        /## Session (\S+) — (.+)\n\n\*\*Prompt:\*\* (.+)/g
      );

      for (const match of sessionMatches) {
        const [, sessionId, timestamp, prompt] = match;
        indexLines.push(
          `- [${date}] \`${sessionId.slice(0, 8)}\` ${prompt.slice(0, 80)}`
        );
      }
    } catch {
      // Skip unreadable files
    }
  }

  await writeFile(join(dir, "index.md"), indexLines.join("\n"), "utf-8");
}

/**
 * Extract key facts from a conversation and append to facts.md.
 * This is a heuristic: looks for sentences containing "remember", "always", "never", etc.
 */
export async function extractFacts(
  conversation: string,
  memoryDir: string
): Promise<string[]> {
  const factsKeywords = [
    "remember that",
    "always use",
    "never use",
    "my name is",
    "i prefer",
    "the project is",
    "the api key",
    "the database",
    "i work at",
    "important:",
    "note:",
  ];

  const lines = conversation.split(/[.!?]\s+/);
  const facts: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (factsKeywords.some((kw) => lower.includes(kw))) {
      facts.push(line.trim());
    }
  }

  return facts;
}
