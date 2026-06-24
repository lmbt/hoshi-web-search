/**
 * Output formatting with detail modes (lean / summary / full).
 * Controls how much content is returned to the LLM for token efficiency.
 */

import type { DetailMode } from "./config.js";

export interface SearchResultFormatted {
  title: string;
  url: string;
  snippet: string;
  content?: string; // Only when includeContent is used
}

/**
 * Format search results based on detail level.
 */
export function formatSearchResults(results: SearchResultFormatted[], detail: DetailMode, query: string, source: string): string {
  if (results.length === 0) return `No results found for: "${query}"`;

  const header = detail === "full"
    ? `Search results for "${query}" (${results.length} results via ${source}):\n\n`
    : `"${query}" — ${results.length} results (${source}):\n\n`;

  const formatted = results.map((r, i) => {
    switch (detail) {
      case "lean":
        return `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${truncateSnippet(r.snippet, 120)}` : ""}`;
      case "summary":
        return `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}${r.content ? `\n   ---\n   ${truncateSnippet(r.content, 500)}` : ""}`;
      case "full":
        return `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}${r.content ? `\n\n   **Content:**\n${indentContent(r.content)}` : ""}`;
    }
  }).join("\n\n");

  return header + formatted;
}

/**
 * Format fetched page content based on detail level.
 */
export function formatFetchContent(content: string, title: string | null, url: string, detail: DetailMode, method: string, cached: boolean): string {
  const statusLine = `${method}${cached ? " (cached)" : ""}`;

  switch (detail) {
    case "lean": {
      const excerpt = truncateSnippet(content, 800);
      return `**${title || "Untitled"}** — ${url}\n${statusLine}\n---\n${excerpt}`;
    }
    case "summary": {
      const excerpt = truncateSnippet(content, 2000);
      return `**${title || "Untitled"}**\nURL: ${url}\nMethod: ${statusLine}\n---\n\n${excerpt}`;
    }
    case "full":
      return `**${title || "Untitled"}**\nURL: ${url}\nMethod: ${statusLine}\n---\n\n${content}`;
  }
}

function truncateSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd() + "...";
}

function indentContent(content: string): string {
  return content.split("\n").map(l => `   ${l}`).join("\n");
}
