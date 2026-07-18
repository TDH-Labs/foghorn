import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { openAndMigrate } from "../src/db/index.ts";
import { isPaused, pause, resume } from "../src/killswitch.ts";
import { getSetting, setSetting, getNumberSetting } from "../src/config/settings.ts";
import { activeProfile, buildProfiles, ratifyProfiles } from "../src/profile/profiler.ts";
import { scorePlatforms, ratifyPlatform } from "../src/select/platform-scorer.ts";
import { validateBeeper, validateLinkedIn, validateNostr, validateTelegram, validateX } from "../src/connectors/validators.ts";
import { scanTrends, freshTrendCards } from "../src/research/trend-scanner.ts";
import { addCreator, listCreators } from "../src/research/watchlist.ts";
import { addEvidence, listEvidence, approveEvidence, rejectEvidence } from "../src/create/evidence-bank.ts";
import { extractEvidenceCandidates } from "../src/create/evidence-extract.ts";
import { runEngine, processIdea } from "../src/create/engine.ts";
import { recordDecision, renderApproval, scheduleDraft, expireStaleApprovals } from "../src/approvals/queue.ts";
import { publishTick } from "../src/publish/publisher.ts";
import { createAdapters } from "../src/publish/adapters/registry.ts";
import { collectXMetrics } from "../src/metrics/collector.ts";
import { capStatus } from "../src/spend/ledger.ts";
import { ratifyPromotion, effectiveLevel } from "../src/autonomy/ladder.ts";
import { generateTextResilient } from "../src/llm/generate.ts";
import { generateWithWebSearch } from "../src/llm/websearch.ts";
import { BeeperSource } from "../src/ingest/beeper.ts";
import { ensureSource, getCursor, setCursor, storeMessages } from "../src/ingest/store.ts";
import { importLinkedInExport, importXArchive } from "../src/ingest/archives.ts";
import { AutomationRunner } from "./automations.ts";
import { ideateChat } from "../src/create/ideate-chat.ts";
import { authorizeLinkedIn, buildAuthUrl, REDIRECT_PORT, SCOPES } from "../src/connectors/linkedin-oauth.ts";
import { randomBytes } from "node:crypto";

const PORT = 3010;
const PUBLIC_DIR = join(import.meta.dir, "public");

// SSE streaming controllers
const sseControllers = new Set<ReadableStreamDefaultController>();

// Persistent module-level database connection (SSE streams are async and must
// not have the db closed under them by a per-request finally block).
const db = openAndMigrate();

// Overwrite console.log & console.error to broadcast messages to all SSE listeners
const originalLog = console.log;
const originalError = console.error;

function broadcastSSE(data: any) {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const c of sseControllers) {
    try {
      c.enqueue(bytes);
    } catch {
      sseControllers.delete(c);
    }
  }
}

console.log = (...args) => {
  originalLog(...args);
  broadcastSSE({
    type: "log",
    level: "info",
    message: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "),
    time: new Date().toISOString()
  });
};

console.error = (...args) => {
  originalError(...args);
  broadcastSSE({
    type: "log",
    level: "error",
    message: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "),
    time: new Date().toISOString()
  });
};

// Interactive ideation question resolver
let pendingQuestion: { angle: string; question: string; ideaId: number } | null = null;
let pendingAnswerResolver: ((answer: string) => void) | null = null;

function dbQuery<T>(db: Database, sql: string, params: any[] = []): T[] {
  return db.query<T, any[]>(sql).all(...params);
}

function dbGet<T>(db: Database, sql: string, params: any[] = []): T | null {
  return db.query<T, any[]>(sql).get(...params) ?? null;
}

