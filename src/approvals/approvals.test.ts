import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/index.ts";
import { computeNextSlot, expireStaleApprovals, recordDecision, requestApproval, renderApproval } from "./queue.ts";
import { pollOnce, sendPendingApprovals } from "./telegram.ts";
import { effectiveLevel, ratifyPromotion, recordCleanApproval, recordIncident } from "../autonomy/ladder.ts";

process.env.FOGHORN_SENTINEL_SECRET = "test-secret-0123456789abcdef";
process.env.FOGHORN_TELEGRAM_BOT_TOKEN = "123:testtoken";
process.env.FOGHORN_TELEGRAM_CHAT_ID = "7078451053";
// isolate the kill-switch flag: the telegram 'pause' test must not touch data/PAUSED
process.env.FOGHORN_PAUSED_FLAG = `${process.env.TMPDIR ?? "/tmp"}/foghorn-test-paused-${process.pid}`;

function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  db.run("UPDATE settings SET value='00:00-00:00' WHERE key='quiet_hours'"); // avoid local-time flakiness
  return db;
}

function insertAwaitingDraft(db: Database, body = "an approved-worthy post about verifier design"): { draftId: number; approvalId: number } {
  const bytes = new TextEncoder().encode(body);
  db.run(
    "INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, version, status, risk_score) VALUES ('x','opinion_take',?,?,'h',1,'awaiting_approval',22)",
    [body, bytes],
  );
  const draftId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
  const approvalId = requestApproval(db, { id: draftId, version: 1, platform: "x", content_class: "opinion_take", body_text: body, risk_score: 22 });
  return { draftId, approvalId };
}

describe("autonomy ladder", () => {
  test("defaults to L0; global ceiling caps; promotions require ratification and no level-skips", () => {
    const db = freshDb();
    expect(effectiveLevel(db, "x", "opinion_take")).toBe(0);
    ratifyPromotion(db, "x", "opinion_take", 1);
    expect(effectiveLevel(db, "x", "opinion_take")).toBe(1);
    expect(() => ratifyPromotion(db, "x", "opinion_take", 3)).toThrow(/skip/);
    ratifyPromotion(db, "x", "opinion_take", 2);
    // ceiling (settings default 1) caps effective level even after ratifying L2
    expect(effectiveLevel(db, "x", "opinion_take")).toBe(1);
    db.run("UPDATE settings SET value='2' WHERE key='max_autonomy_level'");
    expect(effectiveLevel(db, "x", "opinion_take")).toBe(2);
    db.close();
  });

  test("clean-approval streak offers L2 at 10; incident demotes whole platform with cooldown", () => {
    const db = freshDb();
    ratifyPromotion(db, "x", "opinion_take", 1);
    let offer: number | null = null;
    for (let i = 0; i < 10; i++) offer = recordCleanApproval(db, "x", "opinion_take").offerPromotionTo;
    expect(offer).toBe(2);
    ratifyPromotion(db, "x", "opinion_take", 2);
    db.run("UPDATE settings SET value='3' WHERE key='max_autonomy_level'");
    expect(effectiveLevel(db, "x", "opinion_take")).toBe(2);
    recordIncident(db, "x", "platform strike");
    expect(effectiveLevel(db, "x", "opinion_take")).toBe(1); // demoted + cooling down
    db.close();
  });
});

