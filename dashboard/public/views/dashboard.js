import { ApiClient } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <!-- Top KPI Dashboard row -->
    <div class="dash-grid-3col">
      <div class="glass stat-summary-box">
        <div class="stat-summary-icon">🧱</div>
        <div class="stat-summary-text">
          <h3 id="dash-cnt-drafts">—</h3>
          <p>Total Generated Drafts</p>
        </div>
      </div>
      <div class="glass stat-summary-box">
        <div class="stat-summary-icon">🕒</div>
        <div class="stat-summary-text">
          <h3 id="dash-cnt-sched">—</h3>
          <p>Posts Scheduled Today</p>
        </div>
      </div>
      <div class="glass stat-summary-box">
        <div class="stat-summary-icon">📢</div>
        <div class="stat-summary-text">
          <h3 id="dash-cnt-pub">—</h3>
          <p>Total Published Posts</p>
        </div>
      </div>
    </div>

    <!-- Main columns -->
    <div class="dash-grid-2x2">
      <!-- Left Column: Automation Quick Actions -->
      <div class="glass">
        <div class="glass-card-header">
          <h2>Daily Operations Control</h2>
        </div>
        <p class="text-muted" style="margin-bottom: 20px;">
          Foghorn operates using structured logical automations. Trigger a cycle or jump to a specific view to tweak parameters.
        </p>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <a href="#automations" class="btn btn-primary">⚡ Trigger Daily Content Cycle</a>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <a href="#approvals" class="btn btn-secondary">🤝 Review Approvals</a>
            <a href="#pipeline" class="btn btn-secondary">🧱 Kanban Board</a>
          </div>
          <button id="btn-quick-ingest" class="btn btn-secondary">📥 Quick Ingest Beeper Messages</button>
        </div>
      </div>

      <!-- Right Column: System Parameters -->
      <div class="glass">
        <div class="glass-card-header">
          <h2>System Parameters</h2>
        </div>
        <table class="grid-table" style="font-size: 14px;">
          <tr>
            <td><strong>Max Autonomy Level</strong></td>
            <td id="param-autonomy">—</td>
          </tr>
          <tr>
            <td><strong>Quiet Hours</strong></td>
            <td id="param-quiet">—</td>
          </tr>
          <tr>
            <td><strong>Voice Match Threshold</strong></td>
            <td id="param-voice">—</td>
          </tr>
          <tr>
            <td><strong>Beeper Ingest Token</strong></td>
            <td id="param-beeper">Configured</td>
          </tr>
        </table>
      </div>
    </div>

    <!-- Audit Journal / Activity feed -->
    <div class="glass">
      <div class="glass-card-header">
        <h2>Audit Journal (Recent Activity)</h2>
      </div>
      <div style="overflow-x: auto;">
        <table class="grid-table" id="journal-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Scope</th>
              <th>Reference ID</th>
              <th>Action Details</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="4" class="text-muted">Loading audit entries...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Fetch counts, params, and journal
  try {
    const status = await ApiClient.request("/api/status");
    document.getElementById("dash-cnt-drafts").textContent = status.counts.drafts;
    document.getElementById("dash-cnt-sched").textContent = status.counts.schedule_pending;
    document.getElementById("dash-cnt-pub").textContent = status.counts.published;

    const settings = await ApiClient.request("/api/settings");
    document.getElementById("param-autonomy").textContent = `L${settings.max_autonomy_level || 1}`;
    document.getElementById("param-quiet").textContent = settings.quiet_hours || "23:00-07:00";
    document.getElementById("param-voice").textContent = `${settings.voice_threshold || 70}%`;

    // Fetch journal
    const journal = await ApiClient.request("/api/journal?limit=8");
    const jBody = document.querySelector("#journal-table tbody");
    jBody.innerHTML = "";
    
    if (journal.length === 0) {
      jBody.innerHTML = `<tr><td colspan="4" class="text-muted" style="text-align:center;">No recent logs in journal</td></tr>`;
    } else {
      for (const row of journal) {
        const entry = JSON.parse(row.entry_json || "{}");
        const actionStr = entry.action || Object.keys(entry)[0] || "Logged event";
        const detailStr = Object.entries(entry)
          .filter(([k]) => k !== "action")
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
          .join(", ");
        
        const dateStr = new Date(row.created_at || Date.now()).toLocaleTimeString();

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td style="white-space:nowrap; font-family:'JetBrains Mono', monospace; font-size:12px;">${dateStr}</td>
          <td><span class="score-badge voice">${row.scope.toUpperCase()}</span></td>
          <td style="font-family:'JetBrains Mono', monospace;">#${row.ref_id}</td>
          <td><strong>${actionStr}</strong> ${detailStr ? `<span class="text-muted">(${detailStr})</span>` : ""}</td>
        `;
        jBody.appendChild(tr);
      }
    }

    // Ingest button event
    document.getElementById("btn-quick-ingest").addEventListener("click", async (e) => {
      e.target.disabled = true;
      const originalText = e.target.textContent;
      e.target.textContent = "📥 Ingesting...";
      try {
        const report = await ApiClient.request("/api/ingest/beeper", "POST");
        alert(`Beeper Ingest Completed!\nPulled: ${report.pulled}\nStored: ${report.stored}\nRedacted: ${report.redacted}`);
      } catch (err) {
        alert(`Ingest Failed: ${err.message}`);
      } finally {
        e.target.disabled = false;
        e.target.textContent = originalText;
        render(container); // reload
      }
    });

  } catch (err) {
    console.error("Dashboard render failed:", err);
  }
}
