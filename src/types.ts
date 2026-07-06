// Core contracts. Mirrors drydock's src/types.ts gate shapes (fail-closed, n/a != pass).

export type GateStatus = "pass" | "block" | "n/a" | "escalate";
export type Severity = "low" | "medium" | "high" | "critical";

export interface Finding {
  tool: string;
  ruleId: string;
  severity: Severity;
  message: string;
  /** Offending text span, verbatim, so the fixer can localize. */
  span?: string;
  evidence?: Record<string, unknown>;
}

export interface GateVerdict {
  gate: string;
  status: GateStatus;
  findings: Finding[];
  blocking: number;
  ranAt: string;
}

export interface EvidenceRef {
  claim?: string;
  url?: string;
  note?: string;
}

/** What a gate examines: one frozen draft version plus its context. */
export interface DraftSubject {
  draftId: number;
  version: number;
  platform: string;
  contentClass: string;
  bodyText: string;
  canonicalBytes: Uint8Array;
  mediaRefs: string[];
  evidence: EvidenceRef[];
  /** ISO timestamp of the slot the scheduler proposes. */
  proposedSlot?: string;
}

export interface Gate {
  name: string;
  run(subject: DraftSubject): Promise<GateVerdict>;
}

export type ChainOutcome = "pass" | "block" | "escalate" | "n/a";

export type ContentClass =
  | "evergreen_tip"
  | "trend_take"
  | "link_share"
  | "personal_story"
  | "opinion_take"
  | "thread_deep_dive"
  | "reply_ack"
  | "reply_value_add"
  | "reply_boundary";

export type DraftStatus =
  | "drafting"
  | "gating"
  | "blocked"
  | "escalated"
  | "held"
  | "awaiting_approval"
  | "approved"
  | "scheduled"
  | "published"
  | "rejected"
  | "killed";

export const isBlocking = (s: Severity): boolean => s === "high" || s === "critical";

export function verdictOf(gate: string, findings: Finding[]): GateVerdict {
  const blocking = findings.filter((f) => isBlocking(f.severity)).length;
  return {
    gate,
    status: blocking > 0 ? "block" : "pass",
    findings,
    blocking,
    ranAt: new Date().toISOString(),
  };
}

export function notApplicable(gate: string): GateVerdict {
  return { gate, status: "n/a", findings: [], blocking: 0, ranAt: new Date().toISOString() };
}

export function escalation(gate: string, findings: Finding[]): GateVerdict {
  return { gate, status: "escalate", findings, blocking: 0, ranAt: new Date().toISOString() };
}