describe("approval queue", () => {
  test("L0 approve records but does NOT schedule (shadow); render carries the SHADOW tag", () => {
    const db = freshDb();
    const { approvalId } = insertAwaitingDraft(db);
    expect(renderApproval(db, approvalId)).toContain("[SHADOW");
    const result = recordDecision(db, approvalId, "approved", "test");
    expect(result.ok).toBe(true);
    expect(result.scheduled).toBe(false);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM schedule").get()?.n).toBe(0);
    db.close();
  });

  test("L1 approve schedules with jitter + idempotency; first decision wins", () => {
    const db = freshDb();
    ratifyPromotion(db, "x", "opinion_take", 1);
    const { draftId, approvalId } = insertAwaitingDraft(db);
    const result = recordDecision(db, approvalId, "approved", "test");
    expect(result.scheduled).toBe(true);
    const row = db
      .query<{ draft_id: number; jitter_s: number; idempotency_key: string; state: string }, []>(
        "SELECT draft_id, jitter_s, idempotency_key, state FROM schedule",
      )
      .get()!;
    expect(row.draft_id).toBe(draftId);
    expect(row.state).toBe("pending");
    expect(row.jitter_s).toBeGreaterThanOrEqual(0);
    expect(row.jitter_s).toBeLessThan(300);
    expect(row.idempotency_key).toHaveLength(64);

    const second = recordDecision(db, approvalId, "rejected", "test");
    expect(second.ok).toBe(false);
    db.close();
  });

  test("reject resets streak and marks draft rejected", () => {
    const db = freshDb();
    ratifyPromotion(db, "x", "opinion_take", 1);
    recordCleanApproval(db, "x", "opinion_take");
    const { draftId, approvalId } = insertAwaitingDraft(db);
    recordDecision(db, approvalId, "rejected", "test");
    expect(db.query<{ status: string }, [number]>("SELECT status FROM drafts WHERE id=?").get(draftId)?.status).toBe("rejected");
    const streak = db.query<{ clean_streak: number }, []>("SELECT clean_streak FROM autonomy_state WHERE platform='x'").get();
    expect(streak?.clean_streak).toBe(0);
    db.close();
  });

  test("computeNextSlot walks past a full day (daily max)", () => {
    const db = freshDb();
    const today = new Date();
    today.setHours(9, 0, 0, 0);
    for (let i = 0; i < 3; i++) {
      const t = new Date(today.getTime() + i * 4 * 3_600_000);
      db.run("INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, status) VALUES ('x','opinion_take','p',x'00','h','published')");
      const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
      db.run("INSERT INTO schedule (draft_id, platform, scheduled_for, idempotency_key, state) VALUES (?, 'x', ?, ?, 'sent')", [id, t.toISOString(), `k${i}`]);
      db.run("INSERT INTO published_posts (schedule_id, draft_id, platform, external_post_id, published_at) VALUES (last_insert_rowid(), ?, 'x', ?, ?)", [id, `e${i}`, t.toISOString()]);
    }
    const slot = computeNextSlot(db, "x", today);
    expect(slot.getTime()).toBeGreaterThan(today.getTime() + 12 * 3_600_000); // pushed past the packed day
    db.close();
  });

  test("stale approvals expire to holds", () => {
    const db = freshDb();
    const { draftId, approvalId } = insertAwaitingDraft(db);
    db.run("UPDATE approvals SET requested_at = '2026-01-01T00:00:00Z' WHERE id = ?", [approvalId]);
    expect(expireStaleApprovals(db)).toBe(1);
    expect(db.query<{ decision: string }, [number]>("SELECT decision FROM approvals WHERE id=?").get(approvalId)?.decision).toBe("expired");
    expect(db.query<{ status: string }, [number]>("SELECT status FROM drafts WHERE id=?").get(draftId)?.status).toBe("held");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM holds WHERE status='open'").get()?.n).toBe(1);
    db.close();
  });
});

