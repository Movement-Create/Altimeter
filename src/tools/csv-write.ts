/**
 * CsvWrite tool — generate CSV files with proper escaping.
 *
 * No external dependencies — pure string serialization.
 * Handles quoting for fields containing commas, double quotes, and newlines.
 *
 * Permission: "write"
 */

import { z } from "zod";
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const CsvWriteInputSchema = z.object({
  output_path: z.string().describe("Output .csv file path"),
  headers: z.array(z.string()).describe("Column headers"),
  rows: z.array(
    z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  ).describe("Row data"),
});

type CsvWriteInput = z.infer<typeof CsvWriteInputSchema>;

/**
 * Escape a single CSV field per RFC 4180.
 * Wraps in double quotes if the field contains comma, double quote, or newline.
 */
function escapeCsvField(value: string | number | boolean | null): string {
  if (value === null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowToCsv(fields: Array<string | number | boolean | null>): string {
  return fields.map(escapeCsvField).join(",");
}

export const csvWriteTool: Tool<CsvWriteInput> = {
  name: "csv_write",
  description:
    "Create a CSV file with headers and row data. Handles proper CSV escaping (RFC 4180).",
  schema: CsvWriteInputSchema,
  permission_level: "write",

  async execute(input: CsvWriteInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    if (context.plan_mode) {
      return ok(
        `[PLAN MODE] Would create CSV: ${input.output_path} with ${input.rows.length} row(s)`
      );
    }

    const absPath = resolve(context.cwd, input.output_path);
    const dir = dirname(absPath);

    try {
      await mkdir(dir, { recursive: true });
    } catch (e) {
      return err(`Cannot create directory ${dir}: ${String(e)}`);
    }

    try {
      const lines = [
        rowToCsv(input.headers),
        ...input.rows.map(rowToCsv),
      ];
      const csvContent = lines.join("\n") + "\n";

      await writeFile(absPath, csvContent, "utf-8");

      return ok(
        `Created CSV: ${absPath}\n${input.headers.length} column(s), ${input.rows.length} row(s)`
      );
    } catch (e) {
      return err(`Failed to create CSV: ${String(e)}`);
    }
  },
};
