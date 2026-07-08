import { ApiClient, runSseProcess, showToast } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <div class="dash-grid-2x2">
      
      <!-- Automation 1: Setup Onboarding Wizard -->
      <div class="glass automation-card" id="auto-card-setup">
        <div class="automation-header">
          <span class="automation-header-icon">🏁</span>
          <div>
            <span class="automation-title">Setup Pipeline Wizard</span>
            <div class="automation-desc">Runs first-time onboarding (Connect → Ingest Beeper → Build Profile → Score Platforms → Scan Trends → Extract Facts).</div>
          </div>
        </div>
        <div class="automation-steps-list" id="steps-setup">
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Validate Connectors</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Ingest Beeper Messages</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Build Profiles</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Score Platforms</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Scan Platform Trends</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Extract Evidence Candidates</div>
        </div>
        <button class="btn btn-primary btn-run-auto" data-type="setup">⚡ Execute Setup Wizard</button>
      </div>

      <!-- Automation 2: Content Cycle -->
      <div class="glass automation-card" id="auto-card-content">
        <div class="automation-header">
          <span class="automation-header-icon">🔄</span>
          <div>
            <span class="automation-title">Daily Content Cycle</span>
            <div class="automation-desc">Runs routine automated steps (Ingest Beeper → Scan trends → Extract evidence → Run content engine).</div>
          </div>
        </div>
        <div class="automation-steps-list" id="steps-content">
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Ingest Beeper Messages</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Scan Platform Trends</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Extract Evidence Candidates</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Generate Content Drafts</div>
        </div>
        <button class="btn btn-primary btn-run-auto" data-type="content-cycle">⚡ Execute Content Cycle</button>
      </div>

      <!-- Automation 3: Publish & Measure -->
      <div class="glass automation-card" id="auto-card-publish">
        <div class="automation-header">
          <span class="automation-header-icon">📈</span>
          <div>
            <span class="automation-title">Publish & Measure</span>
            <div class="automation-desc">Posts due approved schedule drafts on network and collects performance impressions metrics.</div>
          </div>
        </div>
        <div class="automation-steps-list" id="steps-publish">
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Publish Due Queue Posts</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Measure Engagement Metrics</div>
        </div>
        <button class="btn btn-primary btn-run-auto" data-type="publish-measure">⚡ Publish & Measure</button>
      </div>

      <!-- Automation 4: Full Pipeline -->
      <div class="glass automation-card" id="auto-card-full">
        <div class="automation-header">
          <span class="automation-header-icon">⛓️</span>
          <div>
            <span class="automation-title">Full End-to-End Pipeline</span>
            <div class="automation-desc">Executes entire content generation cycle and waits for approvals before scheduling due posts.</div>
          </div>
        </div>
        <div class="automation-steps-list" id="steps-full">
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Run Content Cycle</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Wait for Approvals</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Publish Due Queue Posts</div>
          <div class="automation-step-row"><span class="automation-step-status-icon">⚪</span> Measure Engagement Metrics</div>
        </div>
        <button class="btn btn-primary btn-run-auto" data-type="full">⚡ Run Full Pipeline</button>
      </div>

    </div>

    <!-- Real-time progress logs panel -->
    <div class="glass log-panel" style="margin-top:24px; display:none;" id="auto-log-panel">
      <div class="glass-card-header">
        <h2>Pipeline Log Console</h2>
        <span id="active-auto-badge" class="score-badge voice">Setup Wizard</span>
      </div>
      <div class="log-terminal" id="auto-terminal" style="height:250px;">
        <div class="log-line system">[system] Launching automation pipeline...</div>
      </div>
    </div>
  `;

  const terminal = document.getElementById("auto-terminal");
  const logPanel = document.getElementById("auto-log-panel");

  function logLine(text, level = "info") {
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    line.textContent = text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  // Handle run triggers
  document.querySelectorAll(".btn-run-auto").forEach((btn) => {
    btn.onclick = async () => {
      const type = btn.getAttribute("data-type");
      
      // Disable all buttons
      document.querySelectorAll(".btn-run-auto").forEach((b) => b.disabled = true);
      logPanel.style.display = "flex";
      terminal.innerHTML = "";
      
      document.getElementById("active-auto-badge").textContent = btn.parentElement.querySelector(".automation-title").textContent;
      logLine(`[system] Invoking automation pipeline ${type}...`, "system");

      // Reset step visual status lists
      resetStepStatus(type);

      const onLog = (log) => {
        if (log.type === "progress") {
          updateStepsUi(type, log.stepIndex, log.status, log.detail, log.steps);
        } else {
          logLine(log.message, log.level === "error" ? "error" : "info");
        }
      };

      runSseProcess(
        "/api/automations/run",
        { type },
        onLog,
        (done) => {
          logLine(`[system] Pipeline finished successfully: ${done.message || "Done"}`, "system");
          document.querySelectorAll(".btn-run-auto").forEach((b) => b.disabled = false);
        },
        (error) => {
          logLine(`[system] Pipeline failed: ${error}`, "error");
          document.querySelectorAll(".btn-run-auto").forEach((b) => b.disabled = false);
        }
      );
    };
  });

  function resetStepStatus(type) {
    const id = getStepContainerId(type);
    const container = document.getElementById(id);
    if (!container) return;

    container.querySelectorAll(".automation-step-row").forEach((row) => {
      row.className = "automation-step-row";
      row.querySelector(".automation-step-status-icon").textContent = "⚪";
    });
  }

  function updateStepsUi(type, stepIndex, status, detail, steps) {
    const id = getStepContainerId(type);
    const container = document.getElementById(id);
    if (!container) return;

    const rows = container.querySelectorAll(".automation-step-row");
    if (rows[stepIndex]) {
      const row = rows[stepIndex];
      const statusIcon = row.querySelector(".automation-step-status-icon");

      row.className = `automation-step-row ${status}`;
      if (status === "running") {
        statusIcon.textContent = "⏳";
        logLine(`Running step ${stepIndex + 1}: ${steps[stepIndex].name}`, "system");
      } else if (status === "completed") {
        statusIcon.textContent = "✅";
        logLine(`Completed step ${stepIndex + 1}: ${steps[stepIndex].name} - ${detail || "Success"}`);
      } else if (status === "failed") {
        statusIcon.textContent = "❌";
        logLine(`Failed step ${stepIndex + 1}: ${steps[stepIndex].name} - ${detail || "Error"}`, "error");
      } else if (status === "waiting") {
        statusIcon.textContent = "⏸";
        logLine(`Paused step ${stepIndex + 1}: ${steps[stepIndex].name} - ${detail || "Waiting for human"}`);
      }
    }
  }

  function getStepContainerId(type) {
    if (type === "setup") return "steps-setup";
    if (type === "content-cycle") return "steps-content";
    if (type === "publish-measure") return "steps-publish";
    return "steps-full";
  }
}
