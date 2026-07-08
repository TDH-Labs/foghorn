import { ApiClient, runSseProcess, showToast } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <!-- Scanner Controller -->
    <div class="glass" style="margin-bottom:24px;">
      <div class="glass-card-header">
        <h2>AI Trend Scanner</h2>
        <button id="btn-scan-trends" class="btn btn-primary btn-sm">📡 Run Trend Scan</button>
      </div>
      <p class="text-muted" style="font-size:13px; margin-bottom:12px;">
        Scans search feeds for current outperforming hooks/formats on the primary platform.
      </p>
      <div class="log-terminal" id="scan-terminal" style="height:120px;">
        <div class="log-line system">[system] Ready to scan platform trends.</div>
      </div>
    </div>

    <div class="dash-grid-2x2">
      <!-- Left: Watchlist Tracker -->
      <div class="glass">
        <div class="glass-card-header">
          <h2>Creator Watchlist</h2>
        </div>
        
        <!-- Quick Add Form -->
        <div style="display:grid; grid-template-columns: 1fr 1fr auto; gap:10px; margin-bottom:20px; align-items:end;">
          <div>
            <label class="stat-label">Platform</label>
            <select id="watch-platform" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
              <option value="linkedin">LinkedIn</option>
              <option value="x">X / Twitter</option>
              <option value="nostr">Nostr</option>
            </select>
          </div>
          <div>
            <label class="stat-label">Handle</label>
            <input type="text" id="watch-handle" placeholder="e.g. gtan" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
          </div>
          <button id="btn-add-watch" class="btn btn-secondary" style="height:40px;">Add</button>
        </div>

        <!-- Watchlist table -->
        <div style="max-height: 350px; overflow-y: auto;">
          <table class="grid-table" id="watchlist-table" style="font-size:14px;">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Handle</th>
                <th>Baseline</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="3" class="text-muted">Loading watched handles...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Right: Trend Cards -->
      <div class="glass">
        <div class="glass-card-header">
          <h2>Factual Trend Cards</h2>
          <span class="column-count" id="cnt-trends">0</span>
        </div>
        <p class="text-muted" style="font-size:13px; margin-bottom:12px;">Active hooks/templates detected on the ratified network.</p>
        <div id="trends-container" style="max-height: 420px; overflow-y: auto; display:flex; flex-direction:column; gap:12px;">
          <div class="text-muted">Loading trends...</div>
        </div>
      </div>

    </div>
  `;

  const terminal = document.getElementById("scan-terminal");

  function logLine(text, level = "info") {
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    line.textContent = text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  async function loadWatchlist() {
    try {
      const list = await ApiClient.request("/api/watchlist");
      const tbody = document.querySelector("#watchlist-table tbody");
      tbody.innerHTML = "";

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-muted" style="text-align:center;">Watchlist is empty. Add a handle above!</td></tr>`;
      } else {
        for (const c of list) {
          const baseline = JSON.parse(c.baseline_json || "{}");
          const baselineText = baseline.n ? `n=${baseline.n}, median=${baseline.median}` : "Calculating baseline...";
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td><span class="score-badge voice">${c.platform.toUpperCase()}</span></td>
            <td><strong>@${c.handle}</strong> ${c.niche_tag ? `<span class="text-muted">(${c.niche_tag})</span>` : ""}</td>
            <td style="font-family:'JetBrains Mono', monospace; font-size:12px;">${baselineText}</td>
          `;
          tbody.appendChild(tr);
        }
      }
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function loadTrends() {
    try {
      const trends = await ApiClient.request("/api/trends");
      const container = document.getElementById("trends-container");
      document.getElementById("cnt-trends").textContent = trends.length;
      container.innerHTML = "";

      if (trends.length === 0) {
        container.innerHTML = `<div class="text-muted" style="text-align:center; padding:24px;">No fresh trend cards found. Run a Trend Scan.</div>`;
        return;
      }

      for (const t of trends) {
        const card = document.createElement("div");
        card.className = "kanban-card";
        card.style.cursor = "default";

        let statusClass = "voice";
        if (t.status === "used") statusClass = "risk";
        if (t.status === "expired") statusClass = "expired";

        card.innerHTML = `
          <div style="display:flex; justify-content:between; align-items:center; margin-bottom:8px;">
            <span class="card-tag" style="margin-bottom:0;">${t.format}</span>
            <span class="score-badge ${statusClass}" style="margin-left:auto; text-transform:uppercase;">${t.status}</span>
          </div>
          <h4 style="font-size:14px; font-weight:600; margin-bottom:4px;">${t.title}</h4>
          <p style="font-size:12px; color:var(--text-muted); line-height:1.4;">${t.summary}</p>
        `;
        container.appendChild(card);
      }
    } catch (e) {
      showToast(e.message, "error");
    }
  }

  // Bind triggers
  document.getElementById("btn-add-watch").onclick = async () => {
    const platInput = document.getElementById("watch-platform");
    const handleInput = document.getElementById("watch-handle");
    const platform = platInput.value;
    const handle = handleInput.value.trim();

    if (!handle) {
      showToast("Handle is required", "error");
      return;
    }

    try {
      await ApiClient.request("/api/watchlist", "POST", { platform, handle });
      showToast(`Added @${handle} to watchlist`, "success");
      handleInput.value = "";
      loadWatchlist();
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  document.getElementById("btn-scan-trends").onclick = () => {
    terminal.innerHTML = "";
    logLine("[system] Starting trend scanner...", "system");
    document.getElementById("btn-scan-trends").disabled = true;

    runSseProcess(
      "/api/scan",
      {},
      (log) => {
        logLine(log.message, log.level === "error" ? "error" : "info");
      },
      (done) => {
        logLine(`Trend scan completed: ${JSON.stringify(done.result)}`, "system");
        document.getElementById("btn-scan-trends").disabled = false;
        loadTrends();
      },
      (error) => {
        logLine(`Trend scan failed: ${error}`, "error");
        document.getElementById("btn-scan-trends").disabled = false;
        loadTrends();
      }
    );
  };

  // Initial load
  await loadWatchlist();
  await loadTrends();
}
