import { describe, expect, test } from "bun:test";
import { migrate, openDb } from "./index.ts";

describe("db migrations", () => {
  test("applies cleanly and is idempotent", () => {
    const db = openDb(":memory:");
    const first = migrate(db);
    expect(first.length).toBeGreaterThan(0);
    const second = migrate(db);
    expect(second).toEqual([]);
    db.close();
  });

  test("creates the core tables and seeds", () => {
    const db = openDb(":memory:");
    migrate(db);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of [
      "sources", "messages", "leak_shingles", "corpus_docs", "profiles",
      "platform_scores", "watchlist_creators", "creator_posts", "trend_cards",
      "ideas", "drafts", "gate_runs", "gate_findings", "sentinels", "approvals",
      "schedule", "published_posts", "metrics", "account_metrics", "spend_ledger",
      "spend_caps", "unit_costs", "journal", "inductions", "autonomy_state",
      "autonomy_events", "holds", "banned_topics", "settings",
    ]) {
      expect(tables).toContain(t);
    }
    const paused = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='paused'").get();
    expect(paused?.value).toBe("0");
    const caps = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM spend_caps").get();
    expect(caps?.n).toBe(3);
    db.close();
  });
});
