/**
 * SpreadsheetCreate tool — generate .xlsx files with multiple sheets.
 *
 * Uses exceljs for xlsx creation.
 *
 * Permission: "write"
 */

import { z } from "zod";
import { mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const SheetSchema = z.object({
  name: z.string().describe("Sheet name"),
  headers: z.array(z.string()).describe("Column headers"),
  rows: z.array(
    z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  ).describe("Row data"),
});

const SpreadsheetCreateInputSchema = z.object({
  output_path: z.string().describe("Output .xlsx file path"),
  sheets: z.array(SheetSchema).describe("Sheets to create"),
});

type SpreadsheetCreateInput = z.infer<typeof SpreadsheetCreateInputSchema>;

export const spreadsheetCreateTool: Tool<SpreadsheetCreateInput> = {
  name: "spreadsheet_create",
  description:
    "Create an Excel (.xlsx) spreadsheet with multiple sheets, headers, and row data.",
  schema: SpreadsheetCreateInputSchema,
  permission_level: "write",

  async execute(
    input: SpreadsheetCreateInput,
    context: ToolExecutionContext
  ): Promise<ToolExecuteResult> {
    if (context.plan_mode) {
      return ok(
        `[PLAN MODE] Would create spreadsheet: ${input.output_path} with ${input.sheets.length} sheet(s)`
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
      // Dynamic import to avoid loading exceljs when not needed
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();

      for (const sheet of input.sheets) {
        const ws = workbook.addWorksheet(sheet.name);

        // Add headers
        ws.addRow(sheet.headers);

        // Bold the header row
        const headerRow = ws.getRow(1);
        headerRow.font = { bold: true };
        headerRow.commit();

        // Add data rows
        for (const row of sheet.rows) {
          ws.addRow(row.map((cell) => (cell === null ? "" : cell)));
        }
      }

      await workbook.xlsx.writeFile(absPath);

      const totalRows = input.sheets.reduce((sum, s) => sum + s.rows.length, 0);
      return ok(
        `Created spreadsheet: ${absPath}\n${input.sheets.length} sheet(s), ${totalRows} data row(s)`
      );
    } catch (e) {
      return err(`Failed to create spreadsheet: ${String(e)}`);
    }
  },
};
