/**
 * Web search via DuckDuckGo HTML with visual fallback.
 */

import { getConsistentUA } from "./user-agent.js";
import { visualParsePage } from "./visual-parser.js";
import { rateLimitWait } from "./rate-limiter.js";
import { cacheGet, cacheSet, makeCacheKey } from "./cache.js";

export interface SearchResult { title: string; url: string; snippet: string; }
export interface SearchOptions { maxResults?: number; signal?: AbortSignal; onProgress?: (msg: string) => void; }

export async function webSearch(query: string, options: SearchOptions = {}): Promise<{ results: SearchResult[]; source: string }> {
  const { maxResults = 10, signal, onProgress } = options;
  const cacheKey = makeCacheKey("search", query, { maxResults });
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);
  if (signal?.aborted) throw new Error("Aborted");
  await rateLimitWait("https://html.duckduckgo.com");
  onProgress?.(`Searching DuckDuckGo for "${query}"...`);
  const ddg = await searchDDG(query, maxResults, signal);
  if (ddg.length > 0) { const r = { results: ddg, source: "duckduckgo" }; try { cacheSet(cacheKey, JSON.stringify(r), 600000); } catch {} return r; }
  onProgress?.("Trying visual fallback...");
  const vis = await visualFallback(query, maxResults, signal);
  if (vis.length > 0) { const r = { results: vis, source: "duckduckgo-visual" }; try { cacheSet(cacheKey, JSON.stringify(r), 300000); } catch {} return r; }
  return { results: [], source: "none" };
}


async function searchDDG(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const { headers } = getConsistentUA(url);
    const res = await fetch(url, { headers, signal, redirect: "follow" });
    if (!res.ok) return [];
    return parseResults(await res.text(), max);
  } catch { return []; }
}

function parseResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  let pos = 0;
  while (results.length < max) {
    const start = findResult(html, pos);
    if (start === -1) break;
    const next = findResult(html, start + 1);
    const block = html.slice(start, next !== -1 ? next : html.length);
    pos = next !== -1 ? next : html.length;
    const link = extractLink(block);
    if (!link) continue;
    const snippet = extractSnippet(block);
    if (link.title && link.url.startsWith("http"))
      results.push({ title: link.title, url: link.url, snippet });
  }
  return results;
}

function findResult(html: string, from: number): number {
  const m = ['class="result results_links', 'class="result '];
  let e = -1;
  for (const mk of m) { const p = html.indexOf(mk, from); if (p !== -1 && (e === -1 || p < e)) e = p; }
  return e;
}

function extractLink(block: string): { title: string; url: string } | null {
  let cp = block.indexOf('class="result__a"');
  if (cp === -1) cp = block.indexOf("result__a");
  if (cp === -1) return null;
  const a = block.lastIndexOf("<a", cp);
  if (a === -1) return null;
  const hm = block.slice(a, cp + 200).match(/href="([^"]*)"/);
  if (!hm) return null;
  let href = hm[1];
  if (href.includes("uddg=")) { const m = href.match(/uddg=([^&]+)/); if (m) href = decodeURIComponent(m[1]); }
  const te = block.indexOf(">", cp + 8);
  if (te === -1) return null;
  const cl = block.indexOf("</a>", te);
  if (cl === -1) return null;
  return { title: block.slice(te + 1, cl).replace(/<[^>]*>/g, "").trim(), url: href };
}

function extractSnippet(block: string): string {
  const p = block.indexOf("result__snippet");
  if (p === -1) return "";
  const te = block.indexOf(">", p);
  if (te === -1) return "";
  let cl = block.indexOf("</a>", te);
  const ct = block.indexOf("</td>", te);
  const cs = block.indexOf("</span>", te);
  if (ct !== -1 && (cl === -1 || ct < cl)) cl = ct;
  if (cs !== -1 && (cl === -1 || cs < cl)) cl = cs;
  if (cl === -1) return "";
  return block.slice(te + 1, cl).replace(/<[^>]*>/g, "").trim();
}


async function visualFallback(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const { accessibilityText } = await visualParsePage(url, { timeout: 20000, fullPage: false, signal });
    const lines = accessibilityText.split("\n").filter((l) => l.trim().length > 0);
    const results: SearchResult[] = [];
    for (let i = 0; i < lines.length && results.length < max; i++) {
      const line = lines[i].trim();
      if (line.startsWith("http://") || line.startsWith("https://")) {
        const title = i > 0 ? lines[i - 1].trim() : "";
        const snippet = i + 1 < lines.length ? lines[i + 1].trim() : "";
        if (title && !title.startsWith("http")) results.push({ title, url: line, snippet });
      }
    }
    return results;
  } catch { return []; }
}
