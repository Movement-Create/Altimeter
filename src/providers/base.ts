/**
 * Abstract LLM provider interface.
 *
 * Design: The factory pattern with a unified interface makes adding new
 * providers trivial — implement ~50 lines, register in router.ts.
 *
 * Every provider must:
 * 1. Accept the unified Message[] format
 * 2. Convert to its own wire format internally
 * 3. Return a normalized LLMResponse
 * 4. Support streaming via AsyncIterable<string>
 */

import type { Message, LLMResponse, ToolCall } from "../core/types.js";

// ---------------------------------------------------------------------------
// Tool definition (what we send to the LLM)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ---------------------------------------------------------------------------
// Request options
// ---------------------------------------------------------------------------

export interface CompletionOptions {
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  /** Model identifier (provider-specific) */
  model: string;
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

export abstract class BaseProvider {
  readonly id: string;
  readonly displayName: string;

  constructor(id: string, displayName: string) {
    this.id = id;
    this.displayName = displayName;
  }

  /**
   * Generate a completion. Returns a normalized LLMResponse.
   * Must handle tool call parsing internally.
   */
  abstract complete(options: CompletionOptions): Promise<LLMResponse>;

  /**
   * Stream text tokens. Yields each text delta as a string.
   * Tool calls are NOT streamed — they come in the final resolved promise.
   * Default: calls complete() and yields the full text (non-streaming fallback).
   */
  async *stream(options: CompletionOptions): AsyncIterable<string> {
    const response = await this.complete({ ...options, stream: true });
    if (response.text) {
      yield response.text;
    }
  }

  /**
   * Estimate cost in USD for given token usage.
   * Override in provider subclasses for accurate pricing.
   */
  estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    // Conservative default: $5/M input, $15/M output
    return (inputTokens * 5 + outputTokens * 15) / 1_000_000;
  }

  /**
   * List available models for this provider.
   */
  abstract listModels(): Promise<string[]>;

  /**
   * Validate that the provider is configured (API key present, etc.)
   */
  abstract validate(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Helper: normalize tool calls from any provider format
// ---------------------------------------------------------------------------

export function makeToolCall(
  id: string,
  name: string,
  input: unknown
): ToolCall {
  return {
    id,
    name,
    input: (typeof input === "object" && input !== null
      ? input
      : {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Helper: build text from content blocks (Anthropic-style)
// ---------------------------------------------------------------------------

export function extractText(content: unknown[]): string {
  return content
    .filter((b: unknown) => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b: unknown) => (b as { text: string }).text)
    .join("");
}
