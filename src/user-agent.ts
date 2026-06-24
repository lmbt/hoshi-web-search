/**
 * Realistic browser user agents rotated to avoid bot detection.
 * These mirror real Chrome/Firefox/Safari strings from recent stable releases.
 *
 * IMPORTANT: Use `getConsistentUA()` to get a UA+headers pair that are fingerprint-matched.
 * This ensures the UA string, Sec-Ch-Ua-Platform, and Accept headers are all consistent.
 */

interface UAEntry {
  ua: string;
  platform: string;
  family: "chrome" | "firefox" | "safari" | "edge";
}

const UA_ENTRIES: UAEntry[] = [
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", platform: '"Windows"', family: "chrome" },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", platform: '"macOS"', family: "chrome" },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0", platform: '"Windows"', family: "firefox" },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0", platform: '"macOS"', family: "firefox" },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", platform: '"macOS"', family: "safari" },
  { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", platform: '"Linux"', family: "chrome" },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", platform: '"Windows"', family: "edge" },
];

let lastIndex = -1;

export interface ConsistentUA {
  userAgent: string;
  headers: Record<string, string>;
}

export function getConsistentUA(url: string): ConsistentUA {
  lastIndex = (lastIndex + 1) % UA_ENTRIES.length;
  const entry = UA_ENTRIES[lastIndex];
  const headers = buildHeaders(url, entry);
  return { userAgent: entry.ua, headers };
}

export function resetUARotation(): void {
  lastIndex = -1;
}

function buildHeaders(url: string, entry: UAEntry): Record<string, string> {
  const parsed = new URL(url);
  const headers: Record<string, string> = {
    "User-Agent": entry.ua,
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    Referer: `${parsed.protocol}//${parsed.host}/`,
  };

  switch (entry.family) {
    case "firefox":
      headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
      headers["Accept-Encoding"] = "gzip, deflate";
      headers["Sec-Fetch-Dest"] = "document";
      headers["Sec-Fetch-Mode"] = "navigate";
      headers["Sec-Fetch-Site"] = "none";
      headers["Sec-Fetch-User"] = "?1";
      break;
    case "safari":
      headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
      headers["Accept-Encoding"] = "gzip, deflate";
      break;
    case "chrome":
    case "edge":
      headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
      headers["Accept-Encoding"] = "gzip, deflate";
      headers["Sec-Ch-Ua"] = entry.family === "edge"
        ? '"Chromium";v="130", "Microsoft Edge";v="130", "Not?A_Brand";v="99"'
        : '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"';
      headers["Sec-Ch-Ua-Mobile"] = "?0";
      headers["Sec-Ch-Ua-Platform"] = entry.platform;
      headers["Sec-Fetch-Dest"] = "document";
      headers["Sec-Fetch-Mode"] = "navigate";
      headers["Sec-Fetch-Site"] = "none";
      headers["Sec-Fetch-User"] = "?1";
      break;
  }
  return headers;
}
