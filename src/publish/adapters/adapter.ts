// Platform adapter contract. Adapters render from frozen canonical bytes only —
// no templating, no LLM (structurally enforced). verifyOwn() exists so ambiguous
// send failures are resolved by READING before any retry (never blind-retry a write).

export interface PostReceipt {
  externalId: string;
  url: string;
}

export interface OwnPost {
  externalId: string;
  textSha256: string;
  postedAt: string;
}

export interface PlatformAdapter {
  platform: string;
  post(canonicalBytes: Uint8Array, mediaRefs: string[]): Promise<PostReceipt>;
  delete(externalId: string): Promise<void>;
  /** List own recent posts (cheap owned-data read) for verify-then-retry. */
  verifyOwn(sinceIso: string): Promise<OwnPost[]>;
}
