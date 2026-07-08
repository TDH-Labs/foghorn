import type { Database } from "bun:sqlite";
import { validateBeeper, validateLinkedIn, validateNostr, validateTelegram, validateX } from "../src/connectors/validators.ts";
import { BeeperSource } from "../src/ingest/beeper.ts";
import { ensureSource, getCursor, setCursor, storeMessages } from "../src/ingest/store.ts";
import { buildProfiles } from "../src/profile/profiler.ts";
import { scorePlatforms } from "../src/select/platform-scorer.ts";
import { scanTrends } from "../src/research/trend-scanner.ts";
import { extractEvidenceCandidates } from "../src/create/evidence-extract.ts";
import { runEngine } from "../src/create/engine.ts";
import { publishTick } from "../src/publish/publisher.ts";
import { createAdapters } from "../src/publish/adapters/registry.ts";
import { collectXMetrics } from "../src/metrics/collector.ts";
import { generateTextResilient } from "../src/llm/generate.ts";
import { generateWithWebSearch } from "../src/llm/websearch.ts";
import { isPaused } from "../src/killswitch.ts";

export interface AutomationStep {
  name: string;
  status: "idle" | "running" | "completed" | "failed" | "waiting";
  detail?: string;
}

export type ProgressCallback = (stepIndex: number, status: AutomationStep["status"], detail?: string) => void;

export class AutomationRunner {
  private db: Database;
  private currentStepIndex = -1;
  private steps: AutomationStep[] = [];
  private onProgress: ProgressCallback;
  private isCancelled = false;

  constructor(db: Database, onProgress: ProgressCallback) {
    this.db = db;
    this.onProgress = onProgress;
  }

  cancel() {
    this.isCancelled = true;
    console.log("[automation] Cancel requested");
  }

  private checkKillSwitch() {
    if (isPaused(this.db)) {
      throw new Error("Pipeline is paused (kill switch is active)");
    }
    if (this.isCancelled) {
      throw new Error("Automation execution cancelled by user");
    }
  }

  getSteps(): AutomationStep[] {
    return this.steps;
  }

  getCurrentStepIndex(): number {
    return this.currentStepIndex;
  }

