/**
 * Tests for the code_run tool.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdir, rm, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { codeRunTool } from "../src/tools/code-run.js";
import type { ToolExecutionContext } from "../src/tools/base.js";

let testDir: string;

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    session: {
      id: "test-session",
      created_at: new Date().toISOString(),
      model: "test",
      provider: "test",
      allowed_tools: [],
      disallowed_tools: [],
      permission_mode: "auto",
      effort: "medium",
      max_turns: 10,
      max_budget_usd: 1.0,
      file_path: "/tmp/test.jsonl",
    },
    cwd: testDir,
    env: {},
    plan_mode: false,
    ...overrides,
  };
}

beforeAll(async () => {
  testDir = join(tmpdir(), `altimeter-coderun-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("codeRunTool", () => {
  it("executes a bash script and captures output", async () => {
    const ctx = makeContext();
    const result = await codeRunTool.execute(
      {
        language: "bash",
        code: 'echo "hello from bash"',
        timeout_ms: 60000,
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.stdout).toContain("hello from bash");
    expect(parsed.exit_code).toBe(0);
  });

  it("executes a node script", async () => {
    const ctx = makeContext();
    const result = await codeRunTool.execute(
      {
        language: "node",
        code: 'console.log("hello from node");',
        timeout_ms: 60000,
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.stdout).toContain("hello from node");
    expect(parsed.exit_code).toBe(0);
  });

  it("executes a python script", async () => {
    const ctx = makeContext();
    const result = await codeRunTool.execute(
      {
        language: "python",
        code: 'print("hello from python")',
        timeout_ms: 60000,
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.stdout).toContain("hello from python");
    expect(parsed.exit_code).toBe(0);
  });

  it("captures stderr and non-zero exit code", async () => {
    const ctx = makeContext();
    const result = await codeRunTool.execute(
      {
        language: "bash",
        code: 'echo "error output" >&2; exit 1',
        timeout_ms: 60000,
      },
      ctx
    );
    expect(result.is_error).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.stderr).toContain("error output");
    expect(parsed.exit_code).toBe(1);
  });

  it("uses a custom filename", async () => {
    const ctx = makeContext();
    const result = await codeRunTool.execute(
      {
        language: "bash",
        code: 'echo "custom"',
        filename: "my-script.sh",
        timeout_ms: 60000,
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.script_path).toContain("my-script.sh");
  });

  it("detects generated files", async () => {
    const ctx = makeContext();
    const result = await codeRunTool.execute(
      {
        language: "bash",
        code: 'echo "data" > "$( dirname "$0" )/output.txt"',
        timeout_ms: 60000,
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.generated_files).toContain("output.txt");
  });

  it("returns plan mode description", async () => {
    const ctx = makeContext({ plan_mode: true });
    const result = await codeRunTool.execute(
      {
        language: "python",
        code: 'print("test")',
        timeout_ms: 60000,
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("[PLAN MODE]");
    expect(result.output).toContain("python");
  });

  it("creates scripts directory automatically", async () => {
    const ctx = makeContext();
    await codeRunTool.execute(
      {
        language: "bash",
        code: 'echo "dir test"',
        timeout_ms: 60000,
      },
      ctx
    );
    const scriptsDir = join(testDir, "sessions", "test-session", "scripts");
    const files = await readdir(scriptsDir);
    expect(files.length).toBeGreaterThan(0);
  });
});
