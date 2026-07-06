// Deterministic spend ledger + hard caps. Every LLM call and platform write goes
// through preflight() BEFORE spending and record() after. Caps are HARD: at 100%
// the caller must not spend. Soft threshold drives the degradation ladder
// (reads stop -> scanner halves -> drafting stops; approved posts publish to 100%).

import type { Database } from "bun:sqlite";

export type LedgerCategory = "x_write" | "x_read" | "x_own_read" | "llm" | "other";

const CAP_GROUP: Record<LedgerCategory, string> = {
  x_write: "x",
  x_read: "x",
  x_own_read: "x",
  llm: "llm",
  other: "other",
};

export function unitCost(db: Database, key: string, fallback: number): number {
  const row = db.query<{ usd: number }, [string]>("SELECT usd FROM unit_costs WHERE key = ?").get(key);
  return row?.usd ?? fallback;
}

export interface LedgerEntry {
  category: LedgerCategory;
  units: number;
  unitCostUsd: number;
  provider?: string;
  model?: string;
  ref?: string;
  note?: string;
}

export function record(db: Database, e: LedgerEntry): number {
  const cost = e.units * e.unitCostUsd;
  db.run(
    `INSERT INTO spend_ledger (category, provider, model, units, unit_cost_usd, cost_usd, ref, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.category, e.provider ?? null, e.model ?? null, e.units, e.unitCostUsd, cost, e.ref ?? null, e.note ?? null],
  );
  return cost;
}

function monthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function monthSpendUsd(db: Database, capGroup: string): number {
  const categories = (Object.keys(CAP_GROUP) as LedgerCategory[]).filter(
    (c) => CAP_GROUP[c] === capGroup,
  );
  if (categories.length === 0) return 0;
  const placeholders = categories.map(() => "?").join(",");
  const row = db
    .query<{ total: number | null }, (string | number)[]>(
      `SELECT SUM(cost_usd) AS total FROM spend_ledger
       WHERE category IN (${placeholders}) AND ts >= ?`,
    )
    .get(...categories, monthStartIso());
  return row?.total ?? 0;
}

export interface CapStatus {
  capGroup: string;
  capUsd: number;
  spentUsd: number;
  softPct: number;
  /** spent / cap, 0..inf */
  level: number;
}

export function capStatus(db: Database, capGroup: string): CapStatus {
  const row = db
    .query<{ monthly_cap_usd: number; soft_pct: number }, [string]>(
      "SELECT monthly_cap_usd, soft_pct FROM spend_caps WHERE cap_group = ?",
    )
    .get(capGroup);
  if (!row) throw new Error(`no spend cap configured for group '${capGroup}' — refusing to spend`);
  const spent = monthSpendUsd(db, capGroup);
  return {
    capGroup,
    capUsd: row.monthly_cap_usd,
    spentUsd: spent,
    softPct: row.soft_pct,
    level: row.monthly_cap_usd > 0 ? spent / row.monthly_cap_usd : Infinity,
  };
}

export interface Preflight {
  ok: boolean;
  reason?: string;
  status: CapStatus;
}

/** Hard-cap check. Fail closed: unknown category / missing cap => not ok. */
export function preflight(db: Database, category: LedgerCategory, projectedUsd: number): Preflight {
  const group = CAP_GROUP[category];
  let status: CapStatus;
  try {
    status = capStatus(db, group);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      status: { capGroup: group, capUsd: 0, spentUsd: 0, softPct: 0, level: Infinity },
    };
  }
  if (status.spentUsd + projectedUsd > status.capUsd) {
    return {
      ok: false,
      reason: `${group} cap: $${status.spentUsd.toFixed(2)} spent + $${projectedUsd.toFixed(2)} projected > $${status.capUsd.toFixed(2)}/mo`,
      status,
    };
  }
  return { ok: true, status };
}

/** True once soft threshold crossed — discretionary spend should degrade. */
export function softExceeded(db: Database, capGroup: string): boolean {
  const s = capStatus(db, capGroup);
  return s.level >= s.softPct;
}
