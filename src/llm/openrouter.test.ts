import { afterEach, describe, expect, test } from "bun:test";
import { migrate, openDb } from "../db/index.ts";
import { generateViaOpenRouter } from "./openrouter.ts";

const SAVED_ENV = { ...process.env };
afterEach(() => {
  Object.assign(process.env, SAVED_ENV);
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
});

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  process.env.FOGHORN_LLM_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  return db;
}

describe("generateViaOpenRouter", () => {
  test("sends OpenAI-shaped chat completion, returns text + usage, records ledger row", async () => {
    const db = freshDb();
    let captured: { url: string; auth: string; body: Record<string, unknown> } | undefined;
    const fake = (async (input: string | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        auth: (init?.headers as Record<string, string>)?.Authorization ?? "",
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({
        choices: [{ message: { content: "gates beat vibes" } }],
        usage: { prompt_tokens: 500, completion_tokens: 40 },
      });
    }) as unknown as typeof fetch;

    const result = await generateViaOpenRouter(db, { stage: "draft", prompt: "write something", system: "be terse" }, fake);
    expect(result.text).toBe("gates beat vibes");
    expect(result.model).toBe("deepseek/deepseek-v4-pro");
    expect(captured?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured?.auth).toBe("Bearer sk-or-test");
    expect(captured?.body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "write something" },
    ]);
    const ledger = db.query<{ provider: string; model: string }, []>("SELECT provider, model FROM spend_ledger").get();
    expect(ledger?.provider).toBe("openrouter");
    expect(ledger?.model).toBe("deepseek/deepseek-v4-pro");
    db.close();
  });

  test("non-ok HTTP status throws with detail", async () => {
    const db = freshDb();
    const fake = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await expect(generateViaOpenRouter(db, { stage: "draft", prompt: "x" }, fake)).rejects.toThrow(/429/);
    db.close();
  });

  test("body.error surfaces even on HTTP 200", async () => {
    const db = freshDb();
    const fake = (async () => Response.json({ error: { message: "model overloaded" } })) as unknown as typeof fetch;
    await expect(generateViaOpenRouter(db, { stage: "draft", prompt: "x" }, fake)).rejects.toThrow(/model overloaded/);
    db.close();
  });

  test("whitespace-only content retries once then throws", async () => {
    const db = freshDb();
    let calls = 0;
    const fake = (async () => {
      calls++;
      return Response.json({ choices: [{ message: { content: "   " } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as unknown as typeof fetch;
    await expect(generateViaOpenRouter(db, { stage: "draft", prompt: "x" }, fake)).rejects.toThrow(/whitespace-only/);
    expect(calls).toBe(2);
    db.close();
  });

  test("spend cap blocks before any fetch (fail closed)", async () => {
    const db = freshDb();
    db.run("UPDATE spend_caps SET monthly_cap_usd = 0 WHERE cap_group = 'llm'");
    const neverFetch = (async () => {
      throw new Error("must not fetch when preflight should have blocked");
    }) as unknown as typeof fetch;
    await expect(generateViaOpenRouter(db, { stage: "draft", prompt: "x" }, neverFetch)).rejects.toThrow(/spend blocked/);
    db.close();
  });

  test("missing OPENROUTER_API_KEY throws before constructing a request", async () => {
    const db = freshDb();
    delete process.env.OPENROUTER_API_KEY;
    const neverFetch = (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
    await expect(generateViaOpenRouter(db, { stage: "draft", prompt: "x" }, neverFetch)).rejects.toThrow(/OPENROUTER_API_KEY/);
    db.close();
  });
});
