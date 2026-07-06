// The ONLY writer for ingested chat data. Enforces the privacy invariant:
// others' messages (is_self=0) land in messages + leak_shingles(n=8) and
// NOWHERE else — never corpus_docs, never any prompt. Own messages also get
// n=13 shingles (own private words must not be quoted verbatim in public).

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { IngestMessage } from "./source.ts";
import { piiFlags } from "./redact.ts";
import { OTHERS_N, SELF_N, shingleHashes } from "./shingles.ts";

export interface StoreReport {
  inserted: number;
  skippedDuplicates: number;
  selfToCorpus: number;
}

export function ensureSource(db: Database, kind: string, configJson = "{}"): number {
  const existing = db
    .query<{ id: number }, [string]>("SELECT id FROM sources WHERE kind = ? ORDER BY id LIMIT 1")
    .get(kind);
  if (existing) return existing.id;
  db.run("INSERT INTO sources (kind, config_json) VALUES (?, ?)", [kind, configJson]);
  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
}

export function getCursor(db: Database, sourceId: number): string | null {
  return db.query<{ cursor: string | null }, [number]>("SELECT cursor FROM sources WHERE id = ?").get(sourceId)?.cursor ?? null;
}

export function setCursor(db: Database, sourceId: number, cursor: string | null): void {
  db.run("UPDATE sources SET cursor = ? WHERE id = ?", [cursor, sourceId]);
}

export function storeMessages(db: Database, sourceId: number, messages: IngestMessage[]): StoreReport {
  const report: StoreReport = { inserted: 0, skippedDuplicates: 0, selfToCorpus: 0 };

  const insertAll = db.transaction((msgs: IngestMessage[]) => {
    for (const m of msgs) {
      db.run(
        `INSERT OR IGNORE INTO messages (source_id, external_id, chat_id, chat_name, sender_name, is_self, sent_at, text, pii_flags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sourceId, m.externalId, m.chatId, m.chatName, m.senderName, m.isSelf ? 1 : 0, m.sentAt, m.text, JSON.stringify(piiFlags(m.text))],
      );
      const changed = db.query<{ n: number }, []>("SELECT changes() n").get()?.n ?? 0;
      if (changed !== 1) {
        report.skippedDuplicates++;
        continue;
      }
      report.inserted++;
      const messageId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);

      const n = m.isSelf ? SELF_N : OTHERS_N;
      for (const hash of shingleHashes(m.text, n)) {
        db.run(
          "INSERT OR IGNORE INTO leak_shingles (shingle_hash, message_id, is_self) VALUES (?, ?, ?)",
          [hash, messageId, m.isSelf ? 1 : 0],
        );
      }

      // Own messages ALSO feed the profiling corpus. Others' never do.
      if (m.isSelf) {
        const hash = createHash("sha256").update(m.text).digest("hex");
        db.run(
          `INSERT OR IGNORE INTO corpus_docs (kind, platform, external_id, text, posted_at, hash)
           VALUES ('message', 'chat', ?, ?, ?, ?)`,
          [m.externalId, m.text, m.sentAt, hash],
        );
        const corpusChanged = db.query<{ n: number }, []>("SELECT changes() n").get()?.n ?? 0;
        if (corpusChanged === 1) report.selfToCorpus++;
      }
    }
  });
  insertAll(messages);
  return report;
}
