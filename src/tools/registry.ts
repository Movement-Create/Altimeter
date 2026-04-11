/**
 * Tool registry + permission engine.
 *
 * Design:
 * - Central registry of all available tools
 * - Handles permission checking before execution
 * - Converts tools to LLM-ready ToolDefinition format
 * - Supports dynamic registration (plugins)
 *
 * Permission check order:
 * 1. Is tool in disallowed_tools? → block
 * 2. Is allowed_tools non-empty and tool NOT in it? → block
 * 3. Permission mode = "bypassPermissions"? → allow
 * 4. Permission mode = "plan"? → allow (but execute returns plan description)
 * 5. Permission level > session risk threshold? → ask (default mode)
 * 6. Mode = "auto"? → allow without asking
 */

import { z } from "zod";
import type {
  PermissionLevel,
  PermissionMode,
  SessionConfig,
} from "../core/types.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";
import type { ToolDefinition } from "../providers/base.js";

// Import all built-in tools
import { bashTool } from "./bash.js";
import { fileReadTool } from "./file-read.js";
import { fileWriteTool } from "./file-write.js";
import { fileEditTool } from "./file-edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";
import { agentTool } from "./agent.js";
import { todoTool } from "./todo.js";

// Permission hierarchy (higher index = more dangerous)
const PERMISSION_RANK: Record<PermissionLevel, number> = {
  read: 0,
  write: 1,
  network: 2,
  execute: 3,
  agent: 4,
};

// Default permission thresholds by mode
const MODE_THRESHOLDS: Record<PermissionMode, PermissionLevel> = {
  default: "execute",    // ask before execute/agent
  auto: "agent",         // never ask (allow everything up to agent)
  plan: "agent",         // plan mode: allow all (execute returns plan text)
  bypassPermissions: "agent", // bypass everything
};

export type PermissionCallback = (
  toolName: string,
  permissionLevel: PermissionLevel,
  description: string
) => Promise<boolean>;

export class ToolRegistry {
  private tools: Map<string, Tool<unknown>> = new Map();
  private permissionCallback?: PermissionCallback;

  constructor() {
    // Register all built-in tools
    this.register(bashTool);
    this.register(fileReadTool);
    this.register(fileWriteTool);
    this.register(fileEditTool);
    this.register(globTool);
    this.register(grepTool);
    this.register(webFetchTool);
    this.register(webSearchTool);
    this.register(agentTool);
    this.register(todoTool);
  }

