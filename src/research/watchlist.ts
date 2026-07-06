// Watchlist creators + their trailing baselines. Creator posts arrive from the
// trend scanner's web pass (default) or the optional X API read path (budgeted,
// OFF by default). Baselines feed the z-score outperformer detector.

import type { Database } from "bun:sqlite";
import { computeBaseline, engagementOf, robustZ, MIN_BASELINE_N, OUTPERFORM_Z } from "./outperformer.ts";

export function addCreator(db: Database, platform: string, handle: string, nicheTag?: string): number {
  db.run(
    "INSERT OR IGNORE INTO watchlist_creators (platform, handle, niche_tag) VALUES (?, ?, ?)",
    [platform, handle.replace(/^@/, ""), nicheTag ?? null],
  );
  const row = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM watchlist_creators WHERE platform = ? AND handle = ?",
    )
    .get(platform, handle.replace(/^@/, ""));
  return row!.id;
}

export function listCreators(db: Database, activeOnly = true) {
  return db
    .query<{ id: number; platform: string; handle: string; niche_tag: string | null; baseline_json: string; last_polled_at: string | null }, []>(
      `SELECT id, platform, handle, niche_tag, baseline_json, last_polled_at FROM watchlist_creators ${activeOnly ? "WHERE active = 1" : ""} ORDER BY platform, handle`,
    )
    .all();
}

export interface RecordedPost {
  externalId: string;
  postedAt?: string;
  textSnippet?: string;
  url?: string;
  metrics: { likes?: number; reposts?: number; replies?: number; quotes?: number };
}

/** Store observed creator posts and refresh the creator's baseline + z-scores. */
export function recordCreatorPosts(db: Database, creatorId: number, posts: RecordedPost[]): { inserted: number } {
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const p of posts) {
      db.run(
        `INSERT OR IGNORE INTO creator_posts (creator_id, external_id, posted_at, text_snippet, url, metrics_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [creatorId, p.externalId, p.postedAt ?? null, p.textSnippet ?? null, p.url ?? null, JSON.stringify(p.metrics)],
      );
      if ((db.query<{ n: number }, []>("SELECT changes() n").get()?.n ?? 0) === 1) inserted++;
    }
  });
  tx();
  refreshBaseline(db, creatorId);
  return { inserted };
}

export function refreshBaseline(db: Database, creatorId: number): void {
  const rows = db
    .query<{ id: number; metrics_json: string }, [number]>(
      "SELECT id, metrics_json FROM creator_posts WHERE creator_id = ? ORDER BY posted_at DESC LIMIT 60",
    )
    .all(creatorId);
  const engagements = rows.map((r) => engagementOf(JSON.parse(r.metrics_json)));
  const baseline = computeBaseline(engagements);
  db.run("UPDATE watchlist_creators SET baseline_json = ?, last_polled_at = ? WHERE id = ?", [
    JSON.stringify(baseline),
    new Date().toISOString(),
    creatorId,
  ]);
  // re-score all posts for this creator against the fresh baseline
  for (const r of rows) {
    const z = robustZ(engagementOf(JSON.parse(r.metrics_json)), baseline);
    db.run("UPDATE creator_posts SET zscore = ? WHERE id = ?", [z, r.id]);
  }
}

export interface Outperformer {
  postId: number;
  creatorId: number;
  handle: string;
  platform: string;
  zscore: number;
  textSnippet: string | null;
  url: string | null;
}

export function detectOutperformers(db: Database, minZ = OUTPERFORM_Z): Outperformer[] {
  return db
    .query<Outperformer & Record<string, unknown>, [number]>(
      `SELECT cp.id AS postId, cp.creator_id AS creatorId, wc.handle, wc.platform,
              cp.zscore, cp.text_snippet AS textSnippet, cp.url
       FROM creator_posts cp
       JOIN watchlist_creators wc ON wc.id = cp.creator_id
       WHERE cp.zscore IS NOT NULL AND cp.zscore >= ?
       ORDER BY cp.zscore DESC`,
    )
    .all(minZ) as Outperformer[];
}

export { MIN_BASELINE_N };
