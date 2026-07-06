import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/index.ts";
import type { DraftSubject, Gate, GateVerdict } from "../types.ts";
import { notApplicable, verdictOf, escalation } from "../types.ts";
import { overall, runChain, runGate } from "./index.ts";

process.env.FOGHORN_SENTINEL_SECRET = "test-secret-0123456789abcdef";

function freshDb(): Database {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function insertDraft(db: Database, body = "hello world"): DraftSubject {
  const bytes = new TextEncoder().encode(body);
  db.run(
    `INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, version, status)
     VALUES ('x', 'evergreen_tip', ?, ?, 'x', 1, 'gating')`,
    [body, bytes],
  );
  const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
  return {
    draftId: id,
    version: 1,
    platform: "x",
    contentClass: "evergreen_tip",
    bodyText: body,
    canonicalBytes: bytes,
    mediaRefs: [],
    evidence: [],
  };
}

const passGate: Gate = { name: "g-pass", run: async () => verdictOf("g-pass", []) };
const naGate: Gate = { name: "g-na", run: async () => notApplicable("g-na") };
const crashGate: Gate = {
  name: "g-crash",
  run: async () => {
    throw new Error("tool binary missing");
  },
};
const blockGate: Gate = {
  name: "g-block",
  run: async () =>
    verdictOf("g-block", [
      { tool: "t", ruleId: "r", severity: "critical", message: "bad" },
    ]),
};
const escalateGate: Gate = {
  name: "g-esc",
  run: async () =>
    escalation("g-esc", [{ tool: "risk", ruleId: "risk-60-84", severity: "medium", message: "human required" }]),
};

describe("fail-closed gate runner", () => {
  test("a crashing gate becomes a blocking critical finding (C-5)", async () => {
    const subject = insertDraft(freshDb());
    const verdict = await runGate(crashGate, subject);
    expect(verdict.status).toBe("block");
    expect(verdict.blocking).toBe(1);
    expect(verdict.findings[0]?.ruleId).toBe("gate-crashed");
    expect(verdict.findings[0]?.severity).toBe("critical");
  });

  test("overall(): block > escalate > pass > n/a", () => {
    const v = (gate: string, status: GateVerdict["status"]): GateVerdict => ({
      gate, status, findings: [], blocking: status === "block" ? 1 : 0, ranAt: "",
    });
    const p = v("a", "pass");
    const b = v("b", "block");
    const e = v("c", "escalate");
    const n = v("d", "n/a");
    expect(overall([p, b, e])).toBe("block");
    expect(overall([p, e, n])).toBe("escalate");
    expect(overall([p, n])).toBe("pass");
    expect(overall([n, n])).toBe("n/a");
    expect(overall([])).toBe("n/a");
  });
});

describe("runChain sentinel minting", () => {
  test("full-chain pass mints a sentinel", async () => {
    const db = freshDb();
    const subject = insertDraft(db);
    const result = await runChain(db, [passGate, naGate], subject, "full");
    expect(result.outcome).toBe("pass");
    expect(result.sentinelId).toBeDefined();
  });

  test("all-n/a board mints NOTHING (n/a != pass)", async () => {
    const db = freshDb();
    const subject = insertDraft(db);
    const result = await runChain(db, [naGate, naGate], subject, "full");
    expect(result.outcome).toBe("n/a");
    expect(result.sentinelId).toBeUndefined();
  });

  test("block mints nothing", async () => {
    const db = freshDb();
    const subject = insertDraft(db);
    const result = await runChain(db, [passGate, blockGate], subject, "full");
    expect(result.outcome).toBe("block");
    expect(result.sentinelId).toBeUndefined();
  });

  test("escalate freezes bytes (sentinel) but outcome stays escalate", async () => {
    const db = freshDb();
    const subject = insertDraft(db);
    const result = await runChain(db, [passGate, escalateGate], subject, "full");
    expect(result.outcome).toBe("escalate");
    expect(result.sentinelId).toBeDefined();
  });

  test("fast chain never mints, even on pass", async () => {
    const db = freshDb();
    const subject = insertDraft(db);
    const result = await runChain(db, [passGate], subject, "fast");
    expect(result.outcome).toBe("pass");
    expect(result.sentinelId).toBeUndefined();
  });

  test("findings are persisted per gate", async () => {
    const db = freshDb();
    const subject = insertDraft(db);
    await runChain(db, [passGate, blockGate, crashGate], subject, "full");
    const rows = db.query<{ gate: string; status: string }, []>(
      "SELECT gate, status FROM gate_findings ORDER BY id",
    ).all();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => r.gate === "g-crash" && r.status === "block")).toBe(true);
  });
});
