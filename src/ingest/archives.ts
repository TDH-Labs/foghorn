// One-shot importers for platform data exports — the zero-API-cost bootstrap
// corpus. X archive (data/tweets.js) and LinkedIn export (Shares.csv).
// Own posts only, straight into corpus_docs with engagement where available.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { DATA_DIR } from "../config/settings.ts";

export interface ImportReport {
  inserted: number;
  skipped: number;
  source: string;
}

/** Accepts a .zip or an already-extracted directory; returns the directory. */
function materialize(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`archive not found: ${path}`);
  if (statSync(path).isDirectory()) return path;
  if (!path.endsWith(".zip")) throw new Error(`expected a .zip or directory: ${path}`);
  const dest = join(DATA_DIR, "imports", `${label}-${Date.now()}`);
  mkdirSync(dest, { recursive: true });
  const proc = Bun.spawnSync(["unzip", "-o", "-q", path, "-d", dest]);
  if (proc.exitCode !== 0) {
    throw new Error(`unzip failed (${proc.exitCode}): ${proc.stderr.toString().slice(0, 300)}`);
  }
  return dest;
}

function findFile(root: string, names: string[]): string | null {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) queue.push(p);
      else if (names.includes(entry)) return p;
    }
  }
  return null;
}

interface XTweet {
  tweet: {
    id_str: string;
    full_text: string;
    created_at: string;
    favorite_count?: string | number;
    retweet_count?: string | number;
    in_reply_to_status_id_str?: string | null;
  };
}

export function importXArchive(db: Database, path: string): ImportReport {
  const dir = materialize(path, "x-archive");
  const tweetsFile = findFile(dir, ["tweets.js", "tweet.js"]);
  if (!tweetsFile) throw new Error(`no tweets.js/tweet.js under ${dir} — is this an X archive?`);

  const raw = readFileSync(tweetsFile, "utf8");
  const eq = raw.indexOf("=");
  if (eq === -1) throw new Error("unexpected tweets.js format (no assignment prefix)");
  const items = JSON.parse(raw.slice(eq + 1)) as XTweet[];

  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const item of items) {
      const t = item.tweet;
      if (!t?.id_str || !t.full_text) { skipped++; continue; }
      const text = t.full_text;
      const isRetweet = text.startsWith("RT @");
      const engagement = {
        likes: Number(t.favorite_count ?? 0),
        reposts: Number(t.retweet_count ?? 0),
        isRetweet,
        isReply: !!t.in_reply_to_status_id_str,
      };
      const postedAt = new Date(t.created_at).toISOString();
      db.run(
        `INSERT OR IGNORE INTO corpus_docs (kind, platform, external_id, text, posted_at, engagement_json, hash)
         VALUES ('post', 'x', ?, ?, ?, ?, ?)`,
        [`x:${t.id_str}`, text, postedAt, JSON.stringify(engagement), createHash("sha256").update(text).digest("hex")],
      );
      const changed = db.query<{ n: number }, []>("SELECT changes() n").get()?.n ?? 0;
      if (changed === 1) inserted++;
      else skipped++;
    }
  });
  tx();
  return { inserted, skipped, source: tweetsFile };
}

/** Minimal RFC-4180 CSV parser: quoted fields, escaped quotes, newlines in quotes. */
export function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export function importLinkedInExport(db: Database, path: string): ImportReport {
  const dir = materialize(path, "linkedin-export");
  const sharesFile = findFile(dir, ["Shares.csv"]);
  if (!sharesFile) throw new Error(`no Shares.csv under ${dir} — request the full LinkedIn data export`);

  const rows = parseCsv(readFileSync(sharesFile, "utf8"));
  const header = rows[0] ?? [];
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const dateIdx = col("Date");
  const linkIdx = col("ShareLink");
  const textIdx = col("ShareCommentary");
  if (dateIdx === -1 || textIdx === -1) {
    throw new Error(`Shares.csv missing expected columns, got: ${header.join(", ")}`);
  }

  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const row of rows.slice(1)) {
      const text = (row[textIdx] ?? "").trim();
      if (!text) { skipped++; continue; }
      const link = linkIdx !== -1 ? (row[linkIdx] ?? "").trim() : "";
      const posted = (row[dateIdx] ?? "").trim();
      const externalId = link || `li:${createHash("sha256").update(posted + text).digest("hex").slice(0, 16)}`;
      db.run(
        `INSERT OR IGNORE INTO corpus_docs (kind, platform, external_id, text, posted_at, hash)
         VALUES ('post', 'linkedin', ?, ?, ?, ?)`,
        [externalId, text, posted ? new Date(posted).toISOString() : null, createHash("sha256").update(text).digest("hex")],
      );
      const changed = db.query<{ n: number }, []>("SELECT changes() n").get()?.n ?? 0;
      if (changed === 1) inserted++;
      else skipped++;
    }
  });
  tx();
  return { inserted, skipped, source: sharesFile };
}
