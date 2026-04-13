/**
 * memory_note — write a fact or lesson to persistent memory.
 *
 * Permission: "write"
 *
 * kind="lesson" (default) → appended to memory/lessons.md with date + tags.
 * kind="fact"             → appended to memory/facts.md as a bullet.
 */

import { z } from "zod";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";
import { memoryManager } from "../memory/manager.js";

const MemoryNoteInputSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe("The lesson or fact to remember. Keep it short and specific."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional tags for relevance scoring later (e.g. file names, tool names, topics)."),
  kind: z
    .enum(["lesson", "fact"])
    .optional()
    .describe("'lesson' (default) for mistakes-to-avoid, 'fact' for durable facts about the user/project."),
});

type MemoryNoteInput = z.infer<typeof MemoryNoteInputSchema>;

export const memoryNoteTool: Tool<MemoryNoteInput> = {
  name: "memory_note",
  description:
    "Write a note to persistent memory. Use kind='lesson' after making a mistake or discovering a non-obvious gotcha that future-you should know. Use kind='fact' for durable project/user facts.",
  schema: MemoryNoteInputSchema,
  permission_level: "write",

  async execute(
    input: MemoryNoteInput,
    _context: ToolExecutionContext
  ): Promise<ToolExecuteResult> {
    const kind = input.kind ?? "lesson";
    try {
      if (kind === "fact") {
        await memoryManager.appendFact(input.content);
        return ok(`Saved fact to facts.md.`);
      }
      await memoryManager.appendLesson(input.content, input.tags ?? []);
      const tagStr = input.tags && input.tags.length > 0
        ? ` [${input.tags.join(", ")}]`
        : "";
      return ok(`Saved lesson to lessons.md${tagStr}.`);
    } catch (e) {
      return err(`memory_note failed: ${String(e)}`);
    }
  },
};
