// Resilient text generation over the official Anthropic SDK, with the spend
// ledger wired into every call. NEVER import this from src/publish/** —
// tests/no-llm-in-publish.test.ts enforces that structurally.
//
// Lessons encoded: maxOutputTokens floor 4000 (reasoning models silently eat
// small budgets); whitespace-only responses retried once; SDK handles 429/5xx.

import Anthropic from "@anthropic-ai/sdk";
import type { Database } from "bun:sqlite";
import { modelForStage, type Stage } from "../config/models.ts";
import { preflight, record, unitCost } from "../spend/ledger.ts";

const MIN_OUTPUT_TOKENS = 4000;
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
  throw new Error(
    `whitespace-only response after retries: stage=${opts.stage} model=${model} len=${lastText.length}`,
  );
}
