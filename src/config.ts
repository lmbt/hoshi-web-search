/**
 * Configuration loader for hoshi-web-search.
 * Supports global config at ~/.pi/hoshi-web-search/config.json
 * and project-local config at .pi/hoshi-web-search.json (walks up).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SearchEngineId = "duckduckgo" | "google" | "bing" | "brave";
export type DetailMode = "lean" | "summary" | "full";

export interface HoshiConfig {
  /** Preferred search engine (default: duckduckgo) */
  preferredEngine: SearchEngineId;
  /** Search engine failover order */
  engineOrder: SearchEngineId[];
  /** Consecutive failures before engine is cooled down */
  engineFailureThreshold: number;
  /** How long (ms) a failed engine is skipped */
  engineCooldownMs: number;
  /** Default detail mode for web_search output */
  searchDetail: DetailMode;
  /** Default detail mode for web_fetch output */
  fetchDetail: DetailMode;
  /** HTTP fetch timeout (ms) */
  httpTimeoutMs: number;
  /** Browser navigation timeout (ms) */
  browserTimeoutMs: number;
  /** Per-domain rate limit delay (ms) */
  rateLimitMs: number;
  /** Max concurrent content fetches for includeContent */
  maxContentConcurrency: number;
  /** Minimum result score to include content for */
  includeContentMinScore: number;
  /** Locale hint for search engines */
  locale: string;
  /** Custom user agent override (null = use rotation) */
  userAgent: string | null;
}

const DEFAULTS: HoshiConfig = {
  preferredEngine: "duckduckgo",
  engineOrder: ["duckduckgo", "google", "bing", "brave"],
  engineFailureThreshold: 2,
  engineCooldownMs: 10 * 60 * 1000,
  searchDetail: "lean",
  fetchDetail: "summary",
  httpTimeoutMs: 30000,
  browserTimeoutMs: 30000,
  rateLimitMs: 1000,
  maxContentConcurrency: 2,
  includeContentMinScore: 0,
  locale: "en-US",
  userAgent: null,
};

let cachedConfig: HoshiConfig | null = null;
let cachedCwd: string | null = null;

function safeReadJson(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function findProjectConfig(cwd: string): string | undefined {
  let current = resolve(cwd);
  for (let i = 0; i < 20; i++) {
    const candidate = join(current, ".pi", "hoshi-web-search.json");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Load merged config (defaults < global < project).
 * Caches per cwd to avoid repeated filesystem reads.
 */
export function loadConfig(cwd?: string): HoshiConfig {
  const effectiveCwd = cwd || process.cwd();
  if (cachedConfig && cachedCwd === effectiveCwd) return cachedConfig;

  const globalPath = join(homedir(), ".pi", "hoshi-web-search", "config.json");
  const projectPath = findProjectConfig(effectiveCwd);

  const global = safeReadJson(globalPath);
  const project = projectPath ? safeReadJson(projectPath) : {};

  cachedConfig = { ...DEFAULTS, ...global, ...project } as HoshiConfig;
  cachedCwd = effectiveCwd;
  return cachedConfig;
}

/**
 * Reset cached config. Call on session_start / reload.
 */
export function resetConfig(): void {
  cachedConfig = null;
  cachedCwd = null;
}
