// X adapter: pay-per-use API v2 with the OAuth 1.0a user context. Text-first —
// media posting is a later phase and THROWS here (publisher fail-closes the row
// into a hold rather than silently dropping attachments). JSON bodies are not
// part of the OAuth1 signature base (form bodies would be).

import { createHash } from "node:crypto";
import { oauth1Header, type OAuth1Creds } from "../../connectors/oauth1.ts";
import type { OwnPost, PlatformAdapter, PostReceipt } from "./adapter.ts";

export function credsFromEnv(): OAuth1Creds {
  const missing = ["X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"].filter(
    (k) => !process.env[k],
  );
  if (missing.length > 0) throw new Error(`x adapter missing env: ${missing.join(", ")}`);
  return {
    consumerKey: process.env.X_API_KEY!,
    consumerSecret: process.env.X_API_KEY_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  };
}

export class XAdapter implements PlatformAdapter {
  readonly platform = "x";
  private readonly creds: OAuth1Creds;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private userId: string | null = null;

  constructor(opts: { creds?: OAuth1Creds; fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
    this.creds = opts.creds ?? credsFromEnv();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = opts.baseUrl ?? "https://api.x.com";
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: oauth1Header(this.creds, method, url),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`x api ${res.status} on ${method} ${path}: ${detail.slice(0, 200)}`);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  async post(canonicalBytes: Uint8Array, mediaRefs: string[]): Promise<PostReceipt> {
    if (mediaRefs.length > 0) throw new Error("x adapter: media posting not implemented yet (fail closed)");
    const text = new TextDecoder().decode(canonicalBytes);
    const result = await this.call<{ data: { id: string } }>("POST", "/2/tweets", { text });
    if (!result.data?.id) throw new Error("x api returned no tweet id");
    return { externalId: result.data.id, url: `https://x.com/i/web/status/${result.data.id}` };
  }

  async delete(externalId: string): Promise<void> {
    await this.call<{ data: { deleted: boolean } }>("DELETE", `/2/tweets/${externalId}`);
  }

  async verifyOwn(sinceIso: string): Promise<OwnPost[]> {
    if (!this.userId) {
      const me = await this.call<{ data: { id: string } }>("GET", "/2/users/me");
      this.userId = me.data.id;
    }
    const result = await this.call<{ data?: { id: string; text: string; created_at: string }[] }>(
      "GET",
      `/2/users/${this.userId}/tweets?max_results=5&tweet.fields=created_at&start_time=${encodeURIComponent(sinceIso)}`,
    );
    return (result.data ?? []).map((t) => ({
      externalId: t.id,
      textSha256: createHash("sha256").update(t.text).digest("hex"),
      postedAt: t.created_at,
    }));
  }
}
