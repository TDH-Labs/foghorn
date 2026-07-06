import { describe, expect, test } from "bun:test";
import { migrate, openDb } from "../db/index.ts";
import { capStatus, monthSpendUsd, preflight, record, softExceeded, unitCost } from "./ledger.ts";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

describe("spend ledger", () => {
  test("records entries and sums the month", () => {
    const db = freshDb();
    record(db, { category: "x_write", units: 2, unitCostUsd: 0.015 });
    record(db, { category: "x_own_read", units: 100, unitCostUsd: 0.001 });
    record(db, { category: "llm", units: 1000, unitCostUsd: 0.00001 });
    expect(monthSpendUsd(db, "x")).toBeCloseTo(0.13, 5);
    expect(monthSpendUsd(db, "llm")).toBeCloseTo(0.01, 5);
    db.close();
  });

  test("preflight blocks at the hard cap", () => {
    const db = freshDb();
    db.run("UPDATE spend_caps SET monthly_cap_usd = 1.0 WHERE cap_group = 'x'");
    record(db, { category: "x_write", units: 60, unitCostUsd: 0.015 }); // $0.90
    expect(preflight(db, "x_write", 0.05).ok).toBe(true);
    const blocked = preflight(db, "x_write", 0.2);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain("cap");
    db.close();
  });

  test("fails closed when no cap row exists", () => {
    const db = freshDb();
    db.run("DELETE FROM spend_caps WHERE cap_group = 'llm'");
    const pf = preflight(db, "llm", 0.01);
    expect(pf.ok).toBe(false);
    expect(pf.reason).toContain("no spend cap");
    expect(() => capStatus(db, "llm")).toThrow();
    db.close();
  });

  test("soft threshold trips at soft_pct of cap", () => {
    const db = freshDb();
    db.run("UPDATE spend_caps SET monthly_cap_usd = 10.0, soft_pct = 0.7 WHERE cap_group = 'llm'");
    record(db, { category: "llm", units: 1, unitCostUsd: 6.9 });
    expect(softExceeded(db, "llm")).toBe(false);
    record(db, { category: "llm", units: 1, unitCostUsd: 0.2 });
    expect(softExceeded(db, "llm")).toBe(true);
    db.close();
  });

  test("unit costs are read from the DB with fallback", () => {
    const db = freshDb();
    expect(unitCost(db, "x.link_write", 0)).toBeCloseTo(0.2, 5);
    expect(unitCost(db, "nonexistent.key", 42)).toBe(42);
    db.close();
  });
});
