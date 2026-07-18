// Claude CLI provider: shells out to `claude -p` (Claude Code print mode)
// instead of calling the Anthropic/OpenRouter API directly. Billed against
// Operator's Claude subscription (OAuth), not metered per-token API spend --
// the whole point is running the insight-generation stage on Sonnet 5
// without paying API rates for it daily. See config/models.ts's
// CLAUDE_CLI_STAGES for which stages actually route here.
//
// Deliberately NOT --bare: bare mode requires ANTHROPIC_API_KEY (skips
// OAuth), which would silently switch this back to metered billing and
// defeat the purpose. Runs from a neutral cwd instead, so Claude Code's
// normal CLAUDE.md/AGENTS.md auto-loading doesn't pull Foghorn's own
// architecture docs into a content-ideation prompt.

import type { Database } from "bun:sqlite";
import { preflight, record } from "../spend/ledger.ts";
import type { GenerateOpts, GenerateResult } from "./generate.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const CLI_PATH = process.env.FOGHORN_CLAUDE_CLI_PATH ?? "/Users/ai/.local/bin/claude";
const CLI_CWD = process.env.FOGHORN_CLAUDE_CLI_CWD ?? "/tmp";

interface ClaudeCliJson {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export type SpawnFn = (args: string[], opts: { cwd: string; signal: AbortSignal }) => Promise<SpawnResult>;

async function defaultSpawn(args: string[], opts: { cwd: string; signal: AbortSignal }): Promise<SpawnResult> {
  const proc = Bun.spawn(args, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", signal: opts.signal });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function generateViaClaudeCli(
  db: Database,
  opts: GenerateOpts,
  spawn: SpawnFn = defaultSpawn,
): Promise<GenerateResult> {
  // Not metered API spend, but still preflight-checked for consistency (a
  // $0 projected cost trivially passes regardless of cap state).
  const pf = preflight(db, "llm", 0);
  if (!pf.ok) throw new Error(`llm spend blocked: ${pf.reason}`);

  const args = [
    CLI_PATH,
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    // 1 turn wasn't enough headroom: on complex prompts Sonnet sometimes
    // attempts a tool call first (blocked by --allowedTools ""), consuming
    // a turn before it can recover with a text answer -- observed live as
    // error_max_turns/stop_reason=tool_use, a wasted paid turn every time.
    // 3 gives room for attempt -> blocked -> recover without opening the
    // door to a real agentic loop (still --allowedTools "", so there is
    // nothing for it to actually call).
    "--max-turns",
    "3",
    "--allowedTools",
    "",
    "--model",
    "sonnet",
  ];
  if (opts.system) args.push("--append-system-prompt", opts.system);

  const { stdout, stderr, exitCode } = await spawn(args, {
    cwd: CLI_CWD,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (exitCode !== 0) {
    throw new Error(`claude CLI exited ${exitCode}: ${(stderr || stdout).slice(0, 500)}`);
  }

  let parsed: ClaudeCliJson;
  try {
    parsed = JSON.parse(stdout) as ClaudeCliJson;
  } catch {
    throw new Error(`claude CLI: non-JSON output: ${stdout.slice(0, 300)}`);
  }
  if (parsed.is_error || parsed.subtype !== "success" || !parsed.result) {
    throw new Error(`claude CLI: subtype=${parsed.subtype ?? "unknown"} result=${(parsed.result ?? "").slice(0, 300)}`);
  }

  const usage = {
    in: parsed.usage?.input_tokens ?? 0,
    out: parsed.usage?.output_tokens ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
  };

  record(db, {
    category: "llm",
    units: usage.in + usage.out,
    unitCostUsd: 0,
    provider: "claude-cli",
    model: "claude-sonnet-5",
    ref: opts.stage,
    note:
      parsed.total_cost_usd !== undefined
        ? `subscription-billed; api-equivalent would be $${parsed.total_cost_usd.toFixed(4)}`
        : "subscription-billed",
  });

  return { text: parsed.result, model: "claude-sonnet-5 (cli)", usage, costUsd: 0 };
}
