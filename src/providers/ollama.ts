/**
 * Ollama local model provider.
 *
 * Connects to a local Ollama server (default: http://localhost:11434).
 * Compatible with any model Ollama supports: llama3, mistral, codellama, etc.
 *
 * Note: Tool calling support varies by model. We use JSON mode as fallback.
 * Models with native function calling: llama3.1, llama3.2, mistral-nemo, etc.
 */

import type { Message, LLMResponse } from "../core/types.js";
import {
  BaseProvider,
  makeToolCall,
  type CompletionOptions,
  type ToolDefinition,
} from "./base.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export class OllamaProvider extends BaseProvider {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    super("ollama", "Ollama (Local)");
    this.baseUrl = baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_URL;
  }

  /**
   * Convert our Message[] to Ollama chat format.
   * Ollama uses OpenAI-compatible /api/chat format.
   */
  private convertMessages(messages: Message[]): unknown[] {
    return messages.map((msg) => {
      const role =
        msg.role === "tool" ? "tool" : msg.role === "assistant" ? "assistant" : msg.role;

      let content = "";
      const rawContent = msg.content;

      if (typeof rawContent === "string") {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        content = rawContent
          .map((b) => {
            if (typeof b === "string") return b;
            if (typeof b === "object" && b !== null) {
              const block = b as { type?: string; text?: string; content?: string };
              if (block.type === "text") return block.text ?? "";
              if (block.type === "tool_result") return block.content ?? "";
            }
            return "";
          })
          .join("\n");
      }

      return { role, content };
    });
  }

  private convertTools(tools: ToolDefinition[]): unknown[] {
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
      stream: false,
      options: {
        num_predict: options.max_tokens ?? 4096,
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
      },
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{
          function: { name: string; arguments: Record<string, unknown> };
        }>;
      };
      done_reason: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const toolCalls = (data.message.tool_calls ?? []).map((tc, i) =>
      makeToolCall(
        `ollama_call_${i}_${Date.now()}`,
        tc.function.name,
        tc.function.arguments
      )
    );

    return {
      text: data.message.content || null,
      tool_calls: toolCalls,
      stop_reason: data.done_reason ?? "stop",
      usage: {
        input_tokens: data.prompt_eval_count ?? 0,
        output_tokens: data.eval_count ?? 0,
      },
      raw: data,
    };
  }

  async *stream(options: CompletionOptions): AsyncIterable<string> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: this.convertMessages(options.messages),
      stream: true,
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const err = await response.text();
      throw new Error(`Ollama streaming error ${response.status}: ${err}`);
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
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
          };
          if (event.message?.content) yield event.message.content;
          if (event.done) return;
        } catch {
          // Ignore
        }
      }
    }
  }

  // Ollama is free (local), so cost is 0
  estimateCost(_model: string, _inputTokens: number, _outputTokens: number): number {
    return 0;
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];
      const data = (await response.json()) as {
        models: Array<{ name: string }>;
      };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  async validate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
