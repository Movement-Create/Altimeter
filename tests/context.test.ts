/**
 * Context assembly and compression tests.
 */

import { describe, it, expect } from "@jest/globals";
import {
  estimateTokens,
  estimateContextTokens,
  compressContext,
  getContextLimit,
} from "../src/core/context.js";
import type { Message } from "../src/core/types.js";

describe("estimateTokens", () => {
  it("estimates tokens from character count", () => {
    const tokens = estimateTokens("Hello world"); // 11 chars
    expect(tokens).toBe(3); // ceil(11/4)
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateContextTokens", () => {
  it("sums tokens across messages", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const tokens = estimateContextTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it("handles array content", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "1", name: "bash", input: { command: "ls" } },
        ],
      },
    ];
    expect(estimateContextTokens(messages)).toBeGreaterThan(0);
  });
});

describe("getContextLimit", () => {
  it("returns correct limit for known models", () => {
    expect(getContextLimit("gpt-4o")).toBe(128_000);
    expect(getContextLimit("claude-3-5-sonnet-20241022")).toBe(200_000);
    expect(getContextLimit("gemini-2.5-pro")).toBe(1_000_000);
  });

  it("returns default for unknown models", () => {
    expect(getContextLimit("unknown-model")).toBe(128_000);
  });
});

describe("compressContext", () => {
  it("returns messages unchanged when under threshold", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const result = compressContext(messages, "gpt-4o");
    expect(result).toEqual(messages);
  });

  it("compresses long conversations", () => {
    const longContent = "x".repeat(200_000);
    const messages: Message[] = [
      { role: "user", content: longContent },
      { role: "assistant", content: longContent },
      { role: "user", content: "Recent question" },
    ];
    const result = compressContext(messages, "gpt-4o");
    expect(result.length).toBeLessThanOrEqual(messages.length);
  });
});
