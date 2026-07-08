// Evidence bank: real, citable facts, so the drafter has something true to
// reach for instead of inventing a number or anecdote. Deliberately no
// embeddings/vector search -- volume is small and personal; the drafter
// itself picks what's relevant out of the full approved set.
//
// Two ways in: `addEvidence` is an explicit human act (CLI) and lands
// 'approved' immediately. `proposeEvidence` is for machine-extracted
// candidates (see evidence-extract.ts) and lands 'proposed' -- the drafter
// only ever sees 'approved' rows, so extraction can never silently
// reintroduce the fabrication problem this whole thing exists to prevent.

import type { Database } from "bun:sqlite";

export interface EvidenceBankEntry {
  id: number;
  topic: string;
  fact: string;
  status: string;
  source_quote: string | null;
}

export function addEvidence(db: Database, topic: string, fact: string): number {
  db.run("INSERT INTO evidence_bank (topic, fact, added_at, status) VALUES (?, ?, ?, 'approved')", [
    topic,
    fact,
    new Date().toISOString(),
  ]);
  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
}

export function proposeEvidence(
  db: Database,
  topic: string,
  fact: string,
  sourceQuote: string,
  sourceDocId: number | null,
): number {
  db.run(
    `INSERT INTO evidence_bank (topic, fact, added_at, status, source_quote, source_doc_id)
     VALUES (?, ?, ?, 'proposed', ?, ?)`,
    [topic, fact, new Date().toISOString(), sourceQuote, sourceDocId],
  );
  return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);
}

export function approveEvidence(db: Database, id: number): void {
  db.run("UPDATE evidence_bank SET status = 'approved' WHERE id = ?", [id]);
}

export function rejectEvidence(db: Database, id: number): void {
  db.run("UPDATE evidence_bank SET status = 'rejected' WHERE id = ?", [id]);
}

/** Only what the drafter is allowed to cite. */
export function approvedEvidence(db: Database, topic?: string): EvidenceBankEntry[] {
  if (topic) {
    return db
      .query<EvidenceBankEntry, [string]>(
        "SELECT id, topic, fact, status, source_quote FROM evidence_bank WHERE status = 'approved' AND topic = ? ORDER BY id",
      )
      .all(topic);
  }
  return db
    .query<EvidenceBankEntry, []>(
      "SELECT id, topic, fact, status, source_quote FROM evidence_bank WHERE status = 'approved' ORDER BY topic, id",
    )
    .all();
}

/** Everything, for `foghorn evidence list` review UI. */
export function listEvidence(db: Database, status?: string): EvidenceBankEntry[] {
  if (status) {
    return db
      .query<EvidenceBankEntry, [string]>(
        "SELECT id, topic, fact, status, source_quote FROM evidence_bank WHERE status = ? ORDER BY id",
      )
      .all(status);
  }
  return db
    .query<EvidenceBankEntry, []>("SELECT id, topic, fact, status, source_quote FROM evidence_bank ORDER BY status, topic, id")
    .all();
}

export function markEvidenceUsed(db: Database, ids: number[]): void {
  for (const id of ids) {
    db.run("UPDATE evidence_bank SET used_count = used_count + 1, last_used_at = ? WHERE id = ?", [
      new Date().toISOString(),
      id,
    ]);
  }
}
