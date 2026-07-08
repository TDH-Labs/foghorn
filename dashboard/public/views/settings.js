import { ApiClient, showToast, refreshGlobalStatus } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <div class="dash-grid-2x2">
      <!-- General Settings & Spend Caps -->
      <div style="display:flex; flex-direction:column; gap:24px;">
        
        <!-- General System Config -->
        <div class="glass">
          <div class="glass-card-header">
            <h2>General Parameters</h2>
          </div>
          <div style="display:flex; flex-direction:column; gap:16px;">
            <div>
              <label class="stat-label">Max Autonomy Level Allowed</label>
              <select id="set-max-autonomy" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
                <option value="0">L0 - Shadow Mode (No publish)</option>
                <option value="1">L1 - Approval Mode (Human check each)</option>
                <option value="2">L2 - Low-Risk Auto (Auto publish risk < 40 + undo)</option>
                <option value="3">L3 - Fully Autonomous (Full send + digest)</option>
              </select>
            </div>
            
            <div>
              <label class="stat-label">Voice Match Threshold (%)</label>
              <input type="number" id="set-voice-threshold" min="0" max="100" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
            </div>

            <div>
              <label class="stat-label">Quiet Hours (Blocked sends)</label>
              <input type="text" id="set-quiet-hours" placeholder="e.g. 23:00-07:00" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
            </div>

            <div>
              <label class="stat-label">Max Autonomously Answered Replies Per Hour</label>
              <input type="number" id="set-max-replies" min="0" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
            </div>

            <button id="btn-save-settings" class="btn btn-primary">💾 Save System Settings</button>
          </div>
        </div>

        <!-- Spend Caps Manager -->
        <div class="glass">
          <div class="glass-card-header">
            <h2>Spend Caps Editor</h2>
          </div>
          <div style="display:flex; flex-direction:column; gap:16px;">
            <p class="text-muted" style="font-size:12px;">Preflight checks verify these caps before LLM queries or postings. 100% hits block sending.</p>
            
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
              <div>
                <label class="stat-label">LLM Monthly Cap ($)</label>
                <input type="number" id="cap-llm" step="0.01" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
              </div>
              <div>
                <label class="stat-label">Platform (X API) Cap ($)</label>
                <input type="number" id="cap-platform" step="0.01" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
              </div>
            </div>
            <button id="btn-save-caps" class="btn btn-secondary">💾 Update Spending Caps</button>
          </div>
        </div>

      </div>

      <!-- Right: Autonomy State Streaks -->
      <div class="glass" style="display:flex; flex-direction:column;">
        <div class="glass-card-header">
          <h2>Autonomy Ladder Status</h2>
        </div>
        <p class="text-muted" style="font-size:12px; margin-bottom:12px;">
          Approved clean posts increase the clean streak. When promotion threshold is met, click Promote to raise levels. Rejections demote immediately.
        </p>
        <div style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:12px;" id="autonomy-ladder-list">
          <div class="text-muted">Loading autonomy status...</div>
        </div>
      </div>
    </div>
  `;

  async function loadConfig() {
    try {
      const settings = await ApiClient.request("/api/settings");
      
      document.getElementById("set-max-autonomy").value = settings.max_autonomy_level || "1";
      document.getElementById("set-voice-threshold").value = settings.voice_threshold || "70";
      document.getElementById("set-quiet-hours").value = settings.quiet_hours || "23:00-07:00";
      document.getElementById("set-max-replies").value = settings.max_replies_per_hour || "10";

      // Spend caps
      const spend = await ApiClient.request("/api/spend");
      document.getElementById("cap-llm").value = spend.llm.capUsd;
      document.getElementById("cap-platform").value = spend.x.capUsd;

    } catch (e) {
      showToast(e.message, "error");
    }
  }

  async function loadAutonomy() {
    const list = document.getElementById("autonomy-ladder-list");
    try {
      const data = await ApiClient.request("/api/autonomy");
      list.innerHTML = "";

      if (data.states.length === 0) {
        list.innerHTML = `<div class="text-muted" style="text-align:center; padding:16px;">No autonomy states currently recorded. Run pipeline cycles to populate.</div>`;
        return;
      }

      for (const s of data.states) {
        const node = document.createElement("div");
        node.className = "autonomy-node";

        // clean streak target values based on level
        const nextLevel = s.level + 1;
        const targetStreak = s.level === 0 ? 5 : s.level === 1 ? 10 : 20; // e.g. prom limit
        const pct = Math.min((s.clean_streak / targetStreak) * 100, 100);
        
        let promoteButton = "";
        // If streak is satisfied and not at ceiling
        if (s.clean_streak >= targetStreak && s.level < 3) {
          promoteButton = `<button class="btn btn-accent btn-sm btn-promote-auto" style="margin-top:10px;">🎓 Promote to L${nextLevel}</button>`;
        }

        node.innerHTML = `
          <div class="autonomy-level-header">
            <strong>${s.platform.toUpperCase()} / ${s.content_class.replace(/_/g, " ").toUpperCase()}</strong>
            <span class="score-badge voice">L${s.level}</span>
          </div>
          <div style="font-size:12px; color:var(--text-muted);">
            <div>Approved count: ${s.total_approved} | Rejected count: ${s.total_rejected}</div>
            <div>Clean Streak: ${s.clean_streak} / ${targetStreak}</div>
            <div class="streak-gauge"><div class="streak-fill" style="width: ${pct}%"></div></div>
          </div>
          ${promoteButton}
        `;

        if (promoteButton) {
          node.querySelector(".btn-promote-auto").onclick = async () => {
            try {
              await ApiClient.request(`/api/autonomy/${s.platform}/${s.content_class}/ratify`, "POST", { level: nextLevel });
              showToast(`Promoted ${s.platform}/${s.content_class} to L${nextLevel}`, "success");
              loadAutonomy();
              refreshGlobalStatus();
            } catch (e) {
              showToast(e.message, "error");
            }
          };
        }

        list.appendChild(node);
      }

    } catch (e) {
      showToast(e.message, "error");
    }
  }

  // Save actions
  document.getElementById("btn-save-settings").onclick = async () => {
    const maxAutonomy = document.getElementById("set-max-autonomy").value;
    const voiceThreshold = document.getElementById("set-voice-threshold").value;
    const quietHours = document.getElementById("set-quiet-hours").value;
    const maxReplies = document.getElementById("set-max-replies").value;

    try {
      await ApiClient.request("/api/settings", "POST", {
        max_autonomy_level: maxAutonomy,
        voice_threshold: voiceThreshold,
        quiet_hours: quietHours,
        max_replies_per_hour: maxReplies
      });
      showToast("General settings saved", "success");
      refreshGlobalStatus();
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  document.getElementById("btn-save-caps").onclick = async () => {
    const llmVal = parseFloat(document.getElementById("cap-llm").value);
    const platVal = parseFloat(document.getElementById("cap-platform").value);

    if (isNaN(llmVal) || isNaN(platVal) || llmVal < 0 || platVal < 0) {
      showToast("Please enter valid positive numbers for both caps", "error");
      return;
    }

    try {
      await ApiClient.request("/api/spend/caps", "POST", {
        llm: llmVal,
        x: platVal
      });
      showToast("Monthly spending caps updated", "success");
      loadConfig();
      refreshGlobalStatus();
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  // Initial load
  await loadConfig();
  await loadAutonomy();
}
