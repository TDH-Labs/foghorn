// Gate regression corpus: every bad post blocked by its INTENDED gate; every
// corrected twin passes the whole deterministic chain. Runs on each `bun test`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../src/db/index.ts";
import { buildFastGates } from "../src/gate/chains.ts";
import { runGate } from "../src/gate/index.ts";
import type { DraftSubject } from "../src/types.ts";
import { ensureSource, storeMessages } from "../src/ingest/store.ts";

interface Case {
  name: string;
  expectBlockedBy: string;
  body: string;
  corrected: string;
  seedOtherMessage?: string;
  seedBannedKeyword?: string;
  seedPublishedBody?: string;
  mediaOutsideLibrary?: boolean;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(ROOT, "fixtures", "bad-posts", "corpus.json"), "utf8")) as {
  cases: Case[];
};

const fakeFetch = (async (input: string | URL) =>
  String(input).includes("dead") ? new Response("", { status: 404 }) : new Response("", { status: 200 })) as unknown as typeof fetch;

function seed(db: Database, c: Case): void {
  if (c.seedOtherMessage) {
    storeMessages(db, ensureSource(db, "beeper"), [
      {
        externalId: `seed-${c.name}`, chatId: "c", chatName: "group", senderName: "Other",
        isSelf: false, sentAt: "2026-07-01T00:00:00Z", text: c.seedOtherMessage,
      },
    ]);
  }
  if (c.seedBannedKeyword) {
    db.run("INSERT INTO banned_topics (pattern, kind) VALUES (?, 'keyword')", [c.seedBannedKeyword]);
  }
  if (c.seedPublishedBody) {
    const bytes = new TextEncoder().encode(c.seedPublishedBody);
    db.run(
      "INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, status) VALUES ('x','opinion_take',?,?,'h','published')",
      [c.seedPublishedBody, bytes],
    );
    const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
    db.run(
      "INSERT INTO schedule (draft_id, platform, scheduled_for, idempotency_key, state) VALUES (?, 'x', ?, ?, 'sent')",
      [id, new Date().toISOString(), `seed-${c.name}`],
    );
  }
}

function subjectFor(c: Case, body: string): DraftSubject {
  return {
    draftId: 424242,
    version: 1,
    platform: "x",
    contentClass: "opinion_take",
    bodyText: body,
    canonicalBytes: new TextEncoder().encode(body),
    mediaRefs: c.mediaOutsideLibrary ? ["/tmp/not-in-library.png"] : [],
    evidence: [],
  };
}

describe("bad-posts regression corpus", () => {
  for (const c of corpus.cases) {
    test(`${c.name}: blocked by ${c.expectBlockedBy}; corrected twin passes the chain`, async () => {
      const db = openDb(":memory:");
      migrate(db);
      seed(db, c);
      const gates = buildFastGates(db, fakeFetch);

      const verdicts = await Promise.all(gates.map((g) => runGate(g, subjectFor(c, c.body))));
      const blockedBy = verdicts.filter((v) => v.status === "block").map((v) => v.gate);
      expect(blockedBy).toContain(c.expectBlockedBy);

      const corrected = subjectFor({ ...c, mediaOutsideLibrary: false }, c.corrected);
      const correctedVerdicts = await Promise.all(gates.map((g) => runGate(g, corrected)));
      const stillBlocked = correctedVerdicts.filter((v) => v.status === "block").map((v) => v.gate);
      expect(stillBlocked).toEqual([]);
      db.close();
    });
  }
});
