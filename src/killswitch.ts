// Kill switch: data/PAUSED file + settings.paused. Every service entrypoint calls
// isPaused() first and exits 0; the publisher also re-checks between schedule rows.
// File and setting are both honored so a pause survives a corrupt/locked DB.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { pausedFlagPath, getSetting, setSetting } from "./config/settings.ts";

export function isPaused(db?: Database): boolean {
  if (existsSync(pausedFlagPath())) return true;
  if (db) {
    try {
      if (getSetting(db, "paused") === "1") return true;
    } catch {
      return true; // fail closed: unreadable settings => treat as paused
    }
  }
  return false;
}

export function pause(db: Database, reason: string, via: string): void {
  const flag = pausedFlagPath();
  mkdirSync(dirname(flag), { recursive: true });
  writeFileSync(flag, `${new Date().toISOString()} via=${via} reason=${reason}\n`);
  setSetting(db, "paused", "1");
  db.run("INSERT INTO journal (scope, ref_id, entry_json) VALUES ('system', 'killswitch', ?)", [
    JSON.stringify({ action: "pause", reason, via }),
  ]);
}

export function resume(db: Database, reason: string, via: string): void {
  if (!reason.trim()) throw new Error("resume requires a logged reason");
  if (existsSync(pausedFlagPath())) unlinkSync(pausedFlagPath());
  setSetting(db, "paused", "0");
  db.run("INSERT INTO journal (scope, ref_id, entry_json) VALUES ('system', 'killswitch', ?)", [
    JSON.stringify({ action: "resume", reason, via }),
  ]);
}
