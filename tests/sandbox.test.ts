/**
 * Process-level sandbox tests.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { SandboxManager } from "../src/security/sandbox.js";

describe("SandboxManager", () => {
  let sandbox: SandboxManager;

  beforeEach(() => {
    sandbox = new SandboxManager({
      enabled: true,
      timeout_ms: 5_000,
      max_output_bytes: 1024,
      block_dangerous: true,
      root_dir: process.cwd(),
      env_allowlist: ["PATH", "HOME"],
    });
  });

  it("executes simple commands", async () => {
    const result = await sandbox.exec("echo hello", process.cwd());
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("blocks dangerous commands", async () => {
    const result = await sandbox.exec("rm -rf /", process.cwd());
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBeDefined();
  });

  it("blocks directory traversal", async () => {
    const result = await sandbox.exec("ls", "/tmp");
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain("outside sandbox root");
  });

  it("enforces timeout", async () => {
    const shortTimeout = new SandboxManager({
      enabled: true,
      timeout_ms: 100,
      max_output_bytes: 1024,
      block_dangerous: false,
      root_dir: process.cwd(),
      env_allowlist: ["PATH"],
    });
    const result = await shortTimeout.exec("sleep 10", process.cwd());
    expect(result.timedOut).toBe(true);
  });

  it("passes through when disabled", async () => {
    const disabled = new SandboxManager({ enabled: false });
    const result = await disabled.exec("echo pass", process.cwd());
    expect(result.stdout.trim()).toBe("pass");
  });
});
