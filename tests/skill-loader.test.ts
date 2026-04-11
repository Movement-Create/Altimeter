/**
 * Skill loader word-boundary matching tests.
 */

import { describe, it, expect } from "@jest/globals";

describe("Word boundary skill matching", () => {
  function matchesSkill(prompt: string, pattern: string): boolean {
    const escaped = pattern.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    return regex.test(prompt.toLowerCase());
  }

  it("matches exact word", () => {
    expect(matchesSkill("Please pay the invoice", "pay")).toBe(true);
  });

  it("does not match substring", () => {
    expect(matchesSkill("Display the results", "pay")).toBe(false);
    expect(matchesSkill("Repayment schedule", "pay")).toBe(false);
  });

  it("matches at start/end of string", () => {
    expect(matchesSkill("pay now", "pay")).toBe(true);
    expect(matchesSkill("time to pay", "pay")).toBe(true);
  });

  it("matches multi-word patterns", () => {
    expect(matchesSkill("I need help with file upload", "file upload")).toBe(true);
    expect(matchesSkill("profile upload section", "file upload")).toBe(false);
  });
});
