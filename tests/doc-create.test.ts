/**
 * Tests for the doc_create tool.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdir, rm, stat, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { docCreateTool } from "../src/tools/doc-create.js";
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
  testDir = join(tmpdir(), `altimeter-doc-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("docCreateTool", () => {
  it("creates a PDF file that is non-empty", async () => {
    const ctx = makeContext();
    const result = await docCreateTool.execute(
      {
        format: "pdf",
        title: "Test Report",
        content: "# Introduction\n\nThis is a test document.\n\n## Section 1\n\nSome content here.\n\n- Item 1\n- Item 2\n",
        output_path: "test-report.pdf",
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("Created PDF");

    const fileStat = await stat(join(testDir, "test-report.pdf"));
    expect(fileStat.size).toBeGreaterThan(0);
  });

  it("creates a CSV document from content", async () => {
    const ctx = makeContext();
    const csvContent = "Name,Age\nAlice,30\nBob,25";
    const result = await docCreateTool.execute(
      {
        format: "csv",
        title: "People",
        content: csvContent,
        output_path: "people.csv",
      },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("Created CSV");

    const content = await readFile(join(testDir, "people.csv"), "utf-8");
    expect(content).toBe(csvContent);
  });

  it("creates parent directories for output", async () => {
    const ctx = makeContext();
    const result = await docCreateTool.execute(
      {
        format: "csv",
        title: "Nested",
        content: "data",
        output_path: "reports/2024/output.csv",
      },
      ctx
    );
    expect(result.is_error).toBe(false);
  });

  it("returns plan mode description", async () => {
    const ctx = makeContext({ plan_mode: true });
    const result = await docCreateTool.execute(
      {
        format: "pdf",
        title: "Test",
        content: "content",
        output_path: "test.pdf",
      },
      ctx
    );
    expect(result.output).toContain("[PLAN MODE]");
    expect(result.output).toContain("PDF");
  });

  it("handles markdown with code blocks", async () => {
    const ctx = makeContext();
    const result = await docCreateTool.execute(
      {
        format: "pdf",
        title: "Code Doc",
        content: "# Code Example\n\n```javascript\nconsole.log('hello');\n```\n\nEnd of doc.",
        output_path: "code-doc.pdf",
      },
      ctx
    );
    expect(result.is_error).toBe(false);

    const fileStat = await stat(join(testDir, "code-doc.pdf"));
    expect(fileStat.size).toBeGreaterThan(0);
  });
});
