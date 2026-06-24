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

## License

Apache-2.0
