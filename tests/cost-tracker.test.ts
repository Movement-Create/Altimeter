/**
 * Cost tracker tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { CostTracker } from "../src/core/cost-tracker.js";
import { unlink, mkdir } from "fs/promises";
import { resolve } from "path";

describe("CostTracker", () => {
  const testPath = resolve(process.cwd(), "test-sessions/test-cost-ledger.jsonl");
  let tracker: CostTracker;

  beforeEach(async () => {
    await mkdir(resolve(testPath, ".."), { recursive: true });
    tracker = new CostTracker(testPath);
  });

  afterEach(async () => {
    try { await unlink(testPath); } catch {}
  });

  it("records and retrieves cost entries", async () => {
    await tracker.record({
      timestamp: new Date().toISOString(),
      session_id: "test-1",
      model: "gpt-4o",
      provider: "openai",
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.05,
      turns: 3,
    });

    await tracker.record({
      timestamp: new Date().toISOString(),
      session_id: "test-2",
      model: "claude-3-5-sonnet-20241022",
      provider: "anthropic",
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.10,
      turns: 5,
    });

    const total = await tracker.getTotalCost();
    expect(total.entries).toBe(2);
    expect(total.total_usd).toBeCloseTo(0.15, 2);
  });

  it("returns zero for empty/missing ledger", async () => {
    const emptyTracker = new CostTracker("/nonexistent/path.jsonl");
    const total = await emptyTracker.getTotalCost();
    expect(total.total_usd).toBe(0);
    expect(total.entries).toBe(0);
  });
});
