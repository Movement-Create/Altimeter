/**
 * Agent loop tests.
 *
 * Tests the core while(tool_use) behavior with mock providers.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { runAgent } from "../src/core/agent-loop.js";
import type { AgentRunOptions, LLMResponse } from "../src/core/types.js";
import { getDefaultConfig } from "../src/config/loader.js";

// Mock provider that returns predetermined responses
function createMockProvider(responses: LLMResponse[]) {
  let callCount = 0;

  return {
    id: "mock",
    displayName: "Mock",
    complete: jest.fn().mockImplementation(async () => {
      const response = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      return response;
    }),
    stream: jest.fn().mockImplementation(async function* () {
      const response = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      if (response.text) yield response.text;
    }),
    listModels: jest.fn().mockResolvedValue(["mock-model"] as string[]),
    validate: jest.fn().mockResolvedValue(true),
    estimateCost: jest.fn().mockReturnValue(0.001),
  };
}

// Mock the router to return our mock provider
jest.mock("../src/providers/router.js", () => ({
  router: {
    resolve: jest.fn().mockReturnValue({
      provider: null, // Will be set per test
      model: "mock-model",
    }),
  },
}));

// Mock hooks engine (no-op)
jest.mock("../src/hooks/engine.js", () => ({
  hookEngine: {
    firePreToolUse: jest.fn().mockResolvedValue({ action: "allow" }),
    firePostToolUse: jest.fn().mockResolvedValue({ action: "allow" }),
    fireStop: jest.fn().mockResolvedValue({ action: "allow" }),
  },
}));

// Mock context assembly
jest.mock("../src/core/context.js", () => ({
  assembleContext: jest.fn().mockResolvedValue("Mock system prompt"),
}));

describe("Agent Loop", () => {
  const config = getDefaultConfig();

  async function makeSession() {
    return {
      id: "test-session",
      title: "Test",
      created_at: new Date().toISOString(),
      model: "mock:mock-model",
      provider: "mock",
      allowed_tools: [],
      disallowed_tools: [],
      permission_mode: "auto" as const,
      effort: "medium" as const,
      max_turns: 10,
      max_budget_usd: 1.0,
      file_path: "/tmp/test-session.jsonl",
    };
  }

  it("returns text-only response immediately when no tool calls", async () => {
    const { router } = await import("../src/providers/router.js");
    const mockProvider = createMockProvider([
      {
        text: "Hello! I can help you with that.",
        tool_calls: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    ]);

    (router.resolve as jest.Mock).mockReturnValue({
      provider: mockProvider,
      model: "mock-model",
    });

    const session = await makeSession();
    const result = await runAgent({
      prompt: "Say hello",
      session,
    });

    expect(result.text).toBe("Hello! I can help you with that.");
    expect(result.turns).toBe(1);
    expect(result.stop_reason).toBe("text");
  });

  it("loops when tool calls are present, returns text on second turn", async () => {
    const { router } = await import("../src/providers/router.js");
    const { registry } = await import("../src/tools/registry.js");

    // Mock a tool execution
    const mockTool = {
      name: "test_tool",
      description: "A test tool",
      schema: { safeParse: () => ({ success: true, data: { query: "test" } }) },
      permission_level: "read" as const,
      execute: jest.fn().mockResolvedValue({
        output: "Tool output: test result",
        is_error: false,
      }),
    };

    // Register mock tool temporarily
    try {
      registry.register(mockTool as unknown as Parameters<typeof registry.register>[0], true);
    } catch {
      // Already registered
    }

    const mockProvider = createMockProvider([
      // First response: tool call
      {
        text: null,
        tool_calls: [{ id: "call_1", name: "test_tool", input: { query: "test" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 15, output_tokens: 30 },
      },
      // Second response: final text
      {
        text: "Based on the results: test result",
        tool_calls: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    ]);

    (router.resolve as jest.Mock).mockReturnValue({
      provider: mockProvider,
      model: "mock-model",
    });

    const session = await makeSession();
    const result = await runAgent({
      prompt: "Use the test tool",
      session,
    });

    expect(result.turns).toBe(2);
    expect(result.text).toBe("Based on the results: test result");
    expect(result.stop_reason).toBe("text");
  });

  it("stops at max_turns", async () => {
    const { router } = await import("../src/providers/router.js");

    // Provider always returns tool calls (infinite loop scenario)
    const mockProvider = createMockProvider([
      {
        text: null,
        tool_calls: [{ id: "call_x", name: "bash", input: { command: "echo test" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    ]);

    (router.resolve as jest.Mock).mockReturnValue({
      provider: mockProvider,
      model: "mock-model",
    });

    const session = {
      ...(await makeSession()),
      max_turns: 3,
      allowed_tools: [], // No tools available = tool calls will fail
      disallowed_tools: [],
    };

    const result = await runAgent({ prompt: "Loop forever", session });

    expect(result.stop_reason).toBe("max_turns");
    expect(result.turns).toBe(3);
  });

  it("calls onText callback for streaming text", async () => {
    const { router } = await import("../src/providers/router.js");

    const mockProvider = createMockProvider([
      {
        text: "Streamed response text",
        tool_calls: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 10 },
      },
    ]);

    (router.resolve as jest.Mock).mockReturnValue({
      provider: mockProvider,
      model: "mock-model",
    });

    const session = await makeSession();
    const chunks: string[] = [];

    await runAgent({
      prompt: "Test streaming",
      session,
      onText: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toContain("Streamed response text");
  });

  it("calls onToolCall and onToolResult callbacks", async () => {
    const { router } = await import("../src/providers/router.js");

    const mockProvider = createMockProvider([
      {
        text: null,
        tool_calls: [{ id: "call_1", name: "test_tool", input: { query: "hello" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 15 },
      },
      {
        text: "Done",
        tool_calls: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 30, output_tokens: 10 },
      },
    ]);

    (router.resolve as jest.Mock).mockReturnValue({
      provider: mockProvider,
      model: "mock-model",
    });

    const session = await makeSession();
    const toolCalls: string[] = [];
    const toolResults: boolean[] = [];

    await runAgent({
      prompt: "Use tools",
      session,
      onToolCall: (call) => { toolCalls.push(call.name); },
      onToolResult: (result) => { toolResults.push(result.is_error); },
    });

    expect(toolCalls).toContain("test_tool");
    expect(toolResults.length).toBe(1);
  });
});
