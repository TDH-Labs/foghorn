// Beeper Desktop API collector (local REST, http://localhost:23373).
// Endpoints per developers.beeper.com/desktop-api-reference:
//   GET /v1/chats/search   ?type=group&limit=200&cursor&direction&lastActivityAfter
//   GET /v1/chats/{chatID}/messages ?cursor&direction   -> {items, hasMore, newestCursor, oldestCursor}
// Auth: Bearer token from Beeper Desktop Settings -> Developers.
//
// Cursor model: sources.cursor stores JSON {chats: {chatID: newestCursor}, lastSync}.
// First sync backfills up to `initialPages` pages per chat (direction=before),
// then increments with direction=after from the stored per-chat cursor.

import type { IngestMessage, MessageSource, PullResult } from "./source.ts";

interface BeeperMessage {
  id: string;
  chatID: string;
  accountID: string;
  senderID: string;
  senderName?: string;
  timestamp: string;
  text?: string;
  type?: string;
  isSender?: boolean;
  isDeleted?: boolean;
}

interface BeeperChat {
  id: string;
  title: string;
  type: "single" | "group";
  network: string;
  accountID: string;
  lastActivity: string;
}

interface Page<T> {
  items: T[];
  hasMore: boolean;
  newestCursor?: string;
  oldestCursor?: string;
}

export interface BeeperSourceOpts {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** "group" (default — special-interest group chats) | "any" */
  chatType?: "group" | "any" | "single";
  /** history pages per chat on first sync */
  initialPages?: number;
  /** max messages per pull() call, safety valve */
  maxMessages?: number;
  /**
   * Chats whose title ends with any of these suffixes are skipped entirely —
   * never fetched, never cursor-tracked. Default excludes Hermes's own
   * Telegram topic-mirror chats (e.g. "Marketing - AdamHodl and Hermes Mac
   * Studio") — operational agent chatter, not personal/professional content,
   * confirmed polluting the ideate() syndication-candidate window (most
   * recent 25 corpus docs) with things like "Approved." and topic-admin
   * commands. Pass [] to disable.
   */
  excludeTitleSuffixes?: string[];
}

const DEFAULT_EXCLUDE_TITLE_SUFFIXES = [" - AdamHodl and Hermes Mac Studio"];

interface CursorState {
  chats: Record<string, string>;
  lastSync: string | null;
}

function parseCursor(raw: string | null): CursorState {
  if (!raw) return { chats: {}, lastSync: null };
  try {
    const parsed = JSON.parse(raw) as Partial<CursorState>;
    return { chats: parsed.chats ?? {}, lastSync: parsed.lastSync ?? null };
  } catch {
    return { chats: {}, lastSync: null };
  }
}

export class BeeperSource implements MessageSource {
  readonly kind = "beeper" as const;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly chatType: "group" | "any" | "single";
  private readonly initialPages: number;
  private readonly maxMessages: number;
  private readonly excludeTitleSuffixes: string[];

  constructor(opts: BeeperSourceOpts = {}) {
    const token = opts.token ?? process.env.BEEPER_ACCESS_TOKEN;
    if (!token) throw new Error("BEEPER_ACCESS_TOKEN not set — generate one in Beeper Desktop Settings > Developers");
    this.token = token;
    this.baseUrl = opts.baseUrl ?? "http://localhost:23373";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.chatType = opts.chatType ?? "group";
    this.initialPages = opts.initialPages ?? 5;
    this.maxMessages = opts.maxMessages ?? 5000;
    this.excludeTitleSuffixes = opts.excludeTitleSuffixes ?? DEFAULT_EXCLUDE_TITLE_SUFFIXES;
  }

  private isExcludedChat(chat: BeeperChat): boolean {
    const title = chat.title ?? "";
    return this.excludeTitleSuffixes.some((suffix) => title.endsWith(suffix));
  }

  private async get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`beeper api ${res.status} on ${url.pathname}`);
    return (await res.json()) as T;
  }

  private async listChats(lastSync: string | null): Promise<BeeperChat[]> {
    const chats: BeeperChat[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.get<Page<BeeperChat>>("/v1/chats/search", {
        type: this.chatType,
        limit: "200",
        includeMuted: "true",
        cursor,
        // only revisit chats with activity since the last sync
        lastActivityAfter: lastSync ?? undefined,
      });
      chats.push(...result.items);
      if (!result.hasMore || !result.oldestCursor) break;
      cursor = result.oldestCursor;
    }
    return chats;
  }

  private toIngest(m: BeeperMessage, chat: BeeperChat): IngestMessage | null {
    if (m.isDeleted) return null;
    const text = (m.text ?? "").trim();
    if (!text) return null;
    return {
      externalId: `beeper:${m.chatID}:${m.id}`,
      chatId: m.chatID,
      chatName: chat.title ?? null,
      senderName: m.senderName ?? m.senderID ?? null,
      isSelf: m.isSender === true,
      sentAt: m.timestamp,
      text,
    };
  }

  async pull(rawCursor: string | null): Promise<PullResult> {
    const state = parseCursor(rawCursor);
    const chats = await this.listChats(state.lastSync);
    const out: IngestMessage[] = [];

    for (const chat of chats) {
      if (out.length >= this.maxMessages) break;
      if (this.isExcludedChat(chat)) continue;
      const known = state.chats[chat.id];

      if (known) {
        // Incremental: walk forward from the stored newest cursor.
        let cursor: string | undefined = known;
        for (let page = 0; page < 50 && out.length < this.maxMessages; page++) {
          const result: Page<BeeperMessage> = await this.get<Page<BeeperMessage>>(
            `/v1/chats/${encodeURIComponent(chat.id)}/messages`,
            { cursor, direction: "after" },
          );
          for (const m of result.items) {
            const ing = this.toIngest(m, chat);
            if (ing) out.push(ing);
          }
          if (result.newestCursor) state.chats[chat.id] = result.newestCursor;
          if (!result.hasMore || !result.newestCursor) break;
          cursor = result.newestCursor;
        }
      } else {
        // First sync: bounded backfill from newest going back.
        let cursor: string | undefined;
        for (let page = 0; page < this.initialPages && out.length < this.maxMessages; page++) {
          const result: Page<BeeperMessage> = await this.get<Page<BeeperMessage>>(
            `/v1/chats/${encodeURIComponent(chat.id)}/messages`,
            { cursor, direction: "before" },
          );
          for (const m of result.items) {
            const ing = this.toIngest(m, chat);
            if (ing) out.push(ing);
          }
          if (page === 0 && result.newestCursor) state.chats[chat.id] = result.newestCursor;
          if (!result.hasMore || !result.oldestCursor) break;
          cursor = result.oldestCursor;
        }
      }
    }

    state.lastSync = new Date().toISOString();
    return { messages: out, cursor: JSON.stringify(state) };
  }
}
