/**
 * OpenAI provider (also compatible with any OpenAI-compatible endpoint).
 *
 * This means it works with:
 * - api.openai.com (GPT-4o, o1, etc.)
 * - Together AI
 * - Groq
 * - Fireworks AI
 * - Any local server exposing /v1/chat/completions
 *
 * Design: We use the standard OpenAI function-calling format and convert
 * to/from our internal Message format.
 */

import type { Message, LLMResponse } from "../core/types.js";
import {
  BaseProvider,
  makeToolCall,
  type CompletionOptions,
  type ToolDefinition,
} from "./base.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 5, output: 15 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "o1-preview": { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
};

export class OpenAIProvider extends BaseProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    super("openai", "OpenAI");
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
  }

  /**
   * Convert our internal Message[] to OpenAI chat format.
   * Key: tool results use role="tool" in OpenAI's format.
   */
  private convertMessages(messages: Message[]): unknown[] {
    const result: unknown[] = [];

    for (const msg of messages) {
      const content = msg.content;

      if (msg.role === "system") {
        result.push({ role: "system", content: this.extractText(content) });
        continue;
      }

      if (msg.role === "user") {
        result.push({ role: "user", content: this.extractText(content) });
        continue;
      }

      if (msg.role === "assistant") {
        // May contain tool_use blocks
        const blocks = Array.isArray(content) ? content : [content];
        const textParts: string[] = [];
        const toolCalls: unknown[] = [];

        for (const block of blocks) {
          if (typeof block === "string") {
            textParts.push(block);
          } else if (typeof block === "object" && block !== null) {
            const b = block as { type: string; text?: string; id?: string; name?: string; input?: unknown };
            if (b.type === "text" && b.text) {
              textParts.push(b.text);
            } else if (b.type === "tool_use") {
              toolCalls.push({
                id: b.id,
                type: "function",
                function: {
                  name: b.name,
                  arguments: JSON.stringify(b.input ?? {}),
                },
              });
            }
          }
        }

        const assistantMsg: Record<string, unknown> = { role: "assistant" };
        if (textParts.length) assistantMsg.content = textParts.join("");
        if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
        result.push(assistantMsg);
        continue;
      }

      if (msg.role === "tool") {
        // Tool results
        const blocks = Array.isArray(content) ? content : [content];
        for (const block of blocks) {
          if (typeof block === "object" && block !== null) {
            const b = block as { type?: string; tool_use_id?: string; content?: string; is_error?: boolean };
            if (b.type === "tool_result") {
              result.push({
                role: "tool",
                tool_call_id: b.tool_use_id,
                content: b.content ?? "",
              });
            }
          }
        }
        continue;
      }
    }

    return result;
  }

  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) =>
          typeof b === "string"
            ? b
            : typeof b === "object" && b !== null && (b as { type?: string }).type === "text"
            ? (b as { text: string }).text
            : ""
        )
        .join("");
    }
    return "";
  }

  private convertTools(
    tools: ToolDefinition[]
  ): unknown[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  async complete(options: CompletionOptions): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: this.convertMessages(options.messages),
      max_tokens: options.max_tokens ?? 4096,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
      body.tool_choice = "auto";
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    const toolCalls = (choice.message.tool_calls ?? []).map((tc) =>
      makeToolCall(
        tc.id,
        tc.function.name,
        JSON.parse(tc.function.arguments || "{}")
      )
    );

    return {
      text: choice.message.content || null,
      tool_calls: toolCalls,
      stop_reason: choice.finish_reason ?? "end_turn",
      usage: {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
      },
      raw: data,
    };
  }

  async *stream(options: CompletionOptions): AsyncIterable<string> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: this.convertMessages(options.messages),
      max_tokens: options.max_tokens ?? 4096,
      stream: true,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const err = await response.text();
      throw new Error(`OpenAI streaming error ${response.status}: ${err}`);
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
            choices: Array<{ delta: { content?: string } }>;
          };
          const text = event.choices[0]?.delta?.content;
          if (text) yield text;
        } catch {
          // Ignore
        }
      }
    }
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = PRICING[model] ?? { input: 5, output: 15 };
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok) return Object.keys(PRICING);
      const data = (await response.json()) as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id);
    } catch {
      return Object.keys(PRICING);
    }
  }

  async validate(): Promise<boolean> {
    return this.apiKey.length > 0;
  }
}
