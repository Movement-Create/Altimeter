/**
 * FileRead tool — read files from disk.
 *
 * Supports:
 * - Plain text files (with optional line range)
 * - Binary file detection (reports type, won't try to read)
 * - Directory listing (if path is a directory)
 *
 * Permission: "read" (lowest risk)
 */

import { z } from "zod";
import { readFile, stat, readdir } from "fs/promises";
import { join, resolve } from "path";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const MAX_FILE_SIZE = 1_000_000; // 1MB text limit
const MAX_OUTPUT = 50_000; // chars

const FileReadInputSchema = z.object({
  path: z.string().describe("Absolute or relative path to file or directory"),
  offset: z
    .number()
    .optional()
    .describe("Line number to start reading from (1-indexed)"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of lines to read"),
});

type FileReadInput = z.infer<typeof FileReadInputSchema>;

export const fileReadTool: Tool<FileReadInput> = {
  name: "file_read",
  description:
    "Read a file's contents, or list a directory. Supports line offset/limit for large files.",
  schema: FileReadInputSchema,
  permission_level: "read",

  async execute(input: FileReadInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    const absPath = resolve(context.cwd, input.path);

    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return err(`File not found: ${absPath}`);
    }

    // Directory listing
    if (stats.isDirectory()) {
      try {
        const entries = await readdir(absPath, { withFileTypes: true });
        const listing = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
        return ok(`Directory: ${absPath}\n\n${listing || "(empty)"}`);
      } catch (e) {
        return err(`Cannot read directory: ${String(e)}`);
      }
    }

    // File size check
    if (stats.size > MAX_FILE_SIZE) {
      return err(
        `File too large: ${stats.size} bytes (limit ${MAX_FILE_SIZE}). Use offset/limit to read in chunks.`
      );
    }

    // Detect binary
    const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
    const binaryExts = new Set([
      "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp",
      "mp3", "mp4", "wav", "ogg", "flac",
      "zip", "tar", "gz", "bz2", "xz",
      "exe", "dll", "so", "dylib",
      "pdf", "doc", "docx", "xls", "xlsx",
    ]);

    if (binaryExts.has(ext)) {
      return ok(
        `Binary file: ${absPath}\nSize: ${stats.size} bytes\nType: .${ext}\n(Binary content not displayed)`
      );
    }

    // Read text
    let content: string;
    try {
      const buffer = await readFile(absPath);
      content = buffer.toString("utf-8");

      // Quick binary check via null bytes
      if (content.includes("\x00")) {
        return ok(`Binary file detected: ${absPath}\nSize: ${stats.size} bytes`);
      }
    } catch (e) {
      return err(`Cannot read file: ${String(e)}`);
    }

    // Apply line offset/limit
    if (input.offset !== undefined || input.limit !== undefined) {
      const lines = content.split("\n");
      const start = (input.offset ?? 1) - 1; // convert to 0-indexed
      const end = input.limit !== undefined ? start + input.limit : lines.length;
      const slice = lines.slice(Math.max(0, start), end);
      content = slice.join("\n");
    }

    // Truncate
    if (content.length > MAX_OUTPUT) {
      content =
        content.slice(0, MAX_OUTPUT) +
        `\n...[file truncated at ${MAX_OUTPUT} chars, total ${stats.size} bytes]`;
    }

    return ok(content);
  },
};
