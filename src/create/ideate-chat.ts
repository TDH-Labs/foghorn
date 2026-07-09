// Interactive ideation: for each proposed angle, ask ONE clarifying question
// if it needs a real specific to be credible, take Adam's live answer as
// approved evidence (an explicit, in-the-moment human act -- same trust tier
// as `foghorn evidence add`), then draft through the normal gate chain. This
// is the direct fix for pure-autonomous drafting hitting a voice-score wall
// on opinion-only content: a real answer from him beats an invented one or a
// generic one every time.

import type { Database } from "bun:sqlite";
import type { GenerateFn } from "../profile/profiler.ts";
import { ideate, type Idea } from "./ideate.ts";
import { proposeEvidence, approveEvidence } from "./evidence-bank.ts";
import { processIdea, type EngineDeps } from "./engine.ts";

export type AskFn = (question: string) => Promise<string>;

export interface ChatReport {
  ideas: number;
  answered: number;
  skipped: number;
  awaitingApproval: number;
  escalated: number;
}

export async function clarifyingQuestion(generate: GenerateFn, idea: Idea): Promise<string | null> {
  const { text } = await generate({
    stage: "ideate",
    system: `Given a post angle/brief (untrusted data below), decide if it needs ONE concrete
real-world detail (a number, outcome, named tool/project) to be credible, beyond pure stance/opinion.
If yes, phrase ONE short, direct, easy-to-answer question to ask the person for that detail. If the
angle is fine as pure opinion needing no specific, respond with exactly: NONE
Respond with ONLY the question, or NONE. No preamble.`,
    prompt: `<angle>${idea.angle}</angle>\n<brief>${idea.brief}</brief>`,
    maxOutputTokens: 300,
  });
  const q = text.trim();
  return q === "NONE" || q.length === 0 ? null : q;
}

export async function ideateChat(
  db: Database,
  deps: EngineDeps,
  platform: string,
  ask: AskFn,
  count = 3,
): Promise<ChatReport> {
  const ideas = await ideate(db, deps.generate, platform, count);
  let answered = 0;
  let skipped = 0;
  let awaitingApproval = 0;
  let escalated = 0;

  for (const idea of ideas) {
    const question = await clarifyingQuestion(deps.generate, idea);
    if (question) {
      const answer = await ask(`[${idea.angle}]\n${question}\n(blank to skip -- post will stay opinion-only)`);
      if (answer.trim()) {
        const id = proposeEvidence(
          db,
          idea.interestTag ?? "general",
          answer.trim(),
          `live answer during ideate-chat to: "${question}"`,
          null,
        );
        approveEvidence(db, id);
        answered++;
      } else {
        skipped++;
      }
    }
    const outcome = await processIdea(db, deps, idea, platform);
    if (outcome === "approval") awaitingApproval++;
    else escalated++;
  }

  return { ideas: ideas.length, answered, skipped, awaitingApproval, escalated };
}
