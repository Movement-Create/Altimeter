/**
 * FileWrite tool — write/create files on disk.
 *
 * Creates parent directories as needed.
 * Permission: "write"
 *
 * Design note: We don't overwrite read-only files silently.
 * The create_dirs option defaults true so the LLM doesn't have to
 * separately create directories.
 */

import { z } from "zod";
import { writeFile, mkdir, access, constants } from "fs/promises";
import { dirname, resolve } from "path";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const FileWriteInputSchema = z.object({
  path: z.string().describe("Absolute or relative path to write"),
  content: z.string().describe("Content to write to the file"),
  create_dirs: z
    .boolean()
    .optional()
    .default(true)
    .describe("Create parent directories if they don't exist (default true)"),
  append: z
    .boolean()
    .optional()
    .default(false)
    .describe("Append to existing file instead of overwriting (default false)"),
});

type FileWriteInput = z.infer<typeof FileWriteInputSchema>;

export const fileWriteTool: Tool<FileWriteInput> = {
  name: "file_write",
  description:
    "Write content to a file. Creates parent directories automatically. Can append to existing files.",
  schema: FileWriteInputSchema,
  permission_level: "write",

  async execute(input: FileWriteInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    if (context.plan_mode) {
      return ok(
        `[PLAN MODE] Would ${input.append ? "append to" : "write"} file: ${input.path}\n${input.content.length} bytes`
      );
    }

    const absPath = resolve(context.cwd, input.path);
    const dir = dirname(absPath);

    // Create parent directories
    if (input.create_dirs) {
      try {
        await mkdir(dir, { recursive: true });
      } catch (e) {
        return err(`Cannot create directory ${dir}: ${String(e)}`);
      }
    }

    // Check if dir exists when create_dirs=false
    if (!input.create_dirs) {
      try {
        await access(dir, constants.W_OK);
      } catch {
        return err(`Directory does not exist: ${dir}. Set create_dirs=true to create it.`);
      }
    }

    try {
      const flag = input.append ? "a" : "w";
      await writeFile(absPath, input.content, { encoding: "utf-8", flag });

      const action = input.append ? "Appended to" : "Wrote";
      return ok(
        `${action} ${absPath}\n${input.content.length} bytes written`
      );
    } catch (e) {
      return err(`Cannot write file ${absPath}: ${String(e)}`);
    }
  },
};
