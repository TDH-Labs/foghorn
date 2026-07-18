// Fail-closed gate chain runner:
// a gate that throws becomes a blocking critical finding; "n/a" is never "pass";
// an all-n/a board mints no sentinel. Sentinels are minted here and only here.

import type { Database } from "bun:sqlite";
import type { ChainOutcome, DraftSubject, Gate, GateVerdict } from "../types.ts";
import { mint } from "./sentinel.ts";

/** Deterministic gates only — the inner fix loop iterates on these. */
export const FAST_GATES: Gate[] = [];
/** Full chain = FAST_GATES + LLM-judged gates; run once at convergence. */
export const GATES: Gate[] = [];

export async function runGate(gate: Gate, subject: DraftSubject): Promise<GateVerdict> {
  try {
    return await gate.run(subject);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      gate: gate.name,
      status: "block",
      blocking: 1,
      ranAt: new Date().toISOString(),
      findings: [
        {
          tool: "gate-runner",
          ruleId: "gate-crashed",
          severity: "critical",
          message: `${gate.name} crashed (fail closed): ${message}`,
        },
      ],
    };
  }
}

export function overall(verdicts: GateVerdict[]): ChainOutcome {
  if (verdicts.some((v) => v.status === "block")) return "block";
  if (verdicts.some((v) => v.status === "escalate")) return "escalate";
  if (verdicts.some((v) => v.status === "pass")) return "pass";
  return "n/a";
}

export interface ChainResult {
  gateRunId: number;
  verdicts: GateVerdict[];
  outcome: ChainOutcome;
  sentinelId?: number;
}

/**
 * Run a chain, persist run + findings, and mint a sentinel iff the outcome
 * freezes an artifact a human (or the ladder) may authorize: pass OR escalate.
 * escalate forces human approval regardless of autonomy level; block and
 * all-n/a mint nothing.
 */
export async function runChain(
  db: Database,
  gates: Gate[],
  subject: DraftSubject,
  chain: "fast" | "full",
): Promise<ChainResult> {
  const startedAt = new Date().toISOString();
  db.run(
    "INSERT INTO gate_runs (draft_id, draft_version, chain, started_at) VALUES (?, ?, ?, ?)",
    [subject.draftId, subject.version, chain, startedAt],
  );
  const gateRunId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id);

  const verdicts: GateVerdict[] = [];
  for (const gate of gates) {
    const verdict = await runGate(gate, subject);
    verdicts.push(verdict);
    if (verdict.findings.length === 0) {
      db.run(
        "INSERT INTO gate_findings (gate_run_id, gate, status) VALUES (?, ?, ?)",
        [gateRunId, verdict.gate, verdict.status],
      );
    }
    for (const f of verdict.findings) {
      db.run(
        `INSERT INTO gate_findings (gate_run_id, gate, status, tool, rule_id, severity, message, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [gateRunId, verdict.gate, verdict.status, f.tool, f.ruleId, f.severity, f.message, JSON.stringify(f.evidence ?? {})],
      );
    }
  }

  const outcome = overall(verdicts);
  let sentinelId: number | undefined;
  if (chain === "full" && (outcome === "pass" || outcome === "escalate")) {
    sentinelId = mint(db, {
      draftId: subject.draftId,
      version: subject.version,
      bytes: subject.canonicalBytes,
      gateRunId,
    }).id;
  }

  db.run("UPDATE gate_runs SET finished_at = ?, overall = ? WHERE id = ?", [
    new Date().toISOString(),
    outcome,
    gateRunId,
  ]);
  return { gateRunId, verdicts, outcome, sentinelId };
}
