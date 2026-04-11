/**
 * Grep tool — search file contents with regex.
 *
 * Pure Node.js implementation. Returns matching lines with context.
 * Searches recursively by default (like ripgrep).
 *
 * Permission: "read"
 */

import { z } from "zod";
import { readFile, readdir, stat } from "fs/promises";
import { join, resolve, relative } from "path";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const MAX_MATCHES = 200;
const MAX_FILE_SIZE = 5_000_000; // 5MB

const GrepInputSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z
    .string()
    .optional()
    .describe("File or directory to search (default: session cwd)"),
  glob: z
    .string()
    .optional()
    .describe("File glob filter, e.g. '*.ts' (applied when path is a directory)"),
  ignore_case: z.boolean().optional().default(false),
  context: z
    .number()
    .optional()
    .default(2)
    .describe("Lines of context to show around each match"),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .default("content"),
  head_limit: z
    .number()
    .optional()
    .describe("Return only first N matches"),
});

type GrepInput = z.infer<typeof GrepInputSchema>;

export const grepTool: Tool<GrepInput> = {
  name: "grep",
  description:
    "Search file contents with a regex pattern. Returns matching lines with context. Searches recursively in directories.",
  schema: GrepInputSchema,
  permission_level: "read",

  async execute(input: GrepInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    const searchPath = resolve(context.cwd, input.path ?? ".");
    const flags = input.ignore_case ? "gi" : "g";
    let regex: RegExp;

    try {
      regex = new RegExp(input.pattern, flags);
    } catch (e) {
      return err(`Invalid regex pattern: ${input.pattern}\n${String(e)}`);
    }

    const maxMatches = input.head_limit ?? MAX_MATCHES;
    const matches: SearchMatch[] = [];

    try {
      await searchPath_inner(
        searchPath,
        searchPath,
        regex,
        input.glob ?? "**",
        matches,
        maxMatches
      );
    } catch (e) {
      return err(`Search error: ${String(e)}`);
    }

    if (matches.length === 0) {
      return ok(`No matches found for: ${input.pattern}`);
    }

    // Format output
    switch (input.output_mode) {
      case "files_with_matches": {
        const files = [...new Set(matches.map((m) => m.file))];
        return ok(files.join("\n"));
      }

      case "count": {
        const fileCounts = new Map<string, number>();
        for (const m of matches) {
          fileCounts.set(m.file, (fileCounts.get(m.file) ?? 0) + 1);
        }
        const lines = [...fileCounts.entries()]
          .map(([f, c]) => `${f}: ${c}`)
          .join("\n");
        return ok(`${matches.length} total matches\n\n${lines}`);
      }

      default: {
        // content mode: show lines with context
        const contextLines = input.context ?? 2;
        const output = formatMatches(matches, contextLines);
        const suffix =
          matches.length >= maxMatches
            ? `\n...[stopped at ${maxMatches} matches]`
            : "";
        return ok(output + suffix);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Internal types + helpers
// ---------------------------------------------------------------------------

interface SearchMatch {
  file: string;
  line_number: number;
  line: string;
  before: string[];
  after: string[];
}

async function searchPath_inner(
  rootPath: string,
  currentPath: string,
  regex: RegExp,
  glob: string,
  matches: SearchMatch[],
  maxMatches: number
): Promise<void> {
  if (matches.length >= maxMatches) return;

  let s;
  try {
    s = await stat(currentPath);
  } catch {
    return;
  }

  if (s.isFile()) {
    await searchFile(rootPath, currentPath, regex, matches, maxMatches);
    return;
  }

  if (!s.isDirectory()) return;

  // Skip common non-source directories
  const skipDirs = new Set(["node_modules", ".git", "dist", ".next", "__pycache__"]);

  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (matches.length >= maxMatches) break;
    if (skipDirs.has(entry.name)) continue;

    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await searchPath_inner(rootPath, fullPath, regex, glob, matches, maxMatches);
    } else if (entry.isFile()) {
      // Apply glob filter
      if (glob !== "**" && !matchesSimpleGlob(entry.name, glob)) continue;
      await searchFile(rootPath, fullPath, regex, matches, maxMatches);
    }
  }
}

async function searchFile(
  rootPath: string,
  filePath: string,
  regex: RegExp,
  matches: SearchMatch[],
  maxMatches: number
): Promise<void> {
  let content: string;
  try {
    const s = await stat(filePath);
    if (s.size > MAX_FILE_SIZE) return;
    const buffer = await readFile(filePath);
    content = buffer.toString("utf-8");
    if (content.includes("\x00")) return; // binary
  } catch {
    return;
  }

  const lines = content.split("\n");
  const relFile = relative(rootPath, filePath);

  regex.lastIndex = 0; // Reset global regex

  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= maxMatches) break;

    regex.lastIndex = 0;
    if (regex.test(lines[i])) {
      matches.push({
        file: relFile,
        line_number: i + 1,
        line: lines[i],
        before: lines.slice(Math.max(0, i - 2), i),
        after: lines.slice(i + 1, Math.min(lines.length, i + 3)),
      });
    }
  }
}

function formatMatches(matches: SearchMatch[], context: number): string {
  const groups: string[] = [];
  let lastFile = "";
  let lastLine = -1;

  for (const m of matches) {
    const header = m.file !== lastFile ? `\n${m.file}:\n` : "";
    lastFile = m.file;

    const separator = m.line_number > lastLine + 1 + context ? "--\n" : "";
    lastLine = m.line_number;

    const before = m.before
      .slice(-context)
      .map((l, i) => {
        const lineNo = m.line_number - m.before.length + i;
        return `${lineNo}:  ${l}`;
      })
      .join("\n");

    const matchLine = `${m.line_number}: \x1b[1m${m.line}\x1b[0m`; // bold match

    const after = m.after
      .slice(0, context)
      .map((l, i) => `${m.line_number + i + 1}:  ${l}`)
      .join("\n");

    const parts = [header, separator];
    if (before) parts.push(before);
    parts.push(matchLine);
    if (after) parts.push(after);

    groups.push(parts.filter(Boolean).join("\n"));
  }

  return groups.join("\n");
}

function matchesSimpleGlob(name: string, pattern: string): boolean {
  // Simple: only handle *.ext patterns
  if (pattern.startsWith("*.")) {
    return name.endsWith(pattern.slice(1));
  }
  return name === pattern || pattern === "**";
}
