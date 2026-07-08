import { ApiClient, runSseProcess, showToast } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <div class="dash-grid-2x2">
      
      <!-- Content Generation Controller -->
      <div class="glass log-panel">
        <div class="glass-card-header">
          <h2>Engine Control Room</h2>
          <div style="display:flex; gap:10px;">
            <button id="btn-run-engine" class="btn btn-primary btn-sm">🚀 Run Engine</button>
            <button id="btn-clear-logs" class="btn btn-secondary btn-sm">Clear Terminal</button>
          </div>
        </div>
        <p class="text-muted" style="margin-bottom:12px;">Runs the ideation, drafting, and full gate check loop. Results stream below.</p>
        <div class="log-terminal" id="engine-terminal">
          <div class="log-line system">[system] Ready. Click "Run Engine" to begin.</div>
        </div>
      </div>

      <!-- Active Holds / Escalations -->
      <div class="glass">
        <div class="glass-card-header">
          <h2>Active Holds (Escalations)</h2>
        </div>
        <p class="text-muted" style="margin-bottom:16px;">
          Drafts blocked by high-severity deterministic or LLM findings are held here.
        </p>
        <div style="max-height: 320px; overflow-y: auto;">
          <table class="grid-table" id="holds-table">
            <thead>
              <tr>
                <th>Hold ID</th>
                <th>Draft</th>
                <th>Escalated For</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="4" class="text-muted">Loading open holds...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>

    <!-- Hold Details Modal -->
    <div id="modal-hold-detail" class="modal" style="display:none;">
      <div class="modal-content glass" style="max-width:700px;">
        <div class="modal-header">
          <h2>Hold details</h2>
          <button class="btn-close" id="btn-close-hold">&times;</button>
        </div>
        <div class="modal-body">
          <label class="stat-label">Hold Reason</label>
          <div class="question-block" id="hold-modal-reason" style="background:rgba(239, 68, 68, 0.05); border-color:rgba(239, 68, 68, 0.2);">...</div>
          
          <label class="stat-label">Finding Details</label>
          <pre id="hold-modal-json" style="background:#030712; border:1px solid var(--surface-border); border-radius:var(--radius-sm); padding:16px; font-family:'JetBrains Mono', monospace; font-size:12px; max-height:250px; overflow:auto;"></pre>
        </div>
        <div class="modal-footer" style="display:flex; justify-content:space-between; width:100%; box-sizing:border-box;">
          <div style="display:flex; gap:10px;">
            <button class="btn btn-primary" id="btn-hold-approve">✅ Force Approve</button>
            <button class="btn btn-danger" id="btn-hold-reject">❌ Reject Draft</button>
          </div>
          <button class="btn btn-secondary" id="btn-hide-hold">Close</button>
        </div>
      </div>
    </div>
  `;

  const terminal = document.getElementById("engine-terminal");

  function logLine(text, level = "info") {
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  // Load holds list
  async function loadHolds() {
    try {
      const holds = await ApiClient.request("/api/holds");
      const hBody = document.querySelector("#holds-table tbody");
      hBody.innerHTML = "";

      if (holds.length === 0) {
        hBody.innerHTML = `<tr><td colspan="4" class="text-muted" style="text-align:center;">No active escalations. Everything passing gates.</td></tr>`;
      } else {
        for (const h of holds) {
          const packet = JSON.parse(h.packet_json || "{}");
          const tr = document.createElement("tr");
          tr.style.cursor = "pointer";
          tr.innerHTML = `
            <td style="font-family:'JetBrains Mono', monospace;">#${h.id}</td>
            <td style="font-family:'JetBrains Mono', monospace;">#${h.draft_id}</td>
            <td><span class="score-badge risk">${h.specialty.toUpperCase()}</span></td>
            <td>${packet.reason || "High risk / claims mismatch"}</td>
          `;
          tr.addEventListener("click", () => showHoldDetails(h, packet));
          hBody.appendChild(tr);
        }
      }
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  let activeHoldId = null;

  function showHoldDetails(h, packet) {
    activeHoldId = h.id;
    const modal = document.getElementById("modal-hold-detail");
    document.getElementById("hold-modal-reason").textContent = packet.reason || "Draft Escalation";
    document.getElementById("hold-modal-json").textContent = JSON.stringify(packet.findings || packet, null, 2);
    modal.style.display = "flex";
  }

  document.getElementById("btn-hold-approve").onclick = async () => {
    if (!activeHoldId) return;
    try {
      const res = await ApiClient.request(`/api/holds/${activeHoldId}/decide`, "POST", { decision: "approved" });
      showToast(res.detail || "Hold manually approved!", "success");
      document.getElementById("modal-hold-detail").style.display = "none";
      await loadHolds();
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  document.getElementById("btn-hold-reject").onclick = async () => {
    if (!activeHoldId) return;
    try {
      const res = await ApiClient.request(`/api/holds/${activeHoldId}/decide`, "POST", { decision: "rejected" });
      showToast(res.detail || "Draft rejected, hold closed.", "info");
      document.getElementById("modal-hold-detail").style.display = "none";
      await loadHolds();
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  // Trigger Content Engine run
  document.getElementById("btn-run-engine").onclick = () => {
    terminal.innerHTML = "";
    logLine("Starting content engine run...", "system");
    document.getElementById("btn-run-engine").disabled = true;

    runSseProcess(
      "/api/engine",
      {},
      (log) => {
        logLine(log.message, log.level === "error" ? "error" : "info");
      },
      (done) => {
        logLine(`Content engine completed successfully! ${JSON.stringify(done.result)}`, "system");
        document.getElementById("btn-run-engine").disabled = false;
        loadHolds(); // refresh holds
      },
      (error) => {
        logLine(`Engine run failed: ${error}`, "error");
        document.getElementById("btn-run-engine").disabled = false;
        loadHolds();
      }
    );
  };

  // Bind close buttons
  document.getElementById("btn-close-hold").onclick = () => {
    document.getElementById("modal-hold-detail").style.display = "none";
  };
  document.getElementById("btn-hide-hold").onclick = () => {
    document.getElementById("modal-hold-detail").style.display = "none";
  };
  document.getElementById("btn-clear-logs").onclick = () => {
    terminal.innerHTML = `<div class="log-line system">[system] Log cleared. Ready.</div>`;
  };

  // Initial load
  await loadHolds();
}
