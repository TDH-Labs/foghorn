// Mines already-ingested corpus_docs (your own messages/posts -- never
// others') for concrete, citable facts, and proposes them into the evidence
// bank for review. Extraction only ever pulls what's actually in the text
// (untrusted input, same as any other ingested content) -- it never infers
// or embellishes. Proposals land 'proposed' and are inert until you
// `foghorn evidence approve <id>`.

import type { Database } from "bun:sqlite";
import type { GenerateFn } from "../profile/profiler.ts";
import { proposeEvidence } from "./evidence-bank.ts";

interface Candidate {
  topic: string;
  fact: string;
  source_quote: string;
}

export function buildEvidenceSystemPrompt(): string {
  const domains = process.env.FOGHORN_BUSINESS_DOMAINS;
  const domainContext = domains ? ` (${domains})` : "";
  const domainExamples = domains ? domains : "startup, engineering, marketing, finance, productivity, ai";

  return `You extract concrete, citable FACTS from a person's own messages (untrusted
data below). A fact is a specific number, named project/tool, quantified outcome, or concrete
detail that is DIRECTLY STATED in the text -- never inferred, generalized, or embellished.
Focus particularly on facts related to the user's specialties${domainContext}.
Skip vague opinions, banter, or anything not independently verifiable from the quote itself.
For each fact, include the exact source line it came from so it can be checked.

Respond ONLY with JSON:
{"candidates":[{"topic":"snake_case_tag","fact":"the fact, phrased as a plain citable sentence","source_quote":"the exact line it's drawn from"}]}
Return an empty array if nothing meets the bar. Do not invent a topic taxonomy -- pick short,
sensible tags (e.g. ${domainExamples}).`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function extractEvidenceCandidates(
  db: Database,
  generate: GenerateFn,
  opts: { limit?: number } = {},
): Promise<{ proposed: number; skipped: number }> {
  const docs = db
    .query<{ id: number; text: string }, [number]>(
      "SELECT id, text FROM corpus_docs WHERE kind IN ('message','post') ORDER BY id DESC LIMIT ?",
    )
    .all(opts.limit ?? 60);
  if (docs.length === 0) return { proposed: 0, skipped: 0 };

  const existing = new Set(
    db.query<{ fact: string }, []>("SELECT fact FROM evidence_bank").all().map((r) => r.fact.toLowerCase()),
  );

  const corpus = docs.map((d) => `[doc:${d.id}] ${stripHtml(d.text)}`).join("\n");
  const { text } = await generate({
    stage: "profile",
    system: buildEvidenceSystemPrompt(),
    prompt: `<their_own_messages>\n${corpus}\n</their_own_messages>`,
    maxOutputTokens: 2500,
    effort: "high",
  });

  const start = text.indexOf("{");
  if (start === -1) throw new Error("evidence extraction: no JSON in output");
  let parsed: { candidates?: Candidate[] };
  try {
    parsed = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)) as { candidates?: Candidate[] };
  } catch {
    // Likely truncated mid-array (hit the token budget). Recover whatever
    // complete {...} candidate objects exist before the cutoff rather than
    // discarding the whole batch.
    const objs = [...text.slice(start).matchAll(/\{[^{}]*"fact"[^{}]*\}/g)].map((m) => m[0]);
    const recovered: Candidate[] = [];
    for (const o of objs) {
      try {
        recovered.push(JSON.parse(o) as Candidate);
      } catch {
        /* skip unrecoverable fragment */
      }
    }
    if (recovered.length === 0) throw new Error("evidence extraction: JSON truncated, nothing recoverable");
    parsed = { candidates: recovered };
  }

  let proposed = 0;
  let skipped = 0;
  for (const c of parsed.candidates ?? []) {
    if (!c.fact || !c.source_quote || existing.has(c.fact.toLowerCase())) {
      skipped++;
      continue;
    }
    const needle = c.source_quote.slice(0, 30).toLowerCase();
    const sourceDoc = docs.find((d) => stripHtml(d.text).toLowerCase().includes(needle));
    proposeEvidence(db, c.topic || "general", c.fact, c.source_quote, sourceDoc?.id ?? null);
    existing.add(c.fact.toLowerCase());
    proposed++;
  }
  return { proposed, skipped };
}
