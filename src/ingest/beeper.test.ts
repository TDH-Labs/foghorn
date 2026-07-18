import { describe, expect, test } from "bun:test";
import { BeeperSource } from "./beeper.ts";

// Fixture Beeper Desktop API: one group chat, 3 old messages, then 1 new one
// appearing before the second pull. Exercises backfill (direction=before),
// cursor persistence, and incremental (direction=after).

interface FakeState {
  newMessageVisible: boolean;
  calls: string[];
}

function fakeFetch(state: FakeState): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    state.calls.push(url.pathname + "?" + url.searchParams.toString());

    if (url.pathname === "/v1/chats/search") {
      return Response.json({
        items: [
          {
            id: "chat-ai",
            title: "AI Builders",
            type: "group",
            network: "WhatsApp",
            accountID: "wa-1",
            lastActivity: "2026-07-06T10:00:00Z",
          },
        ],
        hasMore: false,
      });
    }

    if (url.pathname === "/v1/chats/chat-ai/messages") {
      const direction = url.searchParams.get("direction");
      const cursor = url.searchParams.get("cursor");
      if (direction === "before" || !direction) {
        // backfill page (newest first window)
        return Response.json({
          items: [
            { id: "m3", chatID: "chat-ai", accountID: "wa-1", senderID: "u2", senderName: "Priya", timestamp: "2026-07-06T09:00:00Z", text: "agents need verifiers", isSender: false },
            { id: "m2", chatID: "chat-ai", accountID: "wa-1", senderID: "me", senderName: "Operator", timestamp: "2026-07-06T08:00:00Z", text: "gates over vibes, always", isSender: true },
            { id: "m1", chatID: "chat-ai", accountID: "wa-1", senderID: "u3", senderName: "Lee", timestamp: "2026-07-06T07:00:00Z", text: "", isSender: false },
          ],
          hasMore: false,
          newestCursor: "cur-m3",
          oldestCursor: "cur-m1",
        });
      }
      // incremental
      if (direction === "after" && cursor === "cur-m3" && state.newMessageVisible) {
        return Response.json({
          items: [
            { id: "m4", chatID: "chat-ai", accountID: "wa-1", senderID: "me", senderName: "Operator", timestamp: "2026-07-06T11:00:00Z", text: "shipping the sentinel today", isSender: true },
          ],
          hasMore: false,
          newestCursor: "cur-m4",
          oldestCursor: "cur-m4",
        });
      }
      return Response.json({ items: [], hasMore: false, newestCursor: cursor, oldestCursor: cursor });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("BeeperSource", () => {
  test("first pull backfills, maps isSender, skips empty; cursor advances on second pull", async () => {
    const state: FakeState = { newMessageVisible: false, calls: [] };
    const source = new BeeperSource({ token: "t", fetchImpl: fakeFetch(state), initialPages: 3 });

    const first = await source.pull(null);
    expect(first.messages).toHaveLength(2); // m1 empty text skipped
    const self = first.messages.find((m) => m.externalId.endsWith(":m2"));
    const other = first.messages.find((m) => m.externalId.endsWith(":m3"));
    expect(self?.isSelf).toBe(true);
    expect(self?.senderName).toBe("Operator");
    expect(other?.isSelf).toBe(false);
    expect(other?.chatName).toBe("AI Builders");
    const parsed = JSON.parse(first.cursor!) as { chats: Record<string, string> };
    expect(parsed.chats["chat-ai"]).toBe("cur-m3");

    // second pull: nothing new yet
    const quiet = await source.pull(first.cursor);
    expect(quiet.messages).toHaveLength(0);

    // a new message lands; incremental pull picks up exactly it, cursor moves on
    state.newMessageVisible = true;
    const incr = await source.pull(first.cursor);
    expect(incr.messages).toHaveLength(1);
    expect(incr.messages[0]?.externalId).toBe("beeper:chat-ai:m4");
    expect(JSON.parse(incr.cursor!).chats["chat-ai"]).toBe("cur-m4");
    // incremental used direction=after with the stored cursor
    expect(state.calls.some((c) => c.includes("direction=after") && c.includes("cursor=cur-m3"))).toBe(true);
  });

  test("requires a token", () => {
    const prev = process.env.BEEPER_ACCESS_TOKEN;
    delete process.env.BEEPER_ACCESS_TOKEN;
    expect(() => new BeeperSource({})).toThrow(/BEEPER_ACCESS_TOKEN/);
    if (prev) process.env.BEEPER_ACCESS_TOKEN = prev;
  });

  test("http errors surface loudly (fail closed, no silent partial sync)", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const source = new BeeperSource({ token: "t", fetchImpl: failing });
    await expect(source.pull(null)).rejects.toThrow(/beeper api 500/);
  });

  test("excludes chats whose title matches an operational-agent suffix by default", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/v1/chats/search") {
        return Response.json({
          items: [
            { id: "chat-real", title: "AI Builders", type: "group", network: "WhatsApp", accountID: "wa-1", lastActivity: "2026-07-06T10:00:00Z" },
            { id: "chat-ops", title: "Marketing - OperatorUser and Hermes Mac Studio", type: "group", network: "Telegram", accountID: "tg-1", lastActivity: "2026-07-09T10:00:00Z" },
          ],
          hasMore: false,
        });
      }
      if (url.pathname === "/v1/chats/chat-real/messages") {
        return Response.json({
          items: [{ id: "m1", chatID: "chat-real", accountID: "wa-1", senderID: "u1", senderName: "Priya", timestamp: "2026-07-06T09:00:00Z", text: "real content", isSender: false }],
          hasMore: false, newestCursor: "cur-1", oldestCursor: "cur-1",
        });
      }
      // The excluded chat's messages endpoint should never be called at all.
      if (url.pathname === "/v1/chats/chat-ops/messages") {
        return Response.json({ items: [{ id: "m9", chatID: "chat-ops", accountID: "tg-1", senderID: "u2", senderName: "Operator", timestamp: "2026-07-09T09:00:00Z", text: "Approved.", isSender: true }], hasMore: false, newestCursor: "cur-9", oldestCursor: "cur-9" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const source = new BeeperSource({ token: "t", fetchImpl, initialPages: 3 });
    const result = await source.pull(null);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.chatId).toBe("chat-real");
    expect(calls.some((p) => p.startsWith("/v1/chats/chat-ops/"))).toBe(false);
  });

  test("excludeTitleSuffixes: [] disables the default filter", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/chats/search") {
        return Response.json({
          items: [{ id: "chat-ops", title: "Marketing - OperatorUser and Hermes Mac Studio", type: "group", network: "Telegram", accountID: "tg-1", lastActivity: "2026-07-09T10:00:00Z" }],
          hasMore: false,
        });
      }
      if (url.pathname === "/v1/chats/chat-ops/messages") {
        return Response.json({ items: [{ id: "m9", chatID: "chat-ops", accountID: "tg-1", senderID: "u2", senderName: "Operator", timestamp: "2026-07-09T09:00:00Z", text: "Approved.", isSender: true }], hasMore: false, newestCursor: "cur-9", oldestCursor: "cur-9" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const source = new BeeperSource({ token: "t", fetchImpl, initialPages: 3, excludeTitleSuffixes: [] });
    const result = await source.pull(null);
    expect(result.messages).toHaveLength(1);
  });
});
