// gate -> fix -> re-gate on the FAST chain, bounded and plateau-detected
// Escalation writes a hold packet and moves on —
// the pipeline never blocks on a human. Every accepted fix bumps the draft
// version and revokes any live sentinel.

import type { Database } from "bun:sqlite";
import type { DraftSubject, Finding, Gate } from "../types.ts";
import { runChain } from "../gate/index.ts";
import { sha256Hex, revokeForDraft } from "../gate/sentinel.ts";
import { captureSurface, tamperReason } from "./anti-tamper.ts";

export interface FixerFn {
  (subject: DraftSubject, blocking: Finding[], journal: string[]): Promise<string>;
}

export interface FixLoopResult {
  ok: boolean;
  subject: DraftSubject;
  rounds: number;
  escalated?: { specialty: "voice" | "claims" | "risk" | "platform"; reason: string };
}

function blockSignature(findings: Finding[]): string {
  return findings.map((f) => `${f.tool}:${f.ruleId}`).sort().join("|");
}

function routeSpecialty(findings: Finding[]): "voice" | "claims" | "risk" | "platform" {
  const tools = new Set(findings.map((f) => f.tool));
  if (tools.has("leak") || tools.has("pii") || tools.has("secrets") || tools.has("risk")) return "risk";
  if (tools.has("claims") || tools.has("hallucination")) return "claims";
  if (tools.has("voice") || tools.has("quality")) return "voice";
  return "platform";
}

export function bumpDraftVersion(db: Database, subject: DraftSubject, revisedBody: string): DraftSubject {
  const bytes = new TextEncoder().encode(revisedBody);
  const version = subject.version + 1;
  revokeForDraft(db, subject.draftId);
  db.run(
    `UPDATE drafts SET body_text = ?, canonical_bytes = ?, artifact_sha256 = ?, version = ?, status = 'gating', updated_at = ?
     WHERE id = ?`,
    [revisedBody, bytes, sha256Hex(bytes), version, new Date().toISOString(), subject.draftId],
  );
  return { ...subject, bodyText: revisedBody, canonicalBytes: bytes, version };
}

export function escalateToHold(
  db: Database,
  subject: DraftSubject,
  specialty: "voice" | "claims" | "risk" | "platform",
  reason: string,
  findings: Finding[],
  journal: string[],
): void {
  db.run("INSERT INTO holds (draft_id, packet_json, specialty) VALUES (?, ?, ?)", [
    subject.draftId,
    JSON.stringify({ reason, findings, journal, version: subject.version }),
    specialty,
  ]);
  db.run("UPDATE drafts SET status = 'escalated', updated_at = ? WHERE id = ?", [
    new Date().toISOString(),
    subject.draftId,
  ]);
  db.run("INSERT INTO journal (scope, ref_id, entry_json) VALUES ('draft', ?, ?)", [
    String(subject.draftId),
    JSON.stringify({ action: "escalated", specialty, reason }),
  ]);
}

export async function runFixLoop(
  db: Database,
  fastGates: Gate[],
  initial: DraftSubject,
  fixer: FixerFn,
  opts: { threadSegments?: number } = {},
): Promise<FixLoopResult> {
  const budget = Math.min(4 + 2 * (opts.threadSegments ?? 1), 10);
  const journal: string[] = [];
  let subject = initial;
  let prevSignature: string | null = null;

  for (let round = 0; round < budget; round++) {
    const chain = await runChain(db, fastGates, subject, "fast");
    if (chain.outcome !== "block") {
      return { ok: true, subject, rounds: round };
    }
    const blocking = chain.verdicts
      .filter((v) => v.status === "block")
      .flatMap((v) => v.findings.filter((f) => f.severity === "high" || f.severity === "critical"));

    const signature = blockSignature(blocking);
    if (signature === prevSignature) {
      const reason = `plateau: identical block set two rounds (${signature})`;
      escalateToHold(db, subject, routeSpecialty(blocking), reason, blocking, journal);
      return { ok: false, subject, rounds: round, escalated: { specialty: routeSpecialty(blocking), reason } };
    }
    prevSignature = signature;

    const before = captureSurface(subject);
    let revised: string;
    try {
      revised = await fixer(subject, blocking, journal);
    } catch (err) {
      const reason = `fixer failed: ${err instanceof Error ? err.message : String(err)}`;
      escalateToHold(db, subject, routeSpecialty(blocking), reason, blocking, journal);
      return { ok: false, subject, rounds: round, escalated: { specialty: routeSpecialty(blocking), reason } };
    }

    const tamper = tamperReason(before, revised, subject.evidence.length);
    if (tamper) {
      escalateToHold(db, subject, routeSpecialty(blocking), `anti-tamper: ${tamper}`, blocking, journal);
      return { ok: false, subject, rounds: round, escalated: { specialty: routeSpecialty(blocking), reason: tamper } };
    }

    journal.push(`round ${round}: blocked on [${signature}], applied fix (${revised.length} chars)`);
    db.run("INSERT INTO journal (scope, ref_id, entry_json) VALUES ('draft', ?, ?)", [
      String(subject.draftId),
      JSON.stringify({ action: "fix-round", round, signature }),
    ]);
    subject = bumpDraftVersion(db, subject, revised);
  }

  const reason = `fix budget exhausted (${budget} rounds)`;
  escalateToHold(db, subject, "platform", reason, [], journal);
  return { ok: false, subject, rounds: budget, escalated: { specialty: "platform", reason } };
}
