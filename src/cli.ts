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
  connect: "Phase 3",
  score: "Phase 3",
  scan: "Phase 4",
  engine: "Phase 5",
  metrics: "Phase 6",
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
    case "publish-tick": {
      const db = openAndMigrate();
      // Adapters are registered in Phase 6; an empty map means every due row
      // is held with a reason rather than silently dropped.
      const report = await publishTick(db, new Map());
      console.log(JSON.stringify(report));
      db.close();
      return 0;
    }
    default: {
      if (verb && PHASE_STUBS[verb]) {
        console.error(`'${verb}' is not built yet (${PHASE_STUBS[verb]})`);
        return 1;
      }
      console.error(
        "usage: foghorn <init|migrate|status|pause|resume|publish-tick|ingest|profile|score|scan|engine|connect|metrics|report|diagnose>",
      );
      return verb ? 1 : 0;
    }
  }
}
