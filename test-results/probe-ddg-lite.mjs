// Probe the DDG /lite/ endpoint and inspect for result links.
const url = "https://lite.duckduckgo.com/lite/?q=TypeScript+agent+framework";
const res = await fetch(url, {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
  },
});
console.log("status", res.status, "ct", res.headers.get("content-type"));
const html = await res.text();
console.log("bytes", html.length);
const fs = await import("node:fs/promises");
await fs.writeFile("c:/tmp/ddg-lite.html", html);

// lite layout typically uses <a rel="nofollow" class="result-link" href="...">
const patterns = [
  /<a\b[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs,
  /<a\b[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs,
  /<a\b[^>]*href="([^"]+)"[^>]*>([^<]{10,150})<\/a>/g,
];
for (const [i, p] of patterns.entries()) {
  let n = 0, samp = null;
  let m;
  while ((m = p.exec(html)) !== null) {
    if (!samp) samp = { href: m[1].slice(0, 90), title: m[2].slice(0, 90) };
    n++;
    if (n > 20) break;
  }
  console.log(`pattern ${i}: ${n} matches`, samp);
}
