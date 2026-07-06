// Link gate (deterministic + network): https-only, SSRF-guarded (host allow
// checks BEFORE any fetch), resolvable (<400), X single-link rule, and the
// $0.20 link-write cost annotated + preflighted against the spend cap.

import type { Database } from "bun:sqlite";
import type { DraftSubject, Finding, Gate } from "../../types.ts";
import { notApplicable, verdictOf } from "../../types.ts";
import { preflight, unitCost } from "../../spend/ledger.ts";

export function extractUrls(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s)\]}>"']+/g) ?? [])];
}

function ssrfObjection(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "unparseable URL";
  }
  if (u.protocol !== "https:") return `scheme ${u.protocol} (https only)`;
  const host = u.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return "IP-literal host";
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
    return "private/internal host";
  }
  return null;
}

export function gateLinks(db: Database, fetchImpl: typeof fetch = fetch): Gate {
  return {
    name: "gate-links",
    run: async (s: DraftSubject) => {
      const urls = extractUrls(s.bodyText);
      if (urls.length === 0) return notApplicable("gate-links");
      const findings: Finding[] = [];

      if (s.platform === "x" && urls.length > 1) {
        findings.push({ tool: "links", ruleId: "multi-link-x", severity: "high", message: `${urls.length} links on X (max 1; links cost $0.20 and are reach-penalized)` });
      }

      for (const url of urls) {
        const objection = ssrfObjection(url);
        if (objection) {
          findings.push({ tool: "links", ruleId: "ssrf-guard", severity: "critical", message: `${url}: ${objection}`, span: url });
          continue; // never fetch a guarded URL
        }
        try {
          const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10_000) });
          if (res.status >= 400) {
            findings.push({ tool: "links", ruleId: "dead-link", severity: "high", message: `${url} -> HTTP ${res.status}`, span: url });
          }
        } catch (err) {
          findings.push({ tool: "links", ruleId: "unreachable", severity: "high", message: `${url}: ${err instanceof Error ? err.message : String(err)}`, span: url });
        }
      }

      if (s.platform === "x") {
        const linkCost = unitCost(db, "x.link_write", 0.2);
        const pf = preflight(db, "x_write", linkCost);
        if (!pf.ok) {
          findings.push({ tool: "links", ruleId: "spend-cap", severity: "high", message: `link post costs $${linkCost.toFixed(2)}: ${pf.reason}` });
        } else {
          findings.push({ tool: "links", ruleId: "cost-note", severity: "low", message: `link post will cost $${linkCost.toFixed(2)} (vs $${unitCost(db, "x.write", 0.015).toFixed(3)} plain)` });
        }
      }
      return verdictOf("gate-links", findings);
    },
  };
}
