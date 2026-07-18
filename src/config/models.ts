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

// OpenRouter slugs use "vendor/model" format.
// OpenCode Go uses bare slugs without vendor prefix (confirmed 2026-07-17).
// The FOGHORN_OPENROUTER_BASE_URL env var signals which gateway is active.
const OPENROUTER_TIER_MODEL: Record<Tier, string> = {
  reason: "deepseek/deepseek-v4-pro",
  light: "deepseek/deepseek-v4-flash",
};
// OpenCode Go uses bare slugs. glm-5.2 / glm-5.1 are non-thinking models
// confirmed working (2026-07-17). kimi-k2.6, kimi-k3, deepseek-v4-* are
// thinking models that return null/empty content — avoid on OpenCode.
// kimi-k2.5 and qwen3.5-plus are also confirmed non-thinking alternatives.
const OPENCODE_TIER_MODEL: Record<Tier, string> = {
  reason: "glm-5.2",
  light: "glm-5.1",
};

function openrouterTierModel(): Record<Tier, string> {
  return process.env.FOGHORN_OPENROUTER_BASE_URL ? OPENCODE_TIER_MODEL : OPENROUTER_TIER_MODEL;
}

export function modelForStage(stage: Stage): string {
  const perStage = process.env[`FOGHORN_MODEL_${stage.toUpperCase()}`];
  if (perStage) return perStage;
  const global = process.env.FOGHORN_MODEL;
  if (global) return global;
  const tierModel = activeProvider() === "openrouter" ? openrouterTierModel() : ANTHROPIC_TIER_MODEL;
  return tierModel[STAGE_TIER[stage]];
}

/**
 * Returns a fallback model to retry with when the primary model returns empty output.
 * Always returns the *light* tier model for the current provider.
 * Returns the same string as modelForStage() when the primary is already light-tier —
 * callers should skip the retry in that case (same model won't help).
 */
export function fallbackModelForStage(stage: Stage): string {
  const tierModel = activeProvider() === "openrouter" ? openrouterTierModel() : ANTHROPIC_TIER_MODEL;
  return tierModel["light"];
}
