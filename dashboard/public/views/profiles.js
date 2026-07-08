import { ApiClient, runSseProcess, showToast, refreshGlobalStatus } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <!-- Builder controller -->
    <div class="glass" style="margin-bottom:24px;">
      <div class="glass-card-header">
        <h2>Voice Profiler</h2>
        <div style="display:flex; gap:10px;">
          <button id="btn-force-build" class="btn btn-secondary btn-sm">Force Rebuild</button>
          <button id="btn-build-profile" class="btn btn-primary btn-sm">👤 Build New Profile</button>
        </div>
      </div>
      <p class="text-muted" style="font-size:13px; margin-bottom:12px;">
        Extracts your style patterns (voiceprint), topic interests, technical expertise, and persona vectors from Beeper logs.
      </p>
      <div class="log-terminal" id="profile-terminal" style="height:120px;">
        <div class="log-line system">[system] Ready. Click "Build New Profile" to compile new profile.</div>
      </div>
    </div>

    <div class="dash-grid-2x2">
      <!-- Left: Versions List -->
      <div class="glass">
        <div class="glass-card-header">
          <h2>Profile Versions</h2>
        </div>
        <div style="max-height: 400px; overflow-y: auto; display:flex; flex-direction:column; gap:12px;" id="profile-versions-list">
          <div class="text-muted">Loading profile list...</div>
        </div>
      </div>

      <!-- Right: Content Inspector -->
      <div class="glass" style="display:flex; flex-direction:column; height: 100%;">
        <div class="glass-card-header">
          <h2 id="inspect-version-title">Profile Inspector</h2>
          <button class="btn btn-accent btn-sm" id="btn-ratify-inspected" style="display:none;"> Ratify This Version</button>
        </div>
        <div style="flex:1; overflow-y:auto;">
          <pre id="inspect-json-box" style="background:#030712; border:1px solid var(--surface-border); border-radius:var(--radius-sm); padding:16px; font-family:'JetBrains Mono', monospace; font-size:12px; height: 350px; overflow:auto;"></pre>
        </div>
      </div>
    </div>
  `;

  const terminal = document.getElementById("profile-terminal");
  let selectedVersion = null;

  function logLine(text, level = "info") {
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    line.textContent = text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  async function loadProfiles() {
    try {
      const rows = await ApiClient.request("/api/profiles");
      const list = document.getElementById("profile-versions-list");
      list.innerHTML = "";

      // Group rows by version
      const versions = {};
      for (const r of rows) {
        if (!versions[r.version]) {
          versions[r.version] = {
            version: r.version,
            active: r.active,
            built_at: r.built_at,
            kinds: {}
          };
        }
        versions[r.version].kinds[r.kind] = JSON.parse(r.json);
      }

      const vList = Object.values(versions).sort((a, b) => b.version - a.version);

      if (vList.length === 0) {
        list.innerHTML = `<div class="text-muted" style="text-align:center; padding:24px;">No profile versions found. Trigger build above.</div>`;
        return;
      }

      for (const v of vList) {
        const card = document.createElement("div");
        card.className = `kanban-card ${v.active ? 'active' : ''}`;
        if (v.active) {
          card.style.borderColor = "var(--success)";
        }
        card.style.padding = "16px";
        
        const dateStr = new Date(v.built_at).toLocaleString();

        card.innerHTML = `
          <div style="display:flex; justify-content:between; align-items:center;">
            <h3 style="font-size:16px; font-weight:700;">Profile Version ${v.version}</h3>
            ${v.active ? `<span class="score-badge voice" style="background:var(--success-glow); color:var(--success); margin-left:auto;">ACTIVE</span>` : ""}
          </div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:6px;">Built at: ${dateStr}</div>
          <div style="font-size:11px; margin-top:8px; display:flex; gap:6px;">
            ${Object.keys(v.kinds).map(k => `<span style="background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px;">${k}</span>`).join(" ")}
          </div>
        `;

        card.onclick = () => inspectVersion(v);
        list.appendChild(card);

        // Auto select first (newest) on load
        if (!selectedVersion) {
          inspectVersion(v);
        }
      }

    } catch (e) {
      showToast(e.message, "error");
    }
  }

  function inspectVersion(v) {
    selectedVersion = v;
    
    // Highlight selected card
    document.querySelectorAll("#profile-versions-list .kanban-card").forEach(c => c.style.boxShadow = "none");
    
    document.getElementById("inspect-version-title").textContent = `Version ${v.version} Profile JSON`;
    document.getElementById("inspect-json-box").textContent = JSON.stringify(v.kinds, null, 2);

    const ratifyBtn = document.getElementById("btn-ratify-inspected");
    if (v.active) {
      ratifyBtn.style.display = "none";
    } else {
      ratifyBtn.style.display = "inline-block";
      ratifyBtn.onclick = async () => {
        try {
          await ApiClient.request(`/api/profiles/${v.version}/ratify`, "POST");
          showToast(`Ratified profile version ${v.version}`, "success");
          loadProfiles();
          refreshGlobalStatus();
        } catch (e) {
          showToast(e.message, "error");
        }
      };
    }
  }

  // Bind build button
  document.getElementById("btn-build-profile").onclick = () => triggerBuild(false);
  document.getElementById("btn-force-build").onclick = () => triggerBuild(true);

  function triggerBuild(force) {
    terminal.innerHTML = "";
    logLine(`[system] Starting profile build (force=${force})...`, "system");
    document.getElementById("btn-build-profile").disabled = true;

    runSseProcess(
      "/api/profiles/build",
      { force },
      (log) => {
        logLine(log.message, log.level === "error" ? "error" : "info");
      },
      (done) => {
        logLine(`Profile compilation complete! Result: ${JSON.stringify(done.result)}`, "system");
        document.getElementById("btn-build-profile").disabled = false;
        loadProfiles();
      },
      (error) => {
        logLine(`Build failed: ${error}`, "error");
        document.getElementById("btn-build-profile").disabled = false;
        loadProfiles();
      }
    );
  }

  // Initial load
  await loadProfiles();
}
