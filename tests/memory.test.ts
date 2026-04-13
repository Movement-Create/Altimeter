/**
 * Memory system tests — lessons CRUD, memory tools, relevance scoring.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { MemoryManager, memoryManager } from "../src/memory/manager.js";
import { memoryNoteTool } from "../src/tools/memory-note.js";
import { memoryRecallTool } from "../src/tools/memory-recall.js";
import type { ToolExecutionContext } from "../src/tools/base.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let testDir: string;

function makeContext(): ToolExecutionContext {
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
  };
}

beforeEach(async () => {
  testDir = join(tmpdir(), `altimeter-memory-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  // Point the singleton at a fresh per-test dir so the tools hit this fixture.
  memoryManager.setMemoryDir(testDir);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// MemoryManager.appendLesson / loadLessons
// ---------------------------------------------------------------------------

describe("MemoryManager lessons", () => {
  it("appends and parses a single lesson", async () => {
    const mm = new MemoryManager(testDir);
    await mm.appendLesson("Always run provider tests when editing openai.ts", [
      "provider",
      "openai",
    ]);

    const lessons = await mm.loadLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0].content).toBe(
      "Always run provider tests when editing openai.ts"
    );
    expect(lessons[0].tags).toEqual(["provider", "openai"]);
    expect(lessons[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("appends multiple lessons and parses them in order", async () => {
    const mm = new MemoryManager(testDir);
    await mm.appendLesson("lesson one", ["a"]);
    await mm.appendLesson("lesson two", ["b", "c"]);
    const lessons = await mm.loadLessons();
    expect(lessons).toHaveLength(2);
    expect(lessons[0].content).toBe("lesson one");
    expect(lessons[1].content).toBe("lesson two");
    expect(lessons[1].tags).toEqual(["b", "c"]);
  });

  it("returns empty array when lessons.md is missing", async () => {
    const mm = new MemoryManager(testDir);
    expect(await mm.loadLessons()).toEqual([]);
  });

  it("writeLessons creates a .bak of the original", async () => {
    const mm = new MemoryManager(testDir);
    await mm.appendLesson("original", []);
    await mm.writeLessons("# Lessons Learned\n\n## 2026-01-01\nreplaced\n");
    const bak = await readFile(join(testDir, "lessons.md.bak"), "utf-8");
    expect(bak).toContain("original");
    const current = await readFile(join(testDir, "lessons.md"), "utf-8");
    expect(current).toContain("replaced");
  });
});

// ---------------------------------------------------------------------------
// memory_note tool
// ---------------------------------------------------------------------------

describe("memory_note tool", () => {
  it("writes a lesson by default", async () => {
    const result = await memoryNoteTool.execute(
      { content: "use pnpm not npm", tags: ["pnpm"] },
      makeContext()
    );
    expect(result.is_error).toBe(false);

    const lessons = await memoryManager.loadLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0].content).toBe("use pnpm not npm");
    expect(lessons[0].tags).toEqual(["pnpm"]);
  });

  it("writes a fact when kind='fact'", async () => {
    const result = await memoryNoteTool.execute(
      { content: "project uses TypeScript ESM", kind: "fact" },
      makeContext()
    );
    expect(result.is_error).toBe(false);

    const facts = await memoryManager.loadFacts();
    expect(facts).toContain("project uses TypeScript ESM");
  });
});

// ---------------------------------------------------------------------------
// memory_recall tool
// ---------------------------------------------------------------------------

describe("memory_recall tool", () => {
  it("finds a lesson by keyword", async () => {
    await memoryManager.appendLesson(
      "Integration tests must hit a real DB, not mocks",
      ["tests", "db"]
    );

    const result = await memoryRecallTool.execute(
      { query: "mocks" },
      makeContext()
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("real DB");
  });

  it("finds a lesson by tag", async () => {
    await memoryManager.appendLesson("Some specific lesson content", [
      "deployment",
    ]);

    const result = await memoryRecallTool.execute(
      { query: "deployment" },
      makeContext()
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain("Some specific lesson content");
  });

  it("returns a no-results message when nothing matches", async () => {
    const result = await memoryRecallTool.execute(
      { query: "zzz-nonexistent-zzz" },
      makeContext()
    );
    expect(result.is_error).toBe(false);
    expect(result.output.toLowerCase()).toContain("no memory found");
  });
});
