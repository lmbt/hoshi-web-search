/**
 * SQLite-backed response cache with TTL-based expiration.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 1024 * 1024;

let db: Database.Database | null = null;

function getDbPath(): string {
  const dir = join(homedir(), ".pi", "hoshi-web-search");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "cache.db");
}

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(getDbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL, size_bytes INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cache_created ON cache(created_at);
  `);
  return db;
}

export function makeCacheKey(prefix: string, url: string, extra?: Record<string, unknown>): string {
  let key = `${prefix}:${url}`;
  if (extra) {
    const sorted = Object.keys(extra).filter((k) => extra[k] !== undefined && extra[k] !== null).sort().map((k) => `${k}=${JSON.stringify(extra[k])}`).join("&");
    if (sorted) key += `?${sorted}`;
  }
  return key;
}

export function cacheGet(key: string): string | null {
  try {
    const d = getDb();
    const row = d.prepare("SELECT value, created_at, ttl_ms FROM cache WHERE key = ?").get(key) as { value: string; created_at: number; ttl_ms: number } | undefined;
    if (!row) return null;
    if (Date.now() - row.created_at > row.ttl_ms) { d.prepare("DELETE FROM cache WHERE key = ?").run(key); return null; }
    return row.value;
  } catch { return null; }
}

export function cacheSet(key: string, value: string, ttlMs: number = DEFAULT_TTL_MS): void {
  const sizeBytes = Buffer.byteLength(value, "utf8");
  if (sizeBytes > MAX_ENTRY_BYTES) return;
  try {
    const d = getDb();
    d.prepare(`INSERT OR REPLACE INTO cache (key, value, created_at, ttl_ms, size_bytes) VALUES (?, ?, ?, ?, ?)`).run(key, value, Date.now(), ttlMs, sizeBytes);
    const count = (d.prepare("SELECT COUNT(*) as cnt FROM cache").get() as { cnt: number }).cnt;
    if (count > MAX_ENTRIES) d.prepare(`DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY created_at ASC LIMIT ?)`).run(count - MAX_ENTRIES + 500);
  } catch { /* non-fatal */ }
}

export function cachePrune(): void { try { getDb().prepare("DELETE FROM cache WHERE (created_at + ttl_ms) < ?").run(Date.now()); } catch { /* */ } }
export function cacheClear(): void { try { getDb().prepare("DELETE FROM cache").run(); } catch { /* */ } }
export function cacheClose(): void { if (db) { try { db.close(); } catch { /* */ } db = null; } }
export function cacheStats(): { entries: number; sizeBytes: number } {
  try {
    const now = Date.now();
    const row = getDb().prepare("SELECT COUNT(*) as entries, COALESCE(SUM(size_bytes), 0) as size_bytes FROM cache WHERE (created_at + ttl_ms) >= ?").get(now) as { entries: number; size_bytes: number };
    return { entries: row.entries, sizeBytes: row.size_bytes };
  } catch { return { entries: 0, sizeBytes: 0 }; }
}
