# hoshi-web-search

A [Pi coding agent](https://pi.dev) extension providing web search and fetch tools for the LLM. Runs locally without MCP or paid APIs, uses real browser user agents, supports multiple search engines with automatic failover, extracts YouTube transcripts, and falls back to visual screenshot parsing when text extraction fails.

## Features

- **`web_search`** — Multi-engine search (DuckDuckGo, Google, Bing, Brave) with automatic failover and health tracking
- **`web_fetch`** — Fetch URLs as markdown/text/HTML with CSS selector support and YouTube transcript extraction
- **`includeContent`** — Search + fetch top results in a single tool call (reduces LLM round-trips)
- **Detail modes** — `lean` (token-efficient), `summary`, or `full` output on both tools
- **YouTube transcripts** — Auto-detects YouTube URLs and extracts transcripts via Innertube API (no API key, no yt-dlp)
- **Real browser UAs** — Fingerprint-matched Chrome/Firefox/Safari/Edge rotation
- **Visual fallback** — Headless Chromium screenshot + DOM text extraction with JPEG compression
- **SSRF protection** — Blocks private/internal IPs
- **SQLite cache** — TTL-based response caching
- **Rate limiting** — Per-domain throttle with robots.txt crawl-delay integration
- **Engine health tracking** — Per-engine success/failure/cooldown with automatic failover
- **JSON config file** — Tune all behavior via `~/.pi/hoshi-web-search/config.json` or project-local config
- **Output truncation** — Respects Pi context limits
- **TUI rendering** — Custom renderCall/renderResult with expanded/partial states
- **Slash commands** — `/search`, `/fetch`, `/cache-stats`, `/cache-clear`, `/engine-status`

## Installation

```bash
pi install git:github.com/lmbt/hoshi-web-search
```

Or manually:

```bash
git clone https://github.com/lmbt/hoshi-web-search ~/.pi/agent/extensions/hoshi-web-search
cd ~/.pi/agent/extensions/hoshi-web-search && npm install
```

Dev/testing:

```bash
pi -e ./src/index.ts
```

## Requirements

- **Node.js** >= 22.0.0
- **Pi** with `@earendil-works/pi-coding-agent`
- **Chromium** — automatically managed by Puppeteer (downloads on `npm install`)

## Tools

### `web_search`

Search the internet with automatic engine failover.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | — | Search query |
| `maxResults` | number | No | 10 | Max results (1–20) |
| `engine` | string | No | auto | Force engine: `"duckduckgo"`, `"google"`, `"bing"`, or `"brave"` |
| `detail` | string | No | `"lean"` | Output verbosity: `"lean"`, `"summary"`, or `"full"` |
| `includeContent` | boolean | No | false | Fetch readable content from top 3 results in the same call |

### `web_fetch`

Fetch a web page with YouTube auto-detection and visual fallback.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | — | URL to fetch |
| `format` | string | No | `"markdown"` | `"markdown"`, `"text"`, or `"html"` |
| `timeout` | number | No | 30 | Seconds (5–120) |
| `forceVisual` | boolean | No | false | Force headless browser rendering |
| `selector` | string | No | — | CSS selector to extract specific content |
| `respectRobots` | boolean | No | false | Check robots.txt before fetching |
| `detail` | string | No | `"summary"` | Output verbosity: `"lean"`, `"summary"`, or `"full"` |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/search <q>` | Search and send results as a user message |
| `/fetch <url>` | Fetch URL content as a user message |
| `/cache-stats` | Show cache entry count and size |
| `/cache-clear` | Clear all cached responses |
| `/engine-status` | Show per-engine health: successes, failures, cooldown state |

Commands support autocompletion of recently used queries/URLs.

## Detail Modes

Control how much content is sent to the LLM to manage token costs:

| Mode | `web_search` behavior | `web_fetch` behavior |
|------|----------------------|---------------------|
| `lean` | Compact result list, short snippets, minimal framing | ~800 char excerpt |
| `summary` | Results with snippets, inline content excerpts (500 chars) | ~2000 char excerpt with metadata |
| `full` | Full snippets + complete fetched content (indented) | Full page content with headers |

Default detail modes are configurable in the JSON config file.

## Configuration

Create `~/.pi/hoshi-web-search/config.json` for global settings:

```json
{
  "preferredEngine": "duckduckgo",
  "engineOrder": ["duckduckgo", "google", "bing", "brave"],
  "searchDetail": "lean",
  "fetchDetail": "summary",
  "httpTimeoutMs": 30000,
  "rateLimitMs": 1000,
  "locale": "en-US"
}
```

Project-local override (walks up from cwd): `.pi/hoshi-web-search.json`

### Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `preferredEngine` | `"duckduckgo"` \| `"google"` \| `"bing"` \| `"brave"` | `"duckduckgo"` | First engine to try |
| `engineOrder` | string[] | `["duckduckgo","google","bing","brave"]` | Failover order after preferred engine |
| `engineFailureThreshold` | number | `2` | Consecutive failures before engine is cooled down |
| `engineCooldownMs` | number | `600000` | How long (ms) a failed engine is skipped (10 min) |
| `searchDetail` | `"lean"` \| `"summary"` \| `"full"` | `"lean"` | Default detail mode for `web_search` |
| `fetchDetail` | `"lean"` \| `"summary"` \| `"full"` | `"summary"` | Default detail mode for `web_fetch` |
| `httpTimeoutMs` | number | `30000` | HTTP fetch timeout (ms) |
| `browserTimeoutMs` | number | `30000` | Puppeteer navigation timeout (ms) |
| `rateLimitMs` | number | `1000` | Minimum delay between requests to the same domain (ms) |
| `maxContentConcurrency` | number | `2` | Max parallel content fetches for `includeContent` |
| `includeContentMinScore` | number | `0` | Minimum relevance threshold for content fetching |
| `locale` | string | `"en-US"` | Locale hint for search engines |
| `userAgent` | string \| null | `null` | Custom UA override (null = use built-in rotation) |

## Environment Variables

No environment variables are required. The following are respected if set:

| Variable | Effect |
|----------|--------|
| `PUPPETEER_EXECUTABLE_PATH` | Custom Chromium binary path for visual parser |
| `PUPPETEER_CACHE_DIR` | Directory for Puppeteer's browser download |
| `HOME` / `USERPROFILE` | Resolves `~/.pi/hoshi-web-search/` for cache and config |

## How It Works

### Search Pipeline

1. Check cache for identical recent query
2. Determine engine order (preferred → failover list, skip cooled-down engines)
3. Rate-limit per domain
4. Try each engine in order until one succeeds
5. If all engines fail, try visual fallback via Puppeteer on DuckDuckGo
6. Cache successful results (10 min TTL)
7. If `includeContent: true`, concurrently fetch top 3 results and include excerpts

### Fetch Pipeline

1. SSRF check (block private IPs)
2. YouTube detection → extract transcript via Innertube API
3. Cache check (15 min TTL)
4. robots.txt check (opt-in)
5. Rate limit with crawl-delay integration
6. Standard HTTP fetch with retry (up to 3 attempts with exponential backoff)
7. Content validation (detect CAPTCHA/block pages, check body even on 403/429)
8. Visual fallback with compressed screenshot if text extraction fails
9. Apply detail mode formatting before returning

### Engine Health Tracking

Each search engine is tracked independently:
- **Success** resets the failure streak
- **Failure** increments consecutive failure counter
- After `engineFailureThreshold` consecutive failures, the engine is **cooled down** for `engineCooldownMs`
- Cooled-down engines are skipped in the failover chain
- Use `/engine-status` to inspect current state
- State resets on session start

### YouTube Transcript Extraction

When `web_fetch` receives a YouTube URL:
1. Fetches the watch page to extract the Innertube API key
2. POSTs to the Innertube player endpoint to get caption track metadata
3. Fetches the transcript XML and parses it to plain text
4. Falls back to video description if no captions are available
5. No API key, no yt-dlp, no browser automation required

## Architecture

```
src/
  index.ts            Entry point — registers tools, commands, events
  web-search.ts       Multi-engine search with failover, health tracking, visual fallback
  web-fetch.ts        URL fetching with YouTube detection, retry, visual fallback
  youtube.ts          YouTube transcript extraction via Innertube API
  config.ts           JSON config loader (global + project-local)
  formatting.ts       Detail mode formatting (lean/summary/full)
  user-agent.ts       Structured UA rotation with per-entry platform matching
  html-to-markdown.ts HTML→Markdown (linkedom + turndown) with selector support
  visual-parser.ts    Puppeteer screenshots with compression and error recovery
  cache.ts            SQLite cache with WAL mode and busy_timeout
  rate-limiter.ts     Per-domain throttle with LRU eviction
  robots.ts           robots.txt parser with longest-match precedence
  ssrf.ts             Private IP blocking with DNS resolution check
```

## Usage Patterns

```text
# Quick search (cheapest — lean output, no content fetch)
web_search({ query: "TypeScript 5.7 new features" })

# Search + read top results in one call
web_search({ query: "React server components", includeContent: true })

# Force a specific engine
web_search({ query: "Python asyncio docs", engine: "google" })

# Full verbosity for deep research
web_search({ query: "Kubernetes pod scheduling", detail: "full", includeContent: true })

# Fetch a page (summary mode by default)
web_fetch({ url: "https://docs.python.org/3/library/asyncio.html" })

# Fetch with full content
web_fetch({ url: "https://example.com/docs", detail: "full" })

# YouTube transcript
web_fetch({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })

# Extract specific section
web_fetch({ url: "https://docs.python.org/3/library/asyncio.html", selector: "#coroutines" })

# JS-heavy page
web_fetch({ url: "https://some-spa.app", forceVisual: true })
```

## Development

```bash
git clone https://github.com/lmbt/hoshi-web-search
cd hoshi-web-search
npm install
npx tsc --noEmit   # Type-check
pi -e ./src/index.ts  # Test with Pi
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
