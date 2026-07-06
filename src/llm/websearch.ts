// Web-search-enabled generation for the trend scanner (Anthropic server-side
// web_search tool — searches run on Anthropic infra, results are cited).
// Everything fetched from the web is UNTRUSTED and only ever becomes evidence
// fields on trend cards; deterministic gates are the backstop downstream.

import Anthropic from "@anthropic-ai/sdk";
import type { Database } from "bun:sqlite";
import { modelForStage, type Stage } from "../config/models.ts";
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
  const model = modelForStage(opts.stage);
  const maxSearches = opts.maxSearches ?? 6;

  const searchRate = unitCost(db, "llm.web_search.per_search", 0.01);
  const projected = 0.6 + maxSearches * searchRate; // rough token spend + searches
  const pf = preflight(db, "llm", projected);
  if (!pf.ok) throw new Error(`scan spend blocked: ${pf.reason}`);

  const client = new Anthropic({ timeout: 600_000, maxRetries: 2 });
  const response = await client.messages.create({
    model,
    max_tokens: Math.max(opts.maxOutputTokens ?? 8192, 4000),
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
