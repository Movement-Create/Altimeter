/**
 * Retry logic tests.
 */

import { describe, it, expect } from "@jest/globals";
import { withRetry } from "../src/core/retry.js";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("retries on retryable errors", async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("429 rate limit");
        return Promise.resolve("ok");
      },
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 }
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("throws immediately on non-retryable errors", async () => {
    await expect(
      withRetry(
        () => { throw new Error("401 unauthorized"); },
        { maxRetries: 3, baseDelayMs: 10 }
      )
    ).rejects.toThrow("401 unauthorized");
  });

  it("throws after max retries exhausted", async () => {
    await expect(
      withRetry(
        () => { throw new Error("503 service unavailable"); },
        { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 }
      )
    ).rejects.toThrow("503 service unavailable");
  });

  it("calls onRetry callback", async () => {
    const retries: number[] = [];
    let attempts = 0;
    await withRetry(
      () => {
        attempts++;
        if (attempts < 2) throw new Error("500 internal server error");
        return Promise.resolve("ok");
      },
      {
        maxRetries: 3,
        baseDelayMs: 10,
        onRetry: (attempt) => { retries.push(attempt); },
      }
    );
    expect(retries).toEqual([1]);
  });
});
