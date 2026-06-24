/**
 * Per-domain rate limiter with LRU eviction.
 */

const DEFAULT_DOMAIN_DELAY_MS = 1000;
const MAX_DOMAINS = 200;
const domainTimestamps = new Map<string, number>();

export async function rateLimitWait(url: string, delayMs: number = DEFAULT_DOMAIN_DELAY_MS): Promise<void> {
  const domain = extractDomain(url);
  const lastTime = domainTimestamps.get(domain);
  const now = Date.now();
  if (lastTime) {
    const elapsed = now - lastTime;
    if (elapsed < delayMs) await sleep(delayMs - elapsed);
  }
  domainTimestamps.delete(domain);
  domainTimestamps.set(domain, Date.now());
  if (domainTimestamps.size > MAX_DOMAINS) {
    const excess = domainTimestamps.size - MAX_DOMAINS;
    let removed = 0;
    for (const key of domainTimestamps.keys()) { if (removed >= excess) break; domainTimestamps.delete(key); removed++; }
  }
}

export function resetRateLimiter(): void { domainTimestamps.clear(); }

function extractDomain(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
