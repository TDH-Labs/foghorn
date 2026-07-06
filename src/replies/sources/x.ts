// X mentions collector: GET /2/users/:id/mentions. Shares OAuth1 creds-from-env
// with the publish adapter but is otherwise independent -- reading mentions is
// not part of the send path.

import { credsFromEnv } from "../../publish/adapters/x.ts";
import { oauth1Header, type OAuth1Creds } from "../../connectors/oauth1.ts";
import type { MentionSource, RawMention } from "../mention-source.ts";

interface XMentionRow {
  id: string;
  text: string;
  author_id?: string;
  created_at: string;
  conversation_id?: string;
}

export class XMentionSource implements MentionSource {
  readonly platform = "x";
  private readonly creds: OAuth1Creds;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private userId: string | null;

  constructor(opts: { creds?: OAuth1Creds; fetchImpl?: typeof fetch; baseUrl?: string; userId?: string } = {}) {
    this.creds = opts.creds ?? credsFromEnv();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = opts.baseUrl ?? "https://api.x.com";
    this.userId = opts.userId ?? null;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await this.fetchImpl(url, { headers: { Authorization: oauth1Header(this.creds, "GET", url) } });
    if (!res.ok) throw new Error(`x mentions api ${res.status} on ${path}`);
    return (await res.json()) as T;
  }

  async listMentions(sinceIso: string): Promise<RawMention[]> {
    if (!this.userId) {
      const me = await this.get<{ data: { id: string } }>("/2/users/me");
      this.userId = me.data.id;
    }
    const result = await this.get<{ data?: XMentionRow[] }>(
      `/2/users/${this.userId}/mentions?max_results=50&tweet.fields=created_at,conversation_id,author_id&start_time=${encodeURIComponent(sinceIso)}`,
    );
    return (result.data ?? []).map((t) => ({
      externalId: t.id,
      authorHandle: t.author_id ?? null,
      text: t.text,
      threadKey: t.conversation_id ?? t.id,
      postedAt: t.created_at,
    }));
  }
}
