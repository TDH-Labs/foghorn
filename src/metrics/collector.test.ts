import { describe, expect, test } from "bun:test";
import { migrate, openDb } from "../db/index.ts";
import { collectXMetrics } from "./collector.ts";

const CREDS = { consumerKey: "k", consumerSecret: "ks", accessToken: "t", accessTokenSecret: "ts" };

describe("x metrics collector", () => {
  function seedPublished(db: ReturnType<typeof openDb>, externalId: string): number {
    db.run("INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, status) VALUES ('x','opinion_take','p',x'00','h','published')");
    const draftId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
    db.run("INSERT INTO schedule (draft_id, platform, scheduled_for, idempotency_key, state) VALUES (?, 'x', ?, ?, 'sent')", [draftId, new Date().toISOString(), `k-${externalId}`]);
    db.run(
      "INSERT INTO published_posts (schedule_id, draft_id, platform, external_post_id, published_at) VALUES (last_insert_rowid(), ?, 'x', ?, ?)",
      [draftId, externalId, new Date().toISOString()],
    );
    return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
  }

  test("snapshots public metrics, records owned-read spend, dedupes per collectedAt", async () => {
    const db = openDb(":memory:");
    migrate(db);
    seedPublished(db, "111");
    seedPublished(db, "222");
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      expect(auth).toContain("oauth_signature=");
      expect(String(input)).toContain("public_metrics");
      return Response.json({
        data: [
          { id: "111", public_metrics: { impression_count: 900, like_count: 12, reply_count: 3, retweet_count: 2, quote_count: 1 } },
          { id: "222", public_metrics: { impression_count: 40, like_count: 1, reply_count: 0, retweet_count: 0, quote_count: 0 } },
        ],
      });
    }) as unknown as typeof fetch;

    const at = "2026-07-06T18:00:00Z";
    const report = await collectXMetrics(db, CREDS, fetchImpl, { collectedAt: at });
    expect(report).toEqual({ posts: 2, snapshots: 2 });
    const row = db
      .query<{ impressions: number; likes: number }, []>(
        "SELECT impressions, likes FROM metrics ORDER BY published_post_id LIMIT 1",
      )
      .get();
    expect(row?.impressions).toBe(900);
    expect(row?.likes).toBe(12);
    const ledger = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM spend_ledger WHERE category='x_own_read'").get();
    expect(ledger?.n).toBe(1);

    // same collectedAt => idempotent
    const again = await collectXMetrics(db, CREDS, fetchImpl, { collectedAt: at });
    expect(again.snapshots).toBe(0);
    db.close();
  });

  test("spend cap exhausts gracefully (skipped, not thrown)", async () => {
    const db = openDb(":memory:");
    migrate(db);
    seedPublished(db, "111");
    db.run("UPDATE spend_caps SET monthly_cap_usd = 0 WHERE cap_group = 'x'");
    const report = await collectXMetrics(db, CREDS, (async () => Response.json({})) as unknown as typeof fetch);
    expect(report.snapshots).toBe(0);
    expect(report.skipped).toContain("cap");
    db.close();
  });
});