  async runSetupPipeline(options: { forceProfileBuild?: boolean } = {}) {
    this.steps = [
      { name: "Validate Connectors", status: "idle" },
      { name: "Ingest Beeper Messages", status: "idle" },
      { name: "Build Profiles", status: "idle" },
      { name: "Score Platforms", status: "idle" },
      { name: "Scan Platform Trends", status: "idle" },
      { name: "Extract Evidence Candidates", status: "idle" },
    ];

    try {
      // Step 1: Validate Connectors
      this.currentStepIndex = 0;
      this.onProgress(0, "running", "Checking platform connector configurations...");
      this.checkKillSwitch();

      const results: string[] = [];
      const beeperVal = await validateBeeper().catch((e) => ({ ok: false, connector: "beeper", checks: [] }));
      const tgVal = await validateTelegram().catch((e) => ({ ok: false, connector: "telegram", checks: [] }));
      const xVal = await validateX(this.db).catch((e) => ({ ok: false, connector: "x", checks: [] }));
      const liVal = await validateLinkedIn().catch((e) => ({ ok: false, connector: "linkedin", checks: [] }));
      const noVal = await validateNostr().catch((e) => ({ ok: false, connector: "nostr", checks: [] }));

      results.push(`Beeper: ${beeperVal.ok ? "OK" : "FAIL"}`);
      results.push(`Telegram: ${tgVal.ok ? "OK" : "FAIL"}`);
      results.push(`X: ${xVal.ok ? "OK" : "FAIL"}`);
      results.push(`LinkedIn: ${liVal.ok ? "OK" : "FAIL"}`);
      results.push(`Nostr: ${noVal.ok ? "OK" : "FAIL"}`);

      this.onProgress(0, "completed", results.join(", "));

      // Step 2: Ingest Beeper
      this.currentStepIndex = 1;
      this.onProgress(1, "running", "Pulling group messages from Beeper local API...");
      this.checkKillSwitch();

      const sourceId = ensureSource(this.db, "beeper", JSON.stringify({ chatType: "group" }));
      const source = new BeeperSource();
      const result = await source.pull(getCursor(this.db, sourceId));
      const report = storeMessages(this.db, sourceId, result.messages);
      if (result.cursor) setCursor(this.db, sourceId, result.cursor);
      
      this.onProgress(1, "completed", `Ingested ${result.messages.length} messages (${report.stored} stored, ${report.redacted} redacted)`);

      // Step 3: Build Profiles
      this.currentStepIndex = 2;
      this.onProgress(2, "running", "Building profiles from corpus documents...");
      this.checkKillSwitch();

      const profRes = await buildProfiles(
        this.db,
        (opts) => generateTextResilient(this.db, opts),
        { force: !!options.forceProfileBuild }
      );
      this.onProgress(2, "completed", profRes.built ? `Built profiles version ${profRes.version}` : `Skipped: ${profRes.reason}`);

      // Step 4: Score Platforms
      this.currentStepIndex = 3;
      this.onProgress(3, "running", "Scoring potential social platforms...");
      this.checkKillSwitch();

      const scoreRes = await scorePlatforms(this.db, (opts) => generateTextResilient(this.db, opts));
      const best = scoreRes.scores.length > 0 ? scoreRes.scores[0] : null;
      this.onProgress(3, "completed", best ? `Top platform: ${best.platform} (score: ${best.composite})` : "No scores generated");

      // Step 5: Scan Platform Trends
      this.currentStepIndex = 4;
      this.onProgress(4, "running", "Scanning web for recent content trends...");
      this.checkKillSwitch();

      // Find ratified platform or fallback to top scored
      let platform = this.db.query<{ platform: string }, []>("SELECT platform FROM platform_scores WHERE ratified = 1 LIMIT 1").get()?.platform;
      if (!platform) {
        platform = best?.platform;
      }
      if (!platform) {
        throw new Error("No platform selected/ratified for trend scanning");
      }

      const scanRes = await scanTrends(this.db, (opts) => generateWithWebSearch(this.db, opts), platform);
      this.onProgress(4, "completed", `Scanned ${platform}. Found ${scanRes.extracted} trends (${scanRes.saved} saved)`);

      // Step 6: Extract Evidence
      this.currentStepIndex = 5;
      this.onProgress(5, "running", "Extracting evidence bank candidate facts...");
      this.checkKillSwitch();

      const extRes = await extractEvidenceCandidates(this.db, (opts) => generateTextResilient(this.db, opts));
      this.onProgress(5, "completed", `Found ${extRes.found} candidates (${extRes.saved} new proposed facts)`);

    } catch (err) {
      console.error("[automation] Setup Pipeline failed:", err);
      this.onProgress(this.currentStepIndex, "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async runContentCycle(platformOverride?: string) {
    this.steps = [
      { name: "Ingest Beeper Messages", status: "idle" },
      { name: "Scan Platform Trends", status: "idle" },
      { name: "Extract Evidence Candidates", status: "idle" },
      { name: "Generate Content Drafts", status: "idle" },
    ];

    try {
      let platform = platformOverride || this.db.query<{ platform: string }, []>("SELECT platform FROM platform_scores WHERE ratified = 1 LIMIT 1").get()?.platform;
      if (!platform) {
        throw new Error("No platform has been ratified yet. Run platform scoring and ratify a target first.");
      }

      // Step 1: Ingest Beeper
      this.currentStepIndex = 0;
      this.onProgress(0, "running", "Pulling group messages from Beeper local API...");
      this.checkKillSwitch();

      const sourceId = ensureSource(this.db, "beeper", JSON.stringify({ chatType: "group" }));
      const source = new BeeperSource();
      const result = await source.pull(getCursor(this.db, sourceId));
      const report = storeMessages(this.db, sourceId, result.messages);
      if (result.cursor) setCursor(this.db, sourceId, result.cursor);
      
      this.onProgress(0, "completed", `Ingested ${result.messages.length} messages (${report.stored} stored, ${report.redacted} redacted)`);

      // Step 2: Scan Platform Trends
      this.currentStepIndex = 1;
      this.onProgress(1, "running", `Scanning web for recent content trends on ${platform}...`);
      this.checkKillSwitch();

      const scanRes = await scanTrends(this.db, (opts) => generateWithWebSearch(this.db, opts), platform);
      this.onProgress(1, "completed", `Found ${scanRes.extracted} trends (${scanRes.saved} saved)`);

      // Step 3: Extract Evidence
      this.currentStepIndex = 2;
      this.onProgress(2, "running", "Extracting new evidence facts from conversation logs...");
      this.checkKillSwitch();

      const extRes = await extractEvidenceCandidates(this.db, (opts) => generateTextResilient(this.db, opts));
      this.onProgress(2, "completed", `Found ${extRes.found} candidates (${extRes.saved} proposed)`);

      // Step 4: Run Content Engine
      this.currentStepIndex = 3;
      this.onProgress(3, "running", `Drafting and gating content for ${platform}...`);
      this.checkKillSwitch();

      const engineRes = await runEngine(this.db, { generate: (o) => generateTextResilient(this.db, o) }, platform);
      this.onProgress(3, "completed", `Drafted ${engineRes.ideas} ideas. Awaiting approval: ${engineRes.awaitingApproval}, Holds/Escalated: ${engineRes.escalated}`);

    } catch (err) {
      console.error("[automation] Content Cycle failed:", err);
      this.onProgress(this.currentStepIndex, "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async runPublishAndMeasure() {
    this.steps = [
      { name: "Publish Due Queue Posts", status: "idle" },
      { name: "Measure Engagement Metrics", status: "idle" },
    ];

    try {
      // Step 1: Publish Due Queue
      this.currentStepIndex = 0;
      this.onProgress(0, "running", "Running publication preflights and posting due drafts...");
      this.checkKillSwitch();

      const adapters = createAdapters();
      const pubReport = await publishTick(this.db, adapters);
      
      this.onProgress(0, "completed", `Scan: ${pubReport.fired} posts processed. Sent: ${pubReport.sent}, Failed: ${pubReport.failed}, Held: ${pubReport.held}`);

      // Step 2: Measure Engagement Metrics
      this.currentStepIndex = 1;
      this.onProgress(1, "running", "Collecting engagement performance snapshot...");
      this.checkKillSwitch();

      const missing = ["X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"].filter((k) => !process.env[k]);
      if (missing.length > 0) {
        this.onProgress(1, "completed", `Skipped metrics (missing credentials: ${missing.join(", ")})`);
      } else {
        const metricsReport = await collectXMetrics(this.db, {
          consumerKey: process.env.X_API_KEY!,
          consumerSecret: process.env.X_API_KEY_SECRET!,
          accessToken: process.env.X_ACCESS_TOKEN!,
          accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET!,
        });
        this.onProgress(1, "completed", `Collected metrics for ${metricsReport.updated} posts.`);
      }

    } catch (err) {
      console.error("[automation] Publish & Measure failed:", err);
      this.onProgress(this.currentStepIndex, "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async runFullPipeline(platformOverride?: string) {
    this.steps = [
      { name: "Run Content Cycle", status: "idle" },
      { name: "Wait for Approvals", status: "idle" },
      { name: "Publish Due Queue Posts", status: "idle" },
      { name: "Measure Engagement Metrics", status: "idle" },
    ];

    try {
      let platform = platformOverride || this.db.query<{ platform: string }, []>("SELECT platform FROM platform_scores WHERE ratified = 1 LIMIT 1").get()?.platform;
      if (!platform) {
        throw new Error("No platform ratified yet.");
      }

      // Step 1: Run Content Cycle
      this.currentStepIndex = 0;
      this.onProgress(0, "running", "Executing Content Cycle (Ingest → Scan → Extract → Engine)...");
      this.checkKillSwitch();

      const sourceId = ensureSource(this.db, "beeper", JSON.stringify({ chatType: "group" }));
      const source = new BeeperSource();
      const result = await source.pull(getCursor(this.db, sourceId));
      const report = storeMessages(this.db, sourceId, result.messages);
      if (result.cursor) setCursor(this.db, sourceId, result.cursor);
      
      const scanRes = await scanTrends(this.db, (opts) => generateWithWebSearch(this.db, opts), platform);
      const extRes = await extractEvidenceCandidates(this.db, (opts) => generateTextResilient(this.db, opts));
      const engineRes = await runEngine(this.db, { generate: (o) => generateTextResilient(this.db, o) }, platform);
      
      this.onProgress(0, "completed", `Drafted: ${engineRes.ideas}. Approved queue: ${engineRes.awaitingApproval}, Holds: ${engineRes.escalated}`);

      // Step 2: Wait for Approvals
      this.currentStepIndex = 1;
      this.onProgress(1, "waiting", "Pipeline waiting for human approvals. Approve items in Approvals view.");

    } catch (err) {
      console.error("[automation] Full Pipeline failed:", err);
      this.onProgress(this.currentStepIndex, "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
