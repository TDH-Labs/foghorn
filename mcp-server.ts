#!/usr/bin/env bun
/**
 * mcp-server.ts — stdio JSON-RPC 2.0 MCP server exposing a CURATED subset of
 * Foghorn's pipeline to agent tool-calling (Hermes, via ~/.hermes/config.yaml).
 *
 * This is the enforcement mechanism, not a suggestion: `publish_tick`, `undo`,
 * `resume`, and `connect linkedin authorize` are never imported into this file
 * and therefore have no tool an agent can call. The only real external-send
 * path (`publish-tick`) stays a launchd-timer-triggered CLI invocation acting
 * on already gate-passed + approved + sentinel-valid DB rows — nothing in this
 * server can shorten that path. See ~/rooms/foghorn/room_rules.md.
 *
 * Wire protocol mirrors Harbor's own integrations/mcp-server.ts (line-delimited
 * JSON-RPC over stdin/stdout, no MCP SDK dependency) but this server has no
 * dependency on Harbor's room/budget gating — Foghorn's DB and functions are
 * imported directly, same pattern as dashboard/automations.ts's AutomationRunner.
 */
import type { Database } from "bun:sqlite";
import { openAndMigrate } from "./src/db/index.ts";
import { getSetting } from "./src/config/settings.ts";
import { isPaused, pause } from "./src/killswitch.ts";
import { capStatus } from "./src/spend/ledger.ts";
import { BeeperSource } from "./src/ingest/beeper.ts";
import { ensureSource, getCursor, setCursor, storeMessages } from "./src/ingest/store.ts";
import { buildProfiles, ratifyProfiles } from "./src/profile/profiler.ts";
import { scorePlatforms, ratifyPlatform, ratifiedPlatform } from "./src/select/platform-scorer.ts";
import { scanTrends, freshTrendCards } from "./src/research/trend-scanner.ts";
import { addCreator, listCreators } from "./src/research/watchlist.ts";
import {
  addEvidence,
  listEvidence,
  approveEvidence,
  rejectEvidence,
  proposeEvidence,
} from "./src/create/evidence-bank.ts";
import { extractEvidenceCandidates } from "./src/create/evidence-extract.ts";
import { runEngine, processIdea } from "./src/create/engine.ts";
import { ideate, type Idea } from "./src/create/ideate.ts";
import { clarifyingQuestion } from "./src/create/ideate-chat.ts";
import { generateTextResilient } from "./src/llm/generate.ts";
import { generateWithWebSearch } from "./src/llm/websearch.ts";

// ── JSON-RPC envelopes (same shape as Harbor's mcp-server.ts) ──────────────

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}
function errorResult(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

// ── DB (opened once, held for the server's lifetime) ────────────────────────

const db: Database = openAndMigrate();
const gen = (opts: Parameters<typeof generateTextResilient>[1]) => generateTextResilient(db, opts);
const genWeb = (opts: Parameters<typeof generateWithWebSearch>[1]) => generateWithWebSearch(db, opts);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}

// ── ideate flow: propose/answer split (MCP is request/response; ideateChat's
// original readline loop is replaced with server-held pending-angle state) ──

let nextAngleId = 1;
const pendingAngles = new Map<string, { idea: Idea; platform: string }>();

