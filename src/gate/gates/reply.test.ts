import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../db/index.ts";
import type { DraftSubject } from "../../types.ts";
import { gateReplyThread } from "./reply.ts";

function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function insertReplyDraft(db: Database, contentClass: string, status = "awaiting_approval"): number {
  const body = "a reasonable reply";
  db.run(
    "INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, version, status) VALUES ('x', ?, ?, x'00', 'h', 1, ?)",
    [contentClass, body, status],
  );
  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
}

function insertMention(db: Database, threadKey: string, draftId: number | null): number {
  db.run(
    "INSERT INTO mentions (platform, external_id, thread_key, text, reply_draft_id) VALUES ('x', ?, ?, 'hi', ?)",
    [`ext-${Math.random()}`, threadKey, draftId],
  );
  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
}

function subjectFor(draftId: number, contentClass = "reply_value_add"): DraftSubject {
  return {
    draftId, version: 1, platform: "x", contentClass,
    bodyText: "a reasonable reply", canonicalBytes: new TextEncoder().encode("a reasonable reply"),
    mediaRefs: [], evidence: [],
  };
}

describe("gate-reply-thread", () => {
  test("n/a for non-reply content classes", async () => {
    const db = freshDb();
    const draftId = insertReplyDraft(db, "opinion_take");
    const v = await gateReplyThread(db).run(subjectFor(draftId, "opinion_take"));
    expect(v.status).toBe("n/a");
    db.close();
  });

  test("n/a when no mention row references this draft", async () => {
    const db = freshDb();
    const draftId = insertReplyDraft(db, "reply_ack");
    const v = await gateReplyThread(db).run(subjectFor(draftId, "reply_ack"));
    expect(v.status).toBe("n/a");
    db.close();
  });

  test("first reply in a thread passes", async () => {
    const db = freshDb();
    const draftId = insertReplyDraft(db, "reply_value_add");
    insertMention(db, "thread-1", draftId);
    const v = await gateReplyThread(db).run(subjectFor(draftId));
    expect(v.status).toBe("pass");
    db.close();
  });

  test("second reply in the SAME thread is blocked (anti-pile-on) while pending, approved, or published", async () => {
    for (const priorStatus of ["awaiting_approval", "approved", "scheduled", "published"]) {
      const db = freshDb();
      const firstDraft = insertReplyDraft(db, "reply_value_add", priorStatus);
      insertMention(db, "thread-1", firstDraft);
      const secondDraft = insertReplyDraft(db, "reply_boundary", "gating");
      insertMention(db, "thread-1", secondDraft);
      const v = await gateReplyThread(db).run(subjectFor(secondDraft, "reply_boundary"));
      expect(v.status).toBe("block");
      expect(v.findings[0]?.ruleId).toBe("anti-pile-on");
      db.close();
    }
  });

  test("a rejected prior reply in the thread does NOT block a new attempt", async () => {
    const db = freshDb();
    const firstDraft = insertReplyDraft(db, "reply_value_add", "rejected");
    insertMention(db, "thread-1", firstDraft);
    const secondDraft = insertReplyDraft(db, "reply_value_add", "gating");
    insertMention(db, "thread-1", secondDraft);
    const v = await gateReplyThread(db).run(subjectFor(secondDraft));
    expect(v.status).toBe("pass");
    db.close();
  });

  test("re-gating the SAME draft (fix loop iteration) does not self-block", async () => {
    const db = freshDb();
    const draftId = insertReplyDraft(db, "reply_value_add", "gating");
    insertMention(db, "thread-1", draftId);
    const v = await gateReplyThread(db).run(subjectFor(draftId));
    expect(v.status).toBe("pass");
    db.close();
  });

  test("different threads never block each other", async () => {
    const db = freshDb();
    const firstDraft = insertReplyDraft(db, "reply_value_add", "published");
    insertMention(db, "thread-1", firstDraft);
    const secondDraft = insertReplyDraft(db, "reply_ack", "gating");
    insertMention(db, "thread-2", secondDraft);
    const v = await gateReplyThread(db).run(subjectFor(secondDraft, "reply_ack"));
    expect(v.status).toBe("pass");
    db.close();
  });

  test("rate limit: blocks at the configured max-replies/hour, passes below it", async () => {
    const db = freshDb();
    db.run("UPDATE settings SET value = '3' WHERE key = 'max_replies_per_hour'");
    for (let i = 0; i < 3; i++) {
      const d = insertReplyDraft(db, "reply_ack", "published");
      db.run(
        "INSERT INTO schedule (draft_id, platform, scheduled_for, idempotency_key, state) VALUES (?, 'x', ?, ?, 'sent')",
        [d, new Date().toISOString(), `k${i}`],
      );
      const scheduleId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
      db.run(
        "INSERT INTO published_posts (schedule_id, draft_id, platform, external_post_id, published_at) VALUES (?, ?, 'x', ?, ?)",
        [scheduleId, d, `e${i}`, new Date().toISOString()],
      );
    }
    const newDraft = insertReplyDraft(db, "reply_value_add", "gating");
    insertMention(db, "thread-new", newDraft);
    const v = await gateReplyThread(db).run(subjectFor(newDraft));
    expect(v.status).toBe("block");
    expect(v.findings.some((f) => f.ruleId === "rate-limit")).toBe(true);
    db.close();
  });
});
