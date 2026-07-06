// Reply-specific deterministic gate: anti-pile-on (never a second reply in the
// same thread) + max-replies/hour rate limit. n/a for non-reply content
// classes. Looks up the owning mention row by draft id rather than widening
// the generic DraftSubject with a reply-only field.

import type { Database } from "bun:sqlite";
import type { DraftSubject, Finding, Gate } from "../../types.ts";
import { notApplicable, verdictOf } from "../../types.ts";
import { getNumberSetting } from "../../config/settings.ts";

const REPLY_CLASSES = new Set(["reply_ack", "reply_value_add", "reply_boundary"]);

export function gateReplyThread(db: Database): Gate {
  return {
    name: "gate-reply-thread",
    run: async (s: DraftSubject) => {
      if (!REPLY_CLASSES.has(s.contentClass)) return notApplicable("gate-reply-thread");
      const mention = db
        .query<{ id: number; thread_key: string; platform: string }, [number]>(
          "SELECT id, thread_key, platform FROM mentions WHERE reply_draft_id = ?",
        )
        .get(s.draftId);
      if (!mention) return notApplicable("gate-reply-thread");

      const findings: Finding[] = [];

      const priorInThread = db
        .query<{ n: number }, [string, string, number]>(
          `SELECT COUNT(*) n FROM mentions m
           JOIN drafts d ON d.id = m.reply_draft_id
           WHERE m.thread_key = ? AND m.platform = ? AND m.reply_draft_id != ?
             AND d.status IN ('awaiting_approval','approved','scheduled','published')`,
        )
        .get(mention.thread_key, mention.platform, s.draftId);
      if ((priorInThread?.n ?? 0) > 0) {
        findings.push({
          tool: "reply", ruleId: "anti-pile-on", severity: "critical",
          message: `already replying/replied in thread ${mention.thread_key} — never a second engagement`,
        });
      }

      const maxPerHour = getNumberSetting(db, "max_replies_per_hour", 10);
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const lastHour = db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) n FROM published_posts pp
           JOIN drafts d ON d.id = pp.draft_id
           WHERE pp.platform = ? AND pp.published_at >= ? AND pp.deleted_at IS NULL
             AND d.content_class IN ('reply_ack','reply_value_add','reply_boundary')`,
        )
        .get(mention.platform, hourAgo);
      if ((lastHour?.n ?? 0) >= maxPerHour) {
        findings.push({
          tool: "reply", ruleId: "rate-limit", severity: "high",
          message: `${lastHour?.n} replies on ${mention.platform} in the last hour (max ${maxPerHour})`,
        });
      }

      return verdictOf("gate-reply-thread", findings);
    },
  };
}
