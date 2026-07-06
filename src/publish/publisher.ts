// The deterministic send path. NO LLM anywhere in src/publish/** — enforced by
// tests/no-llm-in-publish.test.ts. A row publishes only when EVERY check passes:
// kill switch, atomic pending->firing claim, live sentinel whose HMAC matches the
// exact bytes being sent, an approval for this (draft, version) [or ladder auto
// with risk<40 — Phase 6+], fire-time cadence ceiling, spend preflight, atomic
// single-use sentinel consume. Any failure => row held + hold packet, never sent.

import type { Database } from "bun:sqlite";
import { isPaused } from "../killswitch.ts";
import { platformSpec } from "../config/platforms.ts";
import { preflight, record, unitCost } from "../spend/ledger.ts";
import { consume, verify } from "../gate/sentinel.ts";
import { effectiveLevel } from "../autonomy/ladder.ts";
import type { PlatformAdapter } from "./adapters/adapter.ts";

export const AUTO_RISK_MAX = 40;

interface DueRow {
  id: number;
  draft_id: number;
  platform: string;
  scheduled_for: string;
  jitter_s: number;
  attempts: number;
  idempotency_key: string;
}

interface DraftRow {
  id: number;
  version: number;
  platform: string;
  content_class: string;
  canonical_bytes: Uint8Array;
  media_refs_json: string;
  risk_score: number | null;
  status: string;
}

export interface TickReport {
  considered: number;
  sent: number;
  held: number;
  skipped: string | null;
}

function hold(db: Database, row: DueRow, reason: string): void {
  db.run("UPDATE schedule SET state = 'held', last_error = ? WHERE id = ?", [reason, row.id]);
  db.run(
    "INSERT INTO holds (draft_id, packet_json, specialty) VALUES (?, ?, 'publish')",
    [row.draft_id, JSON.stringify({ scheduleId: row.id, reason, at: new Date().toISOString() })],
  );
  db.run("INSERT INTO journal (scope, ref_id, entry_json) VALUES ('post', ?, ?)", [
    String(row.draft_id),
    JSON.stringify({ action: "publish-refused", scheduleId: row.id, reason }),
  ]);
}

function sentTodayCount(db: Database, platform: string): number {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const row = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM published_posts WHERE platform = ? AND published_at >= ? AND deleted_at IS NULL",
    )
    .get(platform, dayStart.toISOString());
  return row?.n ?? 0;
}

function approvalFor(db: Database, draftId: number, version: number): boolean {
  const row = db
    .query<{ id: number }, [number, number]>(
      "SELECT id FROM approvals WHERE draft_id = ? AND draft_version = ? AND decision = 'approved' ORDER BY id DESC LIMIT 1",
    )
    .get(draftId, version);
  return !!row;
}

