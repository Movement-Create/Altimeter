/**
 * Bash tool — execute shell commands.
 *
 * Security: This is the highest-risk tool. It requires "execute" permission.
 * In plan mode, commands are logged but not executed.
 * Timeout is enforced to prevent runaway processes.
 *
 * Design: We capture stdout+stderr as a combined stream, capped to MAX_OUTPUT
 * characters to avoid blowing the context window.
 */

import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const execAsync = promisify(exec);

const MAX_OUTPUT = 50_000; // characters
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

const BashInputSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout_ms: z
    .number()
    .optional()
    .default(DEFAULT_TIMEOUT_MS)
    .describe("Timeout in milliseconds (default 30s)"),
  cwd: z
    .string()
    .optional()
    .describe("Working directory override (default: session cwd)"),
});

type BashInput = z.infer<typeof BashInputSchema>;

export const bashTool: Tool<BashInput> = {
  name: "bash",
  description:
    "Execute a shell command and return stdout+stderr. Use for running scripts, build tools, tests, package managers, etc.",
  schema: BashInputSchema,
  permission_level: "execute",

  async execute(input: BashInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    if (context.plan_mode) {
      return ok(`[PLAN MODE] Would execute: ${input.command}`);
    }

    const cwd = input.cwd ?? context.cwd;
    const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    try {
      const { stdout, stderr } = await execAsync(input.command, {
        cwd,
        timeout,
        env: { ...process.env, ...context.env },
        maxBuffer: MAX_OUTPUT * 2, // bytes
      });

      let output = "";
      if (stdout.trim()) output += stdout;
      if (stderr.trim()) output += (output ? "\n[stderr]\n" : "") + stderr;

      if (!output.trim()) output = "(command produced no output)";

      // Truncate if too large
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + `\n...[truncated, ${output.length - MAX_OUTPUT} chars omitted]`;
      }

      return ok(output);
    } catch (e: unknown) {
      const error = e as { code?: number; stdout?: string; stderr?: string; message?: string };

      // Non-zero exit code: still return output + error message
      let output = "";
      if (error.stdout?.trim()) output += error.stdout;
      if (error.stderr?.trim())
        output += (output ? "\n[stderr]\n" : "") + error.stderr;

      const msg = error.message ?? String(e);
      output += (output ? "\n" : "") + `Exit code: ${error.code ?? "unknown"}\n${msg}`;

      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + "\n...[truncated]";
      }

      return err(output);
    }
  },
};
