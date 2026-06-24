/**
 * Multi-engine web search with failover and health tracking.
 * Supports DuckDuckGo, Google, Bing, and Brave Search.
 */

import { getConsistentUA } from "./user-agent.js";
import { visualParsePage } from "./visual-parser.js";
import { rateLimitWait } from "./rate-limiter.js";
import { cacheGet, cacheSet, makeCacheKey } from "./cache.js";
import { loadConfig, type SearchEngineId } from "./config.js";

export interface SearchResult { title: string; url: string; snippet: string; engine: SearchEngineId; }
export interface SearchOptions { maxResults?: number; signal?: AbortSignal; onProgress?: (msg: string) => void; engine?: SearchEngineId; }

// --- Engine health tracking ---
interface EngineHealth { successes: number; failures: number; consecutiveFailures: number; cooldownUntil: number; }
const engineHealth = new Map<SearchEngineId, EngineHealth>();

function getHealth(engine: SearchEngineId): EngineHealth {
  if (!engineHealth.has(engine)) engineHealth.set(engine, { successes: 0, failures: 0, consecutiveFailures: 0, cooldownUntil: 0 });
  return engineHealth.get(engine)!;
}

function recordSuccess(engine: SearchEngineId): void {
  const h = getHealth(engine); h.successes++; h.consecutiveFailures = 0;
}

function recordFailure(engine: SearchEngineId): void {
  const config = loadConfig();
  const h = getHealth(engine); h.failures++; h.consecutiveFailures++;
  if (h.consecutiveFailures >= config.engineFailureThreshold) {
    h.cooldownUntil = Date.now() + config.engineCooldownMs;
  }
}

function isEngineCooledDown(engine: SearchEngineId): boolean {
  const h = getHealth(engine);
  return h.cooldownUntil > Date.now();
}

export function resetEngineHealth(): void { engineHealth.clear(); }

export function getEngineHealthSnapshot(): Array<{ engine: SearchEngineId; successes: number; failures: number; consecutiveFailures: number; cooledDown: boolean }> {
  const engines: SearchEngineId[] = ["duckduckgo", "google", "bing", "brave"];
  return engines.map(e => { const h = getHealth(e); return { engine: e, successes: h.successes, failures: h.failures, consecutiveFailures: h.consecutiveFailures, cooledDown: isEngineCooledDown(e) }; });
}


