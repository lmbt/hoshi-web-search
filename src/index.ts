/**
 * hoshi-web-search — Pi coding agent extension
 * Provides web_search and web_fetch tools for LLM internet access.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "@sinclair/typebox";
import { webSearch, resetEngineHealth, getEngineHealthSnapshot } from "./web-search.js";
import { webFetch } from "./web-fetch.js";
import { closeBrowser } from "./visual-parser.js";
import { cacheClose, cacheClear, cachePrune, cacheStats } from "./cache.js";
import { resetRateLimiter } from "./rate-limiter.js";
import { resetRobotsCache } from "./robots.js";
import { resetUARotation } from "./user-agent.js";
import { loadConfig, resetConfig, type DetailMode, type SearchEngineId } from "./config.js";
import { formatSearchResults, formatFetchContent } from "./formatting.js";

const recentUrls: string[] = [];
const recentQueries: string[] = [];
let contextInjected = false;

function trackUrl(url: string): void { const i = recentUrls.indexOf(url); if (i !== -1) recentUrls.splice(i, 1); recentUrls.unshift(url); if (recentUrls.length > 50) recentUrls.pop(); }
function trackQuery(q: string): void { const i = recentQueries.indexOf(q); if (i !== -1) recentQueries.splice(i, 1); recentQueries.unshift(q); if (recentQueries.length > 30) recentQueries.pop(); }

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    resetRateLimiter(); resetRobotsCache(); resetUARotation(); resetEngineHealth(); resetConfig();
    cachePrune(); recentUrls.length = 0; recentQueries.length = 0; contextInjected = false;
  });

  pi.on("before_agent_start", async () => {
    if (contextInjected) return;
    contextInjected = true;
    return { message: { customType: "hoshi-web-search-context", content: "You have internet access via `web_search` and `web_fetch` tools. web_search supports multiple engines (DuckDuckGo, Google, Bing, Brave) with automatic failover. Use `includeContent: true` to fetch top results in one call. web_fetch auto-extracts YouTube transcripts and supports CSS selectors. Both tools support `detail` modes: lean (token-efficient), summary, or full.", display: false } };
  });


  // --- web_search tool ---
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the internet using multiple engines (DuckDuckGo, Google, Bing, Brave) with automatic failover. Use includeContent=true to also fetch readable content from top results in one call. Use detail parameter to control output verbosity.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (default: 10, max: 20)", minimum: 1, maximum: 20 })),
      engine: Type.Optional(StringEnum(["duckduckgo", "google", "bing", "brave"] as const, { description: "Force a specific search engine (default: auto with failover)" }) as unknown as TSchema),
      detail: Type.Optional(StringEnum(["lean", "summary", "full"] as const, { description: 'Output detail level: "lean" (default, token-efficient), "summary", or "full"' }) as unknown as TSchema),
      includeContent: Type.Optional(Type.Boolean({ description: "Fetch readable content from top results (default: false). Reduces round-trips." })),
    }),
    async execute(_id, params, signal, onUpdate, _ctx) {
      const { query, maxResults, engine: rawEngine, detail: rawDetail, includeContent } = params as { query: string; maxResults?: number; engine?: unknown; detail?: unknown; includeContent?: boolean };
      const config = loadConfig();
      const max = Math.min(maxResults ?? 10, 20);
      const engine = rawEngine as SearchEngineId | undefined;
      const detail = (rawDetail as DetailMode | undefined) ?? config.searchDetail;
      trackQuery(query);

      onUpdate?.({ content: [{ type: "text", text: `Searching for "${query}"...` }], details: { stage: "searching" } });

      const { results, source } = await webSearch(query, {
        maxResults: max, signal: signal ?? undefined, engine,
        onProgress: (msg) => onUpdate?.({ content: [{ type: "text", text: msg }], details: { stage: "progress" } }),
      });

      // includeContent: fetch top results concurrently
      let contentResults = results.map(r => ({ ...r, content: undefined as string | undefined }));
      if (includeContent && results.length > 0) {
        const topN = Math.min(3, results.length);
        onUpdate?.({ content: [{ type: "text", text: `Fetching content from top ${topN} results...` }], details: { stage: "content" } });
        const concurrency = config.maxContentConcurrency;
        const fetchPromises = results.slice(0, topN).map(async (r, i) => {
          try {
            const fetched = await webFetch(r.url, { format: "markdown", timeout: config.httpTimeoutMs, signal: signal ?? undefined, detail, onProgress: (msg) => onUpdate?.({ content: [{ type: "text", text: `[${i + 1}/${topN}] ${msg}` }], details: { stage: "content" } }) });
            return fetched.content;
          } catch { return undefined; }
        });
        // Simple concurrency limiter
        const contents: (string | undefined)[] = [];
        for (let i = 0; i < fetchPromises.length; i += concurrency) {
          const batch = fetchPromises.slice(i, i + concurrency);
          contents.push(...(await Promise.all(batch)));
        }
        contentResults = results.map((r, i) => ({ ...r, content: i < contents.length ? contents[i] : undefined }));
      }

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No results found for: "${query}"` }], details: { query, results: [], source } };
      }

      let text = formatSearchResults(contentResults, detail, query, source);
      const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      if (t.truncated) text = t.content + `\n\n[Truncated: ${t.outputLines} of ${t.totalLines} lines]`;

      return { content: [{ type: "text" as const, text }], details: { query, results, source, resultCount: results.length, detail, includeContent: !!includeContent } };
    },
    renderCall(args, theme) {
      const parts = [theme.fg("toolTitle", theme.bold("web_search ")), theme.fg("muted", `"${args.query}"`)];
      const e = args.engine as string | undefined; if (e) parts.push(theme.fg("dim", ` · ${e}`));
      const d = args.detail as string | undefined; if (d && d !== "lean") parts.push(theme.fg("dim", ` · ${d}`));
      if (args.includeContent) parts.push(theme.fg("warning", " · content"));
      return new Text(parts.join(""), 0, 0);
    },
    renderResult(result, options, theme) {
      if (options.isPartial) return new Text(theme.fg("muted", "Searching..."), 0, 0);
      const d = result.details as any;
      const count = d?.resultCount ?? 0, source = d?.source ?? "unknown";
      if (!options.expanded) return new Text(theme.fg("success", `${count} results`) + theme.fg("muted", ` via ${source}`), 0, 0);
      const rl = d?.results as Array<{ title: string }> | undefined;
      if (rl && rl.length > 0) {
        const lines = rl.slice(0, 5).map((r, i) => `  ${i + 1}. ${r.title}`).join("\n");
        return new Text(theme.fg("success", `${count} results`) + theme.fg("muted", ` via ${source}`) + "\n" + theme.fg("dim", lines + (rl.length > 5 ? `\n  ...${rl.length - 5} more` : "")), 0, 0);
      }
      return new Text(theme.fg("success", `${count} results`) + theme.fg("muted", ` via ${source}`), 0, 0);
    },
  });


  // --- web_fetch tool ---
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page as markdown, text, or HTML. Auto-extracts YouTube transcripts. Uses real browser UA with visual screenshot fallback. Supports CSS selectors and detail modes (lean/summary/full).",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch (http:// or https://)" }),
      format: Type.Optional(StringEnum(["markdown", "text", "html"] as const, { description: 'Output format (default: "markdown")' }) as unknown as TSchema),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30, max: 120)", minimum: 5, maximum: 120 })),
      forceVisual: Type.Optional(Type.Boolean({ description: "Force headless browser rendering" })),
      selector: Type.Optional(Type.String({ description: "CSS selector to extract specific content" })),
      respectRobots: Type.Optional(Type.Boolean({ description: "Check robots.txt before fetching (default: false)" })),
      detail: Type.Optional(StringEnum(["lean", "summary", "full"] as const, { description: 'Output detail: "lean", "summary" (default), or "full"' }) as unknown as TSchema),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, _ctx) {
      const { url, format: rawFmt, timeout, forceVisual, selector, respectRobots, detail: rawDetail } = params as { url: string; format?: unknown; timeout?: number; forceVisual?: boolean; selector?: string; respectRobots?: boolean; detail?: unknown };
      const config = loadConfig();
      const format = (rawFmt as "markdown" | "text" | "html" | undefined) ?? "markdown";
      const detail = (rawDetail as DetailMode | undefined) ?? config.fetchDetail;
      if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("URL must start with http:// or https://");
      trackUrl(url);
      const timeoutMs = Math.min((timeout ?? 30) * 1000, 120000);
      onUpdate?.({ content: [{ type: "text" as const, text: `Fetching ${url}...` }], details: { stage: "fetching" } });

      const result = await webFetch(url, { format, timeout: timeoutMs, signal: signal ?? undefined, forceVisual: forceVisual ?? false, selector, respectRobots: respectRobots ?? false, detail, onProgress: (msg) => onUpdate?.({ content: [{ type: "text" as const, text: msg }], details: { stage: "progress" } }) });

      let textContent = formatFetchContent(result.content, result.title, result.finalUrl, detail, result.method, result.cached ?? false);
      const tr = truncateHead(textContent, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      if (tr.truncated) textContent = tr.content + `\n\n[Truncated: ${tr.outputLines} of ${tr.totalLines} lines (${formatSize(tr.outputBytes)} of ${formatSize(tr.totalBytes)})]`;

      const details = { url, finalUrl: result.finalUrl, title: result.title, status: result.status, contentType: result.contentType, method: result.method, contentLength: result.content.length, truncated: tr.truncated, cached: result.cached ?? false, detail };
      if (result.screenshot) return { content: [{ type: "image" as const, data: result.screenshot, mimeType: "image/png" }, { type: "text" as const, text: textContent }], details };
      return { content: [{ type: "text" as const, text: textContent }], details };
    },
    renderCall(args, theme) {
      const p = [theme.fg("toolTitle", theme.bold("web_fetch ")), theme.fg("muted", String(args.url))];
      const f = args.format as string | undefined; if (f && f !== "markdown") p.push(theme.fg("dim", ` [${f}]`));
      if (args.forceVisual) p.push(theme.fg("warning", " [visual]"));
      if (args.selector) p.push(theme.fg("dim", ` → ${String(args.selector)}`));
      const d = args.detail as string | undefined; if (d && d !== "summary") p.push(theme.fg("dim", ` · ${d}`));
      return new Text(p.join(""), 0, 0);
    },
    renderResult(result, options, theme) {
      if (options.isPartial) return new Text(theme.fg("muted", "Fetching..."), 0, 0);
      const d = result.details as any;
      if (d?.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
      const p: string[] = []; if (d?.cached) p.push(theme.fg("muted", "(cached) "));
      p.push(theme.fg("success", d?.method === "visual" ? "visual" : d?.method === "youtube" ? "youtube" : "fetched"));
      if (d?.contentLength) p.push(theme.fg("muted", ` ${formatSize(d.contentLength)}`));
      if (d?.truncated) p.push(theme.fg("warning", " [truncated]"));
      if (options.expanded && d?.title) { p.push("\n" + theme.fg("dim", `  ${d.title}`)); if (d.finalUrl) p.push("\n" + theme.fg("dim", `  ${d.finalUrl}`)); }
      return new Text(p.join(""), 0, 0);
    },
  });


  // --- Slash commands ---
  pi.registerCommand("search", { description: "Search the web", getArgumentCompletions: (p: string) => { if (!p) return null; const m = recentQueries.filter(q => q.toLowerCase().startsWith(p.toLowerCase())); return m.length > 0 ? m.slice(0, 5).map(q => ({ value: q, label: q })) : null; }, handler: async (args, ctx) => { if (!args?.trim()) { ctx.ui.notify("Usage: /search <query>", "warning"); return; } const q = args.trim(); trackQuery(q); ctx.ui.notify(`Searching: ${q}`, "info"); const { results, source } = await webSearch(q, { maxResults: 5 }); if (!results.length) { ctx.ui.notify(`No results for: ${q}`, "info"); return; } pi.sendUserMessage(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n")); } });

  pi.registerCommand("fetch", { description: "Fetch a URL", getArgumentCompletions: (p: string) => { if (!p) return null; const m = recentUrls.filter(u => u.toLowerCase().startsWith(p.toLowerCase())); return m.length > 0 ? m.slice(0, 5).map(u => ({ value: u, label: u })) : null; }, handler: async (args, ctx) => { if (!args?.trim()) { ctx.ui.notify("Usage: /fetch <url>", "warning"); return; } const url = args.trim(); if (!url.startsWith("http://") && !url.startsWith("https://")) { ctx.ui.notify("URL must start with http:// or https://", "error"); return; } trackUrl(url); ctx.ui.notify(`Fetching ${url}...`, "info"); try { const r = await webFetch(url, { format: "markdown", timeout: 30000 }); const trunc = truncateHead(`**${r.title || "Untitled"}** (${r.finalUrl})\n---\n\n${r.content}`, { maxLines: 500, maxBytes: 50000 }); pi.sendUserMessage(trunc.content); } catch (e) { ctx.ui.notify(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`, "error"); } } });

  pi.registerCommand("cache-stats", { description: "Show cache statistics", handler: async (_a, ctx) => { const s = cacheStats(); ctx.ui.notify(`Cache: ${s.entries} entries, ${formatSize(s.sizeBytes)} on disk`, "info"); } });
  pi.registerCommand("cache-clear", { description: "Clear response cache", handler: async (_a, ctx) => { cacheClear(); ctx.ui.notify("Cache cleared", "info"); } });
  pi.registerCommand("engine-status", { description: "Show search engine health", handler: async (_a, ctx) => { const snap = getEngineHealthSnapshot(); const lines = snap.map(e => `${e.engine}: ok=${e.successes} fail=${e.failures} streak=${e.consecutiveFailures}${e.cooledDown ? " [COOLED DOWN]" : ""}`); ctx.ui.notify(lines.join("\n") || "No engine data yet", "info"); } });

  pi.on("session_shutdown", async () => { await closeBrowser(); cacheClose(); });
}
