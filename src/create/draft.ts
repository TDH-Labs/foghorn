// Drafting: voice-conditioned, platform-shaped, plain completion — the drafter
// has NO tools (it cannot "look things up" and invent). Output is the post
// text only; canonical bytes are frozen at insert and only change via the fix
// loop's version bump.

import type { Database } from "bun:sqlite";
import type { DraftSubject, EvidenceRef } from "../types.ts";
import type { GenerateFn } from "../profile/profiler.ts";
import { activeProfile } from "../profile/profiler.ts";
import { platformSpec } from "../config/platforms.ts";
import { sha256Hex } from "../gate/sentinel.ts";
import { classifyContent } from "./content-class.ts";
import { approvedEvidence, markEvidenceUsed } from "./evidence-bank.ts";
import type { Idea } from "./ideate.ts";

export async function draftFromIdea(
  db: Database,
  generate: GenerateFn,
  idea: Idea,
  platform: string,
): Promise<DraftSubject> {
  const voice = activeProfile(db, "voice");
  if (!voice) throw new Error("drafting needs a ratified voice profile");
  const spec = platformSpec(platform);
  const exemplars = ((voice as { voiceprint?: { exemplars?: { text: string }[] } }).voiceprint?.exemplars ?? [])
    .slice(0, 5)
    .map((e) => `- ${e.text}`)
    .join("\n");

  const evidence: EvidenceRef[] = [];
  if (idea.trendCardId) {
    const card = db
      .query<{ evidence_json: string; title: string }, [number]>("SELECT evidence_json, title FROM trend_cards WHERE id = ?")
      .get(idea.trendCardId);
    if (card) {
      db.run("UPDATE trend_cards SET status = 'used' WHERE id = ?", [idea.trendCardId]);
      for (const e of JSON.parse(card.evidence_json) as { url?: string; note?: string }[]) {
        evidence.push({ url: e.url, note: e.note, claim: card.title });
      }
    }
  }

  // Real, operator-approved facts the drafter may cite instead of inventing a
  // number or anecdote. Small personal corpus -- pass the full bank and let
  // the drafter pick what's relevant rather than building retrieval/embeddings.
  // All entries also become gate evidence, so the hallucination judge has the
  // real facts to check claims against, whether or not a given one was used.
  const bank = approvedEvidence(db);
  const bankBlock = bank.length > 0 ? bank.map((e) => `- [${e.topic}] ${e.fact}`).join("\n") : "(empty)";
  for (const e of bank) evidence.push({ note: `evidence_bank:${e.topic}`, claim: e.fact });

  // If this idea is a syndication, parse the ID and fetch the exact document text.
  let syndicatedDocText = "";
  const match = idea.angle.match(/\[Syndicate Doc #(\d+)\]/i);
  if (match && match[1]) {
    const docId = parseInt(match[1], 10);
    const doc = db.query<{text: string}, [number]>("SELECT text FROM corpus_docs WHERE id = ?").get(docId);
    if (doc) {
      syndicatedDocText = doc.text;
    }
  }

  const draftSystem = (truncate: boolean) => `You are an expert ghostwriter creating a single ${spec.name} post.
You have NO tools and cannot verify facts. You must STRICTLY use the provided <evidence> or <source_document_to_syndicate>.
${syndicatedDocText ? "\nCRITICAL SYNDICATION RULE: You are adapting the provided <source_document_to_syndicate>. Rely heavily on its insights, claims, and tone. Reformat it seamlessly for the target platform while preserving the original intent." : ""}
Formatting rules:
- Max ${spec.maxChars} characters${truncate ? " (STRICT: prior attempt was too long, cut aggressively)" : ""}
- No more than ${spec.maxHashtags} hashtags.
- Write in 2-3 sentence paragraphs with real line breaks.
- NO engagement-bait: no "comment X for the Y", no "swipe through", no manufactured suspense, no forced question-CTA, no hashtag stuffing.
- Output ONLY the post body text, no markdown wrappers, no meta-commentary.`;

  const draftPrompt = `<voice_profile>
${JSON.stringify(voice)}
</voice_profile>
<exemplars>
${exemplars}
</exemplars>
<evidence>
${bankBlock}
</evidence>
${syndicatedDocText ? `<source_document_to_syndicate>
${syndicatedDocText}
</source_document_to_syndicate>
` : ""}<brief>${idea.brief}</brief>
<angle>${idea.angle}</angle>`;

  let { text } = await generate({ stage: "draft", system: draftSystem(false), prompt: draftPrompt, maxOutputTokens: 3000, effort: "high" });
  let body = text.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!body) throw new Error("drafter returned empty post");

  // The length instruction is a soft ask the model doesn't always follow.
  // Retry once with a harder constraint before falling back to a deterministic
  // truncation -- never let an oversized draft reach the fix loop, which has
  // previously gutted posts trying to shrink them (anti-tamper then refuses).
  if (body.length > spec.maxChars) {
    ({ text } = await generate({ stage: "draft", system: draftSystem(true), prompt: draftPrompt, maxOutputTokens: 3000, effort: "high" }));
    body = text.trim().replace(/^["'`]+|["'`]+$/g, "");
    if (!body) throw new Error("drafter returned empty post");
  }
  if (body.length > spec.maxChars) {
    const cut = body.slice(0, spec.maxChars);
    const lastBoundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    body = lastBoundary > spec.maxChars * 0.5 ? cut.slice(0, lastBoundary + 1) : cut.replace(/\s+\S*$/, "");
  }
  const bytes = new TextEncoder().encode(body);
  const contentClass = classifyContent(body, { fromTrendCard: idea.trendCardId !== null });

  db.run(
    `INSERT INTO drafts (idea_id, platform, content_class, body_text, evidence_json, canonical_bytes, artifact_sha256, version, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'gating')`,
    [idea.id, platform, contentClass, body, JSON.stringify(evidence), bytes, sha256Hex(bytes)],
  );
  db.run("UPDATE ideas SET status = 'drafted' WHERE id = ?", [idea.id]);
  const draftId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() id").get()!.id);

  // Best-effort usage tracking (analytics only, not gating-critical): credit
  // a bank entry if a meaningful chunk of its fact shows up in the body.
  const bodyLower = body.toLowerCase();
  const usedIds = bank
    .filter((e) => bodyLower.includes(e.fact.slice(0, Math.min(20, e.fact.length)).toLowerCase()))
    .map((e) => e.id);
  if (usedIds.length > 0) markEvidenceUsed(db, usedIds);

  return {
    draftId,
    version: 1,
    platform,
    contentClass,
    bodyText: body,
    canonicalBytes: bytes,
    mediaRefs: [],
    evidence,
  };
}
