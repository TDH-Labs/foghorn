import { describe, expect, test } from "bun:test";
import { XMentionSource } from "./x.ts";

const CREDS = { consumerKey: "k", consumerSecret: "ks", accessToken: "t", accessTokenSecret: "ts" };

describe("XMentionSource", () => {
  test("resolves user id once (caches it), maps X fields to RawMention", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/2/users/me")) return Response.json({ data: { id: "u9" } });
      if (url.includes("/2/users/u9/mentions")) {
        expect(url).toContain("start_time=2026-07-01T00%3A00%3A00.000Z");
        return Response.json({
          data: [
            { id: "m1", text: "great post", author_id: "a1", created_at: "2026-07-06T10:00:00Z", conversation_id: "root1" },
            { id: "m2", text: "no conversation id here", created_at: "2026-07-06T11:00:00Z" },
          ],
        });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const source = new XMentionSource({ creds: CREDS, fetchImpl });
    const mentions = await source.listMentions("2026-07-01T00:00:00.000Z");
    expect(mentions).toHaveLength(2);
    expect(mentions[0]).toEqual({
      externalId: "m1", authorHandle: "a1", text: "great post", threadKey: "root1", postedAt: "2026-07-06T10:00:00Z",
    });
    // missing conversation_id falls back to the mention's own id as threadKey
    expect(mentions[1]?.threadKey).toBe("m2");
    expect(mentions[1]?.authorHandle).toBeNull();

    // second call reuses the cached user id -- no second /2/users/me hit
    await source.listMentions("2026-07-01T00:00:00.000Z");
    expect(calls.filter((c) => c.includes("/2/users/me"))).toHaveLength(1);
  });

  test("api errors surface with status", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const source = new XMentionSource({ creds: CREDS, fetchImpl });
    await expect(source.listMentions("2026-07-01T00:00:00Z")).rejects.toThrow(/401/);
  });

  test("missing env creds throws clearly when none are supplied", () => {
    const prev = { ...process.env };
    for (const k of ["X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) delete process.env[k];
    expect(() => new XMentionSource()).toThrow(/x adapter missing env/);
    Object.assign(process.env, prev);
  });
});
