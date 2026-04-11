/**
 * FileEdit tool — surgical string replacement in files.
 *
 * Design: LLMs tend to write entire files when editing, which is expensive
 * and error-prone for large files. This tool does exact-match string
 * replacement, which is more reliable and cheaper.
 *
 * Key behaviors:
 * - Fails if old_string not found (prevents silent mis-edits)
 * - Fails if old_string appears more than once (unless replace_all=true)
 * - Returns a unified diff for LLM confirmation
 *
 * Permission: "write"
 */

import { z } from "zod";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const FileEditInputSchema = z.object({
  path: z.string().describe("Path to the file to edit"),
  old_string: z.string().describe("Exact string to find and replace"),
  new_string: z.string().describe("String to replace it with"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace all occurrences (default: false, fail if multiple)"),
});

type FileEditInput = z.infer<typeof FileEditInputSchema>;

export const fileEditTool: Tool<FileEditInput> = {
  name: "file_edit",
  description:
    "Surgically replace a string in a file. More reliable than rewriting whole files. Fails if the old_string is not found or appears multiple times (use replace_all=true for the latter).",
  schema: FileEditInputSchema,
  permission_level: "write",

  async execute(input: FileEditInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    if (context.plan_mode) {
      return ok(
        `[PLAN MODE] Would edit ${input.path}: replace "${input.old_string.slice(0, 50)}..." with "${input.new_string.slice(0, 50)}..."`
      );
    }

    const absPath = resolve(context.cwd, input.path);

    let content: string;
    try {
      const buffer = await readFile(absPath);
      content = buffer.toString("utf-8");
    } catch {
      return err(`File not found: ${absPath}`);
    }

    // Count occurrences
    const occurrences = countOccurrences(content, input.old_string);

    if (occurrences === 0) {
      return err(
        `String not found in ${input.path}.\n\nLooking for:\n${input.old_string}\n\nMake sure the string matches exactly (including whitespace).`
      );
    }

    if (occurrences > 1 && !input.replace_all) {
      return err(
        `Found ${occurrences} occurrences of the string in ${input.path}. ` +
          `Set replace_all=true to replace all, or make old_string more specific.`
      );
    }

    // Apply replacement
    const newContent = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string);

    try {
      await writeFile(absPath, newContent, "utf-8");
    } catch (e) {
      return err(`Cannot write file ${absPath}: ${String(e)}`);
    }

    // Generate a compact diff summary
    const diff = makeDiff(input.old_string, input.new_string);
    const replacedCount = input.replace_all ? occurrences : 1;

    return ok(
      `Edited ${absPath} (${replacedCount} replacement${replacedCount > 1 ? "s" : ""})\n\n${diff}`
    );
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Produce a simplified diff showing removed/added lines.
 * Not a proper unified diff, but good enough for LLM context.
 */
function makeDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const removed = oldLines.map((l) => `- ${l}`).join("\n");
  const added = newLines.map((l) => `+ ${l}`).join("\n");

  const MAX = 20; // lines per side
  const removedDisplay =
    oldLines.length > MAX
      ? oldLines
          .slice(0, MAX)
          .map((l) => `- ${l}`)
          .join("\n") + `\n- ...[${oldLines.length - MAX} more lines]`
      : removed;

  const addedDisplay =
    newLines.length > MAX
      ? newLines
          .slice(0, MAX)
          .map((l) => `+ ${l}`)
          .join("\n") + `\n+ ...[${newLines.length - MAX} more lines]`
      : added;

  return `${removedDisplay}\n${addedDisplay}`;
}
