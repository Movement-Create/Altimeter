/**
 * Glob tool — find files by pattern.
 *
 * Uses Node.js built-in glob (added in Node 22) with fallback to manual
 * recursive readdir for older Node versions.
 *
 * Examples:
 * - "**\/*.ts" — all TypeScript files recursively
 * - "src/**\/*.test.ts" — all test files under src/
 * - "*.md" — markdown files in current directory only
 *
 * Permission: "read"
 */

import { z } from "zod";
import { readdir, stat } from "fs/promises";
import { join, resolve, relative } from "path";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const MAX_RESULTS = 500;

const GlobInputSchema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. '**/*.ts' or 'src/*.json'"),
  path: z
    .string()
    .optional()
    .describe("Base directory to search in (default: session cwd)"),
  ignore: z
    .array(z.string())
    .optional()
    .default(["node_modules/**", ".git/**", "dist/**", "*.min.*"])
    .describe("Patterns to ignore"),
});

type GlobInput = z.infer<typeof GlobInputSchema>;

export const globTool: Tool<GlobInput> = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Returns a list of matching file paths.",
  schema: GlobInputSchema,
  permission_level: "read",

  async execute(input: GlobInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    const basePath = resolve(context.cwd, input.path ?? ".");
    const ignore = new Set(input.ignore ?? []);

    try {
      const matches = await globMatch(basePath, input.pattern, ignore);

      if (matches.length === 0) {
        return ok(`No files matched pattern: ${input.pattern}\nSearched in: ${basePath}`);
      }

      const limited = matches.slice(0, MAX_RESULTS);
      const lines = limited.map((f) => relative(basePath, f)).sort();

      let output = lines.join("\n");
      if (matches.length > MAX_RESULTS) {
        output += `\n...[${matches.length - MAX_RESULTS} more results omitted]`;
      }

      return ok(output);
    } catch (e) {
      return err(`Glob error: ${String(e)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Manual glob implementation (pure Node.js, no external deps)
// ---------------------------------------------------------------------------

async function globMatch(
  basePath: string,
  pattern: string,
  ignore: Set<string>
): Promise<string[]> {
  const regex = globToRegex(pattern);
  const ignoreRegexes = [...ignore].map((p) => globToRegex(p));

  const results: string[] = [];
  await walkDir(basePath, basePath, regex, ignoreRegexes, results);
  return results;
}

async function walkDir(
  rootPath: string,
  currentPath: string,
  pattern: RegExp,
  ignore: RegExp[],
  results: string[]
): Promise<void> {
  if (results.length >= MAX_RESULTS * 2) return;

  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentPath, entry.name);
    const relPath = relative(rootPath, fullPath);

    // Check ignore patterns
    if (ignore.some((rx) => rx.test(relPath) || rx.test(entry.name))) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkDir(rootPath, fullPath, pattern, ignore, results);
    } else if (entry.isFile()) {
      if (pattern.test(relPath) || pattern.test(entry.name)) {
        results.push(fullPath);
      }
    } else if (entry.isSymbolicLink()) {
      // Follow symlinks carefully
      try {
        const s = await stat(fullPath);
        if (s.isFile() && (pattern.test(relPath) || pattern.test(entry.name))) {
          results.push(fullPath);
        }
      } catch {
        // Broken symlink, skip
      }
    }
  }
}

/**
 * Convert a glob pattern to a RegExp.
 * Handles: *, **, ?, [chars], and path separators.
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*" && pattern[i + 1] === "*") {
      // ** matches any path segment
      regexStr += ".*";
      i += 2;
      if (pattern[i] === "/") i++; // consume trailing /
    } else if (ch === "*") {
      // * matches within a path segment (no /)
      regexStr += "[^/]*";
      i++;
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (ch === ".") {
      regexStr += "\\.";
      i++;
    } else if (ch === "/") {
      regexStr += "[/\\\\]";
      i++;
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        regexStr += "\\[";
        i++;
      } else {
        regexStr += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      regexStr += ch.replace(/[$()+.^{|}]/g, "\\$&");
      i++;
    }
  }

  return new RegExp(regexStr + "$", "i");
}
