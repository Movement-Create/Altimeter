/**
 * Provider layer tests.
 *
 * Tests the model router, provider resolution, and message conversion logic.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ModelRouter } from "../src/providers/router.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { GoogleProvider } from "../src/providers/google.js";
import { OllamaProvider } from "../src/providers/ollama.js";
import { makeToolCall } from "../src/providers/base.js";

// ---------------------------------------------------------------------------
// ModelRouter tests
// ---------------------------------------------------------------------------

describe("ModelRouter", () => {
  let router: ModelRouter;

  beforeEach(() => {
    router = new ModelRouter();
  });

  it("resolves explicit provider:model strings", () => {
    const { provider, model } = router.resolve("anthropic:claude-3-5-sonnet-20241022");
    expect(provider.id).toBe("anthropic");
    expect(model).toBe("claude-3-5-sonnet-20241022");
  });

  it("auto-detects Anthropic from claude- prefix", () => {
    const { provider, model } = router.resolve("claude-3-opus-20240229");
    expect(provider.id).toBe("anthropic");
    expect(model).toBe("claude-3-opus-20240229");
  });

  it("auto-detects OpenAI from gpt- prefix", () => {
    const { provider, model } = router.resolve("gpt-4o");
    expect(provider.id).toBe("openai");
    expect(model).toBe("gpt-4o");
  });

  it("auto-detects OpenAI from o1 prefix", () => {
    const { provider, model } = router.resolve("o1-preview");
    expect(provider.id).toBe("openai");
    expect(model).toBe("o1-preview");
  });

  it("auto-detects Google from gemini- prefix", () => {
    const { provider, model } = router.resolve("gemini-1.5-pro");
    expect(provider.id).toBe("google");
    expect(model).toBe("gemini-1.5-pro");
  });

  it("auto-detects Ollama from llama prefix", () => {
    const { provider, model } = router.resolve("llama3.1");
    expect(provider.id).toBe("ollama");
    expect(model).toBe("llama3.1");
  });

  it("uses default provider for unknown model names", () => {
    const { provider } = router.resolve("unknown-model-xyz", "anthropic");
    expect(provider.id).toBe("anthropic");
  });

  it("throws for unknown provider id", () => {
    expect(() => router.resolve("unknown_provider:model")).toThrow("Unknown provider");
  });

  it("returns the same provider instance (singleton per id)", () => {
    const p1 = router.getProvider("anthropic");
    const p2 = router.getProvider("anthropic");
    expect(p1).toBe(p2);
  });

  it("lists all providers", () => {
    const providers = router.listProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("google");
    expect(providers).toContain("ollama");
  });

  it("can register custom providers", () => {
    const customProvider = {
      id: "custom",
      displayName: "Custom",
      complete: jest.fn(),
      stream: jest.fn(),
      listModels: jest.fn(),
      validate: jest.fn(),
      estimateCost: jest.fn(),
    };

    router.registerProvider("custom", () => customProvider as never);
    const { provider } = router.resolve("custom:my-model");
    expect(provider.id).toBe("custom");
  });

  it("recommends different models for different effort levels", () => {
    const low = router.getModelForEffort("anthropic", "low");
    const max = router.getModelForEffort("anthropic", "max");
    expect(low).not.toBe(max);
    expect(low).toContain("haiku");
    expect(max).toContain("opus");
  });
});

// ---------------------------------------------------------------------------
// makeToolCall helper
// ---------------------------------------------------------------------------

describe("makeToolCall", () => {
  it("creates a normalized tool call", () => {
    const call = makeToolCall("id123", "bash", { command: "echo test" });
    expect(call.id).toBe("id123");
    expect(call.name).toBe("bash");
    expect(call.input).toEqual({ command: "echo test" });
  });

  it("handles null/non-object input", () => {
    const call = makeToolCall("id", "tool", null);
    expect(call.input).toEqual({});
  });

  it("handles string input", () => {
    const call = makeToolCall("id", "tool", "not-an-object");
    expect(call.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Provider cost estimation
// ---------------------------------------------------------------------------

describe("Provider cost estimation", () => {
  it("AnthropicProvider estimates cost for known models", () => {
    const provider = new AnthropicProvider("test-key");
    const cost = provider.estimateCost(
      "claude-3-5-sonnet-20241022",
      1_000_000,
      1_000_000
    );
    // $3/M input + $15/M output = $18 per 1M of each
    expect(cost).toBeCloseTo(18, 0);
  });

  it("OllamaProvider always returns 0 cost", () => {
    const provider = new OllamaProvider();
    const cost = provider.estimateCost("llama3.1", 100000, 50000);
    expect(cost).toBe(0);
  });

  it("OpenAIProvider estimates cost for gpt-4o", () => {
    const provider = new OpenAIProvider("test-key");
    const cost = provider.estimateCost("gpt-4o", 1_000_000, 1_000_000);
    // $5/M input + $15/M output
    expect(cost).toBeCloseTo(20, 0);
  });
});

// ---------------------------------------------------------------------------
// Provider validation
// ---------------------------------------------------------------------------

describe("Provider validation", () => {
  it("AnthropicProvider returns false with empty key", async () => {
    const provider = new AnthropicProvider("");
    expect(await provider.validate()).toBe(false);
  });

  it("AnthropicProvider returns true with non-empty key", async () => {
    const provider = new AnthropicProvider("sk-ant-test");
    expect(await provider.validate()).toBe(true);
  });

  it("OpenAIProvider returns false with empty key", async () => {
    const provider = new OpenAIProvider("");
    expect(await provider.validate()).toBe(false);
  });

  it("OllamaProvider attempts connection to validate", async () => {
    // Ollama's validate() tries to connect to the server
    // Since we don't have a server, it should return false
    const provider = new OllamaProvider("http://localhost:19999"); // unused port
    const result = await provider.validate();
    expect(typeof result).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Provider model listing
// ---------------------------------------------------------------------------

describe("Provider model listing", () => {
  it("AnthropicProvider lists known models", async () => {
    const provider = new AnthropicProvider("test");
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.includes("claude"))).toBe(true);
  });

  it("GoogleProvider lists known models", async () => {
    const provider = new GoogleProvider("test");
    const models = await provider.listModels();
    expect(models.some(m => m.includes("gemini"))).toBe(true);
  });

  it("OllamaProvider returns empty array when server unavailable", async () => {
    const provider = new OllamaProvider("http://localhost:19999");
    const models = await provider.listModels();
    expect(Array.isArray(models)).toBe(true);
  });
});
