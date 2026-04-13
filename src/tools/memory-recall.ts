/**
 * memory_recall — search persistent memory (facts + lessons + recent logs).
 *
 * Permission: "read"
 */

import { z } from "zod";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";
import { memoryManager } from "../memory/manager.js";

const MemoryRecallInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Keyword or phrase to search across facts.md, lessons.md, and recent daily logs."),
});

type MemoryRecallInput = z.infer<typeof MemoryRecallInputSchema>;

export const memoryRecallTool: Tool<MemoryRecallInput> = {
  name: "memory_recall",
  description:
    "Search the agent's persistent memory for facts, lessons learned, or recent conversation notes matching a keyword. Use this before tackling non-trivial tasks to check for prior knowledge and mistakes to avoid.",
  schema: MemoryRecallInputSchema,
  permission_level: "read",

  async execute(
    input: MemoryRecallInput,
    _context: ToolExecutionContext
  ): Promise<ToolExecuteResult> {
    try {
      const result = await memoryManager.search(input.query);
      return ok(result);
    } catch (e) {
      return err(`memory_recall failed: ${String(e)}`);
    }
  },
};
