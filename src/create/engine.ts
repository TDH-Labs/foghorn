// The content engine: ideate -> draft -> fast-gate fix loop -> full chain
// (mints sentinel on pass/escalate) -> approval request. Full-chain LLM blocks
// escalate to holds (judges run once at convergence; no LLM-vs-LLM ping-pong).

import type { Database } from "bun:sqlite";
import type { GenerateFn } from "../profile/profiler.ts";
import { buildFastGates, buildFullGates } from "../gate/chains.ts";
import { runChain } from "../gate/index.ts";
import { scoreFrom } from "../gate/gates/llm.ts";
import { runFixLoop, escalateToHold, type FixerFn } from "../fixloop/fixloop.ts";
import { ideate } from "./ideate.ts";
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

function makeFixer(generate: GenerateFn): FixerFn {
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
      maxOutputTokens: 4000,
    });
    return text.trim().replace(/^["'`]+|["'`]+$/g, "");
  };
}

export async function runEngine(
  db: Database,
  deps: EngineDeps,
  platform: string,
  maxDrafts = 3,
): Promise<EngineReport> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fastGates = buildFastGates(db, fetchImpl);
  const fullGates = buildFullGates(db, deps.generate, fetchImpl);
  const fixer = makeFixer(deps.generate);

  const ideas = await ideate(db, deps.generate, platform, maxDrafts);
  let awaitingApproval = 0;
  let escalated = 0;

  for (const idea of ideas) {
    let subject = await draftFromIdea(db, deps.generate, idea, platform);

    const fixed = await runFixLoop(db, fastGates, subject, fixer);
    if (!fixed.ok) { escalated++; continue; }
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
      escalated++;
      continue;
    }
    if (full.outcome === "n/a") {
      escalateToHold(db, subject, "platform", "all-n/a gate board — nothing verified, refusing to proceed", [], []);
      escalated++;
      continue;
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
    awaitingApproval++;
  }

  return { ideas: ideas.length, awaitingApproval, escalated };
}
