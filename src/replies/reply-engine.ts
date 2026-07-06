// Reply engine: collect mentions -> triage -> (no_reply: skip silently) ->
// draft -> fast-gate fix loop -> full chain -> approval request. Mirrors
// create/engine.ts's shape exactly; reuses the SAME gate/fixloop/approval
// machinery -- replies get no safety discount versus original posts.

import type { Database } from "bun:sqlite";
import type { GenerateFn } from "../profile/profiler.ts";
import type { MentionSource } from "./mention-source.ts";
import { triageMention } from "./triage.ts";
import { draftReply } from "./reply-draft.ts";
import { buildFastGates, buildFullGates } from "../gate/chains.ts";
import { runChain } from "../gate/index.ts";
import { scoreFrom } from "../gate/gates/llm.ts";
import { runFixLoop, escalateToHold, type FixerFn } from "../fixloop/fixloop.ts";
import { requestApproval } from "../approvals/queue.ts";
import { isPaused } from "../killswitch.ts";

export interface ReplyEngineDeps {
  generate: GenerateFn;
  fetchImpl?: typeof fetch;
}

export interface ReplyEngineReport {
  collected: number;
  noReply: number;
  awaitingApproval: number;
  escalated: number;
}

function collectAndStore(db: Database, platform: string, raw: { externalId: string; authorHandle: string | null; text: string; threadKey: string; postedAt: string }[]): number {
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const m of raw) {
      db.run(
        `INSERT OR IGNORE INTO mentions (platform, external_id, thread_key, author_handle, text, posted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [platform, m.externalId, m.threadKey, m.authorHandle, m.text, m.postedAt],
      );
      if ((db.query<{ n: number }, []>("SELECT changes() n").get()?.n ?? 0) === 1) inserted++;
    }
  });
  tx();
  return inserted;
}

function makeFixer(generate: GenerateFn): FixerFn {
  return async (subject, blocking, journal) => {
    const { text } = await generate({
      stage: "fix",
      system: `Revise this reply to clear every finding while keeping it in voice and true to its
purpose. Prior attempts listed -- don't repeat a fix that already failed. Output ONLY the
revised reply text.`,
      prompt: `<reply>${subject.bodyText}</reply>
<findings>
${blocking.map((f) => `- [${f.tool}/${f.ruleId}] ${f.message}`).join("\n")}
</findings>
${journal.length > 0 ? `<prior_attempts>\n${journal.join("\n")}\n</prior_attempts>` : ""}`,
      maxOutputTokens: 2000,
    });
    return text.trim().replace(/^["'`]+|["'`]+$/g, "");
  };
}

export async function runReplyEngine(
  db: Database,
  deps: ReplyEngineDeps,
  platform: string,
  source: MentionSource,
  maxReplies = 5,
): Promise<ReplyEngineReport> {
  if (isPaused(db)) return { collected: 0, noReply: 0, awaitingApproval: 0, escalated: 0 };

  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const raw = await source.listMentions(since);
  const collected = collectAndStore(db, platform, raw);

  const pending = db
    .query<{ id: number; text: string }, [string, number]>(
      "SELECT id, text FROM mentions WHERE platform = ? AND status = 'new' ORDER BY id LIMIT ?",
    )
    .all(platform, maxReplies);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const fastGates = buildFastGates(db, fetchImpl);
  const fullGates = buildFullGates(db, deps.generate, fetchImpl);
  const fixer = makeFixer(deps.generate);

  let noReply = 0;
  let awaitingApproval = 0;
  let escalated = 0;

  for (const mention of pending) {
    const { triage, why } = await triageMention(deps.generate, mention.text);

    if (triage === "no_reply") {
      db.run("UPDATE mentions SET triage = ?, status = 'skipped' WHERE id = ?", [triage, mention.id]);
      db.run("INSERT INTO journal (scope, ref_id, entry_json) VALUES ('draft', ?, ?)", [
        `mention:${mention.id}`,
        JSON.stringify({ action: "no-reply", why }),
      ]);
      noReply++;
      continue;
    }
    db.run("UPDATE mentions SET triage = ?, status = 'drafted' WHERE id = ?", [triage, mention.id]);

    let subject = await draftReply(db, deps.generate, { id: mention.id, platform, text: mention.text }, triage);

    const fixed = await runFixLoop(db, fastGates, subject, fixer);
    if (!fixed.ok) {
      db.run("UPDATE mentions SET status = 'held' WHERE id = ?", [mention.id]);
      escalated++;
      continue;
    }
    subject = fixed.subject;

    const full = await runChain(db, fullGates, subject, "full");
    const risk = scoreFrom(full.verdicts, "gate-risk");
    db.run("UPDATE drafts SET risk_score = ?, updated_at = ? WHERE id = ?", [risk, new Date().toISOString(), subject.draftId]);

    if (full.outcome === "block" || full.outcome === "n/a") {
      const blocking = full.verdicts.filter((v) => v.status === "block").flatMap((v) => v.findings);
      escalateToHold(
        db, subject, "risk",
        full.outcome === "n/a" ? "all-n/a gate board on reply — refusing to proceed" : "full-chain block on reply (LLM judges or anti-pile-on)",
        blocking, [],
      );
      db.run("UPDATE mentions SET status = 'held' WHERE id = ?", [mention.id]);
      escalated++;
      continue;
    }

    requestApproval(db, {
      id: subject.draftId, version: subject.version, platform, content_class: subject.contentClass,
      body_text: subject.bodyText, risk_score: risk,
    });
    awaitingApproval++;
  }

  return { collected, noReply, awaitingApproval, escalated };
}