  /**
   * Register a tool. Throws if a tool with the same name already exists.
   * Use force=true to override.
   */
  register(tool: Tool<unknown>, force = false): void {
    if (this.tools.has(tool.name) && !force) {
      throw new Error(
        `Tool "${tool.name}" is already registered. Use force=true to override.`
      );
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool by name.
   */
  get(name: string): Tool<unknown> | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tools as LLM-ready ToolDefinition array.
   * Filtered by the session's allowed/disallowed lists.
   */
  getToolDefinitions(session: SessionConfig): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => this.isToolAllowed(t.name, session))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: zodToJsonSchema(t.schema),
      }));
  }

  /**
   * Execute a tool with permission checking.
   */
  async executeTool(
    name: string,
    input: unknown,
    context: ToolExecutionContext
  ): Promise<ToolExecuteResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { output: `Unknown tool: "${name}"`, is_error: true };
    }

    // Check if tool is allowed in this session
    if (!this.isToolAllowed(name, context.session)) {
      return {
        output: `Tool "${name}" is not allowed in this session.`,
        is_error: true,
      };
    }

    // Permission mode check
    const permissionGranted = await this.checkPermission(
      tool,
      context.session.permission_mode
    );

    if (!permissionGranted) {
      return {
        output: `Tool "${name}" requires permission level "${tool.permission_level}" which was denied.`,
        is_error: true,
      };
    }

    // Validate input with Zod
    const parseResult = tool.schema.safeParse(input);
    if (!parseResult.success) {
      return {
        output: `Invalid input for tool "${name}": ${parseResult.error.message}`,
        is_error: true,
      };
    }

    // Execute
    try {
      return await tool.execute(parseResult.data, context);
    } catch (e) {
      return {
        output: `Tool "${name}" threw an error: ${String(e)}`,
        is_error: true,
      };
    }
  }

  /**
   * Set the callback for interactive permission prompts.
   */
  setPermissionCallback(cb: PermissionCallback): void {
    this.permissionCallback = cb;
  }

  /**
   * List all registered tool names.
   */
  listTools(): string[] {
    return [...this.tools.keys()];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isToolAllowed(name: string, session: SessionConfig): boolean {
    // Disallowed list takes priority
    if (session.disallowed_tools.includes(name)) return false;

    // If allowed_tools is specified, tool must be in it
    if (session.allowed_tools.length > 0) {
      return session.allowed_tools.includes(name);
    }

    return true;
  }

  private async checkPermission(
    tool: Tool<unknown>,
    mode: PermissionMode
  ): Promise<boolean> {
    if (mode === "bypassPermissions") return true;
    if (mode === "plan") return true; // plan mode: allow but tools self-report as dry-run

    const threshold = MODE_THRESHOLDS[mode];
    const toolRank = PERMISSION_RANK[tool.permission_level];
    const thresholdRank = PERMISSION_RANK[threshold];

    // Below threshold: auto-allow
    if (toolRank < thresholdRank) return true;

    // At or above threshold in auto mode: allow
    if (mode === "auto") return true;

    // In default mode at/above threshold: ask
    if (this.permissionCallback) {
      return this.permissionCallback(
        tool.name,
        tool.permission_level,
        tool.description
      );
    }

    // No callback in default mode → allow (headless operation)
    return true;
  }
}

// ---------------------------------------------------------------------------
// Convert Zod schema to JSON Schema (simplified)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function zodToJsonSchema(schema: z.ZodType<unknown, any, any>): ToolDefinition["input_schema"] {
  // For ZodObject, extract properties
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType<unknown>>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodTypeToJsonSchema(value);

      // Check if field is required (not optional)
      const isOptional =
        value instanceof z.ZodOptional ||
        value instanceof z.ZodDefault ||
        (value instanceof z.ZodUnion &&
          value.options.some((o: z.ZodType<unknown>) => o instanceof z.ZodUndefined));

      if (!isOptional) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  return { type: "object", properties: {} };
}

function zodTypeToJsonSchema(type: z.ZodType<unknown>): unknown {
  if (type instanceof z.ZodString) {
    const schema: Record<string, unknown> = { type: "string" };
    if (type.description) schema.description = type.description;
    return schema;
  }
  if (type instanceof z.ZodNumber) {
    const schema: Record<string, unknown> = { type: "number" };
    if (type.description) schema.description = type.description;
    return schema;
  }
  if (type instanceof z.ZodBoolean) {
    const schema: Record<string, unknown> = { type: "boolean" };
    if (type.description) schema.description = type.description;
    return schema;
  }
  if (type instanceof z.ZodArray) {
    return {
      type: "array",
      items: zodTypeToJsonSchema(type.element),
      ...(type.description ? { description: type.description } : {}),
    };
  }
  if (type instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: type.options,
      ...(type.description ? { description: type.description } : {}),
    };
  }
  if (type instanceof z.ZodOptional) {
    return zodTypeToJsonSchema(type.unwrap());
  }
  if (type instanceof z.ZodDefault) {
    const inner = zodTypeToJsonSchema(type.removeDefault());
    const schema = inner as Record<string, unknown>;
    schema.default = type._def.defaultValue();
    return schema;
  }
  if (type instanceof z.ZodObject) {
    return zodToJsonSchema(type);
  }
  // Fallback
  return { type: "string" };
}

// Singleton registry
export const registry = new ToolRegistry();
