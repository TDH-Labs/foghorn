// Read-only "what's being said about my posts" surface. Deliberately separate
// from PlatformAdapter (post/delete/verifyOwn) -- reading mentions has nothing
// to do with the send path.

export interface RawMention {
  externalId: string;
  authorHandle: string | null;
  text: string;
  /** conversation/thread identifier -- gate-reply-thread's anti-pile-on keys off this */
  threadKey: string;
  postedAt: string;
}

export interface MentionSource {
  platform: string;
  listMentions(sinceIso: string): Promise<RawMention[]>;
}
