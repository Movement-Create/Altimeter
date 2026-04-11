/**
 * Tests for the spreadsheet_create tool.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdir, rm, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { spreadsheetCreateTool } from "../src/tools/spreadsheet-create.js";
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
  testDir = join(tmpdir(), `altimeter-xlsx-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("spreadsheetCreateTool", () => {
  it("creates an xlsx file with one sheet", async () => {
    const ctx = makeContext();
    const result = await spreadsheetCreateTool.execute(
      {
        output_path: "test.xlsx",
        sheets: [
          {
            name: "Sheet1",
            headers: ["Name", "Age", "City"],
            rows: [
              ["Alice", 30, "NYC"],
              ["Bob", 25, "LA"],
            ],
          },
        ],
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("Created spreadsheet");
    expect(result.output).toContain("1 sheet(s)");
    expect(result.output).toContain("2 data row(s)");

    const fileStat = await stat(join(testDir, "test.xlsx"));
    expect(fileStat.size).toBeGreaterThan(0);
  });

  it("creates an xlsx file with multiple sheets", async () => {
    const ctx = makeContext();
    const result = await spreadsheetCreateTool.execute(
      {
        output_path: "multi-sheet.xlsx",
        sheets: [
          {
            name: "Users",
            headers: ["Name", "Email"],
            rows: [["Alice", "alice@test.com"]],
          },
          {
            name: "Orders",
            headers: ["ID", "Amount"],
            rows: [
              [1, 99.99],
              [2, 49.50],
            ],
          },
        ],
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("2 sheet(s)");
    expect(result.output).toContain("3 data row(s)");
  });

  it("handles null values in rows", async () => {
    const ctx = makeContext();
    const result = await spreadsheetCreateTool.execute(
      {
        output_path: "nulls.xlsx",
        sheets: [
          {
            name: "Data",
            headers: ["A", "B"],
            rows: [[null, "value"], ["value", null]],
          },
        ],
      },
      ctx
    );
    expect(result.is_error).toBe(false);
  });

  it("handles boolean values", async () => {
    const ctx = makeContext();
    const result = await spreadsheetCreateTool.execute(
      {
        output_path: "bools.xlsx",
        sheets: [
          {
            name: "Data",
            headers: ["Name", "Active"],
            rows: [["Alice", true], ["Bob", false]],
          },
        ],
      },
      ctx
    );
    expect(result.is_error).toBe(false);
  });

  it("creates parent directories", async () => {
    const ctx = makeContext();
    const result = await spreadsheetCreateTool.execute(
      {
        output_path: "reports/q1/data.xlsx",
        sheets: [{ name: "Q1", headers: ["A"], rows: [["1"]] }],
      },
      ctx
    );
    expect(result.is_error).toBe(false);
  });

  it("returns plan mode description", async () => {
    const ctx = makeContext({ plan_mode: true });
    const result = await spreadsheetCreateTool.execute(
      {
        output_path: "plan.xlsx",
        sheets: [{ name: "S1", headers: ["A"], rows: [["1"]] }],
      },
      ctx
    );
    expect(result.output).toContain("[PLAN MODE]");
    expect(result.output).toContain("spreadsheet");
  });

  it("handles empty rows", async () => {
    const ctx = makeContext();
    const result = await spreadsheetCreateTool.execute(
      {
        output_path: "empty-rows.xlsx",
        sheets: [
          {
            name: "Empty",
            headers: ["Col1", "Col2"],
            rows: [],
          },
        ],
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("0 data row(s)");
  });
});
