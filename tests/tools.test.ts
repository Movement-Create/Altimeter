/**
 * Tool system tests.
 *
 * Tests individual tools + the registry permission system.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { fileReadTool } from "../src/tools/file-read.js";
import { fileWriteTool } from "../src/tools/file-write.js";
import { fileEditTool } from "../src/tools/file-edit.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { registry, ToolRegistry } from "../src/tools/registry.js";
import { getDefaultConfig } from "../src/config/loader.js";
import type { ToolExecutionContext } from "../src/tools/base.js";

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

let testDir: string;

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  const config = getDefaultConfig();
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
  testDir = join(tmpdir(), `altimeter-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });

  // Create test files
  await writeFile(join(testDir, "hello.ts"), 'export const greeting = "hello";\n');
  await writeFile(join(testDir, "world.ts"), 'export const world = "world";\n');
  await writeFile(join(testDir, "readme.md"), "# Test Project\n\nA test project.\n");
  await mkdir(join(testDir, "src"), { recursive: true });
  await writeFile(join(testDir, "src", "index.ts"), 'import { greeting } from "../hello.js";\nconsole.log(greeting);\n');
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// FileRead tests
// ---------------------------------------------------------------------------

describe("fileReadTool", () => {
  it("reads a file successfully", async () => {
    const ctx = makeContext();
    const result = await fileReadTool.execute({ path: "hello.ts" }, ctx);
    expect(result.is_error).toBe(false);
    expect(result.output).toContain('greeting = "hello"');
  });

  it("lists directory contents", async () => {
    const ctx = makeContext();
    const result = await fileReadTool.execute({ path: "." }, ctx);
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("hello.ts");
    expect(result.output).toContain("src/");
  });

  it("returns error for non-existent file", async () => {
    const ctx = makeContext();
    const result = await fileReadTool.execute({ path: "nonexistent.ts" }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("not found");
  });

  it("supports line offset and limit", async () => {
    const ctx = makeContext();
    // File has 2 lines: create a multi-line file
    await writeFile(join(testDir, "multiline.txt"), "line1\nline2\nline3\nline4\nline5\n");

    const result = await fileReadTool.execute(
      { path: "multiline.txt", offset: 2, limit: 2 },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("line2");
    expect(result.output).toContain("line3");
    expect(result.output).not.toContain("line1");
    expect(result.output).not.toContain("line5");
  });
});

// ---------------------------------------------------------------------------
// FileWrite tests
// ---------------------------------------------------------------------------

describe("fileWriteTool", () => {
  it("writes a new file", async () => {
    const ctx = makeContext();
    const result = await fileWriteTool.execute(
      { path: "new-file.txt", content: "Hello, World!", create_dirs: true, append: false },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("Wrote");

    // Verify content
    const readResult = await fileReadTool.execute({ path: "new-file.txt" }, ctx);
    expect(readResult.output).toContain("Hello, World!");
  });

  it("creates parent directories automatically", async () => {
    const ctx = makeContext();
    const result = await fileWriteTool.execute(
      { path: "deep/nested/dir/file.txt", content: "nested!", create_dirs: true, append: false },
      ctx
    );
    expect(result.is_error).toBe(false);
  });

  it("appends to existing file", async () => {
    const ctx = makeContext();
    await fileWriteTool.execute({ path: "append-test.txt", content: "line1\n", create_dirs: true, append: false }, ctx);
    const result = await fileWriteTool.execute(
      { path: "append-test.txt", content: "line2\n", create_dirs: true, append: true },
      ctx
    );
    expect(result.is_error).toBe(false);

    const read = await fileReadTool.execute({ path: "append-test.txt" }, ctx);
    expect(read.output).toContain("line1");
    expect(read.output).toContain("line2");
  });

  it("returns plan description in plan mode", async () => {
    const ctx = makeContext({ plan_mode: true });
    const result = await fileWriteTool.execute(
      { path: "test.txt", content: "content", create_dirs: true, append: false },
      ctx
    );
    expect(result.output).toContain("[PLAN MODE]");
    expect(result.is_error).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FileEdit tests
// ---------------------------------------------------------------------------

describe("fileEditTool", () => {
  it("replaces a string in a file", async () => {
    const ctx = makeContext();
    await fileWriteTool.execute(
      { path: "edit-test.ts", content: 'const x = "old value";\n', create_dirs: true, append: false },
      ctx
    );

    const result = await fileEditTool.execute(
      {
        path: "edit-test.ts",
        old_string: '"old value"',
        new_string: '"new value"',
        replace_all: false,
      },
      ctx
    );
    expect(result.is_error).toBe(false);

    const read = await fileReadTool.execute({ path: "edit-test.ts" }, ctx);
    expect(read.output).toContain('"new value"');
    expect(read.output).not.toContain('"old value"');
  });

  it("fails when old_string not found", async () => {
    const ctx = makeContext();
    const result = await fileEditTool.execute(
      {
        path: "hello.ts",
        old_string: "this string does not exist in the file",
        new_string: "replacement",
        replace_all: false,
      },
      ctx
    );
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("not found");
  });

  it("fails when multiple occurrences without replace_all", async () => {
    const ctx = makeContext();
    await fileWriteTool.execute(
      { path: "multi.ts", content: "const x = 1;\nconst x = 1;\n", create_dirs: true, append: false },
      ctx
    );

    const result = await fileEditTool.execute(
      { path: "multi.ts", old_string: "const x = 1;", new_string: "const y = 2;", replace_all: false },
      ctx
    );
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("occurrences");
  });

  it("replaces all with replace_all=true", async () => {
    const ctx = makeContext();
    await fileWriteTool.execute(
      { path: "multi2.ts", content: "const x = 1;\nconst x = 1;\n", create_dirs: true, append: false },
      ctx
    );

    const result = await fileEditTool.execute(
      {
        path: "multi2.ts",
        old_string: "const x = 1;",
        new_string: "const y = 2;",
        replace_all: true,
      },
      ctx
    );
    expect(result.is_error).toBe(false);

    const read = await fileReadTool.execute({ path: "multi2.ts" }, ctx);
    expect(read.output).not.toContain("const x = 1;");
  });
});

// ---------------------------------------------------------------------------
// Glob tests
// ---------------------------------------------------------------------------

describe("globTool", () => {
  it("finds TypeScript files", async () => {
    const ctx = makeContext();
    const result = await globTool.execute({ pattern: "*.ts", ignore: ["node_modules/**", ".git/**", "dist/**", "*.min.*"] }, ctx);
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("hello.ts");
    expect(result.output).toContain("world.ts");
    expect(result.output).not.toContain("readme.md");
  });

  it("finds files recursively with **", async () => {
    const ctx = makeContext();
    const result = await globTool.execute({ pattern: "**/*.ts", ignore: ["node_modules/**", ".git/**", "dist/**", "*.min.*"] }, ctx);
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("hello.ts");
    expect(result.output).toContain("index.ts"); // in src/
  });

  it("returns no matches message for non-matching pattern", async () => {
    const ctx = makeContext();
    const result = await globTool.execute({ pattern: "*.xyz", ignore: ["node_modules/**", ".git/**", "dist/**", "*.min.*"] }, ctx);
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("No files matched");
  });
});

// ---------------------------------------------------------------------------
// Grep tests
// ---------------------------------------------------------------------------

describe("grepTool", () => {
  it("finds pattern in files", async () => {
    const ctx = makeContext();
    const result = await grepTool.execute(
      { pattern: "greeting", path: testDir, ignore_case: false, context: 2, output_mode: "content" as const },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("hello.ts");
  });

  it("returns no matches for missing pattern", async () => {
    const ctx = makeContext();
    const result = await grepTool.execute(
      { pattern: "ZZZNOMATCH9999", path: testDir, ignore_case: false, context: 2, output_mode: "content" as const },
      ctx
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("No matches");
  });

  it("returns files_with_matches mode", async () => {
    const ctx = makeContext();
    const result = await grepTool.execute(
      { pattern: "const", path: testDir, ignore_case: false, context: 2, output_mode: "files_with_matches" as const },
      ctx
    );
    expect(result.is_error).toBe(false);
    // Should return file paths, not match content
  });

  it("handles invalid regex", async () => {
    const ctx = makeContext();
    const result = await grepTool.execute(
      { pattern: "[invalid(regex", path: testDir, ignore_case: false, context: 2, output_mode: "content" as const },
      ctx
    );
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("Invalid regex");
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry tests
// ---------------------------------------------------------------------------

describe("ToolRegistry", () => {
  it("lists all built-in tools", () => {
    const tools = registry.listTools();
    expect(tools).toContain("bash");
    expect(tools).toContain("file_read");
    expect(tools).toContain("file_write");
    expect(tools).toContain("file_edit");
    expect(tools).toContain("glob");
    expect(tools).toContain("grep");
    expect(tools).toContain("web_fetch");
    expect(tools).toContain("web_search");
    expect(tools).toContain("agent");
    expect(tools).toContain("todo_write");
    expect(tools).toContain("code_run");
    expect(tools).toContain("doc_create");
    expect(tools).toContain("spreadsheet_create");
    expect(tools).toContain("csv_write");
  });

  it("blocks tools in disallowed_tools", async () => {
    const ctx = makeContext();
    const session = {
      ...ctx.session,
      disallowed_tools: ["bash"],
    };

    const result = await registry.executeTool(
      "bash",
      { command: "echo test" },
      { ...ctx, session }
    );
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("not allowed");
  });

  it("blocks tools not in allowed_tools when allowed_tools is set", async () => {
    const ctx = makeContext();
    const session = {
      ...ctx.session,
      allowed_tools: ["file_read", "glob"],
      disallowed_tools: [],
    };

    const result = await registry.executeTool(
      "bash",
      { command: "echo test" },
      { ...ctx, session }
    );
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("not allowed");
  });

  it("returns error for unknown tool", async () => {
    const ctx = makeContext();
    const result = await registry.executeTool(
      "nonexistent_tool",
      {},
      ctx
    );
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("Unknown tool");
  });

  it("validates input with Zod schema", async () => {
    const ctx = makeContext();
    // bash requires { command: string }, pass missing input
    const result = await registry.executeTool(
      "bash",
      { notCommand: "invalid" }, // wrong field
      ctx
    );
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("Invalid input");
  });

  it("can register custom tools", () => {
    const testRegistry = new ToolRegistry();
    const customTool = {
      name: "custom_test",
      description: "A custom test tool",
      schema: { safeParse: () => ({ success: true, data: {} }) } as unknown as import("zod").ZodType<unknown>,
      permission_level: "read" as const,
      execute: async () => ({ output: "custom result", is_error: false }),
    };

    testRegistry.register(customTool);
    expect(testRegistry.listTools()).toContain("custom_test");
  });
});
