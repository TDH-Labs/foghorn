// Post-metrics snapshots. X own-data reads are the cheap path ($0.001/read);
// LinkedIn has no member analytics API (manual weekly import — Phase 8);
// Nostr metrics are relay-dependent and deferred.

import type { Database } from "bun:sqlite";
import { oauth1Header, type OAuth1Creds } from "../connectors/oauth1.ts";
import { preflight, record, unitCost } from "../spend/ledger.ts";

interface PublishedRow {
  id: number;
  external_post_id: string;
}

export interface CollectReport {
  posts: number;
  snapshots: number;
  skipped?: string;
}

export async function collectXMetrics(
  db: Database,
  creds: OAuth1Creds,
  fetchImpl: typeof fetch = fetch,
  opts: { baseUrl?: string; windowDays?: number; collectedAt?: string } = {},
): Promise<CollectReport> {
  const base = opts.baseUrl ?? "https://api.x.com";
  const since = new Date(Date.now() - (opts.windowDays ?? 7) * 86400_000).toISOString();
  const posts = db
    .query<PublishedRow, [string]>(
      "SELECT id, external_post_id FROM published_posts WHERE platform = 'x' AND deleted_at IS NULL AND published_at >= ?",
    )
    .all(since);
  if (posts.length === 0) return { posts: 0, snapshots: 0 };

  const readCost = unitCost(db, "x.own_read", 0.001);
  const pf = preflight(db, "x_own_read", posts.length * readCost);
  if (!pf.ok) return { posts: posts.length, snapshots: 0, skipped: pf.reason };

  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  let snapshots = 0;

  for (let i = 0; i < posts.length; i += 100) {
    const batch = posts.slice(i, i + 100);
    const ids = batch.map((p) => p.external_post_id).join(",");
    const url = `${base}/2/tweets?ids=${encodeURIComponent(ids)}&tweet.fields=public_metrics`;
    const res = await fetchImpl(url, { headers: { Authorization: oauth1Header(creds, "GET", url) } });
    if (!res.ok) throw new Error(`x metrics ${res.status}`);
    const body = (await res.json()) as {
      data?: { id: string; public_metrics?: { impression_count?: number; like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number } }[];
    };
    record(db, { category: "x_own_read", units: batch.length, unitCostUsd: readCost, ref: "metrics" });

    for (const t of body.data ?? []) {
      const post = batch.find((p) => p.external_post_id === t.id);
      if (!post || !t.public_metrics) continue;
      const m = t.public_metrics;
      db.run(
        `INSERT OR IGNORE INTO metrics (published_post_id, collected_at, impressions, likes, replies, reposts, quotes, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [post.id, collectedAt, m.impression_count ?? null, m.like_count ?? null, m.reply_count ?? null, m.retweet_count ?? null, m.quote_count ?? null, JSON.stringify(m)],
      );
      if ((db.query<{ n: number }, []>("SELECT changes() n").get()?.n ?? 0) === 1) snapshots++;
    }
  }
  return { posts: posts.length, snapshots };
}
