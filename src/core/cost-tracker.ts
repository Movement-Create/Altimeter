/**
 * Persistent cost tracker.
 * Appends cost entries to a JSONL ledger file.
 */

import { appendFile, readFile, mkdir } from "fs/promises";
import { resolve } from "path";

const DEFAULT_LEDGER_PATH = "./sessions/cost-ledger.jsonl";

interface CostEntry {
  timestamp: string;
  session_id: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  turns: number;
}

export class CostTracker {
  private ledgerPath: string;

  constructor(ledgerPath?: string) {
    this.ledgerPath = ledgerPath ?? DEFAULT_LEDGER_PATH;
  }

  setPath(path: string): void {
    this.ledgerPath = path;
  }

  async record(entry: CostEntry): Promise<void> {
    try {
      const dir = resolve(this.ledgerPath, "..");
      await mkdir(dir, { recursive: true });
      await appendFile(
        this.ledgerPath,
        JSON.stringify(entry) + "\n",
        "utf-8"
      );
    } catch {
      // Never crash the agent over cost tracking
    }
  }

  async getTotalCost(): Promise<{ total_usd: number; entries: number }> {
    try {
      const content = await readFile(this.ledgerPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      let total = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as CostEntry;
          total += entry.cost_usd;
        } catch {
          // Skip corrupted lines
        }
      }
      return { total_usd: total, entries: lines.length };
    } catch {
      return { total_usd: 0, entries: 0 };
    }
  }
}

export const costTracker = new CostTracker();
