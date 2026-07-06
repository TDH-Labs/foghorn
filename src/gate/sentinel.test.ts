import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrate, openDb } from "../db/index.ts";
import { consume, mint, revokeForDraft, verify } from "./sentinel.ts";

process.env.FOGHORN_SENTINEL_SECRET = "test-secret-0123456789abcdef";

function setup(body = "the exact bytes that were gated") {
  const db = openDb(":memory:");
  migrate(db);
  const bytes = new TextEncoder().encode(body);
  db.run(
    `INSERT INTO drafts (platform, content_class, body_text, canonical_bytes, artifact_sha256, version, status)
     VALUES ('x', 'evergreen_tip', ?, ?, 'x', 1, 'gating')`,
    [body, bytes],
  );
  const draftId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
  db.run(
    "INSERT INTO gate_runs (draft_id, draft_version, chain, started_at) VALUES (?, 1, 'full', ?)",
    [draftId, new Date().toISOString()],
  );
  const gateRunId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
  return { db, draftId, gateRunId, bytes };
}

describe("sentinel", () => {
  test("mint then verify with identical bytes passes", () => {
    const { db, draftId, gateRunId, bytes } = setup();
    mint(db, { draftId, version: 1, bytes, gateRunId });
    const v = verify(db, draftId, 1, bytes);
    expect(v.ok).toBe(true);
    db.close();
  });

  test("a single flipped byte is refused", () => {
    const { db, draftId, gateRunId, bytes } = setup();
    mint(db, { draftId, version: 1, bytes, gateRunId });
    const tampered = new Uint8Array(bytes);
    tampered[0] = tampered[0]! ^ 0xff;
    const v = verify(db, draftId, 1, tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("bytes changed");
    db.close();
  });

  test("consume is single-use (replay refused)", () => {
    const { db, draftId, gateRunId, bytes } = setup();
    const { id } = mint(db, { draftId, version: 1, bytes, gateRunId });
    expect(consume(db, id)).toBe(true);
    expect(consume(db, id)).toBe(false);
    // and a consumed sentinel no longer verifies
    expect(verify(db, draftId, 1, bytes).ok).toBe(false);
    db.close();
  });

  test("re-minting revokes the prior sentinel", () => {
    const { db, draftId, gateRunId, bytes } = setup();
    const first = mint(db, { draftId, version: 1, bytes, gateRunId });
    mint(db, { draftId, version: 1, bytes, gateRunId });
    const firstRow = db
      .query<{ revoked_at: string | null }, [number]>("SELECT revoked_at FROM sentinels WHERE id = ?")
      .get(first.id);
    expect(firstRow?.revoked_at).not.toBeNull();
    db.close();
  });

  test("explicit revoke kills verification", () => {
    const { db, draftId, gateRunId, bytes } = setup();
    mint(db, { draftId, version: 1, bytes, gateRunId });
    revokeForDraft(db, draftId);
    expect(verify(db, draftId, 1, bytes).ok).toBe(false);
    db.close();
  });

  test("expired sentinel is refused", () => {
    const { db, draftId, gateRunId, bytes } = setup();
    mint(db, { draftId, version: 1, bytes, gateRunId });
    db.run("UPDATE sentinels SET expires_at = '2000-01-01T00:00:00Z'");
    const v = verify(db, draftId, 1, bytes);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("expired");
    db.close();
  });

  test("wrong version has no sentinel", () => {
    const { db, draftId, gateRunId, bytes } = setup();
    mint(db, { draftId, version: 1, bytes, gateRunId });
    expect(verify(db, draftId, 2, bytes).ok).toBe(false);
    db.close();
  });

  test("MAC mismatch is refused when the row is doctored", () => {
    const { db, draftId, gateRunId, bytes } = setup();
    const { id } = mint(db, { draftId, version: 1, bytes, gateRunId });
    // Attacker rewrites the stored hash to match tampered bytes but can't re-MAC.
    const tampered = new TextEncoder().encode("attacker text");
    const shaHex = require("node:crypto").createHash("sha256").update(tampered).digest("hex");
    db.run("UPDATE sentinels SET artifact_sha256 = ? WHERE id = ?", [shaHex, id]);
    const v = verify(db, draftId, 1, tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("MAC");
    db.close();
  });
});
