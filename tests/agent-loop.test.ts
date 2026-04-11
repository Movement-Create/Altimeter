/**
 * Agent loop tests.
 *
 * Tests the core while(tool_use) behavior with mock providers.
 */

import { describe, it, expect, jest } from "@jest/globals";
import type { LLMResponse } from "../src/core/types.js";
import { getDefaultConfig } from "../src/config/loader.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

const mockResolve = jest.fn<AnyFn>();

// Mock the router to return our mock provider
jest.unstable_mockModule("../src/providers/router.js", () => ({
  router: {
    resolve: mockResolve,
  },
}));

// Mock hooks engine (no-op)
jest.unstable_mockModule("../src/hooks/engine.js", () => ({
  hookEngine: {
    firePreToolUse: jest.fn<AnyFn>().mockResolvedValue({ action: "allow" }),
    firePostToolUse: jest.fn<AnyFn>().mockResolvedValue({ action: "allow" }),
    fireStop: jest.fn<AnyFn>().mockResolvedValue({ action: "allow" }),
  },
}));

// Mock context assembly + compression
jest.unstable_mockModule("../src/core/context.js", () => ({
  assembleContext: jest.fn<AnyFn>().mockResolvedValue("Mock system prompt"),
  compressContext: jest.fn<AnyFn>().mockImplementation((messages: unknown[]) => messages),
  estimateContextTokens: jest.fn<AnyFn>().mockReturnValue(100),
  getContextLimit: jest.fn<AnyFn>().mockReturnValue(200_000),
}));

// Mock audit logger
jest.unstable_mockModule("../src/security/audit.js", () => ({
  auditLogger: {
    log: jest.fn<AnyFn>().mockResolvedValue(undefined),
    logRaw: jest.fn<AnyFn>().mockResolvedValue(undefined),
  },
}));

// Mock cost tracker
jest.unstable_mockModule("../src/core/cost-tracker.js", () => ({
  costTracker: {
    record: jest.fn<AnyFn>().mockResolvedValue(undefined),
  },
}));

// Mock retry (pass through)
jest.unstable_mockModule("../src/core/retry.js", () => ({
  withRetry: jest.fn<AnyFn>().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
}));

// Dynamic import after mocks are set up (ESM requirement)
const { runAgent } = await import("../src/core/agent-loop.js");

// Mock provider that returns predetermined responses
function createMockProvider(responses: LLMResponse[]) {
  let callCount = 0;

  return {
    id: "mock",
    displayName: "Mock",
    complete: jest.fn<AnyFn>().mockImplementation(async () => {
      const response = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      return response;
    }),
    stream: jest.fn<AnyFn>().mockImplementation(async function* () {
      const response = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      if (response.text) yield response.text;
    }),
    listModels: jest.fn<AnyFn>().mockResolvedValue(["mock-model"]),
    validate: jest.fn<AnyFn>().mockResolvedValue(true),
    estimateCost: jest.fn<AnyFn>().mockReturnValue(0.001),
  };
}

describe("Agent Loop", () => {
  async function makeSession() {
    return {
      id: "test-session",
      title: "Test",
      created_at: new Date().toISOString(),
      model: "mock:mock-model",
      provider: "mock",
      allowed_tools: [] as string[],
      disallowed_tools: [] as string[],
      permission_mode: "auto" as const,
      effort: "medium" as const,
      max_turns: 10,
      max_budget_usd: 1.0,
      file_path: "/tmp/test-session.jsonl",
    };
  }

  it("returns text-only response immediately when no tool calls", async () => {
    const mockProvider = createMockProvider([
      {
        text: "Hello! I can help you with that.",
        tool_calls: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    ]);

    mockResolve.mockReturnValue({
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

  it("stops at max_turns", async () => {
    const mockProvider = createMockProvider([
      {
        text: null,
        tool_calls: [{ id: "call_x", name: "bash", input: { command: "echo test" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    ]);

    mockResolve.mockReturnValue({
      provider: mockProvider,
      model: "mock-model",
    });

    const session = {
      ...(await makeSession()),
      max_turns: 3,
    };

    const result = await runAgent({ prompt: "Loop forever", session });

    expect(result.stop_reason).toBe("max_turns");
    expect(result.turns).toBe(3);
  });

  it("calls onText callback for streaming text", async () => {
    const mockProvider = createMockProvider([
      {
        text: "Streamed response text",
        tool_calls: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 10 },
      },
    ]);

    mockResolve.mockReturnValue({
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
});
