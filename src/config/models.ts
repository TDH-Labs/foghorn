// Per-stage model tiers (drydock src/config/models.ts pattern).
// Override per stage with FOGHORN_MODEL_<STAGE>, globally with FOGHORN_MODEL.
// Documented cost knob: FOGHORN_MODEL_SCAN=claude-sonnet-5 cuts the biggest line item.

export type Stage =
  | "scan"
  | "ideate"
  | "draft"
  | "fix"
  | "judge_voice"
  | "judge_quality"
  | "judge_risk"
  | "judge_hallucination"
  | "claims_extract"
  | "triage_reply"
  | "profile"
  | "induct"
  | "report"
  | "orchestrate";

type Tier = "reason" | "light";

const STAGE_TIER: Record<Stage, Tier> = {
  scan: "reason",
  ideate: "reason",
  draft: "reason",
  fix: "reason",
  judge_voice: "light",
  judge_quality: "reason",
  judge_risk: "reason",
  judge_hallucination: "reason",
  claims_extract: "light",
  triage_reply: "light",
  profile: "reason",
  induct: "reason",
  report: "light",
  orchestrate: "light",
};

const TIER_MODEL: Record<Tier, string> = {
  reason: "claude-opus-4-8",
  light: "claude-haiku-4-5",
};

export function modelForStage(stage: Stage): string {
  const perStage = process.env[`FOGHORN_MODEL_${stage.toUpperCase()}`];
  if (perStage) return perStage;
  const global = process.env.FOGHORN_MODEL;
  if (global) return global;
  return TIER_MODEL[STAGE_TIER[stage]];
}
