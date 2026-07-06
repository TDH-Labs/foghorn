// Deterministic style features + exemplar selection from the (self-only)
// corpus. No LLM here — this is the measurable half of the voice profile;
// the profiler's LLM pass interprets on top of it. Same corpus => same output.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export interface Voiceprint {
  corpusHash: string;
  docCount: number;
  avgSentenceLen: number;
  avgDocWords: number;
  exclamationRate: number;
  questionRate: number;
  emojiRate: number;
  emDashRate: number;
  ellipsisRate: number;
  lowercaseStartRate: number;
  hashtagRate: number;
  linkRate: number;
  typeTokenRatio: number;
  topOpeners: string[];
  exemplars: { id: number; text: string; why: string }[];
}

interface DocRow {
  id: number;
  text: string;
  engagement_json: string;
  hash: string;
  kind: string;
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

export function corpusHash(db: Database): string {
  const hashes = db
    .query<{ hash: string }, []>("SELECT hash FROM corpus_docs ORDER BY hash")
    .all()
    .map((r) => r.hash);
  return createHash("sha256").update(hashes.join("|")).digest("hex");
}

export function computeVoiceprint(db: Database, maxExemplars = 8): Voiceprint {
  const docs = db
    .query<DocRow, []>("SELECT id, text, engagement_json, hash, kind FROM corpus_docs ORDER BY id")
    .all();

  const rate = (pred: (t: string) => boolean) =>
    docs.length === 0 ? 0 : docs.filter((d) => pred(d.text)).length / docs.length;

  let sentences = 0;
  let sentenceWords = 0;
  let totalWords = 0;
  const vocab = new Set<string>();
  const openers = new Map<string, number>();

  for (const d of docs) {
    const words = d.text.split(/\s+/).filter(Boolean);
    totalWords += words.length;
    for (const w of words) vocab.add(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
    const parts = d.text.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
    sentences += parts.length;
    sentenceWords += words.length;
    const opener = words.slice(0, 2).join(" ").toLowerCase();
    if (opener) openers.set(opener, (openers.get(opener) ?? 0) + 1);
  }

  // Exemplars: top-engagement posts first, then longest chat messages, deduped.
  const scored = docs
    .map((d) => {
      let engagement = 0;
      try {
        const e = JSON.parse(d.engagement_json) as { likes?: number; reposts?: number };
        engagement = (e.likes ?? 0) + 2 * (e.reposts ?? 0);
      } catch { /* unscored */ }
      return { ...d, engagement };
    })
    .filter((d) => d.text.length > 40);
  const byEngagement = [...scored].sort((a, b) => b.engagement - a.engagement).slice(0, Math.ceil(maxExemplars / 2));
  const byLength = [...scored]
    .filter((d) => !byEngagement.some((e) => e.id === d.id))
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, Math.floor(maxExemplars / 2));

  return {
    corpusHash: corpusHash(db),
    docCount: docs.length,
    avgSentenceLen: sentences > 0 ? Math.round((sentenceWords / sentences) * 10) / 10 : 0,
    avgDocWords: docs.length > 0 ? Math.round((totalWords / docs.length) * 10) / 10 : 0,
    exclamationRate: rate((t) => t.includes("!")),
    questionRate: rate((t) => t.includes("?")),
    emojiRate: rate((t) => EMOJI_RE.test(t)),
    emDashRate: rate((t) => t.includes("—") || t.includes(" - ")),
    ellipsisRate: rate((t) => t.includes("...") || t.includes("…")),
    lowercaseStartRate: rate((t) => /^[a-z]/.test(t.trim())),
    hashtagRate: rate((t) => /#\w/.test(t)),
    linkRate: rate((t) => /https?:\/\//.test(t)),
    typeTokenRatio: totalWords > 0 ? Math.round((vocab.size / totalWords) * 1000) / 1000 : 0,
    topOpeners: [...openers.entries()]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([o]) => o),
    exemplars: [
      ...byEngagement.map((d) => ({ id: d.id, text: d.text, why: `engagement=${d.engagement}` })),
      ...byLength.map((d) => ({ id: d.id, text: d.text, why: "representative long-form" })),
    ],
  };
}
