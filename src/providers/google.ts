/**
 * Google Gemini provider.
 *
 * Uses the Gemini REST API directly (no SDK).
 * Supports: gemini-1.5-pro, gemini-1.5-flash, gemini-2.0-flash-exp
 *
 * Key differences from OpenAI/Anthropic:
 * - "contents" instead of "messages"
 * - "parts" instead of "content"
 * - Tool calls use "functionCall" / "functionResponse" parts
 * - System instruction is separate
 */

import type { Message, LLMResponse } from "../core/types.js";
import {
  BaseProvider,
  makeToolCall,
  type CompletionOptions,
  type ToolDefinition,
} from "./base.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.025, output: 0.1 },
};

export class GoogleProvider extends BaseProvider {
  private apiKey: string;

  constructor(apiKey?: string) {
    super("google", "Google Gemini");
    this.apiKey = apiKey ?? process.env.GOOGLE_API_KEY ?? "";
  }

  /**
   * Convert our Message[] to Gemini "contents" format.
   * Gemini uses "user" and "model" roles (not "assistant").
   * Tool results are "user" role with "functionResponse" parts.
   */
  private convertMessages(messages: Message[]): unknown[] {
    const result: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue; // handled separately

      // Gemini uses "user" and "model" roles only.
      // Tool results (role="tool") become "user" with functionResponse parts.
      const role = msg.role === "assistant" ? "model" : "user";
      const parts = this.convertToParts(msg);

      if (parts.length > 0) {
        result.push({ role, parts });
      }
    }

    return result;
  }

  private convertToParts(msg: Message): unknown[] {
    const content = msg.content;
    const blocks = Array.isArray(content) ? content : [content];
    const parts: unknown[] = [];

    for (const block of blocks) {
      if (typeof block === "string") {
        parts.push({ text: block });
        continue;
      }
      if (typeof block !== "object" || block === null) continue;

      const b = block as {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: string;
      };

      switch (b.type) {
        case "text":
          if (b.text) parts.push({ text: b.text });
          break;
        case "tool_use":
          parts.push({
            functionCall: { name: b.name, args: b.input ?? {} },
          });
          break;
        case "tool_result":
          // Gemini requires function name, not call ID.
          // We store the tool name in tool_use_id via agent-loop mapping.
          parts.push({
            functionResponse: {
              name: b.name ?? b.tool_use_id ?? "unknown",
              response: { result: b.content ?? "" },
            },
          });
          break;
      }
    }

    return parts;
  }

  private extractSystemPrompt(messages: Message[]): string | undefined {
    const sys = messages.find((m) => m.role === "system");
    if (!sys) return undefined;
    const c = sys.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .filter(
          (b) =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: string }).type === "text"
        )
        .map((b) => (b as { text: string }).text)
        .join("\n");
    }
    return undefined;
  }

  private convertTools(tools: ToolDefinition[]): unknown {
    return {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      })),
    };
  }

  async complete(options: CompletionOptions): Promise<LLMResponse> {
    const systemPrompt = options.system ?? this.extractSystemPrompt(options.messages);

    const body: Record<string, unknown> = {
      contents: this.convertMessages(options.messages),
      generationConfig: {
        maxOutputTokens: options.max_tokens ?? 4096,
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
      },
    };

    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = [this.convertTools(options.tools)];
    }

    const url = `${GEMINI_BASE}/models/${options.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      candidates: Array<{
        content: {
          parts: Array<{
            text?: string;
            functionCall?: { name: string; args: unknown };
          }>;
        };
        finishReason: string;
      }>;
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
    };

    const candidate = data.candidates[0];
    let text = "";
    const toolCalls = [];

    for (const part of candidate.content.parts) {
      if (part.text) text += part.text;
      if (part.functionCall) {
        toolCalls.push(
          makeToolCall(
            `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            part.functionCall.name,
            part.functionCall.args
          )
        );
      }
    }

    return {
      text: text || null,
      tool_calls: toolCalls,
      stop_reason: candidate.finishReason ?? "STOP",
      usage: {
        input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      raw: data,
    };
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = PRICING[model] ?? { input: 3.5, output: 10.5 };
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }

  async listModels(): Promise<string[]> {
    return Object.keys(PRICING);
  }

  async validate(): Promise<boolean> {
    return this.apiKey.length > 0;
  }
}
