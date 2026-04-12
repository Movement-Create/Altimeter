/**
 * Tests for the csv_write tool.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { csvWriteTool } from "../src/tools/csv-write.js";
import type { ToolExecutionContext } from "../src/tools/base.js";

let testDir: string;

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    session: {
      id: "test",
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
  testDir = join(tmpdir(), `altimeter-csv-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("csvWriteTool", () => {
  it("creates a simple CSV file", async () => {
    const ctx = makeContext();
    const result = await csvWriteTool.execute(
      {
        output_path: "simple.csv",
        headers: ["Name", "Age", "City"],
        rows: [
          ["Alice", 30, "NYC"],
          ["Bob", 25, "LA"],
        ],
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("Created CSV");

    const content = await readFile(join(testDir, "simple.csv"), "utf-8");
    expect(content).toBe("Name,Age,City\nAlice,30,NYC\nBob,25,LA\n");
  });

  it("escapes fields with commas", async () => {
    const ctx = makeContext();
    await csvWriteTool.execute(
      {
        output_path: "commas.csv",
        headers: ["Name", "Address"],
        rows: [["Alice", "123 Main St, Apt 4"]],
      },
      ctx
    );

    const content = await readFile(join(testDir, "commas.csv"), "utf-8");
    expect(content).toContain('"123 Main St, Apt 4"');
  });

  it("escapes fields with double quotes", async () => {
    const ctx = makeContext();
    await csvWriteTool.execute(
      {
        output_path: "quotes.csv",
        headers: ["Name", "Quote"],
        rows: [["Alice", 'She said "hello"']],
      },
      ctx
    );

    const content = await readFile(join(testDir, "quotes.csv"), "utf-8");
    expect(content).toContain('"She said ""hello"""');
  });

  it("escapes fields with newlines", async () => {
    const ctx = makeContext();
    await csvWriteTool.execute(
      {
        output_path: "newlines.csv",
        headers: ["Name", "Bio"],
        rows: [["Alice", "Line 1\nLine 2"]],
      },
      ctx
    );

    const content = await readFile(join(testDir, "newlines.csv"), "utf-8");
    expect(content).toContain('"Line 1\nLine 2"');
  });

  it("handles null values", async () => {
    const ctx = makeContext();
    await csvWriteTool.execute(
      {
        output_path: "nulls.csv",
        headers: ["Name", "Value"],
        rows: [["Alice", null]],
      },
      ctx
    );

    const content = await readFile(join(testDir, "nulls.csv"), "utf-8");
    expect(content).toBe("Name,Value\nAlice,\n");
  });

  it("handles boolean values", async () => {
    const ctx = makeContext();
    await csvWriteTool.execute(
      {
        output_path: "bools.csv",
        headers: ["Name", "Active"],
        rows: [["Alice", true], ["Bob", false]],
      },
      ctx
    );

    const content = await readFile(join(testDir, "bools.csv"), "utf-8");
    expect(content).toContain("true");
    expect(content).toContain("false");
  });

  it("creates parent directories", async () => {
    const ctx = makeContext();
    const result = await csvWriteTool.execute(
      {
        output_path: "subdir/nested/output.csv",
        headers: ["A"],
        rows: [["1"]],
      },
      ctx
    );
    expect(result.is_error).toBe(false);
  });

  it("returns plan mode description", async () => {
    const ctx = makeContext({ plan_mode: true });
    const result = await csvWriteTool.execute(
      {
        output_path: "plan.csv",
        headers: ["A"],
        rows: [["1"]],
      },
      ctx
    );
    expect(result.output).toContain("[PLAN MODE]");
  });
});
