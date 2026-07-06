import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/index.ts";
import type { GenerateFn } from "../profile/profiler.ts";
import type { MentionSource, RawMention } from "./mention-source.ts";
import { runReplyEngine } from "./reply-engine.ts";

process.env.FOGHORN_SENTINEL_SECRET = "test-secret-0123456789abcdef";

function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  db.run("INSERT INTO profiles (version, kind, json, corpus_hash, active) VALUES (1, 'voice', ?, 'h', 1)", [
    JSON.stringify({ tone: ["direct"], voiceprint: { exemplars: [{ text: "gates beat vibes" }] } }),
  ]);
  return db;
}

function fakeSource(mentions: RawMention[]): MentionSource {
  return { platform: "x", listMentions: async () => mentions };
}

function mention(externalId: string, text: string, threadKey = externalId): RawMention {
  return { externalId, authorHandle: "someone", text, threadKey, postedAt: new Date().toISOString() };
}

function fakeGenerate(opts: { riskScore?: number } = {}): GenerateFn {
  return async ({ stage, prompt }) => {
    switch (stage) {
      case "triage_reply": {
        const m = /<mention>([\s\S]*?)<\/mention>/.exec(prompt);
        const text = m?.[1] ?? "";
        if (text.includes("[NOREPLY]")) return { text: JSON.stringify({ triage: "no_reply" }) };
        if (text.includes("[BOUNDARY]")) return { text: JSON.stringify({ triage: "boundary" }) };
        return { text: JSON.stringify({ triage: "value_add" }) };
      }
      case "draft":
        return { text: "a clean reply that should pass every gate easily" };
      case "fix":
        return { text: "a fixed but still clean reply" };
      case "claims_extract":
        return { text: JSON.stringify({ claims: [] }) };
      case "judge_hallucination":
        return { text: JSON.stringify({ verdict: "supported" }) };
      case "judge_voice":
        return { text: JSON.stringify({ score: 90 }) };
      case "judge_quality":
        return { text: JSON.stringify({ score: 9 }) };
      case "judge_risk":
        return { text: JSON.stringify({ risk: opts.riskScore ?? 10 }) };
      default:
        return { text: "{}" };
    }
  };
}

const okFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

describe("reply engine", () => {
  test("kill switch: paused engine touches nothing", async () => {
    const db = freshDb();
    db.run("UPDATE settings SET value='1' WHERE key='paused'");
    let called = false;
    const source: MentionSource = { platform: "x", listMentions: async () => { called = true; return []; } };
    const report = await runReplyEngine(db, { generate: fakeGenerate(), fetchImpl: okFetch }, "x", source);
    expect(report).toEqual({ collected: 0, noReply: 0, awaitingApproval: 0, escalated: 0 });
    expect(called).toBe(false);
    db.close();
  });

  test("no_reply is silence: mention marked skipped, no draft created, journaled", async () => {
    const db = freshDb();
    const source = fakeSource([mention("m1", "[NOREPLY] unpopular hot take, fight me")]);
    const report = await runReplyEngine(db, { generate: fakeGenerate(), fetchImpl: okFetch }, "x", source);
    expect(report).toEqual({ collected: 1, noReply: 1, awaitingApproval: 0, escalated: 0 });
    const row = db
      .query<{ status: string; triage: string; reply_draft_id: number | null }, []>(
        "SELECT status, triage, reply_draft_id FROM mentions",
      )
      .get();
    expect(row).toEqual({ status: "skipped", triage: "no_reply", reply_draft_id: null });
    const journaled = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM journal WHERE entry_json LIKE '%no-reply%'").get();
    expect(journaled?.n).toBe(1);
    db.close();
  });

  test("clean value_add reply: drafted, gated, sentinel minted, awaiting approval", async () => {
    const db = freshDb();
    const source = fakeSource([mention("m1", "genuine question about the anti-tamper gate")]);
    const report = await runReplyEngine(db, { generate: fakeGenerate(), fetchImpl: okFetch }, "x", source);
    expect(report).toEqual({ collected: 1, noReply: 0, awaitingApproval: 1, escalated: 0 });
    const draft = db
      .query<{ content_class: string; status: string; risk_score: number }, []>(
        "SELECT content_class, status, risk_score FROM drafts",
      )
      .get();
    expect(draft?.content_class).toBe("reply_value_add");
    expect(draft?.status).toBe("awaiting_approval");
    expect(draft?.risk_score).toBe(10);
    const sentinel = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM sentinels WHERE consumed_at IS NULL AND revoked_at IS NULL").get();
    expect(sentinel?.n).toBe(1);
    db.close();
  });

  test("boundary reply gets its own content_class", async () => {
    const db = freshDb();
    const source = fakeSource([mention("m1", "[BOUNDARY] you clearly have no idea what you're talking about")]);
    const report = await runReplyEngine(db, { generate: fakeGenerate(), fetchImpl: okFetch }, "x", source);
    expect(report.awaitingApproval).toBe(1);
    const draft = db.query<{ content_class: string }, []>("SELECT content_class FROM drafts").get();
    expect(draft?.content_class).toBe("reply_boundary");
    db.close();
  });

  test("anti-pile-on: two mentions in the SAME thread -- first gets approval requested, second is held by the gate", async () => {
    const db = freshDb();
    const source = fakeSource([
      mention("m1", "question one about the thread", "thread-shared"),
      mention("m2", "question two, same thread", "thread-shared"),
    ]);
    const report = await runReplyEngine(db, { generate: fakeGenerate(), fetchImpl: okFetch }, "x", source);
    expect(report.collected).toBe(2);
    expect(report.awaitingApproval).toBe(1);
    expect(report.escalated).toBe(1);

    const mentionRows = db
      .query<{ external_id: string; status: string }, []>("SELECT external_id, status FROM mentions ORDER BY id")
      .all();
    expect(mentionRows[0]).toEqual({ external_id: "m1", status: "drafted" });
    expect(mentionRows[1]).toEqual({ external_id: "m2", status: "held" });

    // anti-pile-on is a structural/mechanical violation, not a content-risk one --
    // fixloop's routeSpecialty has no "reply" bucket, so it lands in the catch-all.
    const hold = db.query<{ specialty: string }, []>("SELECT specialty FROM holds WHERE status='open'").get();
    expect(hold?.specialty).toBe("platform");
    db.close();
  });

  test("risk >=85 blocks the full chain and escalates, no approval requested", async () => {
    const db = freshDb();
    const source = fakeSource([mention("m1", "a question that will be judged as risky")]);
    const report = await runReplyEngine(db, { generate: fakeGenerate({ riskScore: 92 }), fetchImpl: okFetch }, "x", source);
    expect(report).toEqual({ collected: 1, noReply: 0, awaitingApproval: 0, escalated: 1 });
    const approvals = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM approvals").get();
    expect(approvals?.n).toBe(0);
    db.close();
  });

  test("re-running against the same mention is idempotent (dedup + no re-triage)", async () => {
    const db = freshDb();
    const source = fakeSource([mention("m1", "[NOREPLY] same bait again")]);
    await runReplyEngine(db, { generate: fakeGenerate(), fetchImpl: okFetch }, "x", source);
    const second = await runReplyEngine(db, { generate: fakeGenerate(), fetchImpl: okFetch }, "x", source);
    expect(second.collected).toBe(0);
    expect(second.noReply).toBe(0);
    db.close();
  });
});