export async function publishTick(
  db: Database,
  adapters: Map<string, PlatformAdapter>,
): Promise<TickReport> {
  if (isPaused(db)) return { considered: 0, sent: 0, held: 0, skipped: "paused" };

  const nowIso = new Date().toISOString();
  const due = db
    .query<DueRow, [string]>(
      `SELECT id, draft_id, platform, scheduled_for, jitter_s, attempts, idempotency_key
       FROM schedule
       WHERE state = 'pending'
         AND datetime(scheduled_for, '+' || jitter_s || ' seconds') <= datetime(?)
       ORDER BY scheduled_for`,
    )
    .all(nowIso);

  let sent = 0;
  let held = 0;

  for (const row of due) {
    if (isPaused(db)) break; // mid-tick kill switch check between rows

    // Atomic claim: only one tick can win this row.
    db.run("UPDATE schedule SET state = 'firing', attempts = attempts + 1 WHERE id = ? AND state = 'pending'", [row.id]);
    const claimed = db.query<{ n: number }, []>("SELECT changes() AS n").get();
    if ((claimed?.n ?? 0) !== 1) continue;

    const draft = db
      .query<DraftRow, [number]>(
        `SELECT id, version, platform, content_class, canonical_bytes, media_refs_json, risk_score, status
         FROM drafts WHERE id = ?`,
      )
      .get(row.draft_id);
    if (!draft) { hold(db, row, "draft row missing"); held++; continue; }

    const bytes = new Uint8Array(draft.canonical_bytes);

    // 1. Sentinel: exact frozen bytes, unexpired, unconsumed, MAC valid.
    const sv = verify(db, draft.id, draft.version, bytes);
    if (!sv.ok || sv.sentinelId === undefined) { hold(db, row, `sentinel: ${sv.reason}`); held++; continue; }

    // 2. Authorization: explicit approval for this exact (draft, version), OR
    //    ladder-auto — L2+ AND risk < 40 AND linkless. Escalated drafts always
    //    carry human approval (gate-risk 60-84 forces it upstream).
    if (!approvalFor(db, draft.id, draft.version)) {
      const level = effectiveLevel(db, draft.platform, draft.content_class);
      const hasLinkAuto = /https?:\/\//i.test(new TextDecoder().decode(bytes));
      const autoOk = level >= 2 && draft.risk_score !== null && draft.risk_score < AUTO_RISK_MAX && !hasLinkAuto;
      if (!autoOk) {
        hold(db, row, `no approval for this draft version (ladder L${level}${draft.risk_score !== null ? `, risk=${draft.risk_score}` : ""}${hasLinkAuto ? ", has link" : ""})`);
        held++;
        continue;
      }
      db.run("INSERT INTO journal (scope, ref_id, entry_json) VALUES ('post', ?, ?)", [
        String(draft.id),
        JSON.stringify({ action: "auto-publish-authorized", level, risk: draft.risk_score }),
      ]);
    }

    // 3. Hard ceiling re-check at fire time, independent of gate-cadence.
    const spec = platformSpec(draft.platform);
    if (sentTodayCount(db, draft.platform) >= spec.hardDailyCeiling) {
      hold(db, row, `hard daily ceiling ${spec.hardDailyCeiling} reached for ${draft.platform}`);
      held++;
      continue;
    }

    // 4. Spend preflight for platform writes.
    if (draft.platform === "x") {
      const hasLink = /https?:\/\//i.test(new TextDecoder().decode(bytes));
      const cost = unitCost(db, hasLink ? "x.link_write" : "x.write", hasLink ? 0.2 : 0.015);
      const pf = preflight(db, "x_write", cost);
      if (!pf.ok) { hold(db, row, `spend: ${pf.reason}`); held++; continue; }
    }

    // 5. Adapter must exist.
    const adapter = adapters.get(draft.platform);
    if (!adapter) { hold(db, row, `no adapter for platform '${draft.platform}'`); held++; continue; }

    // 6. Atomic single-use consume — a replayed sentinel refuses here.
    if (!consume(db, sv.sentinelId)) { hold(db, row, "sentinel already consumed (replay)"); held++; continue; }

    try {
      const receipt = await adapter.post(bytes, JSON.parse(draft.media_refs_json) as string[]);
      const publishedAt = new Date().toISOString();
      db.run(
        `INSERT INTO published_posts (schedule_id, draft_id, platform, external_post_id, url, published_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.id, draft.id, draft.platform, receipt.externalId, receipt.url, publishedAt],
      );
      db.run("UPDATE schedule SET state = 'sent' WHERE id = ?", [row.id]);
      db.run("UPDATE drafts SET status = 'published', updated_at = ? WHERE id = ?", [publishedAt, draft.id]);
      if (draft.platform === "x") {
        const hasLink = /https?:\/\//i.test(new TextDecoder().decode(bytes));
        record(db, {
          category: "x_write",
          units: 1,
          unitCostUsd: unitCost(db, hasLink ? "x.link_write" : "x.write", hasLink ? 0.2 : 0.015),
          ref: `post:${receipt.externalId}`,
        });
      }
      db.run("INSERT INTO journal (scope, ref_id, entry_json) VALUES ('post', ?, ?)", [
        String(draft.id),
        JSON.stringify({ action: "published", scheduleId: row.id, externalId: receipt.externalId, url: receipt.url }),
      ]);
      sent++;
    } catch (err) {
      // Ambiguous failure: the write may have landed. verify-then-retry (Phase 6
      // wires real retries); until then: hold + alert, NEVER blind-retry a write.
      const message = err instanceof Error ? err.message : String(err);
      hold(db, row, `adapter.post failed after consume: ${message} — verify before any retry`);
      held++;
    }
  }

  return { considered: due.length, sent, held, skipped: null };
}