describe("telegram approval loop", () => {
  interface Call { method: string; body: Record<string, unknown> }
  function fakeTelegram(updates: unknown[]): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = url.split("/").pop()!;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ method, body });
      if (method === "getUpdates") return Response.json({ ok: true, result: updates });
      if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: 555 } });
      return Response.json({ ok: true, result: {} });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  test("sendPendingApprovals posts the draft with nonce'd buttons and stores message_id", async () => {
    const db = freshDb();
    const { approvalId } = insertAwaitingDraft(db);
    const nonce = db.query<{ nonce: string }, [number]>("SELECT nonce FROM approvals WHERE id=?").get(approvalId)!.nonce;
    const { fetchImpl, calls } = fakeTelegram([]);
    const sent = await sendPendingApprovals(db, fetchImpl);
    expect(sent).toBe(1);
    const send = calls.find((c) => c.method === "sendMessage")!;
    expect(String(send.body.text)).toContain("verifier design");
    expect(JSON.stringify(send.body.reply_markup)).toContain(`a:${approvalId}:ap:${nonce}`);
    expect(db.query<{ telegram_message_id: string }, [number]>("SELECT telegram_message_id FROM approvals WHERE id=?").get(approvalId)?.telegram_message_id).toBe("555");
    // second run sends nothing (already messaged)
    expect(await sendPendingApprovals(db, fetchImpl)).toBe(0);
    db.close();
  });

  test("approve callback records the decision, edits the message, advances the offset", async () => {
    const db = freshDb();
    const { approvalId } = insertAwaitingDraft(db);
    const nonce = db.query<{ nonce: string }, [number]>("SELECT nonce FROM approvals WHERE id=?").get(approvalId)!.nonce;
    const { fetchImpl, calls } = fakeTelegram([
      {
        update_id: 42,
        callback_query: {
          id: "cb1",
          from: { id: 7078451053 },
          message: { message_id: 555, chat: { id: 7078451053 } },
          data: `a:${approvalId}:ap:${nonce}`,
        },
      },
    ]);
    const report = await pollOnce(db, fetchImpl, 0);
    expect(report.decisions).toBe(1);
    expect(db.query<{ decision: string }, [number]>("SELECT decision FROM approvals WHERE id=?").get(approvalId)?.decision).toBe("approved");
    expect(calls.some((c) => c.method === "editMessageText")).toBe(true);
    expect(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='telegram_offset'").get()?.value).toBe("42");
    db.close();
  });

  test("wrong chat and stale nonce are ignored", async () => {
    const db = freshDb();
    const { approvalId } = insertAwaitingDraft(db);
    const nonce = db.query<{ nonce: string }, [number]>("SELECT nonce FROM approvals WHERE id=?").get(approvalId)!.nonce;
    const { fetchImpl } = fakeTelegram([
      { update_id: 1, callback_query: { id: "c1", from: { id: 999 }, data: `a:${approvalId}:ap:${nonce}` } },
      { update_id: 2, callback_query: { id: "c2", from: { id: 7078451053 }, data: `a:${approvalId}:ap:WRONG` } },
    ]);
    const report = await pollOnce(db, fetchImpl, 0);
    expect(report.decisions).toBe(0);
    expect(db.query<{ decision: string | null }, [number]>("SELECT decision FROM approvals WHERE id=?").get(approvalId)?.decision).toBeNull();
    db.close();
  });

  test('a "promote PLATFORM/CLASS" reply actually ratifies the offered promotion (previously a dead end)', async () => {
    const db = freshDb();
    ratifyPromotion(db, "x", "opinion_take", 1); // start at L1 so a streak means something

    let lastCalls: { method: string; body: Record<string, unknown> }[] = [];
    for (let i = 0; i < 10; i++) {
      const { approvalId } = insertAwaitingDraft(db, `post number ${i} about verifier design patterns`);
      const nonce = db.query<{ nonce: string }, [number]>("SELECT nonce FROM approvals WHERE id=?").get(approvalId)!.nonce;
      const { fetchImpl, calls } = fakeTelegram([
        {
          update_id: 100 + i,
          callback_query: {
            id: `cb${i}`, from: { id: 7078451053 },
            message: { message_id: 1, chat: { id: 7078451053 } },
            data: `a:${approvalId}:ap:${nonce}`,
          },
        },
      ]);
      await pollOnce(db, fetchImpl, 0);
      lastCalls = calls;
    }

    // 10th clean approval offers promotion; message must be a parseable command, not just prose
    const answerCall = lastCalls.find((c) => c.method === "answerCallbackQuery")!;
    expect(String(answerCall.body.text)).toContain("promote x/opinion_take");
    expect(effectiveLevel(db, "x", "opinion_take")).toBe(1); // offered, not yet ratified

    // Reply with exactly the text the bot suggested
    db.run("UPDATE settings SET value='3' WHERE key='max_autonomy_level'"); // raise ceiling so L2 is reachable
    const { fetchImpl: promoteFetch, calls: promoteCalls } = fakeTelegram([
      { update_id: 200, message: { message_id: 2, chat: { id: 7078451053 }, text: "promote x/opinion_take" } },
    ]);
    const report = await pollOnce(db, promoteFetch, 0);
    expect(report.commands).toBe(1);
    expect(effectiveLevel(db, "x", "opinion_take")).toBe(2);
    const sendCall = promoteCalls.find((c) => c.method === "sendMessage")!;
    expect(String(sendCall.body.text)).toContain("promoted x/opinion_take to L2");
    db.close();
  });

  test('"promote" for a platform/class with no autonomy state yet replies clearly instead of crashing', async () => {
    const db = freshDb();
    const { fetchImpl, calls } = fakeTelegram([
      { update_id: 1, message: { message_id: 1, chat: { id: 7078451053 }, text: "promote nostr/thread_deep_dive" } },
    ]);
    const report = await pollOnce(db, fetchImpl, 0);
    expect(report.commands).toBe(1);
    const sendCall = calls.find((c) => c.method === "sendMessage")!;
    expect(String(sendCall.body.text)).toContain("no autonomy state");
    db.close();
  });

  test("'pause' text command from the approver chat pauses the kill switch", async () => {
    const db = freshDb();
    const { fetchImpl } = fakeTelegram([
      { update_id: 7, message: { message_id: 1, chat: { id: 7078451053 }, text: "pause" } },
    ]);
    const report = await pollOnce(db, fetchImpl, 0);
    expect(report.commands).toBe(1);
    expect(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='paused'").get()?.value).toBe("1");
    db.close();
  });
});
