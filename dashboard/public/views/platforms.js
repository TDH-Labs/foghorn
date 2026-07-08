import { ApiClient, runSseProcess, showToast, refreshGlobalStatus } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <!-- Top Scorer trigger -->
    <div class="glass" style="margin-bottom:24px;">
      <div class="glass-card-header">
        <h2>Target Platform Selection</h2>
        <button id="btn-score-platforms" class="btn btn-primary btn-sm">🪐 Re-Score Platforms</button>
      </div>
      <p class="text-muted" style="font-size:13px; margin-bottom:12px;">
        Evaluates social platforms based on audience alignment, newcomer momentum, and trust fit according to your active profile.
      </p>
      <div class="log-terminal" id="score-terminal" style="height:120px;">
        <div class="log-line system">[system] Ready. Click "Re-Score Platforms" to run strategist model.</div>
      </div>
    </div>

    <!-- Platform Connectors Validators -->
    <div class="glass" style="margin-bottom:24px;">
      <div class="glass-card-header">
        <h2>Account API Connector Status</h2>
        <button id="btn-refresh-connectors" class="btn btn-secondary btn-sm">Verify Connections</button>
      </div>
      <div class="dash-grid-3col" id="connectors-status-grid" style="margin-top:12px;">
        <div class="text-muted">Verifying connections...</div>
      </div>
      <div style="margin-top: 16px; border-top:1px solid var(--surface-border); padding-top:16px; font-size:13px;" id="linkedin-oauth-block">
        <strong>LinkedIn Setup:</strong> If LinkedIn shows failure, click here to grant permission: 
        <button id="btn-linkedin-auth" class="btn btn-accent btn-sm" style="display:inline-flex; margin-left:8px;">🔗 Launch LinkedIn OAuth Flow</button>
      </div>
    </div>

    <!-- Platform Scores Grid -->
    <div class="glass">
      <div class="glass-card-header">
        <h2>Strategic Platform Scores</h2>
      </div>
      <div style="display:flex; flex-direction:column; gap:16px;" id="platform-scores-list">
        <div class="text-muted">Loading scorers...</div>
      </div>
    </div>
  `;

  const terminal = document.getElementById("score-terminal");

  function logLine(text, level = "info") {
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    line.textContent = text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  async function verifyConnectors() {
    const grid = document.getElementById("connectors-status-grid");
    grid.innerHTML = `<div class="text-muted">Testing platform APIs...</div>`;
    try {
      const status = await ApiClient.request("/api/platforms/connectors");
      grid.innerHTML = "";

      for (const [key, details] of Object.entries(status)) {
        const checkCard = document.createElement("div");
        checkCard.className = "autonomy-node";
        
        let statusBadge = `<span class="score-badge risk">FAIL</span>`;
        if (details.ok) {
          statusBadge = `<span class="score-badge voice" style="background:var(--success-glow); color:var(--success)">CONNECTED</span>`;
        }

        checkCard.innerHTML = `
          <div style="display:flex; justify-content:between; align-items:center; margin-bottom:8px;">
            <strong style="text-transform:uppercase; font-size:14px;">${key}</strong>
            ${statusBadge}
          </div>
          <div style="display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--text-muted);">
            ${details.checks ? details.checks.map(c => `<div>${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}</div>`).join("") : ""}
          </div>
        `;
        grid.appendChild(checkCard);
      }
    } catch (e) {
      grid.innerHTML = `<div class="score-badge risk">Verification crashed: ${e.message}</div>`;
    }
  }

  async function loadScores() {
    try {
      const scores = await ApiClient.request("/api/platforms/scores");
      const list = document.getElementById("platform-scores-list");
      list.innerHTML = "";

      if (scores.length === 0) {
        list.innerHTML = `<div class="text-muted" style="text-align:center; padding:24px;">No score reports found. Score platforms above first.</div>`;
        return;
      }

      // De-duplicate scores list by platform to display the latest run for each platform
      const latestScoresMap = {};
      for (const s of scores) {
        if (!latestScoresMap[s.platform]) {
          latestScoresMap[s.platform] = s;
        }
      }

      const uniqueScores = Object.values(latestScoresMap);

      for (const s of uniqueScores) {
        const card = document.createElement("div");
        card.className = `glass ${s.ratified ? 'active' : ''}`;
        card.style.padding = "20px";
        if (s.ratified) {
          card.style.borderColor = "var(--success)";
          card.style.background = "rgba(16, 185, 129, 0.02)";
        }

        const ev = JSON.parse(s.evidence_json || "{}");
        const composite = s.composite || 0;
        
        card.innerHTML = `
          <div style="display:grid; grid-template-columns: auto 1fr auto; gap:24px; align-items:center;">
            <div>
              <span class="logo-icon" style="font-size:32px;">${getPlatformIcon(s.platform)}</span>
            </div>
            <div>
              <div style="display:flex; align-items:center; gap:8px;">
                <h3 style="text-transform:uppercase; font-size:18px; font-weight:700;">${s.platform}</h3>
                ${s.ratified ? `<span class="score-badge voice" style="background:var(--success-glow); color:var(--success);">★ PRIMARY RATIFIED</span>` : ""}
              </div>
              <p style="font-size:13px; color:var(--text-muted); margin-top:6px; max-width:600px;">
                ${ev.rationale || "Strategy rationale details not configured."}
              </p>
              ${ev.first_90_days ? `<div style="font-size:12px; margin-top:8px;"><strong>First 90 Days:</strong> <span class="text-muted">${ev.first_90_days}</span></div>` : ""}
            </div>
            
            <div style="display:flex; align-items:center; gap:24px;">
              <div class="stat-gauge" style="text-align:right;">
                <span class="stat-label">Composite Score</span>
                <span class="stat-value text-accent" style="font-size:24px;">${composite} / 100</span>
              </div>
              <div>
                ${s.ratified ? "" : `<button class="btn btn-accent btn-sm btn-ratify-plat">Ratify platform</button>`}
              </div>
            </div>
          </div>
        `;

        if (!s.ratified) {
          card.querySelector(".btn-ratify-plat").onclick = async () => {
            try {
              await ApiClient.request(`/api/platforms/${s.platform}/ratify`, "POST");
              showToast(`Ratified ${s.platform} as primary target`, "success");
              loadScores();
              refreshGlobalStatus();
            } catch (e) {
              showToast(e.message, "error");
            }
          };
        }

        list.appendChild(card);
      }

    } catch (e) {
      showToast(e.message, "error");
    }
  }

  function getPlatformIcon(p) {
    if (p === "x") return "❌";
    if (p === "linkedin") return "💼";
    if (p === "nostr") return "🟣";
    return "🌐";
  }

  // Bind scores trigger
  document.getElementById("btn-score-platforms").onclick = () => {
    terminal.innerHTML = "";
    logLine("[system] Running platform scoring strategist...", "system");
    document.getElementById("btn-score-platforms").disabled = true;

    runSseProcess(
      "/api/platforms/score",
      {},
      (log) => {
        logLine(log.message, log.level === "error" ? "error" : "info");
      },
      (done) => {
        logLine(`Platform scoring run completed!`, "system");
        document.getElementById("btn-score-platforms").disabled = false;
        loadScores();
      },
      (error) => {
        logLine(`Scoring failed: ${error}`, "error");
        document.getElementById("btn-score-platforms").disabled = false;
        loadScores();
      }
    );
  };

  // Bind verify connector trigger
  document.getElementById("btn-refresh-connectors").onclick = verifyConnectors;
  
  // LinkedIn OAuth flow via SSE
  const linkedinTerminal = (() => {
    const block = document.getElementById("linkedin-oauth-block");
    // Inject a mini terminal into the block for status output
    const term = document.createElement("div");
    term.className = "log-terminal";
    term.style.cssText = "height:100px; margin-top:10px; display:none;";
    block.appendChild(term);
    return term;
  })();

  function liLog(msg, level = "info") {
    linkedinTerminal.style.display = "block";
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    line.textContent = msg;
    linkedinTerminal.appendChild(line);
    linkedinTerminal.scrollTop = linkedinTerminal.scrollHeight;
  }

  document.getElementById("btn-linkedin-auth").onclick = async () => {
    const btn = document.getElementById("btn-linkedin-auth");
    btn.disabled = true;
    linkedinTerminal.innerHTML = "";
    liLog("[system] Starting LinkedIn OAuth flow...", "system");

    try {
      const evtSource = new EventSource("/api/platforms/linkedin/auth");
      // Note: EventSource only supports GET. For POST SSE we use fetch + ReadableStream
      evtSource.close(); // close immediately, we'll use fetch below

      const resp = await fetch("/api/platforms/linkedin/auth", { method: "POST" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        liLog(`Error: ${err.error}`, "error");
        btn.disabled = false;
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let tabOpened = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (evt.type === "auth_url" && !tabOpened) {
            tabOpened = true;
            liLog(`Opening LinkedIn authorization in new tab...`, "info");
            window.open(evt.url, "_blank");
            liLog(`If the tab didn't open, copy this URL: ${evt.url}`, "info");
          } else if (evt.type === "log") {
            liLog(evt.message, evt.level === "error" ? "error" : "info");
          } else if (evt.type === "done") {
            liLog(`✅ ${evt.message}`, "system");
            showToast("LinkedIn authorized successfully!", "success");
            btn.disabled = false;
            verifyConnectors();
          } else if (evt.type === "error") {
            liLog(`❌ ${evt.message}`, "error");
            showToast(`LinkedIn auth failed: ${evt.message}`, "error");
            btn.disabled = false;
          }
        }
      }
    } catch (e) {
      liLog(`❌ ${e.message}`, "error");
      showToast(e.message, "error");
      btn.disabled = false;
    }
  };

  // Initial load
  await verifyConnectors();
  await loadScores();
}
