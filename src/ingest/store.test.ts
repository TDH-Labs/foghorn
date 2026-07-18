import { describe, expect, test } from "bun:test";
import { migrate, openDb } from "../db/index.ts";
import type { IngestMessage } from "./source.ts";
import { ensureSource, getCursor, setCursor, storeMessages } from "./store.ts";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

const LONG_SELF =
  "here is my own fairly long message about agent gating architectures and why deterministic verification beats vibes every single time in production";
const LONG_OTHER =
  "someone else wrote this private opinion about their employer and a health matter that must never leak into any public post ever";

function msg(overrides: Partial<IngestMessage>): IngestMessage {
  return {
    externalId: `m-${Math.random()}`,
    chatId: "chat-1",
    chatName: "AI Builders",
    senderName: "Someone",
    isSelf: false,
    sentAt: "2026-07-01T12:00:00Z",
    text: LONG_OTHER,
    ...overrides,
  };
}

describe("ingest store privacy invariant", () => {
  test("others' messages NEVER reach corpus_docs", () => {
    const db = freshDb();
    const sourceId = ensureSource(db, "beeper");
    storeMessages(db, sourceId, [
      msg({ externalId: "o1", isSelf: false }),
      msg({ externalId: "o2", isSelf: false, text: LONG_OTHER + " again" }),
      msg({ externalId: "s1", isSelf: true, senderName: "User", text: LONG_SELF }),
    ]);
    const corpus = db.query<{ external_id: string }, []>("SELECT external_id FROM corpus_docs").all();
    expect(corpus).toHaveLength(1);
    expect(corpus[0]?.external_id).toBe("s1");
    // the plan's phase-1 verification query: zero non-self rows joined into corpus
    const leakJoin = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) n FROM corpus_docs c JOIN messages m ON m.external_id = c.external_id WHERE m.is_self = 0`,
      )
      .get();
    expect(leakJoin?.n).toBe(0);
    db.close();
  });

  test("shingle classes: others at n=8, self at n=13", () => {
    const db = freshDb();
    const sourceId = ensureSource(db, "beeper");
    storeMessages(db, sourceId, [
      msg({ externalId: "o1", isSelf: false }),
      msg({ externalId: "s1", isSelf: true, text: LONG_SELF }),
    ]);
    const others = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM leak_shingles WHERE is_self = 0").get();
    const self = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM leak_shingles WHERE is_self = 1").get();
    expect(others?.n).toBeGreaterThan(0);
    expect(self?.n).toBeGreaterThan(0);
    db.close();
  });

  test("duplicates are idempotent", () => {
    const db = freshDb();
    const sourceId = ensureSource(db, "beeper");
    const m = msg({ externalId: "dup-1" });
    const first = storeMessages(db, sourceId, [m]);
    const second = storeMessages(db, sourceId, [m]);
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skippedDuplicates).toBe(1);
    db.close();
  });

  test("pii flags are recorded on the message row", () => {
    const db = freshDb();
    const sourceId = ensureSource(db, "beeper");
    storeMessages(db, sourceId, [msg({ externalId: "p1", text: "reach me at user@example.com about the deal" })]);
    const row = db
      .query<{ pii_flags_json: string }, [string]>("SELECT pii_flags_json FROM messages WHERE external_id = ?")
      .get("p1");
    expect(JSON.parse(row!.pii_flags_json)).toContain("email");
    db.close();
  });

  test("cursor round-trips through sources", () => {
    const db = freshDb();
    const sourceId = ensureSource(db, "beeper");
    expect(getCursor(db, sourceId)).toBeNull();
    setCursor(db, sourceId, '{"chats":{"c":"abc"}}');
    expect(getCursor(db, sourceId)).toBe('{"chats":{"c":"abc"}}');
    db.close();
  });
});
