// Resilient text generation, dispatched by provider. NEVER import this from
// src/publish/** — tests/no-llm-in-publish.test.ts enforces that structurally.
//
// Lessons encoded: maxOutputTokens floor 500 (reasoning models silently eat
// small budgets); whitespace-only responses retried once; SDK handles 429/5xx.
// After primary retries, a light-tier fallback model is tried before giving up
// (guards against DeepSeek/reasoning model whitespace-flake on the fix stage).
//
// generateTextResilient() is the ONE stable entry point every gate/create/
// profile module calls -- provider selection (config/models.ts activeProvider())
// happens inside it, so no call site needs to know or care which LLM answers.

import Anthropic from "@anthropic-ai/sdk";
import type { Database } from "bun:sqlite";
import { activeProvider, modelForStage, fallbackModelForStage, type Stage } from "../config/models.ts";
import { preflight, record, unitCost } from "../spend/ledger.ts";
import { generateViaOpenRouter } from "./openrouter.ts";
import { generateViaClaudeCli } from "./claude-cli.ts";

// Stages that route through Claude CLI (subscription-billed Sonnet 5)
// instead of the metered API, regardless of activeProvider(). Scoped
// narrowly to insight/recommendation generation -- gates, judges, fix-loop,
// and the actual gate-passing draft stay on the cheap tier. Opt out with
// FOGHORN_DISABLE_CLAUDE_CLI=1 (falls back to the normal API path, e.g. if
// the CLI or subscription auth is unavailable).
const CLAUDE_CLI_STAGES = new Set<Stage>(["ideate"]);

const MIN_OUTPUT_TOKENS = 1000;
const DEFAULT_TIMEOUT_MS = 240_000;

export interface GenerateOpts {
  stage: Stage;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** effort hint for opus-tier stages; ignored for haiku (unsupported there) */
  effort?: "low" | "medium" | "high";
}

export interface GenerateResult {
  text: string;
  model: string;
  usage: { in: number; out: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
}

function estimateCostUsd(db: Database, model: string, inTok: number, outTok: number): number {
  const inRate = unitCost(db, `llm.${model}.in_mtok`, unitCost(db, "llm.default.in_mtok", 5));
  const outRate = unitCost(db, `llm.${model}.out_mtok`, unitCost(db, "llm.default.out_mtok", 25));
  return (inTok / 1_000_000) * inRate + (outTok / 1_000_000) * outRate;
}

let client: Anthropic | null = null;
function getClient(timeoutMs: number): Anthropic {
  if (!client) client = new Anthropic({ timeout: timeoutMs, maxRetries: 2 });
  return client;
}

export async function generateTextResilient(db: Database, opts: GenerateOpts): Promise<GenerateResult> {
  if (CLAUDE_CLI_STAGES.has(opts.stage) && process.env.FOGHORN_DISABLE_CLAUDE_CLI !== "1") {
    try {
      return await generateViaClaudeCli(db, opts);
    } catch (err) {
      // Falls back to the metered API path rather than breaking the whole
      // stage — e.g. `claude auth login` hasn't been run yet, or the CLI
      // binary is unavailable. Logged so the gap is visible, not silent.
      console.error(
        `[generate] claude-cli failed for stage=${opts.stage}, falling back to API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (activeProvider() === "openrouter") {
    try {
      return await generateViaOpenRouter(db, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Whitespace-only flake from primary model — retry once with the light
      // fallback before surfacing the error. Any other error (402, network) re-throws immediately.
      if (!msg.includes("whitespace-only response")) throw err;
      const fallback = fallbackModelForStage(opts.stage);
      console.warn(`[generate] whitespace-only from primary; retrying stage=${opts.stage} with fallback model=${fallback}`);
      return await generateViaOpenRouter(db, opts, fetch, fallback);
    }
  }
  return generateViaAnthropic(db, opts);
}

async function generateViaAnthropic(db: Database, opts: GenerateOpts): Promise<GenerateResult> {
  const model = modelForStage(opts.stage);
  const maxTokens = Math.max(opts.maxOutputTokens ?? 8192, MIN_OUTPUT_TOKENS);

  // Conservative projection: full output budget + rough input estimate.
  const projectedIn = Math.ceil((opts.prompt.length + (opts.system?.length ?? 0)) / 3);
  const projected = estimateCostUsd(db, model, projectedIn, maxTokens);
  const pf = preflight(db, "llm", projected);
  if (!pf.ok) throw new Error(`llm spend blocked: ${pf.reason}`);

  const anthropic = getClient(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const supportsEffort = !model.includes("haiku");

  let lastText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      ...(opts.system ? { system: opts.system } : {}),
      ...(supportsEffort && opts.effort ? { output_config: { effort: opts.effort } } : {}),
      messages: [{ role: "user", content: opts.prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");

    const usage = {
      in: response.usage.input_tokens,
      out: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    };
    const costUsd = estimateCostUsd(db, model, usage.in + Math.ceil(usage.cacheRead * 0.1), usage.out);
    record(db, {
      category: "llm",
      units: usage.in + usage.out,
      unitCostUsd: usage.in + usage.out > 0 ? costUsd / (usage.in + usage.out) : 0,
      provider: "anthropic",
      model,
      ref: opts.stage,
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`llm refusal on stage=${opts.stage} model=${model}`);
    }
    if (text.trim().length > 0) return { text, model, usage, costUsd };
    lastText = text;
  }

  // Primary model exhausted. Try the light-tier fallback once before giving up.
  const fallback = fallbackModelForStage(opts.stage);
  if (fallback !== model) {
    console.warn(`[generate] whitespace-only from ${model}; retrying stage=${opts.stage} with fallback=${fallback}`);
    const fbMaxTokens = Math.max(opts.maxOutputTokens ?? 8192, MIN_OUTPUT_TOKENS);
    const response = await anthropic.messages.create({
      model: fallback,
      max_tokens: fbMaxTokens,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: opts.prompt }],
    });
    const fbText = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const fbUsage = { in: response.usage.input_tokens, out: response.usage.output_tokens, cacheRead: 0, cacheWrite: 0 };
    const fbCost = estimateCostUsd(db, fallback, fbUsage.in, fbUsage.out);
    record(db, { category: "llm", units: fbUsage.in + fbUsage.out, unitCostUsd: fbUsage.in + fbUsage.out > 0 ? fbCost / (fbUsage.in + fbUsage.out) : 0, provider: "anthropic", model: fallback, ref: opts.stage });
    if (fbText.trim().length > 0) return { text: fbText, model: fallback, usage: fbUsage, costUsd: fbCost };
  }

  throw new Error(
    `whitespace-only response after retries: stage=${opts.stage} model=${model} len=${lastText.length}`,
  );
}
