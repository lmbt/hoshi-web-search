/**
 * robots.txt parser and checker with longest-match precedence.
 */

import { getConsistentUA } from "./user-agent.js";

const robotsCache = new Map<string, { rules: RobotsRules; fetchedAt: number }>();
const ROBOTS_CACHE_TTL = 60 * 60 * 1000;

interface RobotsRules { disallowPatterns: string[]; allowPatterns: string[]; crawlDelay: number | null; }

export async function isAllowedByRobots(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const rules = await fetchRobotsRules(`${parsed.protocol}//${parsed.host}/robots.txt`, parsed.hostname);
    if (!rules) return true;
    const path = parsed.pathname + parsed.search;
    let bestAllow: string | null = null;
    let bestDisallow: string | null = null;
    for (const p of rules.allowPatterns) { if (matchesRobotsPattern(path, p) && (!bestAllow || p.length > bestAllow.length)) bestAllow = p; }
    for (const p of rules.disallowPatterns) { if (matchesRobotsPattern(path, p) && (!bestDisallow || p.length > bestDisallow.length)) bestDisallow = p; }
    if (!bestDisallow) return true;
    if (bestAllow && bestAllow.length >= bestDisallow.length) return true;
    return false;
  } catch { return true; }
}

export async function getRobotsCrawlDelay(url: string): Promise<number | null> {
  try {
    const parsed = new URL(url);
    const rules = await fetchRobotsRules(`${parsed.protocol}//${parsed.host}/robots.txt`, parsed.hostname);
    return rules?.crawlDelay ?? null;
  } catch { return null; }
}

export function resetRobotsCache(): void { robotsCache.clear(); }

async function fetchRobotsRules(robotsUrl: string, domain: string): Promise<RobotsRules | null> {
  const cached = robotsCache.get(domain);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL) return cached.rules;
  try {
    const { headers } = getConsistentUA(robotsUrl);
    const response = await fetch(robotsUrl, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const text = await response.text();
    const rules = parseRobotsTxt(text);
    robotsCache.set(domain, { rules, fetchedAt: Date.now() });
    return rules;
  } catch { return null; }
}

function parseRobotsTxt(text: string): RobotsRules {
  const lines = text.split("\n");
  const disallowPatterns: string[] = [];
  const allowPatterns: string[] = [];
  let crawlDelay: number | null = null;
  let inWildcardBlock = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#") || line === "") continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (directive === "user-agent") { inWildcardBlock = value.toLowerCase() === "*"; continue; }
    if (!inWildcardBlock) continue;
    switch (directive) {
      case "disallow": if (value) disallowPatterns.push(value); break;
      case "allow": if (value) allowPatterns.push(value); break;
      case "crawl-delay": { const d = parseFloat(value); if (!isNaN(d) && d > 0) crawlDelay = d * 1000; break; }
    }
  }
  return { disallowPatterns, allowPatterns, crawlDelay };
}

function matchesRobotsPattern(path: string, pattern: string): boolean {
  if (pattern === "") return false;
  if (pattern === "/") return true;
  if (!pattern.includes("*") && !pattern.endsWith("$")) return path.startsWith(pattern);
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") regex += ".*";
    else if (char === "$" && i === pattern.length - 1) regex += "$";
    else regex += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  try { return new RegExp(regex).test(path); }
  catch { return path.startsWith(pattern.replace(/[*$]/g, "")); }
}
