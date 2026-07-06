import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../../db/index.ts";
import { MEDIA_DIR } from "../../config/settings.ts";
import type { DraftSubject } from "../../types.ts";
import { ensureSource, storeMessages } from "../../ingest/store.ts";
import {
  effectiveLength,
  gateBannedTopics,
  gateCadence,
  gateDedup,
  gateMediaRights,
  gatePlatformLimits,
  gatePrivateLeak,
  gateSecretsPii,
  jaccard,
} from "./deterministic.ts";
import { extractUrls, gateLinks } from "./links.ts";

function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function subject(over: Partial<DraftSubject> = {}): DraftSubject {
  const body = over.bodyText ?? "a perfectly ordinary post about shipping deterministic gates";
  return {
    draftId: over.draftId ?? 999,
    version: 1,
    platform: "x",
    contentClass: "opinion_take",
    bodyText: body,
    canonicalBytes: new TextEncoder().encode(body),
    mediaRefs: [],
    evidence: [],
    ...over,
  };
}

describe("gate-secrets-pii", () => {
  test("blocks credentials and PII, passes clean text", async () => {
    const db = freshDb();
    const gate = gateSecretsPii(db);
    expect((await gate.run(subject({ bodyText: "my key is sk-ant-abc123def456ghi789" }))).status).toBe("block");
    expect((await gate.run(subject({ bodyText: "call me at (913) 555-0142" }))).status).toBe("block");
    expect((await gate.run(subject())).status).toBe("pass");
    db.close();
  });

  test("configurable lexicon blocks protected terms", async () => {
    const db = freshDb();
    db.run("INSERT INTO settings (key, value) VALUES ('pii_lexicon', ?)", [JSON.stringify(["harwell kids"])]);
    const v = await gateSecretsPii(db).run(subject({ bodyText: "fun story about the Harwell Kids today" }));
    expect(v.status).toBe("block");
    db.close();
  });
});

describe("gate-private-leak", () => {
  test("8-gram overlap with OTHERS' messages is a critical block; paraphrase passes", async () => {
    const db = freshDb();
    const sourceId = ensureSource(db, "beeper");
    storeMessages(db, sourceId, [
      {
        externalId: "o1", chatId: "c", chatName: "g", senderName: "Friend", isSelf: false,
        sentAt: "2026-07-01T00:00:00Z",
        text: "honestly my company is about to miss payroll next month and nobody knows yet",
      },
    ]);
    const leak = await gatePrivateLeak(db).run(
      subject({ bodyText: "heard that my company is about to miss payroll next month and nobody knows" }),
    );
    expect(leak.status).toBe("block");
    expect(leak.findings[0]?.ruleId).toBe("others-verbatim");
    expect(leak.findings[0]?.severity).toBe("critical");

    const paraphrase = await gatePrivateLeak(db).run(
      subject({ bodyText: "startups quietly running out of cash is more common than people think" }),
    );
    expect(paraphrase.status).toBe("pass");
    db.close();
  });
});

describe("gate-banned-topics", () => {
  test("n/a with empty list; blocks keyword and regex rows", async () => {
    const db = freshDb();
    expect((await gateBannedTopics(db).run(subject())).status).toBe("n/a");
    db.run("INSERT INTO banned_topics (pattern, kind, reason) VALUES ('election', 'keyword', 'no politics')");
    db.run("INSERT INTO banned_topics (pattern, kind) VALUES ('medical (advice|diagnosis)', 'regex')");
    expect((await gateBannedTopics(db).run(subject({ bodyText: "my take on the election tonight" }))).status).toBe("block");
    expect((await gateBannedTopics(db).run(subject({ bodyText: "free medical advice: hydrate" }))).status).toBe("block");
    expect((await gateBannedTopics(db).run(subject({ bodyText: "elections in my codebase" }))).status).toBe("pass");
    db.close();
  });
});

describe("gate-platform-limits", () => {
  test("URL counts as 23 chars on X", () => {
    expect(effectiveLength("x", "read this https://example.com/a-very-long-path-that-goes-on-forever-and-ever")).toBe(
      "read this ".length + 23,
    );
  });
  test("blocks over-length, hashtag and mention overflow", async () => {
    const gate = gatePlatformLimits();
    expect((await gate.run(subject({ bodyText: "x".repeat(281) }))).status).toBe("block");
    expect((await gate.run(subject({ bodyText: "gm #a #b #c #d" }))).status).toBe("block");
    expect((await gate.run(subject({ bodyText: "hey @a @b @c" }))).status).toBe("block");
    expect((await gate.run(subject({ bodyText: "fine post #one @two" }))).status).toBe("pass");
  });
});

describe("gate-links", () => {
  test("extracts unique urls", () => {
    expect(extractUrls("see https://a.com and https://a.com plus https://b.com/x")).toHaveLength(2);
  });
  test("ssrf guard blocks non-https and internal hosts WITHOUT fetching", async () => {
    const db = freshDb();
    const neverFetch = (async () => {
      throw new Error("must not fetch guarded URLs");
    }) as unknown as typeof fetch;
    const v = await gateLinks(db, neverFetch).run(subject({ bodyText: "grab http://localhost:8080/x" }));
    expect(v.status).toBe("block");
    expect(v.findings.some((f) => f.ruleId === "ssrf-guard")).toBe(true);
    db.close();
  });
  test("dead links block; healthy single link passes with cost note", async () => {
    const db = freshDb();
    const fake = (async (input: string | URL) =>
      String(input).includes("dead") ? new Response("", { status: 404 }) : new Response("", { status: 200 })) as unknown as typeof fetch;
    const dead = await gateLinks(db, fake).run(subject({ bodyText: "see https://dead.example.com/gone" }));
    expect(dead.status).toBe("block");
    const ok = await gateLinks(db, fake).run(subject({ bodyText: "see https://alive.example.com/post" }));
    expect(ok.status).toBe("pass");
    expect(ok.findings.some((f) => f.ruleId === "cost-note")).toBe(true);
    db.close();
  });
  test("two links on X block; text with no links is n/a", async () => {
    const db = freshDb();
    const fake = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const multi = await gateLinks(db, fake).run(subject({ bodyText: "https://a.example.com and https://b.example.com" }));
    expect(multi.findings.some((f) => f.ruleId === "multi-link-x")).toBe(true);
    expect(multi.status).toBe("block");
    expect((await gateLinks(db, fake).run(subject())).status).toBe("n/a");
    db.close();
  });
});

