// OpenRouter provider: OpenAI-compatible chat completions over raw fetch.
// NOT the Anthropic wire format -- OpenRouter's surface is
// /api/v1/chat/completions with messages[]/choices[0].message.content.
// Selected via config/models.ts activeProvider(); generate.ts dispatches here.

import type { Database } from "bun:sqlite";
import { modelForStage } from "../config/models.ts";
import { preflight, record, unitCost } from "../spend/ledger.ts";
import type { GenerateOpts, GenerateResult } from "./generate.ts";

const MIN_OUTPUT_TOKENS = 500;
const DEFAULT_TIMEOUT_MS = 240_000;
const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterResponse {
  choices?: { message: { content: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message: string };
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return key;
}

function estimateCostUsd(db: Database, model: string, inTok: number, outTok: number): number {
  const inRate = unitCost(db, `llm.${model}.in_mtok`, unitCost(db, "llm.default.in_mtok", 5));
  const outRate = unitCost(db, `llm.${model}.out_mtok`, unitCost(db, "llm.default.out_mtok", 25));
  return (inTok / 1_000_000) * inRate + (outTok / 1_000_000) * outRate;
}

export async function generateViaOpenRouter(
  db: Database,
  opts: GenerateOpts,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerateResult> {
  const model = modelForStage(opts.stage);
  const maxTokens = Math.max(opts.maxOutputTokens ?? 8192, MIN_OUTPUT_TOKENS);

  const projectedIn = Math.ceil((opts.prompt.length + (opts.system?.length ?? 0)) / 3);
  const pf = preflight(db, "llm", estimateCostUsd(db, model, projectedIn, maxTokens));
  if (!pf.ok) throw new Error(`llm spend blocked: ${pf.reason}`);

  const messages = [
    ...(opts.system ? [{ role: "system", content: opts.system }] : []),
    { role: "user", content: opts.prompt },
  ];

  let lastText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchImpl(BASE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`openrouter ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as OpenRouterResponse;
    if (body.error) throw new Error(`openrouter error: ${body.error.message}`);

    const text = body.choices?.[0]?.message?.content ?? "";
    const usage = { in: body.usage?.prompt_tokens ?? 0, out: body.usage?.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 };
    const costUsd = estimateCostUsd(db, model, usage.in, usage.out);
    record(db, {
      category: "llm",
      units: usage.in + usage.out,
      unitCostUsd: usage.in + usage.out > 0 ? costUsd / (usage.in + usage.out) : 0,
      provider: "openrouter",
      model,
      ref: opts.stage,
    });

    if (text.trim().length > 0) return { text, model, usage, costUsd };
    lastText = text;
  }
  throw new Error(`whitespace-only response after retries: stage=${opts.stage} model=${model} len=${lastText.length}`);
}
