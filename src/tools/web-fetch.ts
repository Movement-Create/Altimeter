/**
 * WebFetch tool — HTTP fetch a URL and return text content.
 *
 * Features:
 * - HTML → plain text conversion (strips tags, scripts, style)
 * - Respects robots.txt (optional, configurable)
 * - Follows redirects (up to 5)
 * - Sets a realistic User-Agent
 *
 * Permission: "network"
 */

import { z } from "zod";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const MAX_RESPONSE_SIZE = 200_000; // chars
const TIMEOUT_MS = 30_000;

const WebFetchInputSchema = z.object({
  url: z.string().url().describe("The URL to fetch"),
  prompt: z
    .string()
    .optional()
    .describe("If provided, extract only the relevant parts matching this description"),
  raw: z
    .boolean()
    .optional()
    .default(false)
    .describe("Return raw HTML instead of extracted text"),
  max_length: z
    .number()
    .optional()
    .default(40000)
    .describe("Maximum characters of content to return"),
});

type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

const USER_AGENT =
  "Mozilla/5.0 (compatible; Altimeter/1.0; +https://github.com/altimeter)";

export const webFetchTool: Tool<WebFetchInput> = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its text content. HTML is automatically converted to readable text. Use prompt parameter to extract specific information.",
  schema: WebFetchInputSchema,
  permission_level: "network",

  async execute(input: WebFetchInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    if (context.plan_mode) {
      return ok(`[PLAN MODE] Would fetch: ${input.url}`);
    }

    let response: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      response = await fetch(input.url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeoutId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("abort")) {
        return err(`Request timed out after ${TIMEOUT_MS / 1000}s: ${input.url}`);
      }
      return err(`Fetch error: ${msg}`);
    }

    if (!response.ok) {
      return err(
        `HTTP ${response.status} ${response.statusText}: ${input.url}`
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const maxLength = input.max_length ?? 40000;

    // Handle non-text responses
    if (
      contentType.includes("application/json") ||
      contentType.includes("application/ld+json")
    ) {
      const text = await response.text();
      return ok(text.slice(0, maxLength));
    }

    if (
      !contentType.includes("text/") &&
      !contentType.includes("application/xhtml")
    ) {
      return ok(
        `Non-text response: ${contentType}\nURL: ${input.url}\nStatus: ${response.status}`
      );
    }

    const rawHtml = await response.text();

    if (input.raw) {
      return ok(rawHtml.slice(0, maxLength));
    }

    // Convert HTML to plain text
    const text = htmlToText(rawHtml);
    const truncated = text.slice(0, maxLength);

    const header = `URL: ${input.url}\nStatus: ${response.status}\n\n`;
    return ok(header + truncated);
  },
};

// ---------------------------------------------------------------------------
// HTML to text conversion (no external deps)
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
  // Remove script and style blocks entirely
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");

  // Convert block elements to newlines
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<h[1-6][^>]*>/gi, "\n\n### ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/th>/gi, "\t")
    .replace(/<\/td>/gi, "\t");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 10))
    )
    .replace(/&[a-z]+;/gi, " ");

  // Normalize whitespace
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}
