/**
 * HTML to clean markdown conversion with CSS selector support.
 */

import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const STRIP_SELECTORS = ["script","style","noscript","iframe","svg","nav","footer","header","aside","form","button","input","select","textarea"];
const STRIP_ATTR_SELECTORS = ["[role='navigation']","[role='banner']","[role='complementary']","[aria-hidden='true']"];
const STRIP_CLASS_SELECTORS = [".cookie-banner",".cookie-consent",".advertisement",".ad",".ads",".social-share",".share-buttons",".popup",".modal"];

export function htmlToMarkdown(html: string, url?: string, selector?: string): string {
  const { document } = parseHTML(html);
  if (selector) {
    try {
      const selected = document.querySelectorAll(selector);
      if (selected.length > 0) {
        const fragments: string[] = [];
        for (const el of selected) fragments.push(el.innerHTML);
        return convertToMarkdown(fragments.join("\n"), url);
      }
    } catch { /* fall through */ }
  }
  stripElements(document);
  const main = document.querySelector("main") || document.querySelector("article") || document.querySelector('[role="main"]') || document.querySelector("#content") || document.querySelector(".content") || document.body;
  return convertToMarkdown(main?.innerHTML || document.body?.innerHTML || html, url);
}

export function extractTitle(html: string): string | null {
  const { document } = parseHTML(html);
  const og = document.querySelector('meta[property="og:title"]');
  if (og) { const c = og.getAttribute("content"); if (c) return c.trim(); }
  const title = document.querySelector("title");
  return title?.textContent?.trim() || null;
}

export function htmlToText(html: string, selector?: string): string {
  const { document } = parseHTML(html);
  if (selector) {
    try {
      const selected = document.querySelectorAll(selector);
      if (selected.length > 0) { const texts: string[] = []; for (const el of selected) texts.push(el.textContent || ""); return texts.join("\n\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(); }
    } catch { /* fall through */ }
  }
  stripElements(document);
  const main = document.querySelector("main") || document.querySelector("article") || document.querySelector('[role="main"]') || document.body;
  const text = main?.textContent || document.body?.textContent || "";
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stripElements(document: any): void {
  for (const sel of [...STRIP_SELECTORS, ...STRIP_ATTR_SELECTORS, ...STRIP_CLASS_SELECTORS]) {
    try { const els = document.querySelectorAll(sel); for (const el of els) el.remove(); } catch { /* */ }
  }
}

function convertToMarkdown(html: string, url: string | undefined): string {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_", strongDelimiter: "**" });
  turndown.addRule("links", {
    filter: "a",
    replacement: (content, node) => {
      const el = node as unknown as { getAttribute(name: string): string | null };
      const href = el.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return content;
      let resolved = href;
      if (url && !href.startsWith("http")) { try { resolved = new URL(href, url).toString(); } catch { /* */ } }
      return content ? `[${content}](${resolved})` : "";
    },
  });
  turndown.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as unknown as { getAttribute(name: string): string | null };
      const alt = el.getAttribute("alt"); const src = el.getAttribute("src");
      if (alt && src) { let resolved = src; if (url && !src.startsWith("http")) { try { resolved = new URL(src, url).toString(); } catch { /* */ } } return `![${alt}](${resolved})`; }
      return alt ? `[Image: ${alt}]` : "";
    },
  });
  let md = turndown.turndown(html);
  return md.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim();
}
