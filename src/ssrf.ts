/**
 * SSRF (Server-Side Request Forgery) protection.
 * Blocks requests to private/internal network ranges.
 */

import { lookup } from "node:dns/promises";

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

export async function checkSSRF(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) return `Blocked: "${hostname}" is a local address`;
    if (isPrivateIP(hostname)) return `Blocked: ${hostname} is a private/reserved IP address`;
    try {
      const result = await lookup(hostname);
      if (isPrivateIP(result.address)) return `Blocked: ${hostname} resolves to private IP ${result.address}`;
    } catch { /* DNS failure — allow */ }
    return null;
  } catch { return null; }
}

function isPrivateIP(ip: string): boolean {
  const cleaned = ip.replace(/^\[|\]$/g, "");
  if (cleaned.includes(".")) {
    const parts = cleaned.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
    const [a, b] = parts;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a >= 224) return true;
    return false;
  }
  if (cleaned.includes(":")) {
    const lower = cleaned.toLowerCase();
    if (lower === "::1" || lower === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
    if (lower === "::" || lower === "0000:0000:0000:0000:0000:0000:0000:0000") return true;
    if (lower.startsWith("fe80")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) { const v4 = lower.slice(7); if (v4.includes(".")) return isPrivateIP(v4); }
    return false;
  }
  return false;
}
