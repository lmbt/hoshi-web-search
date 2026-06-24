/**
 * Web fetch tool: fetches URLs with retry, SSRF protection, cache, visual fallback,
 * YouTube transcript detection, and detail mode support.
 */

import { getConsistentUA } from "./user-agent.js";
import { htmlToMarkdown, htmlToText, extractTitle } from "./html-to-markdown.js";
import { visualParsePage } from "./visual-parser.js";
import { rateLimitWait } from "./rate-limiter.js";
import { isAllowedByRobots, getRobotsCrawlDelay } from "./robots.js";
import { cacheGet, cacheSet, makeCacheKey } from "./cache.js";
import { checkSSRF } from "./ssrf.js";
import { loadConfig, type DetailMode } from "./config.js";
import { isYouTubeUrl, fetchYouTubeTranscript } from "./youtube.js";

export type FetchFormat = "markdown" | "text" | "html";
export interface FetchResult { content: string; title: string | null; finalUrl: string; status: number; contentType: string; method: "fetch" | "visual" | "youtube"; screenshot?: string; cached?: boolean; }

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1500;

export interface WebFetchOptions { format?: FetchFormat; timeout?: number; signal?: AbortSignal; forceVisual?: boolean; respectRobots?: boolean; selector?: string; detail?: DetailMode; onProgress?: (message: string) => void; }

export async function webFetch(url: string, options: WebFetchOptions = {}): Promise<FetchResult> {
  const config = loadConfig();
  const { format = "markdown", timeout = config.httpTimeoutMs, signal, forceVisual = false, respectRobots = false, selector, onProgress } = options;
  if (signal?.aborted) throw new Error("Aborted");

  const ssrfError = await checkSSRF(url);
  if (ssrfError) throw new Error(ssrfError);

  // YouTube special handling
  if (isYouTubeUrl(url) && !forceVisual) {
    onProgress?.("Extracting YouTube transcript...");
    try {
      const yt = await fetchYouTubeTranscript(url, signal);
      const content = yt.hasTranscript
        ? `# ${yt.title}\n\n${yt.transcript}`
        : `# ${yt.title}\n\n_No transcript available. Video description:_\n\n${yt.transcript}`;
      return { content, title: yt.title, finalUrl: url, status: 200, contentType: "text/plain", method: "youtube" };
    } catch (err) {
      onProgress?.(`YouTube extraction failed: ${err instanceof Error ? err.message : String(err)}, falling back to normal fetch...`);
    }
  }

  // Cache check
  if (!forceVisual && format !== "html") {
    const ck = makeCacheKey("fetch", url, { format, selector });
    const cached = cacheGet(ck);
    if (cached) { const p = JSON.parse(cached) as FetchResult; p.cached = true; return p; }
  }

  if (respectRobots) {
    onProgress?.("Checking robots.txt...");
    if (!(await isAllowedByRobots(url))) return { content: `[Blocked by robots.txt] ${url} is disallowed`, title: null, finalUrl: url, status: 0, contentType: "", method: "fetch" };
  }

  if (forceVisual) { onProgress?.("Rendering page in headless browser..."); return fetchVisual(url, timeout, signal); }

  // Rate limit with crawl-delay
  let delayMs = config.rateLimitMs;
  if (respectRobots) { const cd = await getRobotsCrawlDelay(url); if (cd && cd > delayMs) delayMs = Math.min(cd, 10000); }
  await rateLimitWait(url, delayMs);

  // Retry loop
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    if (attempt > 0) { const d = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1); onProgress?.(`Retrying (${attempt + 1}/${MAX_RETRIES + 1}) after ${d}ms...`); await sleep(d); }
    else onProgress?.(`Fetching ${url}...`);
    try {
      const result = await fetchStandard(url, format, timeout, signal, selector);
      if (isUsableContent(result.content, result.status, result.contentType)) {
        if (format !== "html" && !result.screenshot) { try { cacheSet(makeCacheKey("fetch", url, { format, selector }), JSON.stringify(result)); } catch {} }
        return result;
      }
      lastError = new Error("Content appears blocked or unusable");
    } catch (err) { lastError = err instanceof Error ? err : new Error(String(err)); }
  }

  onProgress?.("Text fetch failed, rendering page visually...");
  try { return await fetchVisual(url, timeout, signal); } catch (ve) { throw lastError || ve; }
}


