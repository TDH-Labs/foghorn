import { describe, expect, test } from "bun:test";
import { migrate, openDb } from "../db/index.ts";
import { generateViaClaudeCli, type SpawnFn } from "./claude-cli.ts";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function fakeSpawn(json: unknown, exitCode = 0, stderr = ""): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (args) => {
    calls.push(args);
    return { stdout: JSON.stringify(json), stderr, exitCode };
  };
  return { spawn, calls };
}

describe("generateViaClaudeCli", () => {
  test("runs claude -p in print mode with no tools, one turn, returns text + $0 cost", async () => {
    const db = freshDb();
    const { spawn, calls } = fakeSpawn({
      type: "result",
      subtype: "success",
      result: "Here's a sharper angle on the tenant-KPI story.",
      usage: { input_tokens: 1200, output_tokens: 340 },
      total_cost_usd: 0.0842,
    });

    const result = await generateViaClaudeCli(db, { stage: "ideate", prompt: "propose an angle", system: "be terse" }, spawn);

    expect(result.text).toBe("Here's a sharper angle on the tenant-KPI story.");
    expect(result.costUsd).toBe(0);
    expect(result.usage).toEqual({ in: 1200, out: 340, cacheRead: 0, cacheWrite: 0 });

    const args = calls[0]!;
    expect(args).toContain("-p");
    expect(args).toContain("propose an angle");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("be terse");
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(""); // no tool access — pure text completion
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");

    const ledger = db.query<{ provider: string; model: string; unit_cost_usd: number }, []>(
      "SELECT provider, model, unit_cost_usd FROM spend_ledger",
    ).get();
    expect(ledger?.provider).toBe("claude-cli");
    expect(ledger?.model).toBe("claude-sonnet-5");
    expect(ledger?.unit_cost_usd).toBe(0); // subscription-billed, not counted against the API spend cap
    db.close();
  });

  test("nonzero exit code throws with stderr detail", async () => {
    const db = freshDb();
    const { spawn } = fakeSpawn({}, 1, "claude: command not found");
    await expect(generateViaClaudeCli(db, { stage: "ideate", prompt: "x" }, spawn)).rejects.toThrow(/command not found/);
    db.close();
  });

  test("non-success subtype throws", async () => {
    const db = freshDb();
    const { spawn } = fakeSpawn({ type: "result", subtype: "error_max_turns" });
    await expect(generateViaClaudeCli(db, { stage: "ideate", prompt: "x" }, spawn)).rejects.toThrow(/error_max_turns/);
    db.close();
  });

  test("malformed JSON output throws", async () => {
    const db = freshDb();
    const spawn: SpawnFn = async () => ({ stdout: "not json", stderr: "", exitCode: 0 });
    await expect(generateViaClaudeCli(db, { stage: "ideate", prompt: "x" }, spawn)).rejects.toThrow(/non-JSON/);
    db.close();
  });
});
