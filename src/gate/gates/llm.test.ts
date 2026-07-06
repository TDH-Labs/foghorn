import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../db/index.ts";
import type { DraftSubject } from "../../types.ts";
import type { GenerateFn } from "../../profile/profiler.ts";
import { runGate } from "../index.ts";
import { gateClaimsEvidence, gateHallucination, gateQuality, gateRisk, gateVoice, scoreFrom } from "./llm.ts";

function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function subject(over: Partial<DraftSubject> = {}): DraftSubject {
  const body = over.bodyText ?? "opinion: verifiers beat vibes";
  return {
    draftId: 1, version: 1, platform: "x", contentClass: "opinion_take",
    bodyText: body, canonicalBytes: new TextEncoder().encode(body),
    mediaRefs: [], evidence: [], ...over,
  };
}

const canned = (payload: unknown): GenerateFn => async () => ({ text: JSON.stringify(payload) });

describe("gate-claims-evidence", () => {
  test("n/a when no claims need evidence", async () => {
    const gate = gateClaimsEvidence(canned({ claims: [{ claim: "opinions rock", needs_evidence: false }] }));
    expect((await gate.run(subject())).status).toBe("n/a");
  });
  test("blocks claims without matching evidence; passes when evidence provided", async () => {
    const g = canned({ claims: [{ claim: "engagement rose 43% in Q2", needs_evidence: true }] });
    const blocked = await gateClaimsEvidence(g).run(subject({ bodyText: "engagement rose 43% in Q2" }));
    expect(blocked.status).toBe("block");
    const ok = await gateClaimsEvidence(g).run(
      subject({ bodyText: "engagement rose 43% in Q2", evidence: [{ url: "https://src.example.com", claim: "43%" }] }),
    );
    expect(ok.status).toBe("pass");
  });
});

describe("gate-hallucination", () => {
  test("n/a for opinion classes and evidence-free drafts", async () => {
    const gate = gateHallucination(canned({ verdict: "unsupported" }));
    expect((await gate.run(subject({ contentClass: "opinion_take" }))).status).toBe("n/a");
    expect((await gate.run(subject({ contentClass: "trend_take" }))).status).toBe("n/a"); // no evidence
  });
  test("unsupported statements block with cited problems", async () => {
    const gate = gateHallucination(canned({ verdict: "unsupported", problems: ["'43%': source says 12%"] }));
    const v = await gate.run(subject({ contentClass: "trend_take", evidence: [{ url: "https://s.example.com" }] }));
    expect(v.status).toBe("block");
    expect(v.findings[0]?.message).toContain("43%");
  });
});

describe("gate-voice", () => {
  function withVoice(db: Database): void {
    db.run("INSERT INTO profiles (version, kind, json, corpus_hash, active) VALUES (1,'voice',?, 'h', 1)", [
      JSON.stringify({ tone: ["direct"], voiceprint: { exemplars: [{ text: "gates beat vibes" }] } }),
    ]);
  }
  test("n/a without a ratified voice profile", async () => {
    const db = freshDb();
    expect((await gateVoice(db, canned({ score: 10 })).run(subject())).status).toBe("n/a");
    db.close();
  });
  test("below threshold blocks and cites spans; above passes and records score", async () => {
    const db = freshDb();
    withVoice(db);
    const low = await gateVoice(db, canned({ score: 40, off_voice_spans: ["'synergy': never their word"] })).run(subject());
    expect(low.status).toBe("block");
    const high = await gateVoice(db, canned({ score: 88 })).run(subject());
    expect(high.status).toBe("pass");
    expect(scoreFrom([high], "gate-voice")).toBe(88);
    db.close();
  });
});

describe("gate-quality", () => {
  test("below 7 blocks; 8 passes with score finding", async () => {
    expect((await gateQuality(canned({ score: 4, weaknesses: ["no hook"] })).run(subject())).status).toBe("block");
    const v = await gateQuality(canned({ score: 8 })).run(subject());
    expect(v.status).toBe("pass");
    expect(scoreFrom([v], "gate-quality")).toBe(8);
  });
});

describe("gate-risk", () => {
  test(">=85 critical block; 60-84 escalate; <60 pass — never n/a", async () => {
    expect((await gateRisk(canned({ risk: 92, reasons: ["legal exposure"] })).run(subject())).status).toBe("block");
    const mid = await gateRisk(canned({ risk: 70 })).run(subject());
    expect(mid.status).toBe("escalate");
    expect(scoreFrom([mid], "gate-risk")).toBe(70);
    const low = await gateRisk(canned({ risk: 12 })).run(subject());
    expect(low.status).toBe("pass");
    expect(scoreFrom([low], "gate-risk")).toBe(12);
  });
});

describe("fail-closed on judge garbage", () => {
  test("unparseable judge output becomes a blocking gate-crashed finding", async () => {
    const broken: GenerateFn = async () => ({ text: "I refuse to answer in JSON." });
    const verdict = await runGate(gateQuality(broken), subject());
    expect(verdict.status).toBe("block");
    expect(verdict.findings[0]?.ruleId).toBe("gate-crashed");
  });
});
