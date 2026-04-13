/**
 * Moonshot / Kimi provider.
 *
 * Moonshot AI's API is OpenAI-compatible (same `/chat/completions` wire format,
 * same tool-calling schema), so we inherit all message conversion and streaming
 * logic from OpenAIProvider and just override:
 *   - id / displayName         (for router + CLI display)
 *   - default base URL         (api.moonshot.ai/v1)
 *   - API key env var          (MOONSHOT_API_KEY, with OPENAI_API_KEY fallback)
 *   - pricing table            (moonshot-v1-*, kimi-k2-*, kimi-*)
 *   - listModels               (calls moonshot /models)
 *
 * Gotchas observed during testing:
 *   - kimi-k2-0905-preview occasionally returns malformed JSON in tool_call
 *     arguments (concatenated objects, trailing garbage). The tolerant parser
 *     in openai.ts:parseToolArguments handles this — do NOT bypass it here.
 *   - Moonshot can return HTTP 500 transient errors under load. The agent-loop
 *     retry wrapper handles these.
 */

import { OpenAIProvider } from "./openai.js";

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";

// Approximate pricing per 1M tokens in USD. These are published list prices
// and may drift — update when Moonshot adjusts their rate card. Matches the
// shape expected by BaseProvider.estimateCost (which we inherit).
const PRICING: Record<string, { input: number; output: number }> = {
  "moonshot-v1-8k": { input: 0.2, output: 2.0 },
  "moonshot-v1-32k": { input: 0.5, output: 2.0 },
  "moonshot-v1-128k": { input: 2.0, output: 5.0 },
  "kimi-k2-0711-preview": { input: 0.6, output: 2.5 },
  "kimi-k2-0905-preview": { input: 0.6, output: 2.5 },
  "kimi-k2-thinking-turbo": { input: 1.0, output: 4.0 },
};

// Fallback pricing if an unknown kimi/moonshot model is used.
const DEFAULT_PRICING = { input: 1.0, output: 3.0 };

export class MoonshotProvider extends OpenAIProvider {
  constructor(apiKey?: string, baseUrl?: string) {
    super(
      apiKey ?? process.env.MOONSHOT_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
      baseUrl ?? process.env.MOONSHOT_BASE_URL ?? MOONSHOT_BASE_URL,
      "moonshot",
      "Moonshot / Kimi"
    );
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = PRICING[model] ?? DEFAULT_PRICING;
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
