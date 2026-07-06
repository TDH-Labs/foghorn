import { describe, expect, test } from "bun:test";
import { generateSecretKey, verifyEvent, type Event } from "nostr-tools/pure";
import { LinkedInAdapter } from "./linkedin.ts";
import { NostrAdapter } from "./nostr.ts";
import { XAdapter } from "./x.ts";

const CREDS = { consumerKey: "k", consumerSecret: "ks", accessToken: "t", accessTokenSecret: "ts" };
const bytes = (s: string) => new TextEncoder().encode(s);

describe("XAdapter", () => {
  interface Call { url: string; method: string; auth: string; body?: unknown }
  function fakeX(responses: Record<string, unknown>): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        auth: (init?.headers as Record<string, string>)?.Authorization ?? "",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      for (const [needle, payload] of Object.entries(responses)) {
        if (url.includes(needle)) return Response.json(payload);
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  test("post signs with OAuth1 and returns the tweet receipt", async () => {
    const { fetchImpl, calls } = fakeX({ "/2/tweets": { data: { id: "1901" } } });
    const adapter = new XAdapter({ creds: CREDS, fetchImpl });
    const receipt = await adapter.post(bytes("gates beat vibes"), []);
    expect(receipt.externalId).toBe("1901");
    expect(receipt.url).toContain("1901");
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.auth).toContain("OAuth ");
    expect(call.auth).toContain("oauth_signature=");
    expect(call.body).toEqual({ text: "gates beat vibes" });
  });

  test("media posting fails closed", async () => {
    const adapter = new XAdapter({ creds: CREDS, fetchImpl: fakeX({}).fetchImpl });
    await expect(adapter.post(bytes("x"), ["/media/pic.png"])).rejects.toThrow(/media/);
  });

  test("delete + verifyOwn round-trips", async () => {
    const { fetchImpl, calls } = fakeX({
      "/2/tweets/1901": { data: { deleted: true } },
      "/2/users/me": { data: { id: "u7" } },
      "/2/users/u7/tweets": { data: [{ id: "1901", text: "gates beat vibes", created_at: "2026-07-06T12:00:00Z" }] },
    });
    const adapter = new XAdapter({ creds: CREDS, fetchImpl });
    await adapter.delete("1901");
    expect(calls[0]?.method).toBe("DELETE");
    const own = await adapter.verifyOwn("2026-07-06T00:00:00Z");
    expect(own).toHaveLength(1);
    expect(own[0]?.externalId).toBe("1901");
    expect(own[0]?.textSha256).toHaveLength(64);
  });

  test("api errors surface with status", async () => {
    const failing = (async () => new Response("dup", { status: 403 })) as unknown as typeof fetch;
    const adapter = new XAdapter({ creds: CREDS, fetchImpl: failing });
    await expect(adapter.post(bytes("x"), [])).rejects.toThrow(/403/);
  });
});

describe("NostrAdapter", () => {
  test("signs a valid kind-1 event and publishes when a relay accepts", async () => {
    const sk = generateSecretKey();
    const sent: { relay: string; event: Event }[] = [];
    const adapter = new NostrAdapter({
      secretKey: sk,
      relays: ["wss://one.example", "wss://two.example"],
      send: async (relay, event) => {
        sent.push({ relay, event });
        return relay.includes("one");
      },
    });
    const receipt = await adapter.post(bytes("hello nostr, gates beat vibes"), []);
    expect(sent).toHaveLength(2);
    const event = sent[0]!.event;
    expect(event.kind).toBe(1);
    expect(event.content).toBe("hello nostr, gates beat vibes");
    expect(verifyEvent(event)).toBe(true);
    expect(receipt.externalId).toBe(event.id);
    expect(receipt.url).toContain("njump.me/note1");
  });

  test("zero relay acceptance throws (nothing silently 'published')", async () => {
    const adapter = new NostrAdapter({ secretKey: generateSecretKey(), relays: ["wss://r.example"], send: async () => false });
    await expect(adapter.post(bytes("x"), [])).rejects.toThrow(/no relay accepted/);
  });

  test("delete emits a NIP-09 kind-5 referencing the event", async () => {
    const sent: Event[] = [];
    const adapter = new NostrAdapter({ secretKey: generateSecretKey(), relays: ["wss://r.example"], send: async (_r, e) => (sent.push(e), true) });
    await adapter.delete("abc123");
    expect(sent[0]?.kind).toBe(5);
    expect(sent[0]?.tags).toEqual([["e", "abc123"]]);
  });
});

describe("LinkedInAdapter", () => {
  test("resolves person urn, posts commentary, returns restli id", async () => {
    const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/v2/userinfo")) return Response.json({ sub: "AbC123" });
      if (url.includes("/rest/posts") && init?.method === "POST") {
        return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:987" } });
      }
      if (init?.method === "DELETE") return new Response("", { status: 204 });
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    const adapter = new LinkedInAdapter({ token: "tok", fetchImpl });
    const receipt = await adapter.post(bytes("professional gates beat professional vibes"), []);
    expect(receipt.externalId).toBe("urn:li:share:987");
    expect(receipt.url).toContain("urn:li:share:987");
    const postCall = calls.find((c) => c.method === "POST")!;
    expect(postCall.body?.author).toBe("urn:li:person:AbC123");
    expect(postCall.body?.commentary).toContain("professional gates");

    await adapter.delete("urn:li:share:987");
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toContain(encodeURIComponent("urn:li:share:987"));
  });

  test("non-201 fails loudly", async () => {
    const fetchImpl = (async (input: string | URL) =>
      String(input).includes("userinfo") ? Response.json({ sub: "A" }) : new Response("nope", { status: 422 })) as unknown as typeof fetch;
    const adapter = new LinkedInAdapter({ token: "tok", fetchImpl });
    await expect(adapter.post(bytes("x"), [])).rejects.toThrow(/422/);
  });
});
