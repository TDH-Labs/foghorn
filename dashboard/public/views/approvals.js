import { ApiClient, showToast, refreshGlobalStatus } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <div class="glass-card-header">
      <h2>Approvals Queue</h2>
      <button id="btn-refresh-approvals" class="btn btn-secondary btn-sm">🔄 Refresh</button>
    </div>
    
    <div class="approvals-list" id="approvals-container">
      <div class="loader-container"><div class="spinner"></div></div>
    </div>
  `;

  async function loadApprovals() {
    const listContainer = document.getElementById("approvals-container");
    try {
      const approvals = await ApiClient.request("/api/approvals");
      listContainer.innerHTML = "";

      if (approvals.length === 0) {
        listContainer.innerHTML = `
          <div class="glass" style="text-align:center; padding:48px;">
            <span style="font-size:36px;">🎉</span>
            <h3 style="margin-top:16px;">Queue is Empty</h3>
            <p class="text-muted" style="margin-top:8px;">No pending publications to approve. Generate some drafts first!</p>
          </div>
        `;
        return;
      }

      for (const a of approvals) {
        const item = document.createElement("div");
        item.className = "glass";
        item.style.marginBottom = "24px";
        
        // Check if there was editing changes
        let initialText = a.body_text;

        item.innerHTML = `
          <div class="approval-card-preview">
            <div>
              <div class="glass-card-header">
                <h3>Draft #${a.draft_id} (v${a.draft_version}) — ${a.platform.toUpperCase()}</h3>
                <span class="score-badge voice">${a.content_class.replace(/_/g, " ").toUpperCase()}</span>
              </div>
              
              <!-- Editable draft body text -->
              <label class="stat-label">Body Content (Editable)</label>
              <textarea class="approval-edit-text" style="min-height:160px; font-size:15px; margin-bottom:12px;">${initialText}</textarea>
              
              <div style="margin-bottom:16px;">
                <label class="stat-label">Internal Note / Steering instruction (Optional)</label>
                <input type="text" placeholder="Add a note to this decision..." class="approval-note" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
              </div>
            </div>
            
            <div style="border-left:1px solid var(--surface-border); padding-left:24px;">
              <div class="stat-gauge" style="margin-bottom: 16px;">
                <span class="stat-label">Risk Profile Score</span>
                <span class="stat-value ${a.risk_score > 60 ? 'text-accent' : ''}">${a.risk_score !== null ? Math.round(a.risk_score) : '—'} / 100</span>
              </div>

              <h4 style="font-size:12px; margin-bottom:8px; font-weight:600; text-transform:uppercase; color:var(--text-muted);">Gate Scores</h4>
              <div class="radar-scores" style="margin-bottom:24px;">
                <div class="score-row">
                  <span>Voice Match</span>
                  <span><strong>${a.voice_score !== null ? Math.round(a.voice_score) : '—'} / 100</strong></span>
                </div>
                <div class="score-row">
                  <span>Quality</span>
                  <span><strong>${a.quality_score !== null ? Math.round(a.quality_score) : '—'} / 100</strong></span>
                </div>
              </div>

              <div style="display:flex; flex-direction:column; gap:10px;">
                <button class="btn btn-primary btn-approve">✅ Approve Post</button>
                <button class="btn btn-danger btn-reject">❌ Reject Draft</button>
              </div>
            </div>
          </div>
        `;

        const textarea = item.querySelector(".approval-edit-text");
        const noteInput = item.querySelector(".approval-note");
        const approveBtn = item.querySelector(".btn-approve");
        const rejectBtn = item.querySelector(".btn-reject");

        approveBtn.addEventListener("click", async () => {
          approveBtn.disabled = true;
          rejectBtn.disabled = true;
          const currentText = textarea.value;
          const noteVal = noteInput.value;

          try {
            let res;
            if (currentText !== initialText) {
              // Edited approval flow
              res = await ApiClient.request(`/api/approvals/${a.id}/decide`, "POST", {
                decision: "edited",
                editedText: currentText,
                note: noteVal
              });
            } else {
              // Plain approval flow
              res = await ApiClient.request(`/api/approvals/${a.id}/decide`, "POST", {
                decision: "approved",
                note: noteVal
              });
            }
            
            showToast(res.detail || "Draft approved!", "success");
            loadApprovals();
            refreshGlobalStatus();
          } catch (e) {
            showToast(e.message, "error");
            approveBtn.disabled = false;
            rejectBtn.disabled = false;
          }
        });

        rejectBtn.addEventListener("click", async () => {
          approveBtn.disabled = true;
          rejectBtn.disabled = true;
          const noteVal = noteInput.value;
          try {
            const res = await ApiClient.request(`/api/approvals/${a.id}/decide`, "POST", {
              decision: "rejected",
              note: noteVal
            });
            showToast("Draft rejected", "info");
            loadApprovals();
            refreshGlobalStatus();
          } catch (e) {
            showToast(e.message, "error");
            approveBtn.disabled = false;
            rejectBtn.disabled = false;
          }
        });

        listContainer.appendChild(item);
      }

    } catch (e) {
      showToast(e.message, "error");
    }
  }

  document.getElementById("btn-refresh-approvals").onclick = loadApprovals;
  
  // Initial load
  await loadApprovals();
}