// --- Main search function ---
export async function webSearch(query: string, options: SearchOptions = {}): Promise<{ results: SearchResult[]; source: string }> {
  const { maxResults = 10, signal, onProgress, engine: preferredEngine } = options;
  const config = loadConfig();

  const cacheKey = makeCacheKey("search", query, { maxResults, engine: preferredEngine });
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached);
  if (signal?.aborted) throw new Error("Aborted");

  // Determine engine order: preferred first, then config order, skip cooled-down
  const order = getEngineOrder(preferredEngine || config.preferredEngine, config.engineOrder);

  for (const engine of order) {
    if (signal?.aborted) throw new Error("Aborted");
    if (isEngineCooledDown(engine)) { onProgress?.(`Skipping ${engine} (cooled down)...`); continue; }

    await rateLimitWait(`https://${engineDomain(engine)}`, config.rateLimitMs);
    onProgress?.(`Searching ${engine}...`);

    try {
      const results = await searchEngine(engine, query, maxResults, signal);
      if (results.length > 0) {
        recordSuccess(engine);
        const r = { results, source: engine };
        try { cacheSet(cacheKey, JSON.stringify(r), 600000); } catch {}
        return r;
      }
      // Zero results isn't a failure, try next engine
      onProgress?.(`${engine} returned no results, trying next...`);
    } catch (err) {
      recordFailure(engine);
      onProgress?.(`${engine} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // All engines failed — try visual fallback on DuckDuckGo
  onProgress?.("All engines failed, trying visual fallback...");
  const visualResults = await searchVisualFallback(query, maxResults, signal);
  if (visualResults.length > 0) {
    const r = { results: visualResults, source: "visual-fallback" };
    try { cacheSet(cacheKey, JSON.stringify(r), 300000); } catch {}
    return r;
  }

  return { results: [], source: "none" };
}

function getEngineOrder(preferred: SearchEngineId, configOrder: SearchEngineId[]): SearchEngineId[] {
  const order = [preferred, ...configOrder.filter(e => e !== preferred)];
  // Deduplicate
  return [...new Set(order)];
}

function engineDomain(engine: SearchEngineId): string {
  switch (engine) {
    case "duckduckgo": return "html.duckduckgo.com";
    case "google": return "www.google.com";
    case "bing": return "www.bing.com";
    case "brave": return "search.brave.com";
  }
}


// --- Per-engine search implementations ---
async function searchEngine(engine: SearchEngineId, query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  switch (engine) {
    case "duckduckgo": return searchDDG(query, max, signal);
    case "google": return searchGoogle(query, max, signal);
    case "bing": return searchBing(query, max, signal);
    case "brave": return searchBrave(query, max, signal);
  }
}

async function searchDDG(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { headers } = getConsistentUA(url);
  const res = await fetch(url, { headers, signal, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseDDG(await res.text(), max);
}

async function searchGoogle(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${max}&hl=en`;
  const { headers } = getConsistentUA(url);
  const res = await fetch(url, { headers, signal, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseGoogle(await res.text(), max);
}

async function searchBing(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${max}`;
  const { headers } = getConsistentUA(url);
  const res = await fetch(url, { headers, signal, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseBing(await res.text(), max);
}

async function searchBrave(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
  const { headers } = getConsistentUA(url);
  const res = await fetch(url, { headers, signal, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseBrave(await res.text(), max);
}


// --- HTML parsers for each engine ---
function parseDDG(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  let pos = 0;
  while (results.length < max) {
    const start = findMarker(html, pos, ['class="result results_links', 'class="result ']);
    if (start === -1) break;
    const next = findMarker(html, start + 1, ['class="result results_links', 'class="result ']);
    const block = html.slice(start, next !== -1 ? next : html.length);
    pos = next !== -1 ? next : html.length;
    const link = extractLink(block, "result__a", true);
    if (!link) continue;
    const snippet = extractByClass(block, "result__snippet");
    if (link.title && link.url.startsWith("http")) results.push({ ...link, snippet, engine: "duckduckgo" });
  }
  return results;
}

function parseGoogle(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  let pos = 0;
  while (results.length < max) {
    // Google wraps results in <div class="g"> or data-hveid markers
    const start = findMarker(html, pos, ['class="g"', 'class="g "']);
    if (start === -1) break;
    const next = findMarker(html, start + 10, ['class="g"', 'class="g "']);
    const block = html.slice(start, next !== -1 ? next : Math.min(start + 5000, html.length));
    pos = next !== -1 ? next : html.length;
    // Extract first <a href="..."> with a real URL
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/);
    if (!hrefMatch) continue;
    const url = hrefMatch[1];
    if (url.includes("google.com")) continue;
    // Extract <h3> for title
    const h3Match = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const title = h3Match ? h3Match[1].replace(/<[^>]*>/g, "").trim() : "";
    if (!title) continue;
    // Snippet: look for <span> after the URL block or data-content-feature
    const snippetMatch = block.match(/<span[^>]*class="[^"]*"[^>]*>([\s\S]{20,300}?)<\/span>/);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";
    results.push({ title, url, snippet, engine: "google" });
  }
  return results;
}

function parseBing(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  let pos = 0;
  while (results.length < max) {
    const start = findMarker(html, pos, ['class="b_algo"']);
    if (start === -1) break;
    const next = findMarker(html, start + 10, ['class="b_algo"']);
    const block = html.slice(start, next !== -1 ? next : Math.min(start + 4000, html.length));
    pos = next !== -1 ? next : html.length;
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/);
    if (!hrefMatch) continue;
    const url = hrefMatch[1];
    if (url.includes("bing.com") || url.includes("microsoft.com/bing")) continue;
    const titleEnd = block.indexOf("</a>", block.indexOf(hrefMatch[0]));
    const titleStart = block.lastIndexOf(">", titleEnd);
    const title = block.slice(titleStart + 1, titleEnd).replace(/<[^>]*>/g, "").trim();
    if (!title) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || block.match(/<span[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const snippet = snippetMatch ? (snippetMatch[1] || snippetMatch[2] || "").replace(/<[^>]*>/g, "").trim() : "";
    results.push({ title, url, snippet, engine: "bing" });
  }
  return results;
}

function parseBrave(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  let pos = 0;
  while (results.length < max) {
    const start = findMarker(html, pos, ['class="snippet', 'data-type="web"']);
    if (start === -1) break;
    const next = findMarker(html, start + 10, ['class="snippet', 'data-type="web"']);
    const block = html.slice(start, next !== -1 ? next : Math.min(start + 4000, html.length));
    pos = next !== -1 ? next : html.length;
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/);
    if (!hrefMatch) continue;
    const url = hrefMatch[1];
    if (url.includes("brave.com")) continue;
    const titleMatch = block.match(/<span[^>]*class="[^"]*snippet-title[^"]*"[^>]*>([\s\S]*?)<\/span>/) || block.match(/<div[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const title = titleMatch ? (titleMatch[1] || titleMatch[2] || "").replace(/<[^>]*>/g, "").trim() : "";
    if (!title) continue;
    const snippetMatch = block.match(/<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/) || block.match(/<div[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const snippet = snippetMatch ? (snippetMatch[1] || snippetMatch[2] || "").replace(/<[^>]*>/g, "").trim() : "";
    results.push({ title, url, snippet, engine: "brave" });
  }
  return results;
}


// --- Shared parsing utilities ---
function findMarker(html: string, from: number, markers: string[]): number {
  let earliest = -1;
  for (const m of markers) { const p = html.indexOf(m, from); if (p !== -1 && (earliest === -1 || p < earliest)) earliest = p; }
  return earliest;
}

function extractLink(block: string, className: string, decodeUddg: boolean): { title: string; url: string } | null {
  let cp = block.indexOf(`class="${className}"`);
  if (cp === -1) cp = block.indexOf(className);
  if (cp === -1) return null;
  const a = block.lastIndexOf("<a", cp);
  if (a === -1) return null;
  const hm = block.slice(a, cp + 200).match(/href="([^"]*)"/);
  if (!hm) return null;
  let href = hm[1];
  if (decodeUddg && href.includes("uddg=")) { const m = href.match(/uddg=([^&]+)/); if (m) href = decodeURIComponent(m[1]); }
  const te = block.indexOf(">", cp + className.length + 2);
  if (te === -1) return null;
  const cl = block.indexOf("</a>", te);
  if (cl === -1) return null;
  return { title: block.slice(te + 1, cl).replace(/<[^>]*>/g, "").trim(), url: href };
}

function extractByClass(block: string, className: string): string {
  const p = block.indexOf(className);
  if (p === -1) return "";
  const te = block.indexOf(">", p);
  if (te === -1) return "";
  let cl = block.indexOf("</a>", te);
  const ct = block.indexOf("</td>", te);
  const cs = block.indexOf("</span>", te);
  const cd = block.indexOf("</div>", te);
  if (ct !== -1 && (cl === -1 || ct < cl)) cl = ct;
  if (cs !== -1 && (cl === -1 || cs < cl)) cl = cs;
  if (cd !== -1 && (cl === -1 || cd < cl)) cl = cd;
  if (cl === -1) return "";
  return block.slice(te + 1, cl).replace(/<[^>]*>/g, "").trim();
}

// --- Visual fallback (DuckDuckGo via Puppeteer) ---
async function searchVisualFallback(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const { accessibilityText } = await visualParsePage(url, { timeout: 20000, fullPage: false, signal });
    const lines = accessibilityText.split("\n").filter(l => l.trim().length > 0);
    const results: SearchResult[] = [];
    for (let i = 0; i < lines.length && results.length < max; i++) {
      const line = lines[i].trim();
      if (line.startsWith("http://") || line.startsWith("https://")) {
        const title = i > 0 ? lines[i - 1].trim() : "";
        const snippet = i + 1 < lines.length ? lines[i + 1].trim() : "";
        if (title && !title.startsWith("http")) results.push({ title, url: line, snippet, engine: "duckduckgo" });
      }
    }
    return results;
  } catch { return []; }
}
