/**
 * Docker sandbox manager.
 *
 * Provides isolated execution environments for untrusted sessions.
 * When sandbox mode is enabled, bash tool commands run inside a Docker
 * container rather than on the host.
 *
 * Design:
 * - Container is created once per session, reused for all bash calls
 * - Working directory is bind-mounted from host
 * - No network access by default (configurable)
 * - Container is destroyed when session ends
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface SandboxConfig {
  enabled: boolean;
  image: string;
  /** Mount points: { hostPath: containerPath } */
  mounts: Record<string, string>;
  /** Allow network inside container */
  network: boolean;
  /** Memory limit, e.g. "512m" */
  memory_limit?: string;
  /** CPU limit, e.g. "0.5" */
  cpu_limit?: string;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  image: "node:20-alpine",
  mounts: {},
  network: false,
  memory_limit: "512m",
  cpu_limit: "1.0",
};

export class SandboxManager {
  private containers: Map<string, string> = new Map(); // sessionId → containerId

  /**
   * Check if Docker is available on this system.
   */
  async isDockerAvailable(): Promise<boolean> {
    try {
      await execAsync("docker --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a sandbox container for a session.
   * Returns the container ID.
   */
  async createContainer(
    sessionId: string,
    config: SandboxConfig,
    workDir: string
  ): Promise<string> {
    const existing = this.containers.get(sessionId);
    if (existing) return existing;

    const mountArgs = Object.entries(config.mounts)
      .concat([[workDir, "/workspace"]])
      .map(([host, container]) => `-v "${host}:${container}"`)
      .join(" ");

    const networkArg = config.network ? "" : "--network none";
    const memoryArg = config.memory_limit ? `--memory ${config.memory_limit}` : "";
    const cpuArg = config.cpu_limit ? `--cpus ${config.cpu_limit}` : "";

    const cmd = [
      "docker run -d --rm",
      networkArg,
      memoryArg,
      cpuArg,
      mountArgs,
      `-w /workspace`,
      `--name altimeter_${sessionId.slice(0, 8)}`,
      config.image,
      "tail -f /dev/null", // Keep container alive
    ]
      .filter(Boolean)
      .join(" ");

    try {
      const { stdout } = await execAsync(cmd);
      const containerId = stdout.trim();
      this.containers.set(sessionId, containerId);
      return containerId;
    } catch (e) {
      throw new Error(`Failed to create sandbox container: ${String(e)}`);
    }
  }

  /**
   * Execute a command inside the sandbox container.
   */
  async execInSandbox(
    sessionId: string,
    command: string,
    timeoutMs = 30000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const containerId = this.containers.get(sessionId);
    if (!containerId) {
      throw new Error(`No sandbox container for session ${sessionId}`);
    }

    try {
      const { stdout, stderr } = await execAsync(
        `docker exec ${containerId} sh -c ${JSON.stringify(command)}`,
        { timeout: timeoutMs }
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(e),
        exitCode: err.code ?? 1,
      };
    }
  }

  /**
   * Stop and remove the sandbox container for a session.
   */
  async destroyContainer(sessionId: string): Promise<void> {
    const containerId = this.containers.get(sessionId);
    if (!containerId) return;

    try {
      await execAsync(`docker stop ${containerId}`);
    } catch {
      // Container may already be stopped
    }

    this.containers.delete(sessionId);
  }

  /**
   * Destroy all containers (cleanup on shutdown).
   */
  async destroyAll(): Promise<void> {
    for (const sessionId of this.containers.keys()) {
      await this.destroyContainer(sessionId);
    }
  }
}

export const sandboxManager = new SandboxManager();
