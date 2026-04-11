/**
 * Bash tool — execute shell commands via sandbox manager.
 *
 * Security: This is the highest-risk tool. It requires "execute" permission.
 * In plan mode, commands are logged but not executed.
 * All execution goes through the SandboxManager for defense-in-depth.
 */

import { z } from "zod";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";
import { sandboxManager } from "../security/sandbox.js";

const MAX_OUTPUT = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;

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

    const result = await sandboxManager.exec(input.command, cwd, context.env);

    if (result.blocked) {
      return err(`[Blocked] ${result.blockReason}`);
    }

    let output = "";
    if (result.stdout.trim()) output += result.stdout;
    if (result.stderr.trim()) output += (output ? "\n[stderr]\n" : "") + result.stderr;

    if (result.timedOut) {
      output += "\n[Timed out after " + (input.timeout_ms ?? DEFAULT_TIMEOUT_MS) + "ms]";
    }

    if (!output.trim()) output = "(command produced no output)";

    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + `\n...[truncated, ${output.length - MAX_OUTPUT} chars omitted]`;
    }

    if (result.exitCode !== 0) {
      output += `\nExit code: ${result.exitCode}`;
      return err(output);
    }

    return ok(output);
  },
};
