// Chain assembly: FAST (deterministic, inner fix loop) and FULL (fast + LLM
// judges, run once at convergence; the only chain that can mint a sentinel).

import type { Database } from "bun:sqlite";
import type { Gate } from "../types.ts";
import type { GenerateFn } from "../profile/profiler.ts";
import {
  gateBannedTopics,
  gateCadence,
  gateDedup,
  gateMediaRights,
  gatePlatformLimits,
  gatePrivateLeak,
  gateSecretsPii,
} from "./gates/deterministic.ts";
import { gateLinks } from "./gates/links.ts";
import { gateReplyThread } from "./gates/reply.ts";
import {
  gateClaimsEvidence,
  gateHallucination,
  gateQuality,
  gateRisk,
  gateVoice,
} from "./gates/llm.ts";

export function buildFastGates(db: Database, fetchImpl: typeof fetch = fetch): Gate[] {
  return [
    gateSecretsPii(db),
    gatePrivateLeak(db),
    gateBannedTopics(db),
    gatePlatformLimits(),
    gateLinks(db, fetchImpl),
    gateDedup(db),
    gateCadence(db),
    gateMediaRights(),
    gateReplyThread(db), // n/a for non-reply content classes
  ];
}

export function buildFullGates(db: Database, generate: GenerateFn, fetchImpl: typeof fetch = fetch): Gate[] {
  return [
    ...buildFastGates(db, fetchImpl),
    gateClaimsEvidence(generate),
    gateHallucination(generate),
    gateVoice(db, generate),
    gateQuality(generate),
    gateRisk(generate),
  ];
}
