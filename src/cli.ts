import { mkdirSync } from "node:fs";
import { DATA_DIR, DB_PATH, MEDIA_DIR, getSetting } from "./config/settings.ts";
import { openAndMigrate } from "./db/index.ts";
import { isPaused, pause, resume } from "./killswitch.ts";
import { capStatus } from "./spend/ledger.ts";
import { publishTick } from "./publish/publisher.ts";
import { BeeperSource } from "./ingest/beeper.ts";
import { ensureSource, getCursor, setCursor, storeMessages } from "./ingest/store.ts";
import { importLinkedInExport, importXArchive } from "./ingest/archives.ts";

const PHASE_STUBS: Record<string, string> = {
  report: "Phase 8",
  diagnose: "Phase 8",
};

export async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "init": {
      mkdirSync(DATA_DIR, { recursive: true });
      mkdirSync(MEDIA_DIR, { recursive: true });
      const db = openAndMigrate();
      console.log(`initialized ${DB_PATH}`);
      db.close();
      return 0;
    }
    case "migrate": {
      const db = openAndMigrate();
      console.log("migrations up to date");
      db.close();
      return 0;
    }
    case "status": {
      const db = openAndMigrate();
      const counts = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
      const paused = isPaused(db);
      console.log(`foghorn status @ ${new Date().toISOString()}`);
      console.log(`  paused: ${paused}`);
      console.log(`  max autonomy level: ${getSetting(db, "max_autonomy_level")}`);
      for (const group of ["x", "llm"]) {
        const s = capStatus(db, group);
        console.log(`  spend[${group}]: $${s.spentUsd.toFixed(2)} / $${s.capUsd.toFixed(2)} (${Math.round(s.level * 100)}%)`);
      }
      console.log(`  corpus docs: ${counts("SELECT COUNT(*) n FROM corpus_docs")}`);
      console.log(`  drafts: ${counts("SELECT COUNT(*) n FROM drafts")}`);
      console.log(`  pending schedule: ${counts("SELECT COUNT(*) n FROM schedule WHERE state='pending'")}`);
      console.log(`  open holds: ${counts("SELECT COUNT(*) n FROM holds WHERE status='open'")}`);
      console.log(`  published: ${counts("SELECT COUNT(*) n FROM published_posts WHERE deleted_at IS NULL")}`);
      db.close();
      return 0;
    }
    case "pause": {
      const db = openAndMigrate();
      pause(db, rest.join(" ") || "manual", "cli");
      console.log("paused — publisher will refuse all sends");
      db.close();
      return 0;
    }
    case "resume": {
      const reason = rest.join(" ");
      if (!reason) {
        console.error("resume requires a reason: foghorn resume <why>");
        return 1;
      }
      const db = openAndMigrate();
      resume(db, reason, "cli");
      console.log("resumed");
      db.close();
      return 0;
    }
    case "ingest": {
      const sub = rest[0];
      const db = openAndMigrate();
      try {
        if (sub === "beeper") {
          if (isPaused(db)) { console.log("paused — collector idle"); return 0; }
          const sourceId = ensureSource(db, "beeper", JSON.stringify({ chatType: "group" }));
          const source = new BeeperSource();
          const result = await source.pull(getCursor(db, sourceId));
          const report = storeMessages(db, sourceId, result.messages);
          if (result.cursor) setCursor(db, sourceId, result.cursor);
          console.log(JSON.stringify({ pulled: result.messages.length, ...report }));
          return 0;
        }
        if (sub === "x-archive" && rest[1]) {
          ensureSource(db, "x_archive", JSON.stringify({ path: rest[1] }));
          console.log(JSON.stringify(importXArchive(db, rest[1])));
          return 0;
        }
        if (sub === "linkedin" && rest[1]) {
          ensureSource(db, "linkedin_export", JSON.stringify({ path: rest[1] }));
          console.log(JSON.stringify(importLinkedInExport(db, rest[1])));
          return 0;
        }
        console.error("usage: foghorn ingest <beeper | x-archive <path.zip|dir> | linkedin <path.zip|dir>>");
        return 1;
      } finally {
        db.close();
      }
    }
    case "profile": {
      const sub = rest[0];
      const db = openAndMigrate();
      try {
        if (sub === "build") {
          const { generateTextResilient } = await import("./llm/generate.ts");
          const { buildProfiles } = await import("./profile/profiler.ts");
          const result = await buildProfiles(
            db,
            (opts) => generateTextResilient(db, opts),
            { force: rest.includes("--force") },
          );
          console.log(JSON.stringify(result));
          return result.built || result.reason ? 0 : 1;
        }
        if (sub === "show") {
          const version = rest[1] ? Number(rest[1]) : undefined;
          const rows = db
            .query<{ version: number; kind: string; json: string; active: number; built_at: string }, []>(
              "SELECT version, kind, json, active, built_at FROM profiles ORDER BY version, kind",
            )
            .all()
            .filter((r) => version === undefined || r.version === version);
          if (rows.length === 0) { console.log("no profiles yet — run: foghorn profile build"); return 0; }
          for (const r of rows) {
            console.log(`\n=== v${r.version} ${r.kind}${r.active ? " [ACTIVE]" : ""} (${r.built_at}) ===`);
            console.log(JSON.stringify(JSON.parse(r.json), null, 2).slice(0, 2000));
          }
          return 0;
        }
        if (sub === "ratify" && rest[1]) {
          const { ratifyProfiles } = await import("./profile/profiler.ts");
          ratifyProfiles(db, Number(rest[1]));
          console.log(`profiles v${rest[1]} ratified as active`);
          return 0;
        }
        console.error("usage: foghorn profile <build [--force] | show [version] | ratify <version>>");
        return 1;
      } finally {
        db.close();
      }
    }
    case "connect": {
      const which = rest[0] ?? "all";
      if (which === "linkedin" && rest[1] === "authorize") {
        const { authorizeLinkedIn } = await import("./connectors/linkedin-oauth.ts");
        try {
          await authorizeLinkedIn();
          return 0;
        } catch (err) {
          console.error(`linkedin authorize failed: ${err instanceof Error ? err.message : String(err)}`);
          return 1;
        }
      }
      const db = openAndMigrate();
      try {
        const { validateBeeper, validateLinkedIn, validateNostr, validateTelegram, validateX } = await import(
          "./connectors/validators.ts"
        );
        const runners: Record<string, () => Promise<import("./connectors/index.ts").ConnectResult>> = {
          beeper: () => validateBeeper(),
          telegram: () => validateTelegram(),
          x: () => validateX(db),
          linkedin: () => validateLinkedIn(),
          nostr: () => validateNostr(),
        };
        const names = which === "all" ? Object.keys(runners) : [which];
        let allOk = true;
        for (const name of names) {
          const runner = runners[name];
          if (!runner) { console.error(`unknown connector '${name}'`); return 1; }
          const result = await runner();
          allOk &&= result.ok;
          console.log(`\n${result.ok ? "OK " : "FAIL"} ${result.connector}`);
          for (const c of result.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
        }
        return allOk ? 0 : 1;
      } finally {
        db.close();
      }
    }
    case "score": {
      const sub = rest[0];
      const db = openAndMigrate();
      try {
        if (sub === "build") {
          const { generateTextResilient } = await import("./llm/generate.ts");
          const { scorePlatforms } = await import("./select/platform-scorer.ts");
          const result = await scorePlatforms(db, (opts) => generateTextResilient(db, opts));
          console.log(JSON.stringify(result, null, 2));
          console.log("\nratify with: foghorn score ratify <platform>");
          return 0;
        }
        if (sub === "show") {
          const rows = db
            .query<{ platform: string; composite: number; ratified: number; evidence_json: string; scored_at: string }, []>(
              "SELECT platform, composite, ratified, evidence_json, scored_at FROM platform_scores ORDER BY scored_at DESC, composite DESC LIMIT 12",
            )
            .all();
          if (rows.length === 0) { console.log("no score runs yet — run: foghorn score build"); return 0; }
          for (const r of rows) {
            const ev = JSON.parse(r.evidence_json) as { rationale?: string };
            console.log(`${r.ratified ? "★" : " "} ${r.platform.padEnd(10)} ${String(r.composite).padStart(3)}  ${ev.rationale ?? ""}`);
          }
          return 0;
        }
        if (sub === "ratify" && rest[1]) {
          const { ratifyPlatform } = await import("./select/platform-scorer.ts");
          ratifyPlatform(db, rest[1]);
          console.log(`platform '${rest[1]}' ratified as primary target`);
          return 0;
        }
        console.error("usage: foghorn score <build | show | ratify <platform>>");
        return 1;
      } finally {
        db.close();
      }
    }
    case "watch": {
      const db = openAndMigrate();
      try {
        const { addCreator, listCreators } = await import("./research/watchlist.ts");
        if (rest[0] === "add" && rest[1] && rest[2]) {
          const id = addCreator(db, rest[1], rest[2], rest[3]);
          console.log(`watching ${rest[2]} on ${rest[1]} (id ${id})`);
          return 0;
        }
        if (rest[0] === "list" || rest[0] === undefined) {
          for (const c of listCreators(db)) {
            const b = JSON.parse(c.baseline_json) as { n?: number; median?: number };
            console.log(`#${c.id} ${c.platform}/@${c.handle} ${c.niche_tag ?? ""} baseline(n=${b.n ?? 0}, median=${b.median ?? 0})`);
          }
          return 0;
        }
        console.error("usage: foghorn watch <add <platform> <handle> [niche] | list>");
        return 1;
      } finally {
        db.close();
      }
    }
    case "scan": {
      const db = openAndMigrate();
      try {
        if (isPaused(db)) { console.log("paused — scanner idle"); return 0; }
        const { ratifiedPlatform } = await import("./select/platform-scorer.ts");
        const platform = rest[0] ?? ratifiedPlatform(db);
        if (!platform) { console.error("no ratified platform — run 'foghorn score ratify <platform>' or pass one"); return 1; }
        const { generateWithWebSearch } = await import("./llm/websearch.ts");
        const { scanTrends, freshTrendCards } = await import("./research/trend-scanner.ts");
        const report = await scanTrends(db, (opts) => generateWithWebSearch(db, opts), platform);
        console.log(JSON.stringify(report));
        for (const card of freshTrendCards(db, platform, 6)) {
          console.log(`  [${card.format}] ${card.title} — ${card.summary}`);
        }
        return 0;
      } finally {
        db.close();
      }
    }
    case "engine": {
      const db = openAndMigrate();
      try {
        if (isPaused(db)) { console.log("paused — engine idle"); return 0; }
        const { ratifiedPlatform } = await import("./select/platform-scorer.ts");
        const platform = rest[0] ?? ratifiedPlatform(db);
        if (!platform) { console.error("no ratified platform — 'foghorn score ratify <platform>' first"); return 1; }
        const { generateTextResilient } = await import("./llm/generate.ts");
        const { runEngine } = await import("./create/engine.ts");
        const report = await runEngine(db, { generate: (o) => generateTextResilient(db, o) }, platform);
        console.log(JSON.stringify(report));
        return 0;
      } finally {
        db.close();
      }
    }
    case "approvals-daemon": {
      const db = openAndMigrate();
      const { expireStaleApprovals } = await import("./approvals/queue.ts");
      const { pollOnce, sendPendingApprovals } = await import("./approvals/telegram.ts");
      const once = rest.includes("--once");
      console.log(`approvals daemon up (chat ${process.env.FOGHORN_TELEGRAM_CHAT_ID ?? "7078451053"})`);
      for (;;) {
        try {
          const expired = expireStaleApprovals(db);
          const sent = await sendPendingApprovals(db);
          const poll = await pollOnce(db, fetch, once ? 0 : 25);
          if (expired || sent || poll.updates) {
            console.log(JSON.stringify({ at: new Date().toISOString(), expired, sent, ...poll }));
          }
        } catch (err) {
          console.error(`daemon cycle error: ${err instanceof Error ? err.message : String(err)}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (once) { db.close(); return 0; }
      }
    }
    case "replies": {
      const db = openAndMigrate();
      try {
        if (isPaused(db)) { console.log("paused — replies idle"); return 0; }
        const { ratifiedPlatform } = await import("./select/platform-scorer.ts");
        const platform = rest[0] ?? ratifiedPlatform(db);
        if (!platform) { console.error("no ratified platform — 'foghorn score ratify <platform>' first"); return 1; }
        const { createMentionSources } = await import("./replies/sources/registry.ts");
        const source = createMentionSources().get(platform);
        if (!source) { console.error(`no mentions source for '${platform}' (missing creds, or not yet implemented)`); return 1; }
        const { generateTextResilient } = await import("./llm/generate.ts");
        const { runReplyEngine } = await import("./replies/reply-engine.ts");
        const report = await runReplyEngine(db, { generate: (o) => generateTextResilient(db, o) }, platform, source);
        console.log(JSON.stringify(report));
        return 0;
      } finally {
        db.close();
      }
    }
    case "holds": {
      const db = openAndMigrate();
      try {
        const rows = db
          .query<{ id: number; draft_id: number | null; specialty: string; packet_json: string; created_at: string }, []>(
            "SELECT id, draft_id, specialty, packet_json, created_at FROM holds WHERE status='open' ORDER BY id",
          )
          .all();
        if (rows.length === 0) { console.log("no open holds"); return 0; }
        for (const h of rows) {
          const packet = JSON.parse(h.packet_json) as { reason?: string };
          console.log(`#${h.id} draft=${h.draft_id} [${h.specialty}] ${h.created_at} — ${packet.reason ?? ""}`);
        }
        return 0;
      } finally {
        db.close();
      }
    }
    case "publish-tick": {
      const db = openAndMigrate();
      const { createAdapters } = await import("./publish/adapters/registry.ts");
      const report = await publishTick(db, createAdapters());
      console.log(JSON.stringify(report));
      db.close();
      return 0;
    }
    case "metrics": {
      const db = openAndMigrate();
      try {
        const { collectXMetrics } = await import("./metrics/collector.ts");
        const missing = ["X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"].filter((k) => !process.env[k]);
        if (missing.length > 0) { console.log(`metrics skipped — missing env: ${missing.join(", ")}`); return 0; }
        const report = await collectXMetrics(db, {
          consumerKey: process.env.X_API_KEY!,
          consumerSecret: process.env.X_API_KEY_SECRET!,
          accessToken: process.env.X_ACCESS_TOKEN!,
          accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET!,
        });
        console.log(JSON.stringify(report));
        return 0;
      } finally {
        db.close();
      }
    }
    case "undo": {
      const id = Number(rest[0]);
      if (!id) { console.error("usage: foghorn undo <published_post_id> [--incident <reason>]"); return 1; }
      const db = openAndMigrate();
      try {
        const post = db
          .query<{ id: number; platform: string; external_post_id: string; draft_id: number; deleted_at: string | null }, [number]>(
            "SELECT id, platform, external_post_id, draft_id, deleted_at FROM published_posts WHERE id = ?",
          )
          .get(id);
        if (!post) { console.error(`no published post ${id}`); return 1; }
        if (post.deleted_at) { console.log("already deleted"); return 0; }
        const { createAdapters } = await import("./publish/adapters/registry.ts");
        const adapter = createAdapters().get(post.platform);
        if (!adapter) { console.error(`no adapter for ${post.platform} (missing creds?)`); return 1; }
        await adapter.delete(post.external_post_id);
        const incidentIdx = rest.indexOf("--incident");
        const reason = incidentIdx !== -1 ? rest.slice(incidentIdx + 1).join(" ") || "undo" : null;
        db.run("UPDATE published_posts SET deleted_at = ?, delete_reason = ? WHERE id = ?", [
          new Date().toISOString(), reason ?? "manual undo", id,
        ]);
        if (reason) {
          const { recordIncident } = await import("./autonomy/ladder.ts");
          recordIncident(db, post.platform, reason);
          console.log(`deleted + incident recorded — ${post.platform} demoted to L1 with cooldown`);
        } else {
          console.log("deleted");
        }
        return 0;
      } finally {
        db.close();
      }
    }
    default: {
      if (verb && PHASE_STUBS[verb]) {
        console.error(`'${verb}' is not built yet (${PHASE_STUBS[verb]})`);
        return 1;
      }
      console.error(
        "usage: foghorn <init|migrate|status|pause|resume|publish-tick|ingest|profile|score|scan|engine|replies|connect|metrics|undo|holds|report|diagnose>",
      );
      return verb ? 1 : 0;
    }
  }
}
