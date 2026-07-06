// Approval state machine. An approval authorizes ONE (draft_id, version) whose
// bytes a sentinel already froze. First decision wins (decided_at IS NULL
// guard); approving at ladder >=1 schedules with jitter; L0 (shadow) records
// the decision and schedules nothing. Unanswered 24h -> expired -> hold.

import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { platformSpec } from "../config/platforms.ts";
import { getSetting } from "../config/settings.ts";
import { effectiveLevel, recordCleanApproval, recordEditedApproval, recordRejection } from "../autonomy/ladder.ts";

export interface DraftRowLite {
  id: number;
  version: number;
  platform: string;
  content_class: string;
  body_text: string;
  risk_score: number | null;
}

export function requestApproval(db: Database, draft: DraftRowLite): number {
  const nonce = randomUUID().slice(0, 8);
  db.run(
    "INSERT INTO approvals (draft_id, draft_version, tier, risk_score, nonce) VALUES (?, ?, 'telegram', ?, ?)",
    [draft.id, draft.version, draft.risk_score, nonce],
  );
  db.run("UPDATE drafts SET status = 'awaiting_approval', updated_at = ? WHERE id = ?", [
    new Date().toISOString(),
    draft.id,
  ]);
  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
}

export function renderApproval(db: Database, approvalId: number): string {
  const row = db
    .query<
      { id: number; draft_id: number; draft_version: number; risk_score: number | null; body_text: string; platform: string; content_class: string },
      [number]
    >(
      `SELECT a.id, a.draft_id, a.draft_version, a.risk_score, d.body_text, d.platform, d.content_class
       FROM approvals a JOIN drafts d ON d.id = a.draft_id WHERE a.id = ?`,
    )
    .get(approvalId);
  if (!row) throw new Error(`no approval ${approvalId}`);
  const level = effectiveLevel(db, row.platform, row.content_class);
  const shadow = level === 0 ? "[SHADOW — will NOT publish] " : "";
  return (
    `${shadow}#${row.draft_id}v${row.draft_version} ${row.platform}/${row.content_class}` +
    `${row.risk_score !== null ? ` risk=${row.risk_score}` : ""}\n\n${row.body_text}`
  );
}

/** Next slot respecting quiet hours, min gap, and daily max — walked in 30-min steps. */
export function computeNextSlot(db: Database, platform: string, from: Date = new Date()): Date {
  const spec = platformSpec(platform);
  const quiet = (getSetting(db, "quiet_hours") ?? "23:00-07:00").split("-");
  const toMin = (hhmm: string) => Number(hhmm.split(":")[0]) * 60 + Number(hhmm.split(":")[1] ?? 0);
  const [qs, qe] = [toMin(quiet[0] ?? "23:00"), toMin(quiet[1] ?? "07:00")];

  const slot = new Date(from.getTime() + 10 * 60_000);
  for (let step = 0; step < 7 * 48; step++) {
    const mins = slot.getHours() * 60 + slot.getMinutes();
    const inQuiet = qs <= qe ? mins >= qs && mins < qe : mins >= qs || mins < qe;
    if (!inQuiet) {
      const dayStart = new Date(slot);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 86400_000);
      const sameDay = db
        .query<{ n: number }, [string, string, string]>(
          `SELECT (SELECT COUNT(*) FROM published_posts WHERE platform = ?1 AND published_at BETWEEN ?2 AND ?3 AND deleted_at IS NULL)
                + (SELECT COUNT(*) FROM schedule WHERE platform = ?1 AND state IN ('pending','firing') AND scheduled_for BETWEEN ?2 AND ?3) AS n`,
        )
        .get(platform, dayStart.toISOString(), dayEnd.toISOString());
      const lastBefore = db
        .query<{ t: string | null }, [string, string]>(
          `SELECT MAX(t) t FROM (
             SELECT published_at t FROM published_posts WHERE platform = ?1 AND deleted_at IS NULL
             UNION ALL SELECT scheduled_for t FROM schedule WHERE platform = ?1 AND state IN ('pending','firing')
           ) WHERE t <= ?2`,
        )
        .get(platform, slot.toISOString());
      const gapOk = !lastBefore?.t || slot.getTime() - new Date(lastBefore.t).getTime() >= spec.minGapHours * 3_600_000;
      if ((sameDay?.n ?? 0) < spec.maxPerDay && gapOk) return slot;
    }
    slot.setTime(slot.getTime() + 30 * 60_000);
  }
  throw new Error(`no schedulable slot for ${platform} within 7 days`);
}

