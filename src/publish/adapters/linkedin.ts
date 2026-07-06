// LinkedIn adapter: official member posting via the versioned REST Posts API
// (w_member_social). No scheduling endpoint exists — our scheduler fires it at
// slot time. Member post analytics are not exposed by the API (documented
// limitation); verifyOwn is best-effort empty.

import type { OwnPost, PlatformAdapter, PostReceipt } from "./adapter.ts";

const LINKEDIN_VERSION = "202506";

export class LinkedInAdapter implements PlatformAdapter {
  readonly platform = "linkedin";
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private personUrn: string | null;

  constructor(opts: { token?: string; personUrn?: string; fetchImpl?: typeof fetch; baseUrl?: string } = {}) {
    const token = opts.token ?? process.env.LINKEDIN_ACCESS_TOKEN;
    if (!token) throw new Error("LINKEDIN_ACCESS_TOKEN not set — run the OAuth grant");
    this.token = token;
    this.personUrn = opts.personUrn ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = opts.baseUrl ?? "https://api.linkedin.com";
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "LinkedIn-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      "content-type": "application/json",
    };
  }

  private async ensureUrn(): Promise<string> {
    if (this.personUrn) return this.personUrn;
    const res = await this.fetchImpl(`${this.base}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`linkedin userinfo ${res.status}`);
    const info = (await res.json()) as { sub: string };
    this.personUrn = `urn:li:person:${info.sub}`;
    return this.personUrn;
  }

  async post(canonicalBytes: Uint8Array, mediaRefs: string[]): Promise<PostReceipt> {
    if (mediaRefs.length > 0) throw new Error("linkedin adapter: media not implemented yet (fail closed)");
    const author = await this.ensureUrn();
    const res = await this.fetchImpl(`${this.base}/rest/posts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        author,
        commentary: new TextDecoder().decode(canonicalBytes),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });
    if (res.status !== 201) {
      const detail = await res.text().catch(() => "");
      throw new Error(`linkedin post ${res.status}: ${detail.slice(0, 200)}`);
    }
    const urn = res.headers.get("x-restli-id");
    if (!urn) throw new Error("linkedin post: missing x-restli-id header");
    return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}` };
  }

  async delete(externalId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/rest/posts/${encodeURIComponent(externalId)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (res.status >= 400) throw new Error(`linkedin delete ${res.status}`);
  }

  async verifyOwn(): Promise<OwnPost[]> {
    return []; // member post listing/analytics not exposed by the API
  }
}
