// FAST_GATES: the deterministic chain (secrets-pii, private-leak, banned-topics,
// platform-limits, dedup, cadence, media-rights). Pure checks over the frozen
// draft + DB state; the inner fix loop iterates on exactly these.
// links (network) lives in links.ts; LLM judges in llm.ts.

import { existsSync, readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { DraftSubject, Finding, Gate } from "../../types.ts";
import { notApplicable, verdictOf } from "../../types.ts";
import { platformSpec } from "../../config/platforms.ts";
import { getNumberSetting, getSetting, MEDIA_DIR } from "../../config/settings.ts";
import { OTHERS_N, SELF_N, shingleHashes } from "../../ingest/shingles.ts";
import { normalizeForShingles } from "../../ingest/redact.ts";

const CREDENTIAL_PATTERNS: [string, RegExp][] = [
  ["anthropic-key", /sk-ant-[A-Za-z0-9-]{10,}/],
  ["generic-sk-key", /\bsk-[A-Za-z0-9]{20,}/],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer-ish", /\b(api[_-]?key|token|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i],
];

const PII_PATTERNS: [string, RegExp][] = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["phone", /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b/],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/],
  ["card", /\b(?:\d[ -]*?){13,16}\b/],
];

export function gateSecretsPii(db: Database): Gate {
  return {
    name: "gate-secrets-pii",
    run: async (s: DraftSubject) => {
      const findings: Finding[] = [];
      for (const [ruleId, re] of CREDENTIAL_PATTERNS) {
        const m = s.bodyText.match(re);
        if (m) findings.push({ tool: "secrets", ruleId, severity: "critical", message: `credential pattern in post`, span: m[0]!.slice(0, 12) + "…" });
      }
      for (const [ruleId, re] of PII_PATTERNS) {
        const m = s.bodyText.match(re);
        if (m) findings.push({ tool: "pii", ruleId, severity: "high", message: `${ruleId} in post`, span: m[0]! });
      }
      const lexicon = getSetting(db, "pii_lexicon");
      if (lexicon) {
        for (const term of JSON.parse(lexicon) as string[]) {
          if (term && s.bodyText.toLowerCase().includes(term.toLowerCase())) {
            findings.push({ tool: "pii", ruleId: "lexicon", severity: "high", message: `protected term '${term}' in post` });
          }
        }
      }
      return verdictOf("gate-secrets-pii", findings);
    },
  };
}

export function gatePrivateLeak(db: Database): Gate {
  return {
    name: "gate-private-leak",
    run: async (s: DraftSubject) => {
      const findings: Finding[] = [];
      const check = (n: number, isSelf: 0 | 1): number => {
        const hashes = shingleHashes(s.bodyText, n);
        if (hashes.length === 0) return 0;
        let hits = 0;
        for (const h of hashes) {
          const row = db
            .query<{ n: number }, [string, number]>(
              "SELECT COUNT(*) n FROM leak_shingles WHERE shingle_hash = ? AND is_self = ?",
            )
            .get(h, isSelf);
          if ((row?.n ?? 0) > 0) hits++;
        }
        return hits;
      };
      const otherHits = check(OTHERS_N, 0);
      if (otherHits > 0) {
        findings.push({
          tool: "leak", ruleId: "others-verbatim", severity: "critical",
          message: `${otherHits} ${OTHERS_N}-gram overlap(s) with OTHER people's private messages — non-overridable`,
        });
      }
      const selfHits = check(SELF_N, 1);
      if (selfHits > 0) {
        findings.push({
          tool: "leak", ruleId: "self-verbatim", severity: "high",
          message: `${selfHits} ${SELF_N}-gram overlap(s) with own private chat messages — rephrase, don't quote`,
        });
      }
      return verdictOf("gate-private-leak", findings);
    },
  };
}

