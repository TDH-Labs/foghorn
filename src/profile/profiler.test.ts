import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { migrate, openDb } from "../db/index.ts";
import type { GenerateFn } from "./profiler.ts";
import { activeProfile, buildProfiles, ratifyProfiles } from "./profiler.ts";
import { computeVoiceprint } from "./voiceprint.ts";

function seedCorpus(db: Database, n = 12): void {
  for (let i = 0; i < n; i++) {
    const text = `Post number ${i}: deterministic gates beat vibes — ship verifiers, not hope! Question everything? ${"detail ".repeat(8)}`;
    db.run(
      `INSERT INTO corpus_docs (kind, platform, external_id, text, posted_at, engagement_json, hash)
       VALUES ('post', 'x', ?, ?, ?, ?, ?)`,
      [`x:${i}`, text, "2026-06-01T00:00:00Z", JSON.stringify({ likes: i * 3, reposts: i }), createHash("sha256").update(text).digest("hex")],
    );
  }
}

const CANNED = JSON.stringify({
  voice: { tone: ["direct"], signature_moves: ["em-dash pivots"], avoid: ["corporate speak"], sentence_style: "short", formality: "4" },
  interests: [{ tag: "ai-agents", weight: 0.9, summary: "agent safety", evidence: ["gates beat vibes"] }],
  expertise: [{ area: "agent pipelines", depth: "practitioner", evidence: ["ship verifiers"] }],
  persona_options: [
    { name: "Gatekeeper", positioning: "builder who ships gated agents", target_audience: "ai engineers", content_pillars: ["gates"], platform_hint: "x", risk: "niche" },
    { name: "Operator", positioning: "solo operator automating a business", target_audience: "founders", content_pillars: ["ops"], platform_hint: "linkedin", risk: "broad" },
  ],
});

const fakeGenerate: GenerateFn = async () => ({ text: `Sure! Here is the JSON:\n${CANNED}` });

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

describe("voiceprint", () => {
  test("deterministic on identical corpus, sane feature ranges", () => {
    const db = freshDb();
    seedCorpus(db);
    const a = computeVoiceprint(db);
    const b = computeVoiceprint(db);
    expect(a).toEqual(b);
    expect(a.docCount).toBe(12);
    expect(a.exclamationRate).toBe(1);
    expect(a.questionRate).toBe(1);
    expect(a.emDashRate).toBe(1);
    expect(a.exemplars.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("profiler", () => {
  test("refuses a tiny corpus", async () => {
    const db = freshDb();
    const r = await buildProfiles(db, fakeGenerate);
    expect(r.built).toBe(false);
    expect(r.reason).toContain("too small");
    db.close();
  });

  test("writes all four kinds at one version; idempotent per corpus hash", async () => {
    const db = freshDb();
    seedCorpus(db);
    const first = await buildProfiles(db, fakeGenerate);
    expect(first.built).toBe(true);
    expect(first.version).toBe(1);
    const kinds = db.query<{ kind: string }, []>("SELECT kind FROM profiles WHERE version = 1").all().map((r) => r.kind).sort();
    expect(kinds).toEqual(["expertise", "interests", "persona", "voice"]);

    const again = await buildProfiles(db, fakeGenerate);
    expect(again.built).toBe(false);
    expect(again.reason).toContain("unchanged");

    // corpus grows -> new version
    db.run(
      `INSERT INTO corpus_docs (kind, platform, external_id, text, posted_at, hash)
       VALUES ('post','x','x:new','a brand new post with fresh substance for the profiler to chew on','2026-07-01T00:00:00Z','newhash')`,
    );
    const rebuilt = await buildProfiles(db, fakeGenerate);
    expect(rebuilt.built).toBe(true);
    expect(rebuilt.version).toBe(2);
    db.close();
  });

  test("voice profile embeds the deterministic voiceprint", async () => {
    const db = freshDb();
    seedCorpus(db);
    await buildProfiles(db, fakeGenerate);
    const row = db.query<{ json: string }, []>("SELECT json FROM profiles WHERE kind='voice'").get();
    const voice = JSON.parse(row!.json) as { voiceprint?: { docCount: number } };
    expect(voice.voiceprint?.docCount).toBe(12);
    db.close();
  });

  test("ratify activates exactly one version across kinds", async () => {
    const db = freshDb();
    seedCorpus(db);
    await buildProfiles(db, fakeGenerate);
    db.run("INSERT INTO corpus_docs (kind, platform, external_id, text, hash) VALUES ('post','x','x:v2','more words to move the corpus hash somewhere new','h2')");
    await buildProfiles(db, fakeGenerate);

    ratifyProfiles(db, 1);
    expect(activeProfile(db, "persona")).not.toBeNull();
    const activeVersions = db.query<{ version: number }, []>("SELECT DISTINCT version FROM profiles WHERE active=1").all();
    expect(activeVersions).toEqual([{ version: 1 }]);

    ratifyProfiles(db, 2);
    const now = db.query<{ version: number }, []>("SELECT DISTINCT version FROM profiles WHERE active=1").all();
    expect(now).toEqual([{ version: 2 }]);

    expect(() => ratifyProfiles(db, 99)).toThrow(/no profile version/);
    db.close();
  });

  test("malformed model output throws (fail closed, no partial write)", async () => {
    const db = freshDb();
    seedCorpus(db);
    const bad: GenerateFn = async () => ({ text: "I cannot produce JSON today." });
    await expect(buildProfiles(db, bad)).rejects.toThrow(/no JSON/);
    const rows = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM profiles").get();
    expect(rows?.n).toBe(0);
    db.close();
  });
});
