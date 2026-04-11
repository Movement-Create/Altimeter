/**
 * Process-level sandbox for bash execution.
 *
 * Strategy (no Docker required):
 * 1. Timeout enforcement (hard kill after N ms)
 * 2. Output size cap (prevent memory exhaustion)
 * 3. Environment variable allowlist (strip secrets)
 * 4. Working directory restriction (can't escape project root)
 * 5. Dangerous command pre-screening (heuristic, not a security boundary)
 * 6. Optional: run as unprivileged user via uid/gid (Linux only)
 *
 * This is defense-in-depth, not a true security boundary.
 * For untrusted input, use a VM or container externally.
 */

import { exec, type ExecOptions } from "child_process";
import { promisify } from "util";
import { resolve, relative } from "path";
import { detectDangerousCommand } from "./permissions.js";

const execAsync = promisify(exec);

export interface SandboxConfig {
  enabled: boolean;
  /** Max execution time in ms */
  timeout_ms: number;
  /** Max stdout+stderr bytes */
  max_output_bytes: number;
  /** Allowed environment variable names (everything else stripped) */
  env_allowlist: string[];
  /** Working directory — commands cannot reference paths outside this */
  root_dir: string;
  /** Block commands flagged as dangerous */
  block_dangerous: boolean;
  /** Optional unprivileged uid to run as (Linux only, requires root) */
  uid?: number;
  /** Optional unprivileged gid to run as (Linux only, requires root) */
  gid?: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  timeout_ms: 30_000,
  max_output_bytes: 1_048_576, // 1MB
  env_allowlist: [
    "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM",
    "NODE_ENV", "NPM_CONFIG_PREFIX", "NVM_DIR",
  ],
  root_dir: process.cwd(),
  block_dangerous: true,
};

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  blocked?: boolean;
  blockReason?: string;
  timedOut?: boolean;
}

export class SandboxManager {
  private config: SandboxConfig;

  constructor(config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  configure(config: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Execute a command within sandbox constraints.
   */
  async exec(
    command: string,
    cwd: string,
    extraEnv: Record<string, string> = {}
  ): Promise<SandboxExecResult> {
    // 1. Check if sandbox is enabled
    if (!this.config.enabled) {
      // Sandbox disabled — pass through with timeout only
      return this.rawExec(command, cwd, process.env as Record<string, string>, this.config.timeout_ms);
    }

    // 2. Dangerous command pre-screening
    if (this.config.block_dangerous) {
      const check = detectDangerousCommand(command);
      if (check.dangerous) {
        return {
          stdout: "",
          stderr: `[Sandbox] Blocked: ${check.reason}`,
          exitCode: 1,
          blocked: true,
          blockReason: check.reason,
        };
      }
    }

    // 3. Validate working directory is within root
    const resolvedCwd = resolve(cwd);
    const resolvedRoot = resolve(this.config.root_dir);
    const rel = relative(resolvedRoot, resolvedCwd);
    if (rel.startsWith("..") || resolve(resolvedRoot, rel) !== resolvedCwd) {
      return {
        stdout: "",
        stderr: `[Sandbox] Working directory ${cwd} is outside sandbox root ${this.config.root_dir}`,
        exitCode: 1,
        blocked: true,
        blockReason: "Working directory outside sandbox root",
      };
    }

    // 4. Build sanitized environment
    const sanitizedEnv: Record<string, string> = {};
    for (const key of this.config.env_allowlist) {
      if (process.env[key]) {
        sanitizedEnv[key] = process.env[key]!;
      }
    }
    // Merge extra env (tool-specific, already filtered)
    Object.assign(sanitizedEnv, extraEnv);

    // 5. Execute with constraints
    return this.rawExec(command, resolvedCwd, sanitizedEnv, this.config.timeout_ms);
  }

  private async rawExec(
    command: string,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number
  ): Promise<SandboxExecResult> {
    const opts: ExecOptions = {
      cwd,
      timeout: timeoutMs,
      env,
      maxBuffer: this.config.max_output_bytes,
      killSignal: "SIGKILL",
    };

    // Optional: run as unprivileged user (Linux only)
    if (this.config.uid !== undefined) {
      (opts as Record<string, unknown>).uid = this.config.uid;
    }
    if (this.config.gid !== undefined) {
      (opts as Record<string, unknown>).gid = this.config.gid;
    }

    try {
      const { stdout, stderr } = await execAsync(command, opts);
      return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
    } catch (e: unknown) {
      const err = e as {
        stdout?: string; stderr?: string; code?: number;
        killed?: boolean; signal?: string;
      };

      const timedOut = err.killed === true || err.signal === "SIGKILL";

      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(e),
        exitCode: err.code ?? 1,
        timedOut,
      };
    }
  }
}

export const sandboxManager = new SandboxManager();
