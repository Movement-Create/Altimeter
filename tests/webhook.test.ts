/**
 * Webhook rate limiting tests.
 */

import { describe, it, expect } from "@jest/globals";

// Since WebhookServer requires full config, test the rate limiting logic in isolation
describe("Webhook rate limiting", () => {
  it("allows requests under the limit", () => {
    const counts = new Map<string, { count: number; resetAt: number }>();
    const MAX = 30;

    function checkRateLimit(ip: string): boolean {
      const now = Date.now();
      const entry = counts.get(ip);
      if (!entry || now > entry.resetAt) {
        counts.set(ip, { count: 1, resetAt: now + 60_000 });
        return true;
      }
      entry.count++;
      return entry.count <= MAX;
    }

    // 30 requests should succeed
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit("1.2.3.4")).toBe(true);
    }
    // 31st should fail
    expect(checkRateLimit("1.2.3.4")).toBe(false);
    // Different IP should succeed
    expect(checkRateLimit("5.6.7.8")).toBe(true);
  });
});
