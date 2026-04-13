// Standalone DDG fetch probe — mirrors what web-search.ts does, writes raw HTML to /tmp/ddg-fetch.html
const url = "https://html.duckduckgo.com/html/?q=TypeScript+agent+framework";
const res = await fetch(url, {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
});
console.log("status", res.status, "ct", res.headers.get("content-type"));
const html = await res.text();
console.log("bytes", html.length);
const fs = await import("node:fs/promises");
await fs.writeFile("/tmp/ddg-fetch.html", html);

const anchorPattern =
  /<a\b[^>]*\bclass="result__a"[^>]*\bhref="([^"]+)"[^>]*>(.*?)<\/a>/gs;
let count = 0;
let m;
const matches = [];
while ((m = anchorPattern.exec(html)) !== null) {
  count++;
  if (matches.length < 3) matches.push({ href: m[1].slice(0, 80), title: m[2].slice(0, 60) });
}
console.log("anchor matches:", count);
console.log("first 3:", matches);
