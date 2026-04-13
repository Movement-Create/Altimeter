/**
 * WebSearch tool — search the web using a search API.
 *
 * Supports multiple backends (configured via env vars):
 * - Brave Search API (BRAVE_API_KEY) — primary
 * - SerpAPI (SERP_API_KEY) — fallback
 * - DuckDuckGo HTML scraping — last resort (no API key needed)
 *
 * Permission: "network"
 */

import { z } from "zod";
import { ok, err } from "./base.js";
import type { Tool, ToolExecutionContext, ToolExecuteResult } from "./base.js";

const MAX_RESULTS = 10;

const WebSearchInputSchema = z.object({
  query: z.string().describe("Search query"),
  num_results: z
    .number()
    .optional()
    .default(5)
    .describe("Number of results to return (max 10)"),
});

type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export const webSearchTool: Tool<WebSearchInput> = {
  name: "web_search",
  description:
    "Search the web and return a list of relevant results with titles, URLs, and snippets.",
  schema: WebSearchInputSchema,
  permission_level: "network",

  async execute(input: WebSearchInput, context: ToolExecutionContext): Promise<ToolExecuteResult> {
    if (context.plan_mode) {
      return ok(`[PLAN MODE] Would search: "${input.query}"`);
    }

    const numResults = Math.min(input.num_results ?? 5, MAX_RESULTS);

    // Try Brave Search first
    const braveKey = process.env.BRAVE_API_KEY;
    if (braveKey) {
      return searchBrave(input.query, numResults, braveKey);
    }

    // Fallback: SerpAPI
    const serpKey = process.env.SERP_API_KEY;
    if (serpKey) {
      return searchSerp(input.query, numResults, serpKey);
    }

    // Last resort: DuckDuckGo HTML
    return searchDuckDuckGo(input.query, numResults);
  },
};

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

async function searchBrave(
  query: string,
  numResults: number,
  apiKey: string
): Promise<{ output: string; is_error: boolean }> {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${numResults}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!response.ok) {
      return err(`Brave Search API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          title: string;
          url: string;
          description?: string;
        }>;
      };
    };

    const results = data.web?.results ?? [];
    return ok(formatResults(results));
  } catch (e) {
    return err(`Brave Search error: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// SerpAPI
// ---------------------------------------------------------------------------

async function searchSerp(
  query: string,
  numResults: number,
  apiKey: string
): Promise<{ output: string; is_error: boolean }> {
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${numResults}&api_key=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      return err(`SerpAPI error: ${response.status}`);
    }

    const data = (await response.json()) as {
      organic_results?: Array<{
        title: string;
        link: string;
        snippet?: string;
      }>;
    };

    const results = (data.organic_results ?? []).map((r) => ({
      title: r.title,
      url: r.link,
      description: r.snippet,
    }));

    return ok(formatResults(results));
  } catch (e) {
    return err(`SerpAPI error: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// DuckDuckGo (HTML scraping fallback)
// ---------------------------------------------------------------------------

async function searchDuckDuckGo(
  query: string,
  numResults: number
): Promise<{ output: string; is_error: boolean }> {
  try {
    // FIX(iteration-4): the `/html/` endpoint returns an HTTP 202 bot-challenge
    // page to node's undici fetch (TLS fingerprinting). The `/lite/` endpoint
    // still serves real results to plain fetch. Switch to it and parse the
    // table-based lite layout: `class='result-link'` anchors paired with
    // `class='result-snippet'` <td>s in adjacent rows.
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) {
      return err(`DuckDuckGo search failed: ${response.status}`);
    }

    const html = await response.text();

    const results: Array<{ title: string; url: string; description?: string }> = [];

    // Lite uses single-quoted class attributes: class='result-link'.
    const anchorPattern =
      /<a\b[^>]*\bclass=['"]result-link['"][^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gs;
    // Also tolerate href-before-class ordering just in case.
    const anchorPatternAlt =
      /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\bclass=['"]result-link['"][^>]*>(.*?)<\/a>/gs;

    const snippetPattern =
      /<td\b[^>]*\bclass=['"]result-snippet['"][^>]*>(.*?)<\/td>/gs;

    const snippets: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = snippetPattern.exec(html)) !== null) {
      snippets.push(stripTags(sm[1]));
      if (snippets.length >= numResults * 2) break;
    }

    const collect = (pattern: RegExp) => {
      let match: RegExpExecArray | null;
      let i = 0;
      while ((match = pattern.exec(html)) !== null && results.length < numResults) {
        const title = stripTags(match[2]);
        const realUrl = unwrapDdgRedirect(match[1]);
        if (!realUrl || !title) continue;
        results.push({ title, url: realUrl, description: snippets[i++] });
      }
    };
    collect(anchorPattern);
    if (results.length === 0) collect(anchorPatternAlt);

    if (results.length === 0) {
      return ok(
        "No results found (DuckDuckGo). The DDG HTML layout may have changed — " +
          "set BRAVE_API_KEY or SERP_API_KEY for a reliable backend."
      );
    }

    return ok(formatResults(results));
  } catch (e) {
    return err(
      `Web search unavailable: ${String(e)}\nTip: Set BRAVE_API_KEY or SERP_API_KEY for web search.`
    );
  }
}

// ---------------------------------------------------------------------------
// Format results
// ---------------------------------------------------------------------------

function formatResults(
  results: Array<{ title: string; url: string; description?: string }>
): string {
  if (results.length === 0) return "No results found.";

  return results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title}**\n   URL: ${r.url}${r.description ? `\n   ${r.description}` : ""}`
    )
    .join("\n\n");
}

// FIX(iteration-3): helpers for DuckDuckGo HTML scraping.

/** Strip HTML tags, collapse whitespace, decode core entities. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DuckDuckGo wraps result URLs in a redirect of the form
 *   //duckduckgo.com/l/?uddg=<percent-encoded-target>&rut=<token>
 * Return the decoded target URL, or null if parsing fails.
 * Also handles the (rarer) case where DDG returns a direct http(s) URL.
 */
function unwrapDdgRedirect(raw: string): string | null {
  if (!raw) return null;
  // Direct http(s) URL — keep as-is.
  if (/^https?:\/\//i.test(raw)) return raw;

  // DDG redirect: may start with //duckduckgo.com/l/ or /l/
  const normalized = raw.startsWith("//") ? `https:${raw}` : raw.startsWith("/") ? `https://duckduckgo.com${raw}` : raw;
  try {
    const u = new URL(normalized);
    const target = u.searchParams.get("uddg");
    if (target) return target; // URL() already percent-decodes query params.
  } catch {
    // fall through
  }
  return null;
}
