import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/index.ts";
import { runChain } from "../gate/index.ts";
import type { DraftSubject, Gate } from "../types.ts";
import { verdictOf } from "../types.ts";
import type { PlatformAdapter } from "./adapters/adapter.ts";
import { publishTick } from "./publisher.ts";

process.env.FOGHORN_SENTINEL_SECRET = "test-secret-0123456789abcdef";

const passGate: Gate = { name: "g-pass", run: async () => verdictOf("g-pass", []) };

function fakeAdapter(platform = "x"): { adapter: PlatformAdapter; posted: Uint8Array[] } {
  const posted: Uint8Array[] = [];
  return {
    posted,
    adapter: {
      platform,
      post: async (bytes) => {
        posted.push(bytes);
        return { externalId: `ext-${posted.length}`, url: `https://example/${posted.length}` };
      },
      delete: async () => {},
      verifyOwn: async () => [],
    },
  };
}

async function setupApprovedScheduledDraft(db: Database, body = "gated and approved post") {
  const bytes = new TextEncoder().encode(body);
  db.run(
    `INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, version, status)
     VALUES ('x', 'evergreen_tip', ?, ?, 'x', 1, 'gating')`,
    [body, bytes],
  );
  const draftId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
  const subject: DraftSubject = {
    draftId, version: 1, platform: "x", contentClass: "evergreen_tip",
    bodyText: body, canonicalBytes: bytes, mediaRefs: [], evidence: [],
  };
  const chain = await runChain(db, [passGate], subject, "full");
  db.run(
    `INSERT INTO approvals (draft_id, draft_version, tier, nonce, decided_at, decision, decided_via)
     VALUES (?, 1, 'telegram', 'n', ?, 'approved', 'test')`,
    [draftId, new Date().toISOString()],
  );
  db.run(
    `INSERT INTO schedule (draft_id, platform, scheduled_for, idempotency_key)
     VALUES (?, 'x', ?, ?)`,
    [draftId, new Date(Date.now() - 60_000).toISOString(), `key-${draftId}`],
  );
  return { draftId, bytes, sentinelId: chain.sentinelId! };
}

function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function heldReason(db: Database): string {
  return db.query<{ last_error: string }, []>("SELECT last_error FROM schedule ORDER BY id DESC").get()!.last_error;
}

describe("publisher tick", () => {
  test("kill switch skips everything", async () => {
    const db = freshDb();
    await setupApprovedScheduledDraft(db);
    db.run("UPDATE settings SET value='1' WHERE key='paused'");
    const report = await publishTick(db, new Map());
    expect(report.skipped).toBe("paused");
    expect(report.sent).toBe(0);
    db.close();
  });

  test("happy path: sentinel + approval + adapter => sent exactly once", async () => {
    const db = freshDb();
    const { bytes } = await setupApprovedScheduledDraft(db);
    const { adapter, posted } = fakeAdapter();
    const report = await publishTick(db, new Map([["x", adapter]]));
    expect(report.sent).toBe(1);
    expect(posted).toHaveLength(1);
    expect(new TextDecoder().decode(posted[0]!)).toBe(new TextDecoder().decode(bytes));
    // double tick: nothing left to send, no duplicate
    const again = await publishTick(db, new Map([["x", adapter]]));
    expect(again.considered).toBe(0);
    expect(posted).toHaveLength(1);
    // ledger row for the write exists
    const spend = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM spend_ledger WHERE category='x_write'").get();
    expect(spend?.n).toBe(1);
    db.close();
  });

  test("byte tamper after gating is refused (sentinel mismatch)", async () => {
    const db = freshDb();
    const { draftId } = await setupApprovedScheduledDraft(db);
    // Attacker mutates the stored draft bytes after approval.
    db.run("UPDATE drafts SET canonical_bytes = ? WHERE id = ?", [
      new TextEncoder().encode("attacker swapped this text"),
      draftId,
    ]);
    const { adapter, posted } = fakeAdapter();
    const report = await publishTick(db, new Map([["x", adapter]]));
    expect(report.sent).toBe(0);
    expect(report.held).toBe(1);
    expect(posted).toHaveLength(0);
    expect(heldReason(db)).toContain("sentinel");
    db.close();
  });

  test("no approval => held", async () => {
    const db = freshDb();
    const { draftId } = await setupApprovedScheduledDraft(db);
    db.run("DELETE FROM approvals WHERE draft_id = ?", [draftId]);
    const { adapter } = fakeAdapter();
    const report = await publishTick(db, new Map([["x", adapter]]));
    expect(report.held).toBe(1);
    expect(heldReason(db)).toContain("approval");
    db.close();
  });

  test("consumed sentinel (replay) => held", async () => {
    const db = freshDb();
    await setupApprovedScheduledDraft(db);
    db.run("UPDATE sentinels SET consumed_at = ?", [new Date().toISOString()]);
    const { adapter } = fakeAdapter();
    const report = await publishTick(db, new Map([["x", adapter]]));
    expect(report.held).toBe(1);
    expect(heldReason(db)).toContain("sentinel");
    db.close();
  });

  test("missing adapter => held with reason, sentinel NOT consumed", async () => {
    const db = freshDb();
    await setupApprovedScheduledDraft(db);
    const report = await publishTick(db, new Map());
    expect(report.held).toBe(1);
    expect(heldReason(db)).toContain("no adapter");
    const live = db
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM sentinels WHERE consumed_at IS NULL AND revoked_at IS NULL")
      .get();
    expect(live?.n).toBe(1);
    db.close();
  });

  test("hard daily ceiling blocks at fire time", async () => {
    const db = freshDb();
    const { draftId } = await setupApprovedScheduledDraft(db);
    // Simulate 10 already-published X posts today (the hard ceiling).
    for (let i = 0; i < 10; i++) {
      db.run(
        `INSERT INTO published_posts (schedule_id, draft_id, platform, external_post_id, published_at)
         VALUES (1, ?, 'x', 'prior-' || ?, ?)`,
        [draftId, i, new Date().toISOString()],
      );
    }
    const { adapter } = fakeAdapter();
    const report = await publishTick(db, new Map([["x", adapter]]));
    expect(report.held).toBe(1);
    expect(heldReason(db)).toContain("ceiling");
    db.close();
  });

  test("adapter failure after consume => held for verify-then-retry, never re-sent blindly", async () => {
    const db = freshDb();
    await setupApprovedScheduledDraft(db);
    const adapter: PlatformAdapter = {
      platform: "x",
      post: async () => {
        throw new Error("socket timeout");
      },
      delete: async () => {},
      verifyOwn: async () => [],
    };
    const report = await publishTick(db, new Map([["x", adapter]]));
    expect(report.sent).toBe(0);
    expect(report.held).toBe(1);
    expect(heldReason(db)).toContain("verify before any retry");
    db.close();
  });
});