// Ingest runner helper
async function runBeeperIngest(db: Database) {
  if (isPaused(db)) throw new Error("Collector idle — pipeline is paused");
  const sourceId = ensureSource(db, "beeper", JSON.stringify({ chatType: "group" }));
  const source = new BeeperSource();
  const result = await source.pull(getCursor(db, sourceId));
  const report = storeMessages(db, sourceId, result.messages);
  if (result.cursor) setCursor(db, sourceId, result.cursor);
  return { pulled: result.messages.length, ...report };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // Disable timeout for long-running SSE streams (engine, profile build, scan)
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Static assets
    if (path === "/" || path === "/index.html") {
      const file = Bun.file(join(PUBLIC_DIR, "index.html"));
      return new Response(file);
    }

    if (!path.startsWith("/api/")) {
      const filePath = join(PUBLIC_DIR, path);
      if (existsSync(filePath)) {
        return new Response(Bun.file(filePath));
      }
      return new Response("Not Found", { status: 404 });
    }

    try {
      // API endpoints

      // 1. Status and Settings
      if (path === "/api/status" && method === "GET") {
        const paused = isPaused(db);
        const counts = (sql: string) => dbGet<{ n: number }>(db, sql)?.n ?? 0;
        
        const platformSpend = capStatus(db, "x");
        const llmSpend = capStatus(db, "llm");
        const otherSpend = capStatus(db, "other");

        const platformScores = dbQuery<{ platform: string, ratified: number }>(db, "SELECT platform, ratified FROM platform_scores WHERE ratified = 1 LIMIT 1");
        const ratifiedPlat = platformScores.length > 0 ? platformScores[0].platform : null;

        const activeProfileVer = dbGet<{ version: number }>(db, "SELECT version FROM profiles WHERE active = 1 LIMIT 1")?.version ?? null;

        return Response.json({
          paused,
          max_autonomy_level: getSetting(db, "max_autonomy_level") ?? "1",
          ratified_platform: ratifiedPlat,
          active_profile_version: activeProfileVer,
          spend: {
            x: platformSpend,
            llm: llmSpend,
            other: otherSpend
          },
          counts: {
            corpus_docs: counts("SELECT COUNT(*) n FROM corpus_docs"),
            drafts: counts("SELECT COUNT(*) n FROM drafts"),
            schedule_pending: counts("SELECT COUNT(*) n FROM schedule WHERE state='pending'"),
            holds_open: counts("SELECT COUNT(*) n FROM holds WHERE status='open'"),
            published: counts("SELECT COUNT(*) n FROM published_posts WHERE deleted_at IS NULL")
          }
        }, { headers: corsHeaders });
      }

      if (path === "/api/settings" && method === "GET") {
        const rows = dbQuery<{ key: string, value: string }>(db, "SELECT key, value FROM settings");
        const settingsMap: Record<string, string> = {};
        for (const r of rows) settingsMap[r.key] = r.value;
        return Response.json(settingsMap, { headers: corsHeaders });
      }

      if (path === "/api/settings" && method === "POST") {
        const body = await req.json();
        for (const [key, value] of Object.entries(body)) {
          setSetting(db, key, String(value));
        }
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // 2. Kill Switch (Pause/Resume)
      if (path === "/api/pause" && method === "POST") {
        const body = await req.json();
        const reason = body.reason || "manual web interface pause";
        pause(db, reason, "dashboard");
        return Response.json({ ok: true, paused: true }, { headers: corsHeaders });
      }

      if (path === "/api/resume" && method === "POST") {
        const body = await req.json();
        const reason = body.reason;
        if (!reason || !reason.trim()) {
          return new Response(JSON.stringify({ error: "Resume requires a reason" }), { status: 400, headers: corsHeaders });
        }
        resume(db, reason, "dashboard");
        return Response.json({ ok: true, paused: false }, { headers: corsHeaders });
      }

      // 3. Ingestion
      if (path === "/api/ingest/beeper" && method === "POST") {
        const result = await runBeeperIngest(db);
        return Response.json(result, { headers: corsHeaders });
      }

      if (path === "/api/ingest/archive" && method === "POST") {
        const body = await req.json();
        const { kind, path: filePath } = body;
        if (!filePath) {
          return new Response(JSON.stringify({ error: "Path is required" }), { status: 400, headers: corsHeaders });
        }
        if (kind === "x") {
          ensureSource(db, "x_archive", JSON.stringify({ path: filePath }));
          const res = importXArchive(db, filePath);
          return Response.json(res, { headers: corsHeaders });
        } else if (kind === "linkedin") {
          ensureSource(db, "linkedin_export", JSON.stringify({ path: filePath }));
          const res = importLinkedInExport(db, filePath);
          return Response.json(res, { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: "Invalid kind" }), { status: 400, headers: corsHeaders });
      }

      // 4. Profiles
      if (path === "/api/profiles" && method === "GET") {
        const rows = dbQuery<{ version: number; kind: string; json: string; active: number; built_at: string }>(
          db,
          "SELECT version, kind, json, active, built_at FROM profiles ORDER BY version DESC, kind"
        );
        return Response.json(rows, { headers: corsHeaders });
      }

      if (path === "/api/profiles/build" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        const force = !!body.force;
        
        return new Response(new ReadableStream({
          async start(controller) {
            sseControllers.add(controller);
            try {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start", message: "Building profiles..." })}\n\n`));
              const result = await buildProfiles(
                db,
                (opts) => generateTextResilient(db, opts),
                { force }
              );
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", result })}\n\n`));
            } catch (err: any) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", message: err.message || String(err) })}\n\n`));
            } finally {
              sseControllers.delete(controller);
              controller.close();
            }
          }
        }), { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
      }

      if (path.match(/\/api\/profiles\/(\d+)\/ratify$/) && method === "POST") {
        const match = path.match(/\/api\/profiles\/(\d+)\/ratify$/);
        const version = Number(match![1]);
        ratifyProfiles(db, version);
        return Response.json({ ok: true, ratified: version }, { headers: corsHeaders });
      }

      // 5. Platforms & Connectors
      if (path === "/api/platforms/scores" && method === "GET") {
        const rows = dbQuery<{ platform: string; composite: number; ratified: number; evidence_json: string; scored_at: string }>(
          db,
          "SELECT platform, composite, ratified, evidence_json, scored_at FROM platform_scores ORDER BY scored_at DESC, composite DESC LIMIT 20"
        );
        return Response.json(rows, { headers: corsHeaders });
      }

      if (path === "/api/platforms/score" && method === "POST") {
        return new Response(new ReadableStream({
          async start(controller) {
            sseControllers.add(controller);
            try {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start", message: "Scoring platforms..." })}\n\n`));
              const result = await scorePlatforms(db, (opts) => generateTextResilient(db, opts));
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", result })}\n\n`));
            } catch (err: any) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", message: err.message || String(err) })}\n\n`));
            } finally {
              sseControllers.delete(controller);
              controller.close();
            }
          }
        }), { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
      }

      if (path.match(/\/api\/platforms\/([a-zA-Z0-9_-]+)\/ratify$/) && method === "POST") {
        const match = path.match(/\/api\/platforms\/([a-zA-Z0-9_-]+)\/ratify$/);
        const platform = match![1];
        ratifyPlatform(db, platform);
        return Response.json({ ok: true, ratified: platform }, { headers: corsHeaders });
      }

      // LinkedIn OAuth flow — starts local callback listener and streams auth URL via SSE
      if (path === "/api/platforms/linkedin/auth" && method === "POST") {
        const clientId = process.env.LINKEDIN_CLIENT_ID;
        const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return new Response(
            JSON.stringify({ error: "LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not set in .env.local" }),
            { status: 400, headers: corsHeaders }
          );
        }
        const state = randomBytes(16).toString("hex");
        const authUrl = buildAuthUrl(clientId, state);
        return new Response(
          new ReadableStream({
            async start(controller) {
              const enc = (d: any) => new TextEncoder().encode(`data: ${JSON.stringify(d)}\n\n`);
              sseControllers.add(controller);
              try {
                controller.enqueue(enc({ type: "auth_url", url: authUrl, redirect_port: REDIRECT_PORT }));
                controller.enqueue(enc({ type: "log", level: "info", message: `Open this URL to authorize LinkedIn:\n${authUrl}` }));
                controller.enqueue(enc({ type: "log", level: "info", message: `Waiting for redirect on port ${REDIRECT_PORT}...` }));
                // Run the full auth flow — this blocks until the user completes the browser step
                await authorizeLinkedIn({ clientId, clientSecret, timeoutMs: 180_000 });
                controller.enqueue(enc({ type: "done", message: "LinkedIn authorized! Token saved to .env.local." }));
              } catch (err: any) {
                controller.enqueue(enc({ type: "error", message: err.message || String(err) }));
              } finally {
                sseControllers.delete(controller);
                controller.close();
              }
            },
          }),
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }
        );
      }

      if (path === "/api/platforms/connectors" && method === "GET") {
        const beeperVal = await validateBeeper().catch((e) => ({ ok: false, connector: "beeper", checks: [] }));
        const tgVal = await validateTelegram().catch((e) => ({ ok: false, connector: "telegram", checks: [] }));
        const xVal = await validateX(db).catch((e) => ({ ok: false, connector: "x", checks: [] }));
        const liVal = await validateLinkedIn().catch((e) => ({ ok: false, connector: "linkedin", checks: [] }));
        const noVal = await validateNostr().catch((e) => ({ ok: false, connector: "nostr", checks: [] }));
        return Response.json({
          beeper: beeperVal,
          telegram: tgVal,
          x: xVal,
          linkedin: liVal,
          nostr: noVal
        }, { headers: corsHeaders });
      }

      // 6. Research (Trends & Watchlist)
      if (path === "/api/trends" && method === "GET") {
        const platform = url.searchParams.get("platform") || dbGet<{ platform: string }>(db, "SELECT platform FROM platform_scores WHERE ratified = 1 LIMIT 1")?.platform;
        if (!platform) {
          return Response.json([], { headers: corsHeaders });
        }
        const limit = Number(url.searchParams.get("limit") || "20");
        const cards = freshTrendCards(db, platform, limit);
        return Response.json(cards, { headers: corsHeaders });
      }

      if (path === "/api/scan" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        const platform = body.platform || dbGet<{ platform: string }>(db, "SELECT platform FROM platform_scores WHERE ratified = 1 LIMIT 1")?.platform;
        if (!platform) {
          return new Response(JSON.stringify({ error: "No ratified platform to scan. Specify platform in request body." }), { status: 400, headers: corsHeaders });
        }

        return new Response(new ReadableStream({
          async start(controller) {
            sseControllers.add(controller);
            try {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start", message: `Scanning trends on ${platform}...` })}\n\n`));
              const result = await scanTrends(db, (opts) => generateWithWebSearch(db, opts), platform);
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", result })}\n\n`));
            } catch (err: any) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", message: err.message || String(err) })}\n\n`));
            } finally {
              sseControllers.delete(controller);
              controller.close();
            }
          }
        }), { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
      }

      if (path === "/api/watchlist" && method === "GET") {
        const list = listCreators(db);
        return Response.json(list, { headers: corsHeaders });
      }

      if (path === "/api/watchlist" && method === "POST") {
        const body = await req.json();
        const { platform, handle, niche } = body;
        if (!platform || !handle) {
          return new Response(JSON.stringify({ error: "Platform and handle are required" }), { status: 400, headers: corsHeaders });
        }
        const id = addCreator(db, platform, handle, niche);
        return Response.json({ ok: true, id }, { headers: corsHeaders });
      }

      // 7. Evidence Bank
      if (path === "/api/evidence" && method === "GET") {
        const status = url.searchParams.get("status") || undefined; // pending/approved/rejected (pending is mapped to proposed in database)
        const dbStatus = status === "pending" ? "proposed" : status;
        const list = listEvidence(db, dbStatus);
        return Response.json(list, { headers: corsHeaders });
      }

      if (path === "/api/evidence" && method === "POST") {
        const body = await req.json();
        const { topic, fact } = body;
        if (!topic || !fact) {
          return new Response(JSON.stringify({ error: "Topic and fact are required" }), { status: 400, headers: corsHeaders });
        }
        const id = addEvidence(db, topic, fact);
        return Response.json({ ok: true, id }, { headers: corsHeaders });
      }

      if (path === "/api/evidence/extract" && method === "POST") {
        return new Response(new ReadableStream({
          async start(controller) {
            sseControllers.add(controller);
            try {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start", message: "Extracting evidence candidates..." })}\n\n`));
              const result = await extractEvidenceCandidates(db, (opts) => generateTextResilient(db, opts));
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", result })}\n\n`));
            } catch (err: any) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", message: err.message || String(err) })}\n\n`));
            } finally {
              sseControllers.delete(controller);
              controller.close();
            }
          }
        }), { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
      }

      if (path.match(/\/api\/evidence\/(\d+)\/approve$/) && method === "POST") {
        const match = path.match(/\/api\/evidence\/(\d+)\/approve$/);
        const id = Number(match![1]);
        approveEvidence(db, id);
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (path.match(/\/api\/evidence\/(\d+)\/reject$/) && method === "POST") {
        const match = path.match(/\/api\/evidence\/(\d+)\/reject$/);
        const id = Number(match![1]);
        rejectEvidence(db, id);
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // 8. Content Engine, Holds & Approvals
      if (path === "/api/drafts" && method === "GET") {
        const status = url.searchParams.get("status") || undefined;
        let query = "SELECT * FROM drafts";
        const params: any[] = [];
        if (status) {
          query += " WHERE status = ?";
          params.push(status);
        }
        query += " ORDER BY id DESC";
        const drafts = dbQuery<any>(db, query, params);
        return Response.json(drafts, { headers: corsHeaders });
      }

      if (path === "/api/engine" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        const platform = body.platform || dbGet<{ platform: string }>(db, "SELECT platform FROM platform_scores WHERE ratified = 1 LIMIT 1")?.platform;
        if (!platform) {
          return new Response(JSON.stringify({ error: "No platform ratified. Engine requires a platform." }), { status: 400, headers: corsHeaders });
        }

        return new Response(new ReadableStream({
          async start(controller) {
            sseControllers.add(controller);
            try {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start", message: `Running Content Engine for ${platform}...` })}\n\n`));
              const result = await runEngine(db, { generate: (o) => generateTextResilient(db, o) }, platform);
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", result })}\n\n`));
            } catch (err: any) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", message: err.message || String(err) })}\n\n`));
            } finally {
              sseControllers.delete(controller);
              controller.close();
            }
          }
        }), { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
      }

      if (path === "/api/holds" && method === "GET") {
        const holds = dbQuery<any>(db, "SELECT * FROM holds WHERE status='open' ORDER BY id DESC");
        return Response.json(holds, { headers: corsHeaders });
      }

      if (path.match(/\/api\/holds\/(\d+)\/decide$/) && method === "POST") {
        const match = path.match(/\/api\/holds\/(\d+)\/decide$/);
        const holdId = Number(match![1]);
        const body = await req.json();
        const { decision, note } = body; // decision: approved / rejected

        const hold = dbGet<{ draft_id: number | null, specialty: string }>(
          db,
          "SELECT draft_id, specialty FROM holds WHERE id = ? AND status = 'open'",
          [holdId]
        );
        if (!hold) {
          return new Response(JSON.stringify({ error: "Open hold not found" }), { status: 404, headers: corsHeaders });
        }

        db.run(
          "UPDATE holds SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?",
          [new Date().toISOString(), decision + (note ? `: ${note}` : ""), holdId]
        );

        if (hold.draft_id !== null) {
          const draft = dbGet<{ id: number, platform: string, content_class: string }>(
            db,
            "SELECT id, platform, content_class FROM drafts WHERE id = ?",
            [hold.draft_id]
          );

          if (draft) {
            if (decision === "approved") {
              db.run(
                "UPDATE drafts SET status = 'approved', updated_at = ? WHERE id = ?",
                [new Date().toISOString(), draft.id]
              );
              const level = effectiveLevel(db, draft.platform, draft.content_class);
              if (level >= 1) {
                scheduleDraft(db, draft.id);
              }
            } else {
              db.run(
                "UPDATE drafts SET status = 'rejected', updated_at = ? WHERE id = ?",
                [new Date().toISOString(), draft.id]
              );
            }
          }
        }

        return Response.json({ ok: true, detail: `Hold resolved as ${decision}` }, { headers: corsHeaders });
      }

      if (path === "/api/approvals" && method === "GET") {
        const approvals = dbQuery<any>(
          db,
          `SELECT a.id, a.draft_id, a.draft_version, a.risk_score, a.requested_at, d.body_text, d.platform, d.content_class, d.voice_score, d.quality_score
           FROM approvals a JOIN drafts d ON d.id = a.draft_id
           WHERE a.decision IS NULL ORDER BY a.id DESC`
        );
        return Response.json(approvals, { headers: corsHeaders });
      }

      if (path.match(/\/api\/approvals\/(\d+)\/decide$/) && method === "POST") {
        const match = path.match(/\/api\/approvals\/(\d+)\/decide$/);
        const approvalId = Number(match![1]);
        const body = await req.json();
        const { decision, note, editedText } = body; // decision: approved / rejected / edited

        if (decision === "edited" && editedText) {
          // If the user edited the text:
          // 1. Get the draft details
          const approvalObj = dbGet<{ draft_id: number }>(db, "SELECT draft_id FROM approvals WHERE id = ?", [approvalId]);
          if (!approvalObj) {
            return new Response(JSON.stringify({ error: "Approval not found" }), { status: 404, headers: corsHeaders });
          }
          const draft = dbGet<any>(db, "SELECT * FROM drafts WHERE id = ?", [approvalObj.draft_id]);
          if (!draft) {
            return new Response(JSON.stringify({ error: "Draft not found" }), { status: 404, headers: corsHeaders });
          }

          // 2. Perform version bump and register edited draft text
          const bytes = new TextEncoder().encode(editedText);
          const newVersion = draft.version + 1;
          
          // Re-gating the edited draft so it gets sentinel and new scores
          // We construct a temporary DraftSubject
          const subject = {
            draftId: draft.id,
            version: newVersion,
            platform: draft.platform,
            contentClass: draft.content_class,
            bodyText: editedText,
            canonicalBytes: bytes,
            evidence: JSON.parse(draft.evidence_json || "[]")
          };

          // Run fast and full chains
          const fullGates = buildFullGates(db, (opts) => generateTextResilient(db, opts));
          const chainRes = await runChain(db, fullGates, subject, "full");

          const voice = scoreFrom(chainRes.verdicts, "gate-voice");
          const quality = scoreFrom(chainRes.verdicts, "gate-quality");
          const risk = scoreFrom(chainRes.verdicts, "gate-risk");

          db.run(
            `UPDATE drafts SET body_text = ?, canonical_bytes = ?, artifact_sha256 = ?, version = ?, 
             voice_score = ?, quality_score = ?, risk_score = ?, status = 'approved', updated_at = ?
             WHERE id = ?`,
            [editedText, bytes, chainRes.sentinelId ? dbGet<{artifact_sha256: string}>(db, "SELECT artifact_sha256 FROM sentinels WHERE id = ?", [chainRes.sentinelId])?.artifact_sha256 || "" : "", 
             newVersion, voice, quality, risk, new Date().toISOString(), draft.id]
          );

          // Complete decision with "edited"
          const result = recordDecision(db, approvalId, "edited", "dashboard", note);
          return Response.json({ ok: result.ok, detail: result.detail, gateOutcome: chainRes.outcome }, { headers: corsHeaders });
        }

        // Standard approve/reject decision
        const result = recordDecision(db, approvalId, decision, "dashboard", note);
        return Response.json(result, { headers: corsHeaders });
      }

      // 9. Schedule & Publishing
      if (path === "/api/schedule" && method === "GET") {
        const schedule = dbQuery<any>(
          db,
          `SELECT s.*, d.body_text, d.content_class
           FROM schedule s JOIN drafts d ON d.id = s.draft_id
           WHERE s.state IN ('pending', 'firing') ORDER BY s.scheduled_for ASC`
        );
        return Response.json(schedule, { headers: corsHeaders });
      }

      const scheduleMatch = path.match(/^\/api\/schedule\/(\d+)$/);
      if (scheduleMatch) {
        const id = parseInt(scheduleMatch[1], 10);
        if (method === "PUT") {
          const body = await req.json();
          if (body.scheduled_for) {
            db.run("UPDATE schedule SET scheduled_for = ? WHERE id = ?", [body.scheduled_for, id]);
          }
          return Response.json({ success: true }, { headers: corsHeaders });
        }
        if (method === "DELETE") {
          db.run("UPDATE schedule SET state = 'cancelled' WHERE id = ?", [id]);
          return Response.json({ success: true }, { headers: corsHeaders });
        }
      }

      if (path === "/api/replies" && method === "GET") {
        const replies = dbQuery<any>(
          db,
          `SELECT m.*, d.body_text as draft_body, d.content_class
           FROM mentions m 
           LEFT JOIN drafts d ON m.reply_draft_id = d.id
           ORDER BY m.id DESC LIMIT 50`
        );
        return Response.json(replies, { headers: corsHeaders });
      }

      if (path === "/api/engine/replies" && method === "POST") {
        // Trigger the reply engine
        const { runReplyEngine } = await import("../src/replies/reply-engine.ts");
        const { XSource } = await import("../src/replies/sources/x-source.ts");
        // For now, we'll run it for X as an example. Production would iterate active profiles/platforms.
        const report = await runReplyEngine(db, { generate }, "x", new XSource(db));
        return Response.json(report, { headers: corsHeaders });
      }

      if (path === "/api/publish-tick" && method === "POST") {
        const adapters = createAdapters();
        const report = await publishTick(db, adapters);
        return Response.json(report, { headers: corsHeaders });
      }

      if (path === "/api/published" && method === "GET") {
        const published = dbQuery<any>(
          db,
          `SELECT p.*, d.body_text, d.content_class, m.impressions, m.likes, m.replies, m.reposts
           FROM published_posts p 
           JOIN drafts d ON d.id = p.draft_id
           LEFT JOIN metrics m ON m.published_post_id = p.id
           ORDER BY p.id DESC LIMIT 100`
        );
        return Response.json(published, { headers: corsHeaders });
      }

      if (path.match(/\/api\/undo\/(\d+)$/) && method === "POST") {
        const match = path.match(/\/api\/undo\/(\d+)$/);
        const id = Number(match![1]);
        const body = await req.json().catch(() => ({}));
        const incidentReason = body.incident;

        const post = dbGet<{ id: number; platform: string; external_post_id: string; draft_id: number; deleted_at: string | null }>(
          db,
          "SELECT id, platform, external_post_id, draft_id, deleted_at FROM published_posts WHERE id = ?",
          [id]
        );

        if (!post) {
          return new Response(JSON.stringify({ error: "Published post not found" }), { status: 404, headers: corsHeaders });
        }
        if (post.deleted_at) {
          return Response.json({ ok: true, detail: "already deleted" }, { headers: corsHeaders });
        }

        const adapter = createAdapters().get(post.platform);
        if (!adapter) {
          return new Response(JSON.stringify({ error: `no adapter for ${post.platform}` }), { status: 400, headers: corsHeaders });
        }

        await adapter.delete(post.external_post_id);

        db.run("UPDATE published_posts SET deleted_at = ?, delete_reason = ? WHERE id = ?", [
          new Date().toISOString(), incidentReason || "manual dashboard undo", id,
        ]);

        if (incidentReason) {
          const { recordIncident } = await import("../src/autonomy/ladder.ts");
          recordIncident(db, post.platform, incidentReason);
        }

        return Response.json({ ok: true, deleted: true }, { headers: corsHeaders });
      }

      // 10. Spend & Autonomy
      if (path === "/api/spend" && method === "GET") {
        const x = capStatus(db, "x");
        const llm = capStatus(db, "llm");
        const other = capStatus(db, "other");
        return Response.json({ x, llm, other }, { headers: corsHeaders });
      }

      if (path === "/api/spend/caps" && method === "POST") {
        const body = await req.json();
        // body: { llm?: number, x?: number, other?: number }
        for (const group of ["llm", "x", "other"] as const) {
          const val = body[group];
          if (val !== undefined && !isNaN(Number(val))) {
            db.run(
              "UPDATE spend_caps SET monthly_cap_usd = ? WHERE cap_group = ?",
              [Number(val), group]
            );
          }
        }
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      if (path === "/api/autonomy" && method === "GET") {
        const states = dbQuery<any>(db, "SELECT * FROM autonomy_state ORDER BY platform, content_class");
        const events = dbQuery<any>(db, "SELECT * FROM autonomy_events ORDER BY id DESC LIMIT 50");
        return Response.json({ states, events }, { headers: corsHeaders });
      }

      if (path.match(/\/api\/autonomy\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/ratify$/) && method === "POST") {
        const match = path.match(/\/api\/autonomy\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/ratify$/);
        const platform = match![1];
        const cc = match![2];
        const body = await req.json();
        const toLevel = Number(body.level);

        ratifyPromotion(db, platform, cc, toLevel);
        return Response.json({ ok: true }, { headers: corsHeaders });
      }

      // 11. Journal / Activity logs
      if (path === "/api/journal" && method === "GET") {
        const limit = Number(url.searchParams.get("limit") || "100");
        const rows = dbQuery<any>(db, `SELECT * FROM journal ORDER BY id DESC LIMIT ?`, [limit]);
        return Response.json(rows, { headers: corsHeaders });
      }

      // 12. Interactive Ideation
      if (path === "/api/ideate-chat/question" && method === "GET") {
        return Response.json({ question: pendingQuestion }, { headers: corsHeaders });
      }

      if (path === "/api/ideate-chat/answer" && method === "POST") {
        const body = await req.json();
        const answer = body.answer || "";
        if (pendingAnswerResolver) {
          pendingAnswerResolver(answer);
          return Response.json({ ok: true }, { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: "No pending question to answer" }), { status: 400, headers: corsHeaders });
      }

      // 13. Logical Automations Run (SSE)
      if (path === "/api/automations/run" && method === "POST") {
        const body = await req.json();
        const type = body.type; // setup / content-cycle / publish-measure / full
        const platform = body.platform || undefined;

        return new Response(new ReadableStream({
          async start(controller) {
            sseControllers.add(controller);
            const runner = new AutomationRunner(db, (stepIdx, status, detail) => {
              const payload = {
                type: "progress",
                stepIndex: stepIdx,
                status,
                detail,
                steps: runner.getSteps()
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
            });

            try {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start", steps: runner.getSteps() })}\n\n`));
              
              if (type === "setup") {
                await runner.runSetupPipeline();
              } else if (type === "content-cycle") {
                await runner.runContentCycle(platform);
              } else if (type === "publish-measure") {
                await runner.runPublishAndMeasure();
              } else if (type === "full") {
                await runner.runFullPipeline(platform);
              } else {
                throw new Error(`Unknown automation type: ${type}`);
              }

              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", message: "Automation pipeline run successfully completed" })}\n\n`));
            } catch (err: any) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", message: err.message || String(err) })}\n\n`));
            } finally {
              sseControllers.delete(controller);
              controller.close();
            }
          }
        }), { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
      }

      // 14. Interactive Ideate Chat Trigger (SSE)
      if (path === "/api/ideate-chat/start" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        const platform = body.platform || dbGet<{ platform: string }>(db, "SELECT platform FROM platform_scores WHERE ratified = 1 LIMIT 1")?.platform;
        if (!platform) {
          return new Response(JSON.stringify({ error: "No ratified platform." }), { status: 400, headers: corsHeaders });
        }

        return new Response(new ReadableStream({
          async start(controller) {
            sseControllers.add(controller);
            try {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start", message: "Starting interactive ideation..." })}\n\n`));
              
              const result = await ideateChat(
                db,
                { generate: (o) => generateTextResilient(db, o) },
                platform,
                async (question) => {
                  return new Promise<string>((resolve) => {
                    pendingQuestion = { angle: "", question, ideaId: 0 };
                    pendingAnswerResolver = (ans) => {
                      pendingQuestion = null;
                      pendingAnswerResolver = null;
                      resolve(ans);
                    };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "question", question })}\n\n`));
                  });
                }
              );

              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "done", result })}\n\n`));
            } catch (err: any) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", message: err.message || String(err) })}\n\n`));
            } finally {
              sseControllers.delete(controller);
              controller.close();
            }
          }
        }), { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (err: any) {
      console.error("[server] API Error:", err);
      return new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500, headers: corsHeaders });
    }
  }
});

console.log(`[server] Foghorn Dashboard API running at http://localhost:${PORT}`);
export default server;
