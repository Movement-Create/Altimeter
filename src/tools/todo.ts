/**
 * Todo tool — structured task tracking within a session.
 *
 * Design: The LLM uses this to maintain a visible, checkable task list.
 * It's stored in session state (not a file) for fast access.
 * The whole list is replaced on each write (not append-only) — this forces
 * the LLM to think about the full list state, not just deltas.
 *
 * Pattern inspired by Claude Code's TodoWrite tool.
 * Permission: "write" (writes to session state, not disk)
 */

import { z } from "zod";
import { ok } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const TodoItemSchema = z.object({
  id: z.string().describe("Unique identifier for the task"),
  content: z.string().describe("Task description"),
  status: z
    .enum(["pending", "in_progress", "completed", "blocked"])
    .default("pending"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
});

const TodoWriteInputSchema = z.object({
  todos: z
    .array(TodoItemSchema)
    .describe("Complete list of todos (replaces existing list)"),
});

type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

// In-memory store per session (key: session_id → todos)
const sessionTodos = new Map<string, TodoItem[]>();

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  priority: "low" | "medium" | "high";
}

export const todoTool: Tool<TodoWriteInput> = {
  name: "todo_write",
  description:
    "Create or update the task list. Pass the COMPLETE list on every call — this replaces the current list. Use this to track multi-step work and show progress.",
  schema: TodoWriteInputSchema,
  permission_level: "write",

  async execute(input: TodoWriteInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    const todos = input.todos;
    sessionTodos.set(context.session.id, todos);

    const formatted = formatTodos(todos);
    return ok(`Todo list updated:\n\n${formatted}`);
  },
};

// ---------------------------------------------------------------------------
// Read todos for a session (used by agent loop to inject into context)
// ---------------------------------------------------------------------------

export function getTodos(sessionId: string): TodoItem[] {
  return sessionTodos.get(sessionId) ?? [];
}

export function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "(no tasks)";

  const icons: Record<string, string> = {
    completed: "✓",
    in_progress: "→",
    pending: "○",
    blocked: "✗",
  };

  return todos
    .map((t) => {
      const icon = icons[t.status] ?? "○";
      const priority = t.priority !== "medium" ? ` [${t.priority}]` : "";
      return `${icon} [${t.id}] ${t.content}${priority}`;
    })
    .join("\n");
}
