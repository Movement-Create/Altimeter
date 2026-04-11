/**
 * Model router — provider registry and auto-selection.
 *
 * Design goals:
 * 1. Single place to resolve "provider:model" strings to provider instances
 * 2. Auto-routing: given a task complexity, pick the best available model
 * 3. Fallback chain: if primary provider unavailable, try next
 *
 * Provider resolution:
 * - "anthropic:claude-3-5-sonnet-20241022" → AnthropicProvider
 * - "openai:gpt-4o" → OpenAIProvider
 * - "google:gemini-1.5-pro" → GoogleProvider
 * - "ollama:llama3" → OllamaProvider
 * - "claude-3-5-sonnet-20241022" (no prefix) → auto-detect by model name
 */

import { BaseProvider } from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GoogleProvider } from "./google.js";
import { OllamaProvider } from "./ollama.js";
import type { EffortLevel } from "../core/types.js";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

type ProviderFactory = () => BaseProvider;

const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  google: () => new GoogleProvider(),
  ollama: () => new OllamaProvider(),
};

// Model name prefixes → provider id (for auto-detection)
const MODEL_PREFIX_MAP: Array<[RegExp, string]> = [
  [/^claude-/i, "anthropic"],
  [/^gpt-/i, "openai"],
  [/^o1/i, "openai"],
  [/^gemini-/i, "google"],
  [/^llama|mistral|codellama|phi|qwen/i, "ollama"],
];

// Effort → recommended model per provider
const EFFORT_MODELS: Record<
  string,
  Record<EffortLevel, string>
> = {
  anthropic: {
    low: "claude-3-5-haiku-20241022",
    medium: "claude-3-5-sonnet-20241022",
    high: "claude-3-5-sonnet-20241022",
    max: "claude-3-opus-20240229",
  },
  openai: {
    low: "gpt-4o-mini",
    medium: "gpt-4o",
    high: "gpt-4o",
    max: "o1-preview",
  },
  google: {
    low: "gemini-2.0-flash-lite",
    medium: "gemini-2.5-flash",
    high: "gemini-2.5-flash",
    max: "gemini-2.5-pro",
  },
  ollama: {
    low: "llama3.2",
    medium: "llama3.1",
    high: "llama3.1:70b",
    max: "llama3.1:405b",
  },
};

// ---------------------------------------------------------------------------
// ModelRouter
// ---------------------------------------------------------------------------

export class ModelRouter {
  private instances: Map<string, BaseProvider> = new Map();

  /**
   * Register a custom provider factory.
   */
  registerProvider(id: string, factory: ProviderFactory): void {
    PROVIDER_FACTORIES[id] = factory;
  }

  /**
   * Get (or create) a provider instance by id.
   */
  getProvider(providerId: string): BaseProvider {
    if (!this.instances.has(providerId)) {
      const factory = PROVIDER_FACTORIES[providerId];
      if (!factory) {
        throw new Error(
          `Unknown provider: "${providerId}". Available: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`
        );
      }
      this.instances.set(providerId, factory());
    }
    return this.instances.get(providerId)!;
  }

  /**
   * Resolve a "provider:model" or bare model string.
   * Returns { provider, model }.
   */
  resolve(modelString: string, defaultProvider?: string): { provider: BaseProvider; model: string } {
    const colonIdx = modelString.indexOf(":");
    if (colonIdx > 0) {
      const providerId = modelString.slice(0, colonIdx);
      const model = modelString.slice(colonIdx + 1);
      return { provider: this.getProvider(providerId), model };
    }

    // Auto-detect provider from model name
    for (const [pattern, providerId] of MODEL_PREFIX_MAP) {
      if (pattern.test(modelString)) {
        return { provider: this.getProvider(providerId), model: modelString };
      }
    }

    // Use default provider
    const pid = defaultProvider ?? "anthropic";
    return { provider: this.getProvider(pid), model: modelString };
  }

  /**
   * Auto-select the best model for a given effort level.
   * Tries providers in preference order based on available API keys.
   */
  async autoSelect(effort: EffortLevel): Promise<{ provider: BaseProvider; model: string }> {
    const preferenceOrder = ["anthropic", "openai", "google", "ollama"];

    for (const pid of preferenceOrder) {
      const provider = this.getProvider(pid);
      const isValid = await provider.validate();
      if (isValid) {
        const model = EFFORT_MODELS[pid]?.[effort] ?? "default";
        return { provider, model };
      }
    }

    throw new Error(
      "No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY, or run a local Ollama server."
    );
  }

  /**
   * List all registered provider IDs.
   */
  listProviders(): string[] {
    return Object.keys(PROVIDER_FACTORIES);
  }

  /**
   * Get effort-level model recommendation for a provider.
   */
  getModelForEffort(providerId: string, effort: EffortLevel): string {
    return EFFORT_MODELS[providerId]?.[effort] ?? "default";
  }
}

// Singleton instance
export const router = new ModelRouter();
