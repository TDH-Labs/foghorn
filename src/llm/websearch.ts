// Web-search-enabled generation for the trend scanner. Dispatches by
// activeProvider() same as generate.ts: Anthropic's server-side web_search
// tool, or OpenRouter's "openrouter:web_search" server tool. Everything
// fetched from the web is UNTRUSTED and only ever becomes evidence fields on
// trend cards; deterministic gates are the backstop downstream.

import Anthropic from "@anthropic-ai/sdk";
import type { Database } from "bun:sqlite";
import { activeProvider, modelForStage, type Stage } from "../config/models.ts";
import { preflight, record, unitCost } from "../spend/ledger.ts";

export interface WebSearchOpts {
  stage: Stage;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  maxSearches?: number;
}

export interface WebSearchResult {
  text: string;
  model: string;
  searches: number;
}

export async function generateWithWebSearch(db: Database, opts: WebSearchOpts): Promise<WebSearchResult> {
  if (activeProvider() === "openrouter") return generateWithWebSearchOpenRouter(db, opts);
  return generateWithWebSearchAnthropic(db, opts);
}

async function generateWithWebSearchAnthropic(db: Database, opts: WebSearchOpts): Promise<WebSearchResult> {
  const model = modelForStage(opts.stage);
  const maxSearches = opts.maxSearches ?? 6;

  const searchRate = unitCost(db, "llm.web_search.per_search", 0.01);
  const projected = 0.6 + maxSearches * searchRate; // rough token spend + searches
  const pf = preflight(db, "llm", projected);
  if (!pf.ok) throw new Error(`scan spend blocked: ${pf.reason}`);

  const client = new Anthropic({ timeout: 600_000, maxRetries: 2 });
  const response = await client.messages.create({
    model,
    max_tokens: Math.max(opts.maxOutputTokens ?? 1500, 1000),
    ...(opts.system ? { system: opts.system } : {}),
    tools: [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: maxSearches }],
    messages: [{ role: "user", content: opts.prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
  const searches = response.content.filter((b) => b.type === "server_tool_use").length;

  const inRate = unitCost(db, `llm.${model}.in_mtok`, 5);
  const outRate = unitCost(db, `llm.${model}.out_mtok`, 25);
  const tokenCost =
    (response.usage.input_tokens / 1e6) * inRate + (response.usage.output_tokens / 1e6) * outRate;
  record(db, {
    category: "llm",
    units: 1,
    unitCostUsd: tokenCost + searches * searchRate,
    provider: "anthropic",
    model,
    ref: `${opts.stage}:websearch`,
    note: `${searches} searches`,
  });

  if (!text.trim()) throw new Error("web-search generation returned empty text");
  return { text, model, searches };
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterAnnotation {
  type: string;
}

interface OpenRouterWebSearchResponse {
  choices?: { message: { content: string | null; annotations?: OpenRouterAnnotation[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message: string };
}

function openRouterApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return key;
}

async function generateWithWebSearchOpenRouter(
  db: Database,
  opts: WebSearchOpts,
  fetchImpl: typeof fetch = fetch,
): Promise<WebSearchResult> {
  const model = modelForStage(opts.stage);
  const maxResults = opts.maxSearches ?? 6;

  const searchRate = unitCost(db, "llm.web_search.per_search", 0.005);
  const projected = 0.6 + maxResults * searchRate;
  const pf = preflight(db, "llm", projected);
  if (!pf.ok) throw new Error(`scan spend blocked: ${pf.reason}`);

  const messages = [
    ...(opts.system ? [{ role: "system", content: opts.system }] : []),
    { role: "user", content: opts.prompt },
  ];

  const baseUrl = process.env.FOGHORN_OPENROUTER_BASE_URL || OPENROUTER_BASE_URL;
  const isCustomUrl = !!process.env.FOGHORN_OPENROUTER_BASE_URL;
  const tools = isCustomUrl ? undefined : [{ type: "openrouter:web_search", parameters: { engine: "auto", max_results: maxResults } }];

  const res = await fetchImpl(baseUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${openRouterApiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: Math.max(opts.maxOutputTokens ?? 1500, 1000),
      ...(tools ? { tools } : {}),
    }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`openrouter ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as OpenRouterWebSearchResponse;
  if (body.error) throw new Error(`openrouter error: ${body.error.message}`);

  const text = body.choices?.[0]?.message?.content ?? "";
  const citations = body.choices?.[0]?.message?.annotations?.filter((a) => a.type === "url_citation").length ?? 0;
  const searches = Math.max(citations > 0 ? Math.ceil(citations / maxResults) : 0, citations > 0 ? 1 : 0);

  const inRate = unitCost(db, `llm.${model}.in_mtok`, 5);
  const outRate = unitCost(db, `llm.${model}.out_mtok`, 25);
  const tokenCost =
    ((body.usage?.prompt_tokens ?? 0) / 1e6) * inRate + ((body.usage?.completion_tokens ?? 0) / 1e6) * outRate;
  record(db, {
    category: "llm",
    units: 1,
    unitCostUsd: tokenCost + searches * searchRate,
    provider: "openrouter",
    model,
    ref: `${opts.stage}:websearch`,
    note: `${searches} searches, ${citations} citations`,
  });

  if (!text.trim()) throw new Error("web-search generation returned empty text");
  return { text, model, searches };
}
