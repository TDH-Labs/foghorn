// Anti-tamper semantics: a "fix" that deletes the flagged
// content instead of addressing it is rejected and escalated — never shipped.

import type { DraftSubject } from "../types.ts";

export interface Surface {
  length: number;
  evidenceCount: number;
  disclosures: string[];
}

const DISCLOSURE_RE = /#(ad|sponsored|partner)\b/gi;

export function captureSurface(subject: DraftSubject): Surface {
  return {
    length: subject.bodyText.length,
    evidenceCount: subject.evidence.length,
    disclosures: [...new Set(subject.bodyText.match(DISCLOSURE_RE) ?? [])].map((d) => d.toLowerCase()),
  };
}

export function tamperReason(before: Surface, revisedBody: string, evidenceCount: number): string | null {
  if (revisedBody.trim().length === 0) return "fix emptied the post";
  if (before.length >= 80 && revisedBody.length < before.length * 0.4) {
    return `fix gutted the post (${revisedBody.length} chars < 40% of ${before.length})`;
  }
  if (evidenceCount < before.evidenceCount) return "fix removed evidence references";
  for (const d of before.disclosures) {
    if (!revisedBody.toLowerCase().includes(d)) return `fix dropped required disclosure '${d}'`;
  }
  if (/(as an ai|i cannot|here is the revised|revised post:)/i.test(revisedBody)) {
    return "fix returned meta/non-content text";
  }
  return null;
}
