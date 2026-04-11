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
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      return err(`DuckDuckGo search failed: ${response.status}`);
    }

    const html = await response.text();

    // Extract results from DDG HTML
    const results: Array<{ title: string; url: string; description?: string }> = [];
    const resultPattern = /<a class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
    const snippetPattern = /<a class="result__snippet"[^>]*>([^<]+(?:<[^a][^>]*>[^<]*<\/[^a][^>]*>[^<]*)*)<\/a>/g;

    let match;
    const snippets: string[] = [];

    // Extract snippets first
    let sm;
    while ((sm = snippetPattern.exec(html)) !== null && snippets.length < numResults) {
      snippets.push(sm[1].replace(/<[^>]+>/g, "").trim());
    }

    // Extract result links
    let i = 0;
    while ((match = resultPattern.exec(html)) !== null && results.length < numResults) {
      const rawUrl = match[1];
      const title = match[2].trim();

      // Skip non-http URLs
      if (!rawUrl.startsWith("http")) continue;

      results.push({
        title,
        url: rawUrl,
        description: snippets[i++],
      });
    }

    if (results.length === 0) {
      return ok("No results found (DuckDuckGo). Try setting BRAVE_API_KEY for better results.");
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
