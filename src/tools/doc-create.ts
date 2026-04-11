/**
 * DocCreate tool — generate PDF or CSV documents from markdown content.
 *
 * Uses pdfkit for PDF generation.
 * CSV uses simple string serialization.
 *
 * Permission: "write"
 */

import { z } from "zod";
import { createWriteStream } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const DocCreateInputSchema = z.object({
  format: z.enum(["pdf", "csv"]).describe("Output format"),
  title: z.string().describe("Document title"),
  content: z.string().describe("Document content in markdown"),
  output_path: z.string().describe("Output file path"),
});

type DocCreateInput = z.infer<typeof DocCreateInputSchema>;

export const docCreateTool: Tool<DocCreateInput> = {
  name: "doc_create",
  description:
    "Create a PDF or CSV document from markdown content. Renders title as header and content as formatted text.",
  schema: DocCreateInputSchema,
  permission_level: "write",

  async execute(input: DocCreateInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    if (context.plan_mode) {
      return ok(
        `[PLAN MODE] Would create ${input.format.toUpperCase()} document: ${input.output_path}`
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
      if (input.format === "pdf") {
        await createPdf(absPath, input.title, input.content);
      } else {
        await writeFile(absPath, input.content, "utf-8");
      }

      return ok(`Created ${input.format.toUpperCase()} document: ${absPath}`);
    } catch (e) {
      return err(`Failed to create document: ${String(e)}`);
    }
  },
};

async function createPdf(outputPath: string, title: string, content: string): Promise<void> {
  // Dynamic import to avoid loading pdfkit when not needed
  const PDFDocument = (await import("pdfkit")).default;

  return new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = createWriteStream(outputPath);

    stream.on("finish", () => resolve());
    stream.on("error", reject);

    doc.pipe(stream);

    // Title
    doc.fontSize(24).font("Helvetica-Bold").text(title, { align: "center" });
    doc.moveDown(1.5);

    // Parse markdown content into blocks
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.startsWith("# ")) {
        doc.fontSize(20).font("Helvetica-Bold").text(line.slice(2));
        doc.moveDown(0.5);
      } else if (line.startsWith("## ")) {
        doc.fontSize(16).font("Helvetica-Bold").text(line.slice(3));
        doc.moveDown(0.5);
      } else if (line.startsWith("### ")) {
        doc.fontSize(14).font("Helvetica-Bold").text(line.slice(4));
        doc.moveDown(0.3);
      } else if (line.startsWith("```")) {
        // Toggle code block styling — for simplicity, just style the fence line
        doc.fontSize(10).font("Courier");
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        doc.fontSize(12).font("Helvetica").text(`  \u2022 ${line.slice(2)}`, { indent: 10 });
      } else if (line.trim() === "") {
        doc.moveDown(0.5);
      } else {
        doc.fontSize(12).font("Helvetica").text(line);
      }
    }

    doc.end();
  });
}
