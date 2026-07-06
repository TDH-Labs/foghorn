import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";

// src/config/settings.ts -> project root is two levels up.
export const ROOT: string =
  process.env.FOGHORN_ROOT ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const DATA_DIR: string = join(ROOT, "data");
export const DB_PATH: string = process.env.FOGHORN_DB ?? join(DATA_DIR, "foghorn.db");

/** Read at call time so tests can isolate the kill-switch flag from the real one. */
export function pausedFlagPath(): string {
  return process.env.FOGHORN_PAUSED_FLAG ?? join(DATA_DIR, "PAUSED");
}
export const MEDIA_DIR: string = join(DATA_DIR, "media");
export const LOG_DIR: string = join(process.env.HOME ?? "~", "Library", "Logs", "foghorn");

export function getSetting(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export function getNumberSetting(db: Database, key: string, fallback: number): number {
  const v = getSetting(db, key);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
