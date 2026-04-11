/**
 * Anthropic Claude provider.
 *
 * Uses the Anthropic Messages API directly via fetch (no SDK dependency).
 * Handles: streaming, tool calls, vision (image content).
 *
 * Supported models: claude-3-5-sonnet, claude-3-opus, claude-3-haiku, etc.
 */

import type {
  Message,
  LLMResponse,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ImageContent,
  MessageContent,
} from "../core/types.js";
import {
  BaseProvider,
  makeToolCall,
  type CompletionOptions,
  type ToolDefinition,
} from "./base.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Pricing per million tokens (as of 2024)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "claude-3-sonnet-20240229": { input: 3, output: 15 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
};

export class AnthropicProvider extends BaseProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    super("anthropic", "Anthropic Claude");
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.baseUrl = baseUrl ?? ANTHROPIC_API_URL;
  }

  /**
   * Convert our internal Message[] to Anthropic wire format.
   * Key differences:
   * - System message is separate, not in messages array
   * - Tool results use "tool_result" content type
   * - Images use "image" content type with base64 or url source
   */
  private convertMessages(messages: Message[]): unknown[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: this.convertContent(m.content),
      }));
  }

  private convertContent(content: MessageContent | MessageContent[]): unknown {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) {
      return [this.convertBlock(content)];
    }
    return content.map((c) => this.convertBlock(c));
  }

  private convertBlock(block: MessageContent): unknown {
    if (typeof block === "string") {
      return { type: "text", text: block };
    }
    switch (block.type) {
      case "text":
        return { type: "text", text: (block as TextContent).text };
      case "tool_use": {
        const tu = block as ToolUseContent;
        return { type: "tool_use", id: tu.id, name: tu.name, input: tu.input };
      }
      case "tool_result": {
        const tr = block as ToolResultContent;
        return {
          type: "tool_result",
          tool_use_id: tr.tool_use_id,
          content: tr.content,
          is_error: tr.is_error ?? false,
        };
      }
      case "image": {
        const img = block as ImageContent;
        return { type: "image", source: img.source };
      }
      default:
        return block;
    }
  }

  private convertTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  async complete(options: CompletionOptions): Promise<LLMResponse> {
    const system =
      options.system ??
      options.messages.find((m) => m.role === "system")?.content;

    const systemText =
      typeof system === "string"
        ? system
        : Array.isArray(system)
        ? (system as TextContent[]).map((b) => b.text).join("\n")
        : undefined;

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.max_tokens ?? 4096,
      messages: this.convertMessages(options.messages),
    };

    if (systemText) body.system = systemText;
    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const textBlocks = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    const toolCalls = data.content
      .filter((b) => b.type === "tool_use")
      .map((b) => makeToolCall(b.id!, b.name!, b.input));

    return {
      text: textBlocks || null,
      tool_calls: toolCalls,
      stop_reason: data.stop_reason,
      usage: {
        input_tokens: data.usage.input_tokens,
        output_tokens: data.usage.output_tokens,
      },
      raw: data,
    };
  }

  async *stream(options: CompletionOptions): AsyncIterable<string> {
    const system =
      options.system ??
      options.messages.find((m) => m.role === "system")?.content;

    const systemText =
      typeof system === "string"
        ? system
        : Array.isArray(system)
        ? (system as TextContent[]).map((b) => b.text).join("\n")
        : undefined;

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.max_tokens ?? 4096,
      messages: this.convertMessages(options.messages),
      stream: true,
    };

    if (systemText) body.system = systemText;
    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const err = await response.text();
      throw new Error(`Anthropic streaming error ${response.status}: ${err}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === "[DONE]" || !jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr) as {
            type: string;
            delta?: { type: string; text?: string };
          };
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            event.delta.text
          ) {
            yield event.delta.text;
          }
        } catch {
          // Ignore parse errors in streaming
        }
      }
    }
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = PRICING[model] ?? { input: 5, output: 15 };
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }

  async listModels(): Promise<string[]> {
    return Object.keys(PRICING);
  }

  async validate(): Promise<boolean> {
    return this.apiKey.length > 0;
  }
}
