/**
 * Visual page parsing using Puppeteer with screenshot compression and protocol-error fallback.
 */

import puppeteer, { type Browser, type Page } from "puppeteer";
import { getConsistentUA } from "./user-agent.js";

const MAX_SCREENSHOT_HEIGHT = 4000;
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_SCREENSHOT_BASE64_BYTES = 2 * 1024 * 1024;

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
const inflightPages = new Set<Page>();

async function getBrowser(): Promise<Browser> {
  if (browserInstance) { try { if (browserInstance.connected) return browserInstance; } catch { /* */ } browserInstance = null; }
  if (browserLaunchPromise) return browserLaunchPromise;
  browserLaunchPromise = puppeteer.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-software-rasterizer","--disable-extensions","--disable-background-networking","--disable-default-apps","--disable-sync","--disable-translate","--metrics-recording-only","--no-first-run"],
  }).then((browser) => {
    browserInstance = browser; browserLaunchPromise = null;
    browser.on("disconnected", () => { if (browserInstance === browser) browserInstance = null; });
    return browser;
  }).catch((err) => { browserLaunchPromise = null; throw err; });
  return browserLaunchPromise;
}

export interface VisualParseResult { screenshot: string; title: string; finalUrl: string; accessibilityText: string; }

export async function visualParsePage(url: string, options: { timeout?: number; viewport?: { width: number; height: number }; fullPage?: boolean; signal?: AbortSignal } = {}): Promise<VisualParseResult> {
  const { timeout = 30000, viewport = { width: MAX_SCREENSHOT_WIDTH, height: 900 }, fullPage = true, signal } = options;
  const browser = await getBrowser();
  const page = await browser.newPage();
  inflightPages.add(page);
  try {
    if (signal?.aborted) throw new Error("Aborted");
    const { userAgent, headers } = getConsistentUA(url);
    await page.setUserAgent(userAgent);
    await page.setViewport(viewport);
    const { "User-Agent": _ua, ...extraHeaders } = headers;
    await page.setExtraHTTPHeaders(extraHeaders);
    await page.goto(url, { waitUntil: "networkidle2", timeout });
    if (signal?.aborted) throw new Error("Aborted");
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    await page.evaluate((maxHeight: number) => new Promise<void>((resolve) => { let h = 0; const t = setInterval(() => { window.scrollBy(0, 400); h += 400; if (h >= document.body.scrollHeight || h > maxHeight) { clearInterval(t); window.scrollTo(0, 0); resolve(); } }, 80); }), MAX_SCREENSHOT_HEIGHT);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    if (signal?.aborted) throw new Error("Aborted");
    const title = await page.title();
    const finalUrl = page.url();
    const screenshot = await takeScreenshotSafe(page, fullPage, viewport);
    let accessibilityText = "";
    try {
      accessibilityText = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (node) => { const p = node.parentElement; if (!p) return NodeFilter.FILTER_REJECT; const s = window.getComputedStyle(p); if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return NodeFilter.FILTER_REJECT; if (["script","style","noscript","svg"].includes(p.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT; return NodeFilter.FILTER_ACCEPT; } });
        const texts: string[] = []; let n: Node | null; while ((n = walker.nextNode())) { const t = n.textContent?.trim(); if (t && t.length > 0) texts.push(t); } return texts.join("\n");
      });
    } catch { /* best-effort */ }
    return { screenshot, title, finalUrl, accessibilityText };
  } finally { inflightPages.delete(page); await page.close().catch(() => {}); }
}

async function takeScreenshotSafe(page: Page, fullPage: boolean, viewport: { width: number; height: number }): Promise<string> {
  let buffer: Buffer;
  if (fullPage) {
    try {
      const raw = await page.screenshot({ fullPage: true, type: "png", captureBeyondViewport: true });
      buffer = Buffer.from(raw);
      if (buffer.byteLength > MAX_SCREENSHOT_BASE64_BYTES) { const vr = await page.screenshot({ fullPage: false, type: "png" }); buffer = Buffer.from(vr); }
    } catch { try { const vr = await page.screenshot({ fullPage: false, type: "png" }); buffer = Buffer.from(vr); } catch { return ""; } }
  } else {
    try { const raw = await page.screenshot({ fullPage: false, type: "png", clip: { x: 0, y: 0, width: viewport.width, height: viewport.height } }); buffer = Buffer.from(raw); } catch { return ""; }
  }
  if (buffer.byteLength > MAX_SCREENSHOT_BASE64_BYTES) { try { const jr = await page.screenshot({ fullPage: false, type: "jpeg", quality: 60 }); buffer = Buffer.from(jr); } catch { /* use what we have */ } }
  return buffer.toString("base64");
}

export async function closeBrowser(): Promise<void> {
  if (inflightPages.size > 0) { const deadline = Date.now() + 5000; while (inflightPages.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200)); for (const p of inflightPages) await p.close().catch(() => {}); inflightPages.clear(); }
  if (browserInstance) { try { await browserInstance.close(); } catch { /* */ } browserInstance = null; }
  browserLaunchPromise = null;
}
