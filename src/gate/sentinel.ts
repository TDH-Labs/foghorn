// HMAC pass sentinel: the only thing the publisher trusts. Minted exclusively by
// the gate runner on a passing full chain; bound to the exact canonical bytes of
// one draft version; single-use (atomic consume); revoked on any draft edit.
// Missing FOGHORN_SENTINEL_SECRET => random per-process key, which fails closed
// across processes (drydock sentinelMac semantics).

import { createHmac, createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

const SENTINEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let ephemeralWarned = false;
let ephemeralKey: string | null = null;

function secret(): string {
  const env = process.env.FOGHORN_SENTINEL_SECRET;
  if (env && env.length >= 16) return env;
  if (!ephemeralKey) ephemeralKey = randomBytes(32).toString("hex");
  if (!ephemeralWarned) {
    ephemeralWarned = true;
    console.error(
      "[sentinel] FOGHORN_SENTINEL_SECRET unset/short — using ephemeral per-process key (fails closed across processes)",
    );
  }
  return ephemeralKey;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mac(artifactSha256: string, draftId: number, version: number, gateRunId: number, mintedAt: string): string {
  return createHmac("sha256", secret())
    .update(`${artifactSha256}|${draftId}|${version}|${gateRunId}|${mintedAt}`)
    .digest("hex");
}

interface SentinelRow {
  id: number;
  draft_id: number;
  draft_version: number;
  artifact_sha256: string;
  mac: string;
  minted_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

/** Revoke all live sentinels for a draft (any edit or re-gate calls this first). */
export function revokeForDraft(db: Database, draftId: number): void {
  db.run(
    "UPDATE sentinels SET revoked_at = ? WHERE draft_id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
    [new Date().toISOString(), draftId],
  );
}

export function mint(
  db: Database,
  args: { draftId: number; version: number; bytes: Uint8Array; gateRunId: number },
): { id: number; artifactSha256: string } {
  revokeForDraft(db, args.draftId);
  const artifactSha256 = sha256Hex(args.bytes);
  const mintedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SENTINEL_TTL_MS).toISOString();
  db.run(
    `INSERT INTO sentinels (draft_id, draft_version, artifact_sha256, mac, minted_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [args.draftId, args.version, artifactSha256, mac(artifactSha256, args.draftId, args.version, args.gateRunId, mintedAt), mintedAt, expiresAt],
  );
  // gateRunId is baked into the MAC; recover it for verification via gate_runs.sentinel_id
  const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id);
  db.run("UPDATE gate_runs SET sentinel_id = ? WHERE id = ?", [id, args.gateRunId]);
  return { id, artifactSha256 };
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  sentinelId?: number;
}

/** Verify the exact bytes about to be sent against the live sentinel. */
export function verify(db: Database, draftId: number, version: number, bytes: Uint8Array): VerifyResult {
  const row = db
    .query<SentinelRow, [number, number]>(
      `SELECT * FROM sentinels
       WHERE draft_id = ? AND draft_version = ? AND consumed_at IS NULL AND revoked_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(draftId, version);
  if (!row) return { ok: false, reason: "no live sentinel for this draft version" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: "sentinel expired" };

  const actualSha = sha256Hex(bytes);
  if (actualSha !== row.artifact_sha256) {
    return { ok: false, reason: `artifact bytes changed since gating (sha ${actualSha.slice(0, 12)} != ${row.artifact_sha256.slice(0, 12)})` };
  }
  const gateRun = db
    .query<{ id: number }, [number]>("SELECT id FROM gate_runs WHERE sentinel_id = ?")
    .get(row.id);
  if (!gateRun) return { ok: false, reason: "no gate run backs this sentinel" };
  const expected = mac(row.artifact_sha256, draftId, version, gateRun.id, row.minted_at);
  if (expected !== row.mac) return { ok: false, reason: "sentinel MAC mismatch (wrong key or tampered row)" };
  return { ok: true, sentinelId: row.id };
}

/** Atomic single-use consume. Returns false if already consumed (replay). */
export function consume(db: Database, sentinelId: number): boolean {
  db.run("UPDATE sentinels SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", [
    new Date().toISOString(),
    sentinelId,
  ]);
  const row = db.query<{ n: number }, []>("SELECT changes() AS n").get();
  return (row?.n ?? 0) === 1;
}