describe("gate-dedup", () => {
  function seedPublished(db: Database, body: string): void {
    const bytes = new TextEncoder().encode(body);
    db.run(
      "INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, status) VALUES ('x','opinion_take',?,?,'h','published')",
      [body, bytes],
    );
    const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
    db.run(
      "INSERT INTO schedule (draft_id, platform, scheduled_for, idempotency_key, state) VALUES (?, 'x', ?, ?, 'sent')",
      [id, new Date().toISOString(), `k${id}`],
    );
  }
  test("near-duplicate blocks; unrelated passes; jaccard sane", async () => {
    const db = freshDb();
    const body = "deterministic gates beat vibes every time so ship verifiers not hope my friends";
    seedPublished(db, body);
    expect((await gateDedup(db).run(subject({ bodyText: body }))).status).toBe("block");
    expect((await gateDedup(db).run(subject({ bodyText: "completely different topic entirely about gardening tomatoes in july heat waves" }))).status).toBe("pass");
    expect(jaccard(new Set(["a b c"]), new Set(["a b c"]))).toBe(1);
    db.close();
  });
});

describe("gate-cadence", () => {
  function seedPublishedAt(db: Database, iso: string): void {
    db.run(
      "INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, status) VALUES ('x','opinion_take','p',x'00','h','published')",
    );
    const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
    db.run(
      "INSERT INTO schedule (draft_id, platform, scheduled_for, idempotency_key, state) VALUES (?, 'x', ?, ?, 'sent')",
      [id, iso, `k${id}`],
    );
    db.run(
      "INSERT INTO published_posts (schedule_id, draft_id, platform, external_post_id, published_at) VALUES (last_insert_rowid(), ?, 'x', ?, ?)",
      [id, `e${id}`, iso],
    );
  }

  test("no slot => n/a; daily max and min gap block", async () => {
    const db = freshDb();
    db.run("UPDATE settings SET value='00:00-00:00' WHERE key='quiet_hours'"); // disable quiet hours
    expect((await gateCadence(db).run(subject())).status).toBe("n/a");

    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    for (const h of [8, 9, 10]) {
      const t = new Date(noon);
      t.setHours(h);
      seedPublishedAt(db, t.toISOString());
    }
    const v = await gateCadence(db).run(subject({ proposedSlot: noon.toISOString() }));
    expect(v.findings.some((f) => f.ruleId === "daily-max")).toBe(true);

    const db2 = freshDb();
    db2.run("UPDATE settings SET value='00:00-00:00' WHERE key='quiet_hours'");
    const oneHourAgo = new Date(noon.getTime() - 3_600_000);
    // seed into db2 (fresh) — only one post, 1h before slot => min-gap (3h) blocks
    const bytes = new TextEncoder().encode("p");
    db2.run("INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, status) VALUES ('x','opinion_take','p',?,'h','published')", [bytes]);
    const id = Number(db2.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
    db2.run("INSERT INTO schedule (draft_id, platform, scheduled_for, idempotency_key, state) VALUES (?, 'x', ?, 'k1', 'sent')", [id, oneHourAgo.toISOString()]);
    db2.run("INSERT INTO published_posts (schedule_id, draft_id, platform, external_post_id, published_at) VALUES (1, ?, 'x', 'e1', ?)", [id, oneHourAgo.toISOString()]);
    const gap = await gateCadence(db2).run(subject({ proposedSlot: noon.toISOString() }));
    expect(gap.findings.some((f) => f.ruleId === "min-gap")).toBe(true);
    db.close();
    db2.close();
  });

  test("quiet hours block", async () => {
    const db = freshDb();
    const slot = new Date();
    slot.setHours(23, 30, 0, 0);
    const v = await gateCadence(db).run(subject({ proposedSlot: slot.toISOString() }));
    expect(v.findings.some((f) => f.ruleId === "quiet-hours")).toBe(true);
    db.close();
  });
});

describe("gate-media-rights", () => {
  test("n/a without media; blocks outside-library, missing, unlicensed; passes owned", async () => {
    const gate = gateMediaRights();
    expect((await gate.run(subject())).status).toBe("n/a");
    expect((await gate.run(subject({ mediaRefs: ["/tmp/elsewhere.png"] }))).status).toBe("block");
    expect((await gate.run(subject({ mediaRefs: [join(MEDIA_DIR, "nope.png")] }))).status).toBe("block");

    mkdirSync(MEDIA_DIR, { recursive: true });
    const licensed = join(MEDIA_DIR, "test-owned.png");
    writeFileSync(licensed, "png");
    try {
      expect((await gate.run(subject({ mediaRefs: [licensed] }))).status).toBe("block"); // no sidecar
      writeFileSync(`${licensed}.license`, "owned");
      expect((await gate.run(subject({ mediaRefs: [licensed] }))).status).toBe("pass");
    } finally {
      rmSync(licensed, { force: true });
      rmSync(`${licensed}.license`, { force: true });
    }
  });
});