// ── Tool catalog ─────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  { name: "status", description: "Pause state, autonomy level, spend caps, corpus/draft/hold/publish counts. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "profile_show", description: "Show voice profile versions (persona/interests). Read-only.", inputSchema: { type: "object", properties: { version: { type: "number" } } } },
  { name: "profile_build", description: "LLM-build a new shadow (unratified) voice profile version from ingested corpus.", inputSchema: { type: "object", properties: { force: { type: "boolean" } } } },
  { name: "profile_ratify", description: "Mark a profile version as active.", inputSchema: { type: "object", properties: { version: { type: "number" } }, required: ["version"] } },
  { name: "score_show", description: "Show recent platform score runs. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "score_build", description: "LLM-score candidate platforms, writes shadow (unratified) scores.", inputSchema: { type: "object", properties: {} } },
  { name: "score_ratify", description: "Mark a platform as the ratified/primary publishing target.", inputSchema: { type: "object", properties: { platform: { type: "string" } }, required: ["platform"] } },
  { name: "watch_list", description: "List watched creators (competitor/research watchlist). Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "watch_add", description: "Add a creator to the research watchlist.", inputSchema: { type: "object", properties: { platform: { type: "string" }, handle: { type: "string" }, niche: { type: "string" } }, required: ["platform", "handle"] } },
  { name: "evidence_list", description: "List evidence-bank rows, optionally filtered by status (pending|approved|rejected). Read-only.", inputSchema: { type: "object", properties: { status: { type: "string" } } } },
  { name: "evidence_add", description: "Add a human-entered fact to the evidence bank (auto-approved).", inputSchema: { type: "object", properties: { topic: { type: "string" }, fact: { type: "string" } }, required: ["topic", "fact"] } },
  { name: "evidence_extract", description: "LLM-extract candidate facts from ingested corpus into the evidence bank (status=proposed, needs approval).", inputSchema: { type: "object", properties: {} } },
  { name: "evidence_approve", description: "Approve a proposed evidence candidate so the drafter may cite it.", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "evidence_reject", description: "Reject a proposed evidence candidate.", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "holds", description: "List open holds (drafts stuck pending human review). Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "scan", description: "Web-search trend scan for a platform (defaults to the ratified one), stores trend cards.", inputSchema: { type: "object", properties: { platform: { type: "string" } } } },
  { name: "ingest_beeper", description: "Pull new messages from the local Beeper API into the corpus.", inputSchema: { type: "object", properties: {} } },
  { name: "engine", description: "Run the ideation -> draft -> gate pipeline autonomously for a platform (defaults to ratified). Produces drafts/holds, never publishes.", inputSchema: { type: "object", properties: { platform: { type: "string" } } } },
  { name: "ideate_suggest_angles", description: "Brainstorm-only: propose several content angles/briefs (drawing on trend cards, approved evidence, and past publications for syndication/adaptation candidates) WITHOUT drafting or committing anything. Use this for a morning digest / open-ended 'what should we talk about' conversation. Nothing here touches the gate chain or evidence bank — pure suggestions to discuss with Adam.", inputSchema: { type: "object", properties: { platform: { type: "string" }, count: { type: "number" } } } },
  { name: "ideate_propose_angle", description: "Propose ONE content angle and commit to drafting it. If it needs a real specific to be credible, returns a clarifying question for you to relay to Adam and answer via ideate_answer_question. If not, drafts immediately and returns the outcome. Use ideate_suggest_angles first if you just want options to discuss, not a draft yet.", inputSchema: { type: "object", properties: { platform: { type: "string" } } } },
  { name: "ideate_answer_question", description: "Answer a pending clarifying question from ideate_propose_angle (Adam's real answer becomes approved evidence), then drafts through the normal gate chain.", inputSchema: { type: "object", properties: { angle_id: { type: "string" }, answer: { type: "string" } }, required: ["angle_id", "answer"] } },
  { name: "pause", description: "Set the kill switch — publisher will refuse all sends until a human resumes it via CLI.", inputSchema: { type: "object", properties: { reason: { type: "string" } } } },
] as const;

// ── Tool implementations ─────────────────────────────────────────────────

function statusImpl(): ToolResult {
  const counts = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  return text({
    paused: isPaused(db),
    maxAutonomyLevel: getSetting(db, "max_autonomy_level"),
    spend: {
      x: capStatus(db, "x"),
      llm: capStatus(db, "llm"),
    },
    corpusDocs: counts("SELECT COUNT(*) n FROM corpus_docs"),
    drafts: counts("SELECT COUNT(*) n FROM drafts"),
    pendingSchedule: counts("SELECT COUNT(*) n FROM schedule WHERE state='pending'"),
    openHolds: counts("SELECT COUNT(*) n FROM holds WHERE status='open'"),
    published: counts("SELECT COUNT(*) n FROM published_posts WHERE deleted_at IS NULL"),
  });
}

function profileShowImpl(version?: number): ToolResult {
  const rows = db
    .query<{ version: number; kind: string; json: string; active: number; built_at: string }, []>(
      "SELECT version, kind, json, active, built_at FROM profiles ORDER BY version, kind",
    )
    .all()
    .filter((r) => version === undefined || r.version === version);
  if (rows.length === 0) return text("no profiles yet — call profile_build");
  return text(rows.map((r) => ({ version: r.version, kind: r.kind, active: !!r.active, builtAt: r.built_at, profile: JSON.parse(r.json) })));
}

function scoreShowImpl(): ToolResult {
  const rows = db
    .query<{ platform: string; composite: number; ratified: number; evidence_json: string; scored_at: string }, []>(
      "SELECT platform, composite, ratified, evidence_json, scored_at FROM platform_scores ORDER BY scored_at DESC, composite DESC LIMIT 12",
    )
    .all();
  if (rows.length === 0) return text("no score runs yet — call score_build");
  return text(rows.map((r) => ({ platform: r.platform, composite: r.composite, ratified: !!r.ratified, scoredAt: r.scored_at, evidence: JSON.parse(r.evidence_json) })));
}

function holdsImpl(): ToolResult {
  const rows = db
    .query<{ id: number; draft_id: number | null; specialty: string; packet_json: string; created_at: string }, []>(
      "SELECT id, draft_id, specialty, packet_json, created_at FROM holds WHERE status='open' ORDER BY id",
    )
    .all();
  if (rows.length === 0) return text("no open holds");
  return text(rows.map((h) => ({ id: h.id, draftId: h.draft_id, specialty: h.specialty, createdAt: h.created_at, ...JSON.parse(h.packet_json) })));
}

async function ingestBeeperImpl(): Promise<ToolResult> {
  if (isPaused(db)) return text("paused — collector idle");
  const sourceId = ensureSource(db, "beeper", JSON.stringify({ chatType: "group" }));
  const source = new BeeperSource();
  const result = await source.pull(getCursor(db, sourceId));
  const report = storeMessages(db, sourceId, result.messages);
  if (result.cursor) setCursor(db, sourceId, result.cursor);
  return text({ pulled: result.messages.length, ...report });
}

async function scanImpl(platformArg?: string): Promise<ToolResult> {
  if (isPaused(db)) return text("paused — scanner idle");
  const platform = platformArg ?? ratifiedPlatform(db);
  if (!platform) return errorResult("no ratified platform — call score_ratify first, or pass one");
  const report = await scanTrends(db, genWeb, platform);
  const cards = freshTrendCards(db, platform, 6);
  return text({ ...report, sample: cards.map((c) => ({ format: c.format, title: c.title, summary: c.summary })) });
}

async function engineImpl(platformArg?: string): Promise<ToolResult> {
  if (isPaused(db)) return text("paused — engine idle");
  const platform = platformArg ?? ratifiedPlatform(db);
  if (!platform) return errorResult("no ratified platform — call score_ratify first, or pass one");
  const report = await runEngine(db, { generate: gen }, platform);
  return text(report);
}

async function ideateSuggestAnglesImpl(platformArg?: string, count?: number): Promise<ToolResult> {
  const platform = platformArg ?? ratifiedPlatform(db);
  if (!platform) return errorResult("no ratified platform — call score_ratify first, or pass one");
  const ideas = await ideate(db, gen, platform, count && count > 0 ? count : 3);
  if (ideas.length === 0) return text("no angles generated — check trend cards / evidence coverage (try scan / evidence_extract first)");
  return text(ideas.map((i) => ({ angle: i.angle, brief: i.brief, interestTag: i.interestTag })));
}

async function ideateProposeAngleImpl(platformArg?: string): Promise<ToolResult> {
  if (isPaused(db)) return text("paused — engine idle");
  const platform = platformArg ?? ratifiedPlatform(db);
  if (!platform) return errorResult("no ratified platform — call score_ratify first, or pass one");
  const [idea] = await ideate(db, gen, platform, 1);
  if (!idea) return text("no ideas generated — check trend cards / evidence coverage");

  const question = await clarifyingQuestion(gen, idea);
  if (!question) {
    // No real specific needed — draft immediately, same branch ideateChat takes.
    const outcome = await processIdea(db, { generate: gen }, idea, platform);
    return text({ angle: idea.angle, brief: idea.brief, question: null, outcome });
  }

  const angleId = String(nextAngleId++);
  pendingAngles.set(angleId, { idea, platform });
  return text({ angleId, angle: idea.angle, brief: idea.brief, question });
}

async function ideateAnswerQuestionImpl(angleId: string, answer: string): Promise<ToolResult> {
  const pending = pendingAngles.get(angleId);
  if (!pending) return errorResult(`no pending angle '${angleId}' — it may have already been answered, or the server restarted`);
  pendingAngles.delete(angleId);
  const { idea, platform } = pending;

  if (answer.trim()) {
    const id = proposeEvidence(db, idea.interestTag ?? "general", answer.trim(), `live answer during Hermes ideate flow`, null);
    approveEvidence(db, id);
  }
  const outcome = await processIdea(db, { generate: gen }, idea, platform);
  return text({ angle: idea.angle, answered: !!answer.trim(), outcome });
}

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  switch (name) {
    case "status":
      return statusImpl();
    case "profile_show":
      return profileShowImpl(num(args.version));
    case "profile_build":
      return text(await buildProfiles(db, gen, { force: !!args.force }));
    case "profile_ratify": {
      const v = num(args.version);
      if (v === undefined) return errorResult("profile_ratify: version is required");
      ratifyProfiles(db, v);
      return text(`profiles v${v} ratified as active`);
    }
    case "score_show":
      return scoreShowImpl();
    case "score_build":
      return text(await scorePlatforms(db, gen));
    case "score_ratify": {
      const p = str(args.platform);
      if (!p) return errorResult("score_ratify: platform is required");
      ratifyPlatform(db, p);
      return text(`platform '${p}' ratified as primary target`);
    }
    case "watch_list":
      return text(listCreators(db));
    case "watch_add": {
      const platform = str(args.platform);
      const handle = str(args.handle);
      if (!platform || !handle) return errorResult("watch_add: platform and handle are required");
      const id = addCreator(db, platform, handle, str(args.niche));
      return text({ id, platform, handle });
    }
    case "evidence_list":
      return text(listEvidence(db, str(args.status) === "pending" ? "proposed" : str(args.status)));
    case "evidence_add": {
      const topic = str(args.topic);
      const fact = str(args.fact);
      if (!topic || !fact) return errorResult("evidence_add: topic and fact are required");
      const id = addEvidence(db, topic, fact);
      return text({ id, topic, fact, status: "approved" });
    }
    case "evidence_extract":
      return text(await extractEvidenceCandidates(db, gen));
    case "evidence_approve": {
      const id = num(args.id);
      if (id === undefined) return errorResult("evidence_approve: id is required");
      approveEvidence(db, id);
      return text(`approved #${id}`);
    }
    case "evidence_reject": {
      const id = num(args.id);
      if (id === undefined) return errorResult("evidence_reject: id is required");
      rejectEvidence(db, id);
      return text(`rejected #${id}`);
    }
    case "holds":
      return holdsImpl();
    case "scan":
      return scanImpl(str(args.platform));
    case "ingest_beeper":
      return ingestBeeperImpl();
    case "engine":
      return engineImpl(str(args.platform));
    case "ideate_suggest_angles":
      return ideateSuggestAnglesImpl(str(args.platform), num(args.count));
    case "ideate_propose_angle":
      return ideateProposeAngleImpl(str(args.platform));
    case "ideate_answer_question": {
      const angleId = str(args.angle_id);
      const answer = str(args.answer);
      if (!angleId || answer === undefined) return errorResult("ideate_answer_question: angle_id and answer are required");
      return ideateAnswerQuestionImpl(angleId, answer);
    }
    case "pause": {
      pause(db, str(args.reason) || "agent", "mcp-agent");
      return text("paused — publisher will refuse all sends until a human resumes it via CLI");
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

// ── JSON-RPC dispatch (same shape as Harbor's mcp-server.ts) ────────────────

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeDispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return await dispatchTool(name, args);
  } catch (err) {
    return errorResult(`tool error: ${messageOf(err)}`);
  }
}

async function handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const frame = request as unknown;
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    return errorResponse(null, ERR_INVALID_REQUEST, "invalid request: expected a JSON-RPC object");
  }
  const id = request.id ?? null;
  const method = request.method;
  if (request.jsonrpc !== undefined && request.jsonrpc !== "2.0") {
    return errorResponse(id, ERR_INVALID_REQUEST, "jsonrpc must be '2.0'");
  }
  if (typeof method !== "string") {
    return errorResponse(id, ERR_INVALID_REQUEST, "missing method");
  }
  const isNotification = request.id === undefined || request.id === null;

  switch (method) {
    case "initialize":
      return isNotification
        ? null
        : ok(id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "foghorn", title: "Foghorn", version: "0.0.1" },
            instructions:
              "Foghorn is Adam's gated social-influence pipeline. These tools cover ideation, " +
              "evidence review, status, and drafting — never publishing. There is no tool to " +
              "trigger a real send; publish-tick runs only on a scheduled timer against " +
              "already-approved, gate-passed content. If Adam wants something published sooner, " +
              "tell him to run `bun foghorn.ts publish-tick` himself.",
          });
    case "notifications/initialized":
    case "initialized":
      return null;
    case "ping":
      return isNotification ? null : ok(id, {});
    case "tools/list":
      return isNotification ? null : ok(id, { tools: TOOL_DEFINITIONS });
    case "tools/call": {
      const params = request.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments as Record<string, unknown>) ?? {};
      if (!name) return isNotification ? null : errorResponse(id, ERR_INVALID_PARAMS, "tools/call: missing tool name");
      const result = await safeDispatch(name, args);
      return isNotification ? null : ok(id, result);
    }
    default:
      return isNotification ? null : errorResponse(id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

// ── stdio transport ──────────────────────────────────────────────────────

async function runStdioServer(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const write = (line: string) => process.stdout.write(line);

  const processLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write(JSON.stringify(errorResponse(null, ERR_PARSE, "parse error")) + "\n");
      return;
    }
    const response = await handle(request);
    if (response !== null) write(JSON.stringify(response) + "\n");
  };

  for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await processLine(line);
    }
  }
  if (buffer.trim()) await processLine(buffer);
}

runStdioServer();