export function scheduleDraft(db: Database, draftId: number): number {
  const draft = db
    .query<{ id: number; version: number; platform: string }, [number]>(
      "SELECT id, version, platform FROM drafts WHERE id = ?",
    )
    .get(draftId);
  if (!draft) throw new Error(`no draft ${draftId}`);
  const slot = computeNextSlot(db, draft.platform);
  const jitter = Math.floor(Math.random() * 300); // 0-5 min human-variance jitter
  const key = createHash("sha256")
    .update(`${draft.id}|${draft.version}|${draft.platform}|${slot.toISOString()}`)
    .digest("hex");
  db.run(
    "INSERT INTO schedule (draft_id, platform, scheduled_for, jitter_s, idempotency_key) VALUES (?, ?, ?, ?, ?)",
    [draft.id, draft.platform, slot.toISOString(), jitter, key],
  );
  db.run("UPDATE drafts SET status = 'scheduled', updated_at = ? WHERE id = ?", [new Date().toISOString(), draft.id]);
  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
}

export type Decision = "approved" | "rejected" | "edited";

export interface DecisionResult {
  ok: boolean;
  detail: string;
  scheduled?: boolean;
  promotionOffer?: number | null;
  platform?: string;
  contentClass?: string;
}

export function recordDecision(
  db: Database,
  approvalId: number,
  decision: Decision,
  via: string,
  note?: string,
): DecisionResult {
  db.run(
    "UPDATE approvals SET decision = ?, decided_at = ?, decided_via = ?, note = ? WHERE id = ? AND decided_at IS NULL",
    [decision, new Date().toISOString(), via, note ?? null, approvalId],
  );
  if ((db.query<{ n: number }, []>("SELECT changes() n").get()?.n ?? 0) !== 1) {
    return { ok: false, detail: "already decided (first write wins)" };
  }
  const row = db
    .query<{ draft_id: number; platform: string; content_class: string }, [number]>(
      `SELECT a.draft_id, d.platform, d.content_class FROM approvals a JOIN drafts d ON d.id = a.draft_id WHERE a.id = ?`,
    )
    .get(approvalId)!;

  if (decision === "rejected") {
    db.run("UPDATE drafts SET status = 'rejected', updated_at = ? WHERE id = ?", [new Date().toISOString(), row.draft_id]);
    recordRejection(db, row.platform, row.content_class);
    return { ok: true, detail: "rejected" };
  }

  const promotion =
    decision === "approved"
      ? recordCleanApproval(db, row.platform, row.content_class)
      : (recordEditedApproval(db, row.platform, row.content_class), { offerPromotionTo: null });

  db.run("UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ?", [new Date().toISOString(), row.draft_id]);

  const level = effectiveLevel(db, row.platform, row.content_class);
  if (level >= 1) {
    scheduleDraft(db, row.draft_id);
    return {
      ok: true, detail: "approved + scheduled", scheduled: true,
      promotionOffer: promotion.offerPromotionTo, platform: row.platform, contentClass: row.content_class,
    };
  }
  return {
    ok: true, detail: "approved (SHADOW — not scheduled at L0)", scheduled: false,
    promotionOffer: promotion.offerPromotionTo, platform: row.platform, contentClass: row.content_class,
  };
}

/** Unanswered approvals expire to holds — nothing publishes stale. */
export function expireStaleApprovals(db: Database, maxAgeHours = 24): number {
  const cutoff = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString();
  const stale = db
    .query<{ id: number; draft_id: number }, [string]>(
      "SELECT id, draft_id FROM approvals WHERE decided_at IS NULL AND requested_at < ?",
    )
    .all(cutoff);
  for (const s of stale) {
    db.run("UPDATE approvals SET decision = 'expired', decided_at = ? WHERE id = ? AND decided_at IS NULL", [
      new Date().toISOString(),
      s.id,
    ]);
    db.run("UPDATE drafts SET status = 'held', updated_at = ? WHERE id = ?", [new Date().toISOString(), s.draft_id]);
    db.run("INSERT INTO holds (draft_id, packet_json, specialty) VALUES (?, ?, 'publish')", [
      s.draft_id,
      JSON.stringify({ reason: `approval #${s.id} expired after ${maxAgeHours}h` }),
    ]);
  }
  return stale.length;
}
