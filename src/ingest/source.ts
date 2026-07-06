// The ingestion seam (Q1): Beeper Desktop API is the default source, but a
// remote-access or archives-only mode can substitute without touching anything
// downstream — profiler and gates only ever see rows written by store.ts.

export interface IngestMessage {
  /** globally unique per source, e.g. beeper message id */
  externalId: string;
  chatId: string;
  chatName: string | null;
  senderName: string | null;
  isSelf: boolean;
  /** ISO 8601 */
  sentAt: string;
  text: string;
}

export interface PullResult {
  messages: IngestMessage[];
  /** opaque cursor to persist in sources.cursor; null = unchanged */
  cursor: string | null;
}

export interface MessageSource {
  kind: "beeper" | "x_archive" | "linkedin_export" | "manual";
  /** Incremental pull from the persisted cursor (null = first sync). */
  pull(cursor: string | null): Promise<PullResult>;
}
