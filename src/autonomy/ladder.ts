// Autonomy ladder, keyed (platform, content_class). L0 shadow -> L1 approve-each
// -> L2 auto-low-risk+undo -> L3 auto+digest. Promotions are only ever OFFERED
// (Telegram prompt); this module never self-promotes. Global ceiling
// settings.max_autonomy_level (default 1) caps everything until Phase 9.

import type { Database } from "bun:sqlite";
import { getNumberSetting } from "../config/settings.ts";

export const PROMOTE_L2_STREAK = 10;
export const PROMOTE_L3_STREAK = 20;
export const DEMOTION_COOLDOWN_DAYS = 14;

function ensureRow(db: Database, platform: string, contentClass: string): void {
  db.run(
    "INSERT OR IGNORE INTO autonomy_state (platform, content_class, level) VALUES (?, ?, 0)",
    [platform, contentClass],
  );
}

export function effectiveLevel(db: Database, platform: string, contentClass: string): number {
  ensureRow(db, platform, contentClass);
  const row = db
    .query<{ level: number; cooldown_until: string | null }, [string, string]>(
      "SELECT level, cooldown_until FROM autonomy_state WHERE platform = ? AND content_class = ?",
    )
    .get(platform, contentClass)!;
  const ceiling = getNumberSetting(db, "max_autonomy_level", 1);
  const cooling = row.cooldown_until && new Date(row.cooldown_until).getTime() > Date.now();
  return Math.min(cooling ? Math.min(row.level, 1) : row.level, ceiling);
}

function logEvent(db: Database, platform: string, contentClass: string, event: string, from: number, to: number, reason: string): void {
  db.run(
    "INSERT INTO autonomy_events (platform, content_class, event, from_level, to_level, reason) VALUES (?, ?, ?, ?, ?, ?)",
    [platform, contentClass, event, from, to, reason],
  );
}

/** Clean approval (zero edits). Returns a promotion OFFER when a streak threshold is crossed. */
export function recordCleanApproval(db: Database, platform: string, contentClass: string): { offerPromotionTo: number | null } {
  ensureRow(db, platform, contentClass);
  db.run(
    `UPDATE autonomy_state SET clean_streak = clean_streak + 1, total_approved = total_approved + 1, updated_at = ?
     WHERE platform = ? AND content_class = ?`,
    [new Date().toISOString(), platform, contentClass],
  );
  const row = db
    .query<{ level: number; clean_streak: number }, [string, string]>(
      "SELECT level, clean_streak FROM autonomy_state WHERE platform = ? AND content_class = ?",
    )
    .get(platform, contentClass)!;
  if (row.level === 1 && row.clean_streak >= PROMOTE_L2_STREAK) return { offerPromotionTo: 2 };
  if (row.level === 2 && row.clean_streak >= PROMOTE_L3_STREAK) return { offerPromotionTo: 3 };
  return { offerPromotionTo: null };
}

/** An edit is signal: streak resets, no demotion. */
export function recordEditedApproval(db: Database, platform: string, contentClass: string): void {
  ensureRow(db, platform, contentClass);
  db.run(
    "UPDATE autonomy_state SET clean_streak = 0, total_approved = total_approved + 1, updated_at = ? WHERE platform = ? AND content_class = ?",
    [new Date().toISOString(), platform, contentClass],
  );
}

export function recordRejection(db: Database, platform: string, contentClass: string): void {
  ensureRow(db, platform, contentClass);
  db.run(
    "UPDATE autonomy_state SET clean_streak = 0, total_rejected = total_rejected + 1, updated_at = ? WHERE platform = ? AND content_class = ?",
    [new Date().toISOString(), platform, contentClass],
  );
  logEvent(db, platform, contentClass, "reset", 0, 0, "rejection resets streak");
}

/** Human ratifies a promotion offer. */
export function ratifyPromotion(db: Database, platform: string, contentClass: string, toLevel: number): void {
  ensureRow(db, platform, contentClass);
  const row = db
    .query<{ level: number }, [string, string]>("SELECT level FROM autonomy_state WHERE platform = ? AND content_class = ?")
    .get(platform, contentClass)!;
  if (toLevel > row.level + 1) throw new Error(`cannot skip levels (${row.level} -> ${toLevel})`);
  db.run(
    "UPDATE autonomy_state SET level = ?, clean_streak = 0, updated_at = ? WHERE platform = ? AND content_class = ?",
    [toLevel, new Date().toISOString(), platform, contentClass],
  );
  logEvent(db, platform, contentClass, "ratify", row.level, toLevel, "human-ratified promotion");
}

/** Undo at L2, platform strike, post-hoc leak: demote to L1 + cooldown. Incident demotes the whole platform. */
export function recordIncident(db: Database, platform: string, reason: string, contentClass?: string): void {
  const until = new Date(Date.now() + DEMOTION_COOLDOWN_DAYS * 86400_000).toISOString();
  const rows = contentClass
    ? [{ content_class: contentClass }]
    : db.query<{ content_class: string }, [string]>("SELECT content_class FROM autonomy_state WHERE platform = ?").all(platform);
  for (const r of rows) {
    ensureRow(db, platform, r.content_class);
    const cur = db
      .query<{ level: number }, [string, string]>("SELECT level FROM autonomy_state WHERE platform = ? AND content_class = ?")
      .get(platform, r.content_class)!;
    db.run(
      `UPDATE autonomy_state SET level = MIN(level, 1), clean_streak = 0, last_incident_at = ?, cooldown_until = ?, updated_at = ?
       WHERE platform = ? AND content_class = ?`,
      [new Date().toISOString(), until, new Date().toISOString(), platform, r.content_class],
    );
    logEvent(db, platform, r.content_class, "incident", cur.level, Math.min(cur.level, 1), reason);
  }
}