async function fetchStandard(url: string, format: FetchFormat, timeout: number, signal?: AbortSignal, selector?: string): Promise<FetchResult> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout);
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener("abort", () => controller.abort(), { once: true }); }
  try {
    const { headers } = getConsistentUA(url);
    const response = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
    const contentType = response.headers.get("content-type") || "";
    const finalUrl = response.url;
    const rssrf = await checkSSRF(finalUrl);
    if (rssrf) throw new Error(`Redirect blocked: ${rssrf}`);
    const cl = response.headers.get("content-length");
    if (cl && parseInt(cl, 10) > MAX_RESPONSE_BYTES) throw new Error(`Response too large: ${cl} bytes`);
    if (isBinaryContentType(contentType)) throw new Error(`Binary content type: ${contentType}`);
    const body = await readBodyLimited(response, MAX_RESPONSE_BYTES);
    if (!contentType.includes("html") && !contentType.includes("xml")) {
      let content = body;
      if (contentType.includes("json")) { try { content = JSON.stringify(JSON.parse(body), null, 2); } catch {} }
      return { content, title: null, finalUrl, status: response.status, contentType, method: "fetch" };
    }
    const title = extractTitle(body);
    let content: string;
    switch (format) { case "markdown": content = htmlToMarkdown(body, finalUrl, selector); break; case "text": content = htmlToText(body, selector); break; case "html": content = body; break; default: content = htmlToMarkdown(body, finalUrl, selector); }
    return { content, title, finalUrl, status: response.status, contentType, method: "fetch" };
  } finally { clearTimeout(tid); }
}

async function fetchVisual(url: string, timeout: number, signal?: AbortSignal): Promise<FetchResult> {
  const r = await visualParsePage(url, { timeout, signal });
  return { content: r.accessibilityText || "[Visual content — see screenshot]", title: r.title, finalUrl: r.finalUrl, status: 200, contentType: "text/html", method: "visual", screenshot: r.screenshot };
}

async function readBodyLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const decoder = new TextDecoder(); const chunks: string[] = []; let total = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > maxBytes) { const keep = value.byteLength - (total - maxBytes); if (keep > 0) chunks.push(decoder.decode(value.slice(0, keep), { stream: true })); break; } chunks.push(decoder.decode(value, { stream: true })); } } finally { reader.cancel().catch(() => {}); }
  chunks.push(decoder.decode(new Uint8Array(0), { stream: false }));
  return chunks.join("");
}

function isUsableContent(content: string, status: number, contentType: string): boolean {
  if (!contentType.includes("html") && !contentType.includes("xml")) return content.trim().length > 0;
  const stripped = content.replace(/<[^>]*>/g, "").trim().length;
  if (stripped < 30) return false;
  const indicators = ["captcha","are you human","access denied","please verify you","checking your browser","enable javascript to continue","please enable cookies","just a moment","attention required","cf-browser-verification","challenge-platform"];
  const lower = content.toLowerCase().slice(0, 5000);
  let mc = 0; for (const i of indicators) if (lower.includes(i)) mc++;
  if (status === 403 || status === 429 || status === 503) { if (mc >= 2) return false; if (mc >= 1 && stripped < 1000) return false; return true; }
  if (stripped < 5000) { if (mc >= 2) return false; if (mc >= 1 && stripped < 500) return false; }
  return true;
}

function isBinaryContentType(ct: string): boolean { return ["application/pdf","application/zip","application/gzip","application/octet-stream","application/x-tar","image/","video/","audio/","application/wasm"].some(t => ct.toLowerCase().includes(t)); }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
