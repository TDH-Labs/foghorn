// Per-stage model tiers (drydock src/config/models.ts pattern).
// Override per stage with FOGHORN_MODEL_<STAGE>, globally with FOGHORN_MODEL.
// Documented cost knob: FOGHORN_MODEL_SCAN=claude-sonnet-5 cuts the biggest line item.
//
// Provider is a separate axis from model: FOGHORN_LLM_PROVIDER=openrouter (or
// auto-detect on OPENROUTER_API_KEY) swaps the TIER default only -- explicit
// per-stage/global model overrides above still win regardless of provider.

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

export type Provider = "anthropic" | "openrouter";

/** FOGHORN_LLM_PROVIDER wins outright; else auto-detect on OPENROUTER_API_KEY; else anthropic. */
export function activeProvider(): Provider {
  const explicit = process.env.FOGHORN_LLM_PROVIDER;
  if (explicit === "openrouter" || explicit === "anthropic") return explicit;
  return process.env.OPENROUTER_API_KEY ? "openrouter" : "anthropic";
}

const ANTHROPIC_TIER_MODEL: Record<Tier, string> = {
  reason: "claude-opus-4-8",
  light: "claude-haiku-4-5",
};

// Slugs + prices confirmed against openrouter.ai model pages 2026-07-06 --
// marketplace pricing/slugs shift, re-verify before trusting long-term.
// deepseek-v4-pro $0.435/$0.87 per MTok; deepseek-v4-flash $0.09/$0.18 (the
// `:free` variant was pulled -- do not rely on it). z-ai/glm-5.2 ($0.56/$1.76)
// is a same-tier alternate, selectable via FOGHORN_MODEL_<STAGE> if preferred.
const OPENROUTER_TIER_MODEL: Record<Tier, string> = {
  reason: "deepseek/deepseek-v4-pro",
  light: "deepseek/deepseek-v4-flash",
};

export function modelForStage(stage: Stage): string {
  const perStage = process.env[`FOGHORN_MODEL_${stage.toUpperCase()}`];
  if (perStage) return perStage;
  const global = process.env.FOGHORN_MODEL;
  if (global) return global;
  const tierModel = activeProvider() === "openrouter" ? OPENROUTER_TIER_MODEL : ANTHROPIC_TIER_MODEL;
  return tierModel[STAGE_TIER[stage]];
}
