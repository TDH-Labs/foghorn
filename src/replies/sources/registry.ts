// Build the mentions-source map from whatever credentials exist -- mirrors
// publish/adapters/registry.ts. A platform without an implemented/credentialed
// source simply has no entry; the CLI reports that clearly rather than guessing.

import type { MentionSource } from "../mention-source.ts";
import { XMentionSource } from "./x.ts";

export function createMentionSources(): Map<string, MentionSource> {
  const sources = new Map<string, MentionSource>();
  try {
    sources.set("x", new XMentionSource());
  } catch {
    // missing X creds -- no mentions source for x
  }
  // Nostr/LinkedIn mention-listening is a later enhancement (relay REQ /
  // no public comments API respectively) -- same posture as their adapters'
  // verifyOwn() stubs.
  return sources;
}
