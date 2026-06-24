# hoshi-web-search

A [Pi coding agent](https://pi.dev) extension providing web search and fetch tools for the LLM. Runs locally without MCP, uses real browser user agents, and falls back to visual screenshot parsing when text extraction fails.

## Features

- **`web_search`** — DuckDuckGo search (no API key)
- **`web_fetch`** — Fetch URLs as markdown/text/HTML with CSS selector support
- **Real browser UAs** — Fingerprint-matched Chrome/Firefox/Safari/Edge rotation
- **Visual fallback** — Headless Chromium screenshot + DOM text extraction
- **SSRF protection** — Blocks private/internal IPs
- **SQLite cache** — TTL-based response caching
- **Rate limiting** — Per-domain throttle with robots.txt crawl-delay
- **Output truncation** — Respects Pi context limits
- **TUI rendering** — Custom renderCall/renderResult
- **Slash commands** — `/search`, `/fetch`, `/cache-stats`, `/cache-clear`

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
- **Pi** with `@earendil-works/pi-coding-agent` (any recent version)
- **Chromium** — automatically managed by Puppeteer (downloads on `npm install`)

## Environment Variables

This extension does not require any environment variables. However, the following standard variables are respected if set:

| Variable | Effect |
|----------|--------|
| `PUPPETEER_EXECUTABLE_PATH` | Custom path to a Chromium/Chrome binary for the visual parser. Overrides Puppeteer's bundled browser. Useful in Docker or CI where you pre-install Chromium. |
| `PUPPETEER_CACHE_DIR` | Directory where Puppeteer stores its browser download. Defaults to `~/.cache/puppeteer`. |
| `HOME` / `USERPROFILE` | Used to resolve `~/.pi/hoshi-web-search/cache.db` for the SQLite cache location. |
| `NO_COLOR` | If set, Puppeteer respects this for its internal logging (does not affect extension TUI rendering — Pi handles that). |

> **Note:** No API keys are needed. Search uses DuckDuckGo's public HTML interface. Visual parsing uses Puppeteer's bundled Chromium.

## Configuration

### Cache Location

The SQLite response cache is stored at:

```
~/.pi/hoshi-web-search/cache.db
```

This directory is created automatically on first use. To move it, symlink the directory:

```bash
ln -s /path/to/custom/location ~/.pi/hoshi-web-search
```

### Cache Behavior

| Setting | Value | Notes |
|---------|-------|-------|
| Fetch TTL | 15 minutes | How long `web_fetch` results are cached |
| Search TTL | 10 minutes | How long `web_search` results are cached |
| Max entries | 5,000 | Oldest entries are pruned when exceeded |
| Max entry size | 1 MB | Larger responses are not cached |
| DB timeout | 5 seconds | Max time to wait if DB is locked by another process |

Use `/cache-stats` to check current usage and `/cache-clear` to wipe the cache.

### Rate Limiting

| Setting | Value | Notes |
|---------|-------|-------|
| Default delay | 1,000 ms | Minimum interval between requests to the same domain |
| Max tracked domains | 200 | LRU eviction when exceeded |
| Crawl-delay integration | Enabled | When `respectRobots: true`, uses the site's `Crawl-delay` directive (capped at 10s) |

Rate limiting is automatic and per-domain. The extension will never hammer a single site with rapid requests.

### Visual Parser (Puppeteer)

| Setting | Value | Notes |
|---------|-------|-------|
| Max screenshot height | 4,000 px | Scroll limit for lazy-loading trigger |
| Max screenshot size | 2 MB (base64) | Falls back to viewport-only or JPEG if exceeded |
| JPEG fallback quality | 60% | Used when PNG is too large |
| Viewport | 1280 x 900 | Default rendering viewport |
| Network idle timeout | 30 seconds | Max wait for page load |
| Browser launch args | `--no-sandbox`, etc. | Safe for Docker/CI (no setuid needed) |

The Chromium browser instance is shared across calls and automatically relaunched if it disconnects.

### SSRF Protection

The following are **always blocked** (cannot be disabled):

- `localhost`, `localhost.localdomain`, `ip6-localhost`, `ip6-loopback`
- IPv4 private ranges: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- IPv4 link-local: `169.254.0.0/16`
- IPv4 reserved: `0.0.0.0/8`, `224.0.0.0/4`, `240.0.0.0/4`
- IPv6: `::1`, `::`, `fe80::/10`, `fc00::/7`
- IPv4-mapped IPv6 (`::ffff:x.x.x.x`) — the mapped address is also checked

DNS resolution is performed before each request to catch hostnames that resolve to private IPs. Redirect targets are also checked.

### Output Truncation

Tool output is truncated using Pi's built-in `truncateHead` utility to prevent context overflow. The limits match Pi's defaults:

- **Max lines:** 2,000
- **Max bytes:** ~100 KB (Pi's `DEFAULT_MAX_BYTES`)

When truncation occurs, a notice is appended indicating how much content was cut.

## Tools

### `web_search`

| Parameter    | Type   | Required | Default | Description |
| ------------ | ------ | -------- | ------- | ----------- |
| `query`      | string | Yes      | —       | Search query |
| `maxResults` | number | No       | 10      | Max results (1–20) |

### `web_fetch`

| Parameter       | Type    | Required | Default      | Description |
| --------------- | ------- | -------- | ------------ | ----------- |
| `url`           | string  | Yes      | —            | URL to fetch |
| `format`        | string  | No       | `"markdown"` | `"markdown"`, `"text"`, or `"html"` |
| `timeout`       | number  | No       | 30           | Seconds (5–120) |
| `forceVisual`   | boolean | No       | false        | Force headless browser rendering |
| `selector`      | string  | No       | —            | CSS selector to extract specific content |
| `respectRobots` | boolean | No       | false        | Check robots.txt before fetching |

## Slash Commands

| Command        | Description |
| -------------- | ----------- |
| `/search <q>`  | Search and send results as a user message |
| `/fetch <url>` | Fetch URL content as a user message |
| `/cache-stats` | Show cache entry count and size |
| `/cache-clear` | Clear all cached responses |

Commands support autocompletion of recently used queries/URLs.

## Architecture

```
src/
  index.ts            Entry point — registers tools, commands, events
  web-search.ts       DuckDuckGo search with iterative HTML parser
  web-fetch.ts        URL fetching with retry and visual fallback
  user-agent.ts       Structured UA rotation with per-entry platform matching
  html-to-markdown.ts HTML→Markdown (linkedom + turndown) with selector support
  visual-parser.ts    Puppeteer screenshots with compression and error recovery
  cache.ts            SQLite cache with WAL mode and busy_timeout
  rate-limiter.ts     Per-domain throttle with LRU eviction
  robots.ts           robots.txt parser with longest-match precedence
  ssrf.ts             Private IP blocking with DNS resolution check
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
