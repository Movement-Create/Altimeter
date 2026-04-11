/**
 * Permission classifier.
 *
 * Design:
 * - Static classification for known tools (fast path)
 * - LLM-as-judge for unknown/dynamic tools (slow path, cached)
 * - Interactice permission prompts (for TTY sessions in default mode)
 *
 * Permission levels (ascending risk):
 * read < write < network < execute < agent
 */

import type { PermissionLevel } from "../core/types.js";

// Static permission table for built-in tools
const STATIC_PERMISSIONS: Record<string, PermissionLevel> = {
  file_read: "read",
  glob: "read",
  grep: "read",
  file_write: "write",
  file_edit: "write",
  todo_write: "write",
  web_fetch: "network",
  web_search: "network",
  bash: "execute",
  agent: "agent",
};

/**
 * Get the permission level for a tool by name.
 * Returns "execute" for unknown tools (safe default).
 */
export function getPermissionLevel(toolName: string): PermissionLevel {
  return STATIC_PERMISSIONS[toolName] ?? "execute";
}

/**
 * Check if a given permission level is within the allowed threshold.
 */
export function isPermissionAllowed(
  level: PermissionLevel,
  threshold: PermissionLevel
): boolean {
  const ranks: Record<PermissionLevel, number> = {
    read: 0,
    write: 1,
    network: 2,
    execute: 3,
    agent: 4,
  };

  return ranks[level] <= ranks[threshold];
}

/**
 * Create an interactive permission prompt for TTY sessions.
 * Returns a callback that asks the user via stdin.
 */
export function createInteractivePermissionCallback(): (
  toolName: string,
  level: PermissionLevel,
  description: string
) => Promise<boolean> {
  return async (toolName, level, description) => {
    // Only prompt in TTY environments
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return true; // Auto-allow in non-interactive mode
    }

    const { createInterface } = await import("readline");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      console.log(`\n[Permission Request]`);
      console.log(`Tool: ${toolName}`);
      console.log(`Level: ${level}`);
      console.log(`Description: ${description}`);

      rl.question("Allow this tool? [y/N] ", (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
      });
    });
  };
}

/**
 * Dangerous pattern detector — check if a bash command looks dangerous.
 * This is a heuristic, not a security boundary.
 */
export function detectDangerousCommand(command: string): {
  dangerous: boolean;
  reason?: string;
} {
  const dangerousPatterns: Array<[RegExp, string]> = [
    [/rm\s+-rf\s+\/(?:\s|$)/, "Recursive delete of root filesystem"],
    [/>\s*\/dev\/sd[a-z]/, "Direct write to disk device"],
    [/dd\s+.*if=.*of=\/dev\//, "dd to disk device"],
    [/mkfs/, "Filesystem format command"],
    [/:(){ :|:& };:/, "Fork bomb"],
    [/curl[^|]*\|\s*(bash|sh)/, "Curl pipe to shell (potential code execution)"],
    [/wget[^|]*\|\s*(bash|sh)/, "Wget pipe to shell"],
    [/eval\s+\$\(/, "Eval command substitution"],
    [/chmod\s+777\s+\//, "World-writable permissions on root"],
  ];

  for (const [pattern, reason] of dangerousPatterns) {
    if (pattern.test(command)) {
      return { dangerous: true, reason };
    }
  }

  return { dangerous: false };
}