export function gateBannedTopics(db: Database): Gate {
  return {
    name: "gate-banned-topics",
    run: async (s: DraftSubject) => {
      const rows = db
        .query<{ pattern: string; kind: string; reason: string | null }, []>(
          "SELECT pattern, kind, reason FROM banned_topics WHERE active = 1",
        )
        .all();
      const findings: Finding[] = [];
      for (const r of rows) {
        const hit =
          r.kind === "regex"
            ? new RegExp(r.pattern, "i").test(s.bodyText)
            : new RegExp(`\\b${r.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s.bodyText);
        if (hit) {
          findings.push({ tool: "banned-topics", ruleId: r.kind, severity: "high", message: `banned topic '${r.pattern}'${r.reason ? ` (${r.reason})` : ""}` });
        }
      }
      return rows.length === 0 ? notApplicable("gate-banned-topics") : verdictOf("gate-banned-topics", findings);
    },
  };
}

/** X counts every URL as 23 chars regardless of length. */
export function effectiveLength(platform: string, text: string): number {
  if (platform !== "x") return text.length;
  return text.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
}

export function gatePlatformLimits(): Gate {
  return {
    name: "gate-platform-limits",
    run: async (s: DraftSubject) => {
      const spec = platformSpec(s.platform); // unknown platform throws => fail closed
      const findings: Finding[] = [];
      const len = effectiveLength(s.platform, s.bodyText);
      if (len > spec.maxChars) {
        findings.push({ tool: "limits", ruleId: "over-length", severity: "high", message: `${len} chars > ${spec.maxChars} limit on ${s.platform}` });
      }
      const hashtags = (s.bodyText.match(/#\w+/g) ?? []).length;
      if (hashtags > spec.maxHashtags) {
        findings.push({ tool: "limits", ruleId: "hashtags", severity: "high", message: `${hashtags} hashtags > ${spec.maxHashtags}` });
      }
      const mentions = (s.bodyText.match(/(^|\s)@\w+/g) ?? []).length;
      if (mentions > spec.maxMentions) {
        findings.push({ tool: "limits", ruleId: "mentions", severity: "high", message: `${mentions} mentions > ${spec.maxMentions}` });
      }
      if (s.mediaRefs.length > spec.maxMedia) {
        findings.push({ tool: "limits", ruleId: "media-count", severity: "high", message: `${s.mediaRefs.length} media > ${spec.maxMedia}` });
      }
      return verdictOf("gate-platform-limits", findings);
    },
  };
}

function trigrams(text: string): Set<string> {
  const words = normalizeForShingles(text);
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) grams.add(words.slice(i, i + 3).join(" "));
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

export function gateDedup(db: Database): Gate {
  return {
    name: "gate-dedup",
    run: async (s: DraftSubject) => {
      const prior = db
        .query<{ id: number; body_text: string }, [number]>(
          `SELECT DISTINCT d.id, d.body_text FROM drafts d
           LEFT JOIN published_posts pp ON pp.draft_id = d.id
           LEFT JOIN schedule sc ON sc.draft_id = d.id
           WHERE d.id != ?
             AND (pp.id IS NOT NULL OR sc.state IN ('pending','firing','sent'))
             AND d.created_at >= datetime('now', '-90 days')`,
        )
        .all(s.draftId);
      const mine = trigrams(s.bodyText);
      const findings: Finding[] = [];
      for (const p of prior) {
        const sim = jaccard(mine, trigrams(p.body_text));
        if (sim > 0.8) {
          findings.push({ tool: "dedup", ruleId: "near-duplicate", severity: "high", message: `jaccard ${sim.toFixed(2)} vs draft #${p.id}` });
        } else if (sim > 0.6) {
          findings.push({ tool: "dedup", ruleId: "similar", severity: "low", message: `jaccard ${sim.toFixed(2)} vs draft #${p.id} — consider more variation` });
        }
      }
      return verdictOf("gate-dedup", findings);
    },
  };
}

