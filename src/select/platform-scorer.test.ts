import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/index.ts";
import type { GenerateFn } from "../profile/profiler.ts";
import { ratifiedPlatform, ratifyPlatform, scorePlatforms } from "./platform-scorer.ts";

function freshDbWithProfiles(): Database {
  const db = openDb(":memory:");
  migrate(db);
  for (const kind of ["voice", "interests", "expertise", "persona"]) {
    db.run(
      "INSERT INTO profiles (version, kind, json, corpus_hash, active) VALUES (1, ?, ?, 'h', 1)",
      [kind, JSON.stringify({ stub: kind })],
    );
  }
  return db;
}

const CANNED = JSON.stringify({
  scores: [
    { platform: "x", audience_alignment: 88, momentum: 80, trust_fit: 70, composite: 84, rationale: "builder niche lives here", first_90_days: "reply-first strategy" },
    { platform: "linkedin", audience_alignment: 72, momentum: 55, trust_fit: 90, composite: 71, rationale: "b2b trust", first_90_days: "one insight post per day" },
    { platform: "nostr", audience_alignment: 60, momentum: 40, trust_fit: 65, composite: 55, rationale: "high signal, small", first_90_days: "mirror posts" },
  ],
  recommendation: { primary: "x", secondary: "linkedin", why: "fastest loop for a text-native builder voice." },
});

const fakeGenerate: GenerateFn = async () => ({ text: CANNED });

describe("platform scorer", () => {
  test("requires ratified profiles", async () => {
    const db = openDb(":memory:");
    migrate(db);
    await expect(scorePlatforms(db, fakeGenerate)).rejects.toThrow(/ratified profiles/);
    db.close();
  });

  test("persists scores + recommendation, then human ratifies (possibly overriding)", async () => {
    const db = freshDbWithProfiles();
    const result = await scorePlatforms(db, fakeGenerate);
    expect(result.recommendation.primary).toBe("x");
    const rows = db.query<{ platform: string; composite: number }, []>(
      "SELECT platform, composite FROM platform_scores ORDER BY composite DESC",
    ).all();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.platform).toBe("x");

    expect(ratifiedPlatform(db)).toBeNull();
    ratifyPlatform(db, "linkedin"); // human overrides the recommendation
    expect(ratifiedPlatform(db)).toBe("linkedin");
    ratifyPlatform(db, "x"); // and changes their mind — single ratified row
    expect(ratifiedPlatform(db)).toBe("x");
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM platform_scores WHERE ratified=1").get();
    expect(count?.n).toBe(1);
    db.close();
  });

  test("unknown platform cannot be ratified", async () => {
    const db = freshDbWithProfiles();
    await scorePlatforms(db, fakeGenerate);
    expect(() => ratifyPlatform(db, "myspace")).toThrow(/no score run/);
    db.close();
  });

  test("malformed scorer output fails closed", async () => {
    const db = freshDbWithProfiles();
    const bad: GenerateFn = async () => ({ text: '{"scores": []}' });
    await expect(scorePlatforms(db, bad)).rejects.toThrow(/malformed/);
    db.close();
  });
});
