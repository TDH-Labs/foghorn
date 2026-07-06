import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/index.ts";
import { computeBaseline, engagementOf, median, robustZ } from "./outperformer.ts";
import { addCreator, detectOutperformers, recordCreatorPosts } from "./watchlist.ts";
import { freshTrendCards, scanTrends, type ScanGenerate } from "./trend-scanner.ts";

function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

describe("robust statistics", () => {
  test("median: odd, even, empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  test("small-n guard: no z-score below MIN_BASELINE_N", () => {
    const b = computeBaseline([10, 12, 11]);
    expect(robustZ(100, b)).toBeNull();
  });

  test("known outlier scores high; typical post scores near zero", () => {
    const history = [10, 12, 9, 11, 10, 13, 8, 12, 10, 11];
    const b = computeBaseline(history);
    expect(robustZ(11, b)!).toBeLessThan(1);
    expect(robustZ(60, b)!).toBeGreaterThan(2);
  });

  test("flat history (MAD=0) still detects a genuine spike without dividing by zero", () => {
    const b = computeBaseline([10, 10, 10, 10, 10, 10, 10, 10]);
    const z = robustZ(50, b);
    expect(Number.isFinite(z!)).toBe(true);
    expect(z!).toBeGreaterThan(2);
  });

  test("engagement weighting favors reposts/quotes over likes", () => {
    expect(engagementOf({ likes: 10 })).toBe(10);
    expect(engagementOf({ reposts: 10 })).toBe(20);
    expect(engagementOf({ likes: 2, reposts: 3, replies: 2, quotes: 1 })).toBe(2 + 6 + 3 + 2);
  });
});

describe("watchlist", () => {
  test("baselines refresh on record; outperformers detected at z>=2", () => {
    const db = freshDb();
    const id = addCreator(db, "x", "@builder", "ai-agents");
    const normal = Array.from({ length: 12 }, (_, i) => ({
      externalId: `p${i}`,
      postedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      metrics: { likes: 10 + (i % 3), reposts: 1 },
    }));
    recordCreatorPosts(db, id, normal);
    expect(detectOutperformers(db)).toHaveLength(0);

    recordCreatorPosts(db, id, [
      { externalId: "viral", postedAt: "2026-07-01T00:00:00Z", textSnippet: "the viral one", url: "https://x.com/p", metrics: { likes: 300, reposts: 80 } },
    ]);
    const hits = detectOutperformers(db);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.handle).toBe("builder");
    expect(hits[0]?.zscore).toBeGreaterThan(2);
    db.close();
  });

  test("duplicate posts are idempotent", () => {
    const db = freshDb();
    const id = addCreator(db, "x", "someone");
    const p = { externalId: "same", metrics: { likes: 5 } };
    expect(recordCreatorPosts(db, id, [p]).inserted).toBe(1);
    expect(recordCreatorPosts(db, id, [p]).inserted).toBe(0);
    db.close();
  });
});

describe("trend scanner", () => {
  const CANNED = JSON.stringify({
    cards: [
      { title: "Build-log threads", summary: "Daily build logs outperform.", format: "build_log", evidence: [{ url: "https://example.com/1", note: "3 exemplars" }], ttl_days: 7 },
      { title: "Contrarian takes on agent hype", summary: "Pushback posts spike.", format: "contrarian_take", evidence: [], ttl_days: 5 },
    ],
  });
  const fake: ScanGenerate = async () => ({ text: CANNED, searches: 3 });

  function withProfiles(db: Database) {
    for (const kind of ["interests", "persona"]) {
      db.run("INSERT INTO profiles (version, kind, json, corpus_hash, active) VALUES (1, ?, ?, 'h', 1)", [
        kind,
        JSON.stringify({ stub: kind }),
      ]);
    }
  }

  test("requires ratified interests", async () => {
    const db = freshDb();
    await expect(scanTrends(db, fake, "x")).rejects.toThrow(/interests/);
    db.close();
  });

  test("inserts cards with expiry; dedupes repeats within 14 days", async () => {
    const db = freshDb();
    withProfiles(db);
    const first = await scanTrends(db, fake, "x");
    expect(first.inserted).toBe(2);
    const second = await scanTrends(db, fake, "x");
    expect(second.inserted).toBe(0);
    expect(second.skippedDuplicate).toBe(2);
    expect(freshTrendCards(db, "x")).toHaveLength(2);
    db.close();
  });

  test("expired cards drop out of the fresh view", async () => {
    const db = freshDb();
    withProfiles(db);
    await scanTrends(db, fake, "x");
    db.run("UPDATE trend_cards SET expires_at = datetime('now', '-1 day')");
    await scanTrends(db, async () => ({ text: '{"cards": []}' }), "x"); // triggers expiry sweep
    expect(freshTrendCards(db, "x")).toHaveLength(0);
    db.close();
  });

  test("malformed output fails closed", async () => {
    const db = freshDb();
    withProfiles(db);
    await expect(scanTrends(db, async () => ({ text: "no json" }), "x")).rejects.toThrow(/no JSON/);
    db.close();
  });
});
