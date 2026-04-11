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
  // Normalize: collapse whitespace
  const normalized = command.replace(/\s+/g, " ").trim();

  // Layer 1: Direct pattern matching
  const directPatterns: Array<[RegExp, string]> = [
    // Filesystem destruction
    [/rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+).*\//, "Forced recursive delete"],
    [/rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+).*\//, "Recursive delete from root-adjacent path"],
    [/>\s*\/dev\/sd[a-z]/, "Direct write to disk device"],
    [/dd\s+.*of=\/dev\//, "dd to disk device"],
    [/mkfs\./, "Filesystem format"],
    [/fdisk\s/, "Disk partition modification"],

    // Fork/resource bombs
    [/:\(\)\s*\{.*\|.*&\s*\}\s*;/, "Fork bomb"],
    [/while\s+true.*do.*done/, "Infinite loop (review manually)"],

    // Remote code execution
    [/curl\s[^|]*\|\s*(bash|sh|zsh|python|perl|ruby)/, "Curl pipe to interpreter"],
    [/wget\s[^|]*\|\s*(bash|sh|zsh|python|perl|ruby)/, "Wget pipe to interpreter"],
    [/curl\s[^|]*>\s*\/tmp\/[^;]*;\s*(bash|sh|chmod)/, "Download and execute pattern"],

    // Eval / injection
    [/eval\s+["'`$]/, "Eval with dynamic input"],
    [/\$\(.*\)\s*\|\s*(bash|sh)/, "Command substitution piped to shell"],

    // Credential / system compromise
    [/passwd\s/, "Password modification"],
    [/chmod\s+(0?777|a\+rwx)\s+\//, "World-writable permissions on system path"],
    [/chown\s+.*\/etc/, "Ownership change on system config"],

    // Network exfiltration indicators
    [/nc\s+-[a-zA-Z]*l[a-zA-Z]*\s/, "Netcat listener"],
    [/\/dev\/(tcp|udp)\//, "Bash network device"],
  ];

  for (const [pattern, reason] of directPatterns) {
    if (pattern.test(normalized)) {
      return { dangerous: true, reason };
    }
  }

  // Layer 2: Base64-encoded command detection
  const base64Exec = /echo\s+[A-Za-z0-9+/=]{8,}\s*\|\s*base64\s+-d\s*\|\s*(bash|sh)/;
  if (base64Exec.test(normalized)) {
    return { dangerous: true, reason: "Base64-encoded command execution" };
  }

  // Layer 3: Python/Node one-liner system calls
  const scriptExec = /python[23]?\s+-c\s+["'].*(?:os\.system|subprocess|exec|__import__).*["']/;
  if (scriptExec.test(normalized)) {
    return { dangerous: true, reason: "Script interpreter system call" };
  }

  const nodeExec = /node\s+-e\s+["'].*(?:child_process|exec|spawn).*["']/;
  if (nodeExec.test(normalized)) {
    return { dangerous: true, reason: "Node.js child_process execution" };
  }

  return { dangerous: false };
}
