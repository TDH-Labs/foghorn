import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/index.ts";
import type { GenerateFn } from "../profile/profiler.ts";
import { classifyContent } from "./content-class.ts";
import { runEngine } from "./engine.ts";

process.env.FOGHORN_SENTINEL_SECRET = "test-secret-0123456789abcdef";

describe("content classifier", () => {
  test("deterministic class per shape", () => {
    expect(classifyContent("check this out https://a.example.com")).toBe("link_share");
    expect(classifyContent("How to ship gated agents in a weekend")).toBe("evergreen_tip");
    expect(classifyContent("Today I shipped the sentinel layer and learned three things")).toBe("personal_story");
    expect(classifyContent("x".repeat(900))).toBe("thread_deep_dive");
    expect(classifyContent("hot take on the topic", { fromTrendCard: true })).toBe("trend_take");
    expect(classifyContent("verifiers beat vibes, always")).toBe("opinion_take");
    expect(classifyContent("thanks!", { isReply: true })).toBe("reply_ack");
    expect(classifyContent("great question — the trick is to freeze bytes under an HMAC and verify at send time", { isReply: true })).toBe("reply_value_add");
  });
});

function seedRatified(db: Database): void {
  const voice = {
    tone: ["direct"],
    voiceprint: { exemplars: [{ text: "gates beat vibes — ship verifiers" }] },
  };
  const rows: [string, unknown][] = [
    ["voice", voice],
    ["interests", { interests: [{ tag: "ai-agents", weight: 0.9 }] }],
    ["expertise", { expertise: [] }],
    ["persona", { persona_options: [{ name: "Gatekeeper" }] }],
  ];
  for (const [kind, json] of rows) {
    db.run("INSERT INTO profiles (version, kind, json, corpus_hash, active) VALUES (1, ?, ?, 'h', 1)", [
      kind,
      JSON.stringify(json),
    ]);
  }
}

/** Stage-routed fake model. riskScore parameterizes the risk judge. */
function fakeGenerate(opts: { riskScore?: number; qualityScore?: number } = {}): GenerateFn {
  return async ({ stage }) => {
    switch (stage) {
      case "ideate":
        return { text: JSON.stringify({ ideas: [{ angle: "verifier-first", brief: "write about why deterministic verification beats prompt hope", interest_tag: "ai-agents" }] }) };
      case "draft":
        return { text: "verifiers beat vibes. freeze the bytes, gate the send path, sleep at night." };
      case "fix":
        return { text: "clean fixed body that satisfies the gates while keeping the point intact" };
      case "claims_extract":
        return { text: JSON.stringify({ claims: [] }) };
      case "judge_hallucination":
        return { text: JSON.stringify({ verdict: "supported" }) };
      case "judge_voice":
        return { text: JSON.stringify({ score: 90 }) };
      case "judge_quality":
        return { text: JSON.stringify({ score: opts.qualityScore ?? 9 }) };
      case "judge_risk":
        return { text: JSON.stringify({ risk: opts.riskScore ?? 15 }) };
      default:
        return { text: "{}" };
    }
  };
}

const okFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

describe("content engine end-to-end (fake model)", () => {
  test("clean pass: draft lands awaiting approval with sentinel + persisted scores", async () => {
    const db = openDb(":memory:");
    migrate(db);
    seedRatified(db);
    const report = await runEngine(db, { generate: fakeGenerate(), fetchImpl: okFetch }, "x", 1);
    expect(report).toEqual({ ideas: 1, awaitingApproval: 1, escalated: 0 });

    const draft = db
      .query<{ status: string; voice_score: number; quality_score: number; risk_score: number; content_class: string }, []>(
        "SELECT status, voice_score, quality_score, risk_score, content_class FROM drafts",
      )
      .get()!;
    expect(draft.status).toBe("awaiting_approval");
    expect(draft.voice_score).toBe(90);
    expect(draft.quality_score).toBe(9);
    expect(draft.risk_score).toBe(15);
    expect(draft.content_class).toBe("opinion_take");

    const sentinel = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sentinels WHERE consumed_at IS NULL AND revoked_at IS NULL").get();
    expect(sentinel?.n).toBe(1);
    const approval = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM approvals WHERE decided_at IS NULL").get();
    expect(approval?.n).toBe(1);
    db.close();
  });

  test("risk 60-84 escalates but still freezes bytes and requests (forced) human approval", async () => {
    const db = openDb(":memory:");
    migrate(db);
    seedRatified(db);
    const report = await runEngine(db, { generate: fakeGenerate({ riskScore: 70 }), fetchImpl: okFetch }, "x", 1);
    expect(report.awaitingApproval).toBe(1);
    const sentinel = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sentinels").get();
    expect(sentinel?.n).toBe(1);
    db.close();
  });

  test("full-chain LLM block (quality 3) escalates to a hold, no approval requested", async () => {
    const db = openDb(":memory:");
    migrate(db);
    seedRatified(db);
    const report = await runEngine(db, { generate: fakeGenerate({ qualityScore: 3 }), fetchImpl: okFetch }, "x", 1);
    expect(report).toEqual({ ideas: 1, awaitingApproval: 0, escalated: 1 });
    const hold = db.query<{ specialty: string }, []>("SELECT specialty FROM holds WHERE status='open'").get();
    expect(hold?.specialty).toBe("risk");
    const approvals = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM approvals").get();
    expect(approvals?.n).toBe(0);
    db.close();
  });
});