export function gateCadence(db: Database): Gate {
  return {
    name: "gate-cadence",
    run: async (s: DraftSubject) => {
      if (!s.proposedSlot) return notApplicable("gate-cadence");
      const spec = platformSpec(s.platform);
      const slot = new Date(s.proposedSlot);
      const findings: Finding[] = [];

      const dayStart = new Date(slot);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
      const sameDay = db
        .query<{ n: number }, [string, string, string, number]>(
          `SELECT (SELECT COUNT(*) FROM published_posts WHERE platform = ?1 AND published_at BETWEEN ?2 AND ?3 AND deleted_at IS NULL)
                + (SELECT COUNT(*) FROM schedule sc JOIN drafts d ON d.id = sc.draft_id
                   WHERE sc.platform = ?1 AND sc.state IN ('pending','firing') AND sc.scheduled_for BETWEEN ?2 AND ?3 AND sc.draft_id != ?4) AS n`,
        )
        .get(s.platform, dayStart.toISOString(), dayEnd.toISOString(), s.draftId);
      if ((sameDay?.n ?? 0) >= spec.maxPerDay) {
        findings.push({ tool: "cadence", ruleId: "daily-max", severity: "high", message: `${sameDay?.n} posts already on ${s.platform} that day (max ${spec.maxPerDay})` });
      }

      const nearest = db
        .query<{ t: string | null }, [string, string, string]>(
          `SELECT MAX(t) t FROM (
             SELECT published_at t FROM published_posts WHERE platform = ?1 AND deleted_at IS NULL AND published_at <= ?2
             UNION ALL
             SELECT scheduled_for t FROM schedule WHERE platform = ?1 AND state IN ('pending','firing') AND scheduled_for <= ?3
           )`,
        )
        .get(s.platform, slot.toISOString(), slot.toISOString());
      if (nearest?.t) {
        const gapH = (slot.getTime() - new Date(nearest.t).getTime()) / 3_600_000;
        if (gapH >= 0 && gapH < spec.minGapHours) {
          findings.push({ tool: "cadence", ruleId: "min-gap", severity: "high", message: `${gapH.toFixed(1)}h since previous ${s.platform} post (min ${spec.minGapHours}h)` });
        }
      }

      const quiet = (getSetting(db, "quiet_hours") ?? "23:00-07:00").split("-");
      const [qs, qe] = [quiet[0] ?? "23:00", quiet[1] ?? "07:00"];
      const mins = slot.getHours() * 60 + slot.getMinutes();
      const toMin = (hhmm: string) => Number(hhmm.split(":")[0]) * 60 + Number(hhmm.split(":")[1] ?? 0);
      const inQuiet = toMin(qs) <= toMin(qe) ? mins >= toMin(qs) && mins < toMin(qe) : mins >= toMin(qs) || mins < toMin(qe);
      if (inQuiet) {
        findings.push({ tool: "cadence", ruleId: "quiet-hours", severity: "high", message: `slot ${qs}-${qe} local is quiet hours` });
      }

      // class-mix imbalance: warn only
      const week = db
        .query<{ n: number; same: number }, [string, string]>(
          `SELECT COUNT(*) n, SUM(CASE WHEN content_class = ?2 THEN 1 ELSE 0 END) same
           FROM drafts d JOIN published_posts pp ON pp.draft_id = d.id
           WHERE pp.platform = ?1 AND pp.published_at >= datetime('now','-7 days')`,
        )
        .get(s.platform, s.contentClass);
      if ((week?.n ?? 0) >= 5 && (week?.same ?? 0) / (week?.n ?? 1) > 0.6) {
        findings.push({ tool: "cadence", ruleId: "class-mix", severity: "low", message: `>60% of last week's posts are ${s.contentClass} — vary the mix` });
      }
      return verdictOf("gate-cadence", findings);
    },
  };
}

export function gateMediaRights(): Gate {
  return {
    name: "gate-media-rights",
    run: async (s: DraftSubject) => {
      if (s.mediaRefs.length === 0) return notApplicable("gate-media-rights");
      const findings: Finding[] = [];
      for (const ref of s.mediaRefs) {
        if (!ref.startsWith(MEDIA_DIR)) {
          findings.push({ tool: "media", ruleId: "outside-library", severity: "high", message: `${ref} is outside the owned media library` });
          continue;
        }
        if (!existsSync(ref)) {
          findings.push({ tool: "media", ruleId: "missing-file", severity: "high", message: `${ref} does not exist` });
          continue;
        }
        const licensePath = `${ref}.license`;
        const license = existsSync(licensePath) ? readFileSync(licensePath, "utf8").trim() : "unknown";
        if (!["owned", "licensed", "generated"].includes(license)) {
          findings.push({ tool: "media", ruleId: "unknown-license", severity: "high", message: `${ref}: license '${license}' (need owned|licensed|generated sidecar)` });
        }
      }
      return verdictOf("gate-media-rights", findings);
    },
  };
}
