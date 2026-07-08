// The content engine: ideate -> draft -> fast-gate fix loop -> full chain
// (mints sentinel on pass/escalate) -> approval request. Full-chain LLM blocks
// escalate to holds (judges run once at convergence; no LLM-vs-LLM ping-pong).
// processIdea() is shared with ideate-chat.ts's interactive flow.

import type { Database } from "bun:sqlite";
import type { GenerateFn } from "../profile/profiler.ts";
import { buildFastGates, buildFullGates } from "../gate/chains.ts";
import { runChain } from "../gate/index.ts";
import { scoreFrom } from "../gate/gates/llm.ts";
import { runFixLoop, escalateToHold, type FixerFn } from "../fixloop/fixloop.ts";
import { ideate, type Idea } from "./ideate.ts";
import { draftFromIdea } from "./draft.ts";
import { requestApproval } from "../approvals/queue.ts";

export interface EngineDeps {
  generate: GenerateFn;
  fetchImpl?: typeof fetch;
}

export interface EngineReport {
  ideas: number;
  awaitingApproval: number;
  escalated: number;
}

export function makeFixer(generate: GenerateFn): FixerFn {
  return async (subject, blocking, journal) => {
    const { text } = await generate({
      stage: "fix",
      system: `Revise the post to clear EVERY finding while keeping the author's voice and the
post's substance. Address findings, never delete the whole point. Prior attempts are listed —
do not repeat a fix that already failed. Output ONLY the revised post text.`,
      prompt: `<post>${subject.bodyText}</post>
<findings>
${blocking.map((f) => `- [${f.tool}/${f.ruleId}] ${f.message}${f.span ? ` (span: "${f.span}")` : ""}`).join("\n")}
</findings>
${journal.length > 0 ? `<prior_attempts>\n${journal.join("\n")}\n</prior_attempts>` : ""}`,
      maxOutputTokens: 1200,
    });
    return text.trim().replace(/^["'`]+|["'`]+$/g, "");
  };
}

/** Draft one idea through the full fast+full gate chain. Returns 'approval' | 'escalated'. */
export async function processIdea(
  db: Database,
  deps: EngineDeps,
  idea: Idea,
  platform: string,
): Promise<"approval" | "escalated"> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fastGates = buildFastGates(db, fetchImpl);
  const fullGates = buildFullGates(db, deps.generate, fetchImpl);
  const fixer = makeFixer(deps.generate);

  let subject = await draftFromIdea(db, deps.generate, idea, platform);

  const fixed = await runFixLoop(db, fastGates, subject, fixer);
  if (!fixed.ok) return "escalated";
  subject = fixed.subject;

  const full = await runChain(db, fullGates, subject, "full");
  const voice = scoreFrom(full.verdicts, "gate-voice");
  const quality = scoreFrom(full.verdicts, "gate-quality");
  const risk = scoreFrom(full.verdicts, "gate-risk");
  db.run("UPDATE drafts SET voice_score = ?, quality_score = ?, risk_score = ?, updated_at = ? WHERE id = ?", [
    voice, quality, risk, new Date().toISOString(), subject.draftId,
  ]);

  if (full.outcome === "block") {
    const blocking = full.verdicts.filter((v) => v.status === "block").flatMap((v) => v.findings);
    escalateToHold(db, subject, "risk", "full-chain block (LLM judges)", blocking, []);
    return "escalated";
  }
  if (full.outcome === "n/a") {
    escalateToHold(db, subject, "platform", "all-n/a gate board — nothing verified, refusing to proceed", [], []);
    return "escalated";
  }

  // pass or escalate: bytes are frozen under a sentinel; escalate additionally
  // forces human approval regardless of ladder level (handled by tier anyway at L1).
  requestApproval(db, {
    id: subject.draftId,
    version: subject.version,
    platform: subject.platform,
    content_class: subject.contentClass,
    body_text: subject.bodyText,
    risk_score: risk,
  });
  return "approval";
}

export async function runEngine(
  db: Database,
  deps: EngineDeps,
  platform: string,
  maxDrafts = 3,
): Promise<EngineReport> {
  const ideas = await ideate(db, deps.generate, platform, maxDrafts);
  let awaitingApproval = 0;
  let escalated = 0;

  for (const idea of ideas) {
    const outcome = await processIdea(db, deps, idea, platform);
    if (outcome === "approval") awaitingApproval++;
    else escalated++;
  }

  return { ideas: ideas.length, awaitingApproval, escalated };
}
