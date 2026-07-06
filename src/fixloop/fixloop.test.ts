import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/index.ts";
import type { DraftSubject, Gate } from "../types.ts";
import { verdictOf } from "../types.ts";
import { mint, verify } from "../gate/sentinel.ts";
import { captureSurface, tamperReason } from "./anti-tamper.ts";
import { runFixLoop, type FixerFn } from "./fixloop.ts";

process.env.FOGHORN_SENTINEL_SECRET = "test-secret-0123456789abcdef";

function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function insertDraft(db: Database, body: string): DraftSubject {
  const bytes = new TextEncoder().encode(body);
  db.run(
    "INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, version, status) VALUES ('x','opinion_take',?,?,'h',1,'gating')",
    [body, bytes],
  );
  const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
  return { draftId: id, version: 1, platform: "x", contentClass: "opinion_take", bodyText: body, canonicalBytes: bytes, mediaRefs: [], evidence: [] };
}

/** Gate that blocks while the body contains 'FORBIDDEN'. */
const forbiddenGate: Gate = {
  name: "g-forbidden",
  run: async (s) =>
    verdictOf(
      "g-forbidden",
      s.bodyText.includes("FORBIDDEN")
        ? [{ tool: "test", ruleId: "forbidden-token", severity: "critical", message: "contains FORBIDDEN" }]
        : [],
    ),
};

const BODY = "this long enough post about agents unfortunately says FORBIDDEN which the gate hates a lot";

describe("anti-tamper", () => {
  test("gutting, meta text, dropped disclosure and removed evidence are rejected", () => {
    const s = { ...insertDraft(freshDb(), BODY + " #ad"), evidence: [{ url: "https://e.example.com" }] };
    const surface = captureSurface(s);
    expect(tamperReason(surface, "tiny", 1)).toContain("gutted");
    expect(tamperReason(surface, "Here is the revised post: " + BODY + " #ad", 1)).toContain("meta");
    expect(tamperReason(surface, BODY.replace("FORBIDDEN", "fine"), 1)).toContain("disclosure");
    expect(tamperReason(surface, BODY.replace("FORBIDDEN", "fine") + " #ad", 0)).toContain("evidence");
    expect(tamperReason(surface, BODY.replace("FORBIDDEN", "fine") + " #ad", 1)).toBeNull();
  });
});

describe("fix loop", () => {
  test("fixes in one round, bumps version, revokes prior sentinel", async () => {
    const db = freshDb();
    const subject = insertDraft(db, BODY);
    // pre-mint a sentinel to prove version bump revokes it
    db.run("INSERT INTO gate_runs (draft_id, draft_version, chain, started_at) VALUES (?, 1, 'full', 't')", [subject.draftId]);
    const gr = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
    mint(db, { draftId: subject.draftId, version: 1, bytes: subject.canonicalBytes, gateRunId: gr });

    const fixer: FixerFn = async (s) => s.bodyText.replace("FORBIDDEN", "permitted");
    const result = await runFixLoop(db, [forbiddenGate], subject, fixer);
    expect(result.ok).toBe(true);
    expect(result.subject.version).toBe(2);
    expect(result.subject.bodyText).toContain("permitted");
    expect(verify(db, subject.draftId, 1, subject.canonicalBytes).ok).toBe(false); // revoked
    const row = db.query<{ version: number; status: string }, [number]>("SELECT version, status FROM drafts WHERE id = ?").get(subject.draftId);
    expect(row?.version).toBe(2);
    db.close();
  });

  test("plateau (fixer returns the same body) escalates to a hold", async () => {
    const db = freshDb();
    const subject = insertDraft(db, BODY);
    const stubborn: FixerFn = async (s) => s.bodyText; // never actually fixes
    const result = await runFixLoop(db, [forbiddenGate], subject, stubborn);
    expect(result.ok).toBe(false);
    expect(result.escalated?.reason).toContain("plateau");
    const hold = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM holds WHERE status='open'").get();
    expect(hold?.n).toBe(1);
    const status = db.query<{ status: string }, [number]>("SELECT status FROM drafts WHERE id = ?").get(subject.draftId);
    expect(status?.status).toBe("escalated");
    db.close();
  });

  test("tampering fixer (guts the post) escalates instead of shipping", async () => {
    const db = freshDb();
    const subject = insertDraft(db, BODY);
    const gutter: FixerFn = async () => "ok"; // "fixes" by deleting everything
    const result = await runFixLoop(db, [forbiddenGate], subject, gutter);
    expect(result.ok).toBe(false);
    expect(result.escalated?.reason).toContain("gutted");
    db.close();
  });

  test("fixer crash escalates with the error captured", async () => {
    const db = freshDb();
    const subject = insertDraft(db, BODY);
    const crasher: FixerFn = async () => {
      throw new Error("model outage");
    };
    const result = await runFixLoop(db, [forbiddenGate], subject, crasher);
    expect(result.ok).toBe(false);
    expect(result.escalated?.reason).toContain("model outage");
    db.close();
  });

  test("already-clean draft passes with zero rounds", async () => {
    const db = freshDb();
    const subject = insertDraft(db, "a perfectly clean post about verifier-first agent design patterns");
    const result = await runFixLoop(db, [forbiddenGate], subject, async () => "unused");
    expect(result.ok).toBe(true);
    expect(result.rounds).toBe(0);
    db.close();
  });
});
