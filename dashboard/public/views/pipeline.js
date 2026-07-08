import { ApiClient, showToast } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <div class="glass-card-header">
      <h2>Post Pipeline Kanban</h2>
      <button id="btn-refresh-pipeline" class="btn btn-secondary btn-sm">🔄 Refresh</button>
    </div>
    
    <div class="kanban-board">
      
      <!-- Column 1: Drafting / Gating -->
      <div class="kanban-column" id="col-drafting">
        <div class="column-header">
          <span class="column-title">⚙️ Gating / Drafting</span>
          <span class="column-count" id="count-drafting">0</span>
        </div>
        <div class="column-cards"></div>
      </div>

      <!-- Column 2: Escalated / Held -->
      <div class="kanban-column" id="col-held">
        <div class="column-header">
          <span class="column-title">⚠️ Escalated / Holds</span>
          <span class="column-count" id="count-held">0</span>
        </div>
        <div class="column-cards"></div>
      </div>

      <!-- Column 3: Awaiting Approval -->
      <div class="kanban-column" id="col-approval">
        <div class="column-header">
          <span class="column-title">🤝 Awaiting Approval</span>
          <span class="column-count" id="count-approval">0</span>
        </div>
        <div class="column-cards"></div>
      </div>

      <!-- Column 4: Scheduled -->
      <div class="kanban-column" id="col-scheduled">
        <div class="column-header">
          <span class="column-title">🕒 Scheduled</span>
          <span class="column-count" id="count-scheduled">0</span>
        </div>
        <div class="column-cards"></div>
      </div>

      <!-- Column 5: Published -->
      <div class="kanban-column" id="col-published">
        <div class="column-header">
          <span class="column-title">✅ Published</span>
          <span class="column-count" id="count-published">0</span>
        </div>
        <div class="column-cards"></div>
      </div>

    </div>

    <!-- Card Detail Modal overlay -->
    <div id="modal-card-detail" class="modal" style="display:none;">
      <div class="modal-content glass" style="max-width: 800px;">
        <div class="modal-header">
          <h2 id="detail-modal-title">Draft #0</h2>
          <button class="btn-close" id="btn-close-detail">&times;</button>
        </div>
        <div class="modal-body" style="display:grid; grid-template-columns: 2fr 1fr; gap:24px;">
          <div>
            <label class="stat-label">Post Body Content</label>
            <div class="approval-body-text" id="detail-modal-body" style="max-height: 300px; overflow-y: auto;">...</div>
          </div>
          <div>
            <div class="stat-gauge" style="margin-bottom: 16px;">
              <span class="stat-label">Platform Target</span>
              <span class="stat-value text-accent" id="detail-modal-platform">—</span>
            </div>
            <div class="stat-gauge" style="margin-bottom: 16px;">
              <span class="stat-label">Content Class</span>
              <span class="stat-value text-accent" id="detail-modal-class">—</span>
            </div>
            <div class="stat-gauge" style="margin-bottom: 16px;">
              <span class="stat-label">Status</span>
              <span class="stat-value" id="detail-modal-status">—</span>
            </div>
            
            <h3 style="font-size:14px; margin-bottom:10px; font-weight:600;">Gate Scores</h3>
            <div class="radar-scores">
              <div class="score-row">
                <span>Voice Match</span>
                <span id="detail-score-voice">—</span>
              </div>
              <div class="score-row">
                <span>Quality</span>
                <span id="detail-score-quality">—</span>
              </div>
              <div class="score-row">
                <span>Risk Index</span>
                <span id="detail-score-risk">—</span>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer" id="detail-modal-footer">
          <!-- context actions will inject here -->
        </div>
      </div>
    </div>
  `;

  // Fetch drafts and populate columns
  async function loadDrafts() {
    try {
      const drafts = await ApiClient.request("/api/drafts");
      
      const columns = {
        drafting: { el: document.querySelector("#col-drafting .column-cards"), cnt: 0 },
        held: { el: document.querySelector("#col-held .column-cards"), cnt: 0 },
        approval: { el: document.querySelector("#col-approval .column-cards"), cnt: 0 },
        scheduled: { el: document.querySelector("#col-scheduled .column-cards"), cnt: 0 },
        published: { el: document.querySelector("#col-published .column-cards"), cnt: 0 },
      };

      // Clear previous cards
      for (const col of Object.values(columns)) {
        col.el.innerHTML = "";
      }

      for (const d of drafts) {
        let colKey = "drafting";
        if (d.status === "drafting" || d.status === "gating") colKey = "drafting";
        else if (d.status === "escalated" || d.status === "held") colKey = "held";
        else if (d.status === "awaiting_approval") colKey = "approval";
        else if (d.status === "scheduled" || d.status === "approved") colKey = "scheduled";
        else if (d.status === "published") colKey = "published";
        else continue; // e.g. rejected, skip

        columns[colKey].cnt++;

        const card = document.createElement("div");
        card.className = "kanban-card";
        card.innerHTML = `
          <span class="card-tag">${d.platform} / ${d.content_class.replace(/_/g, " ")}</span>
          <div class="card-title">${escapeHtml(d.body_text)}</div>
          <div class="card-footer">
            <span>ID: #${d.id}v${d.version}</span>
            <div style="display:flex; gap:6px;">
              ${d.voice_score ? `<span class="score-badge voice">V:${Math.round(d.voice_score)}</span>` : ""}
              ${d.risk_score ? `<span class="score-badge risk">R:${Math.round(d.risk_score)}</span>` : ""}
            </div>
          </div>
        `;

        card.addEventListener("click", () => showCardDetail(d));
        columns[colKey].el.appendChild(card);
      }

      // Update counters
      document.getElementById("count-drafting").textContent = columns.drafting.cnt;
      document.getElementById("count-held").textContent = columns.held.cnt;
      document.getElementById("count-approval").textContent = columns.approval.cnt;
      document.getElementById("count-scheduled").textContent = columns.scheduled.cnt;
      document.getElementById("count-published").textContent = columns.published.cnt;

    } catch (e) {
      showToast(e.message, "error");
    }
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function showCardDetail(d) {
    const modal = document.getElementById("modal-card-detail");
    document.getElementById("detail-modal-title").textContent = `Draft #${d.id} (Version ${d.version})`;
    document.getElementById("detail-modal-body").textContent = d.body_text;
    document.getElementById("detail-modal-platform").textContent = d.platform.toUpperCase();
    document.getElementById("detail-modal-class").textContent = d.content_class.replace(/_/g, " ");
    document.getElementById("detail-modal-status").textContent = d.status.toUpperCase();

    document.getElementById("detail-score-voice").textContent = d.voice_score !== null ? `${Math.round(d.voice_score)}/100` : "N/A";
    document.getElementById("detail-score-quality").textContent = d.quality_score !== null ? `${Math.round(d.quality_score)}/100` : "N/A";
    document.getElementById("detail-score-risk").textContent = d.risk_score !== null ? `${Math.round(d.risk_score)}/100` : "N/A";

    const existingHoldSection = document.getElementById("detail-modal-hold-section");
    if (existingHoldSection) existingHoldSection.remove();

    const footer = document.getElementById("detail-modal-footer");
    footer.innerHTML = "";

    if (d.status === "escalated" || d.status === "held") {
      try {
        const holds = await ApiClient.request("/api/holds");
        const holdObj = holds.find(h => h.draft_id === d.id);
        if (holdObj) {
          const packet = JSON.parse(holdObj.packet_json || "{}");
          const holdSection = document.createElement("div");
          holdSection.id = "detail-modal-hold-section";
          holdSection.style.marginTop = "16px";
          holdSection.innerHTML = `
            <label class="stat-label" style="color:var(--text-accent);">Hold details / Finding</label>
            <div class="question-block" style="background:rgba(239, 68, 68, 0.05); border-color:rgba(239, 68, 68, 0.2); font-size:13px; font-family:monospace; white-space:pre-wrap; max-height:150px; overflow:auto;">${packet.reason || "Escalation findings"}\n\n${JSON.stringify(packet.findings || [], null, 2)}</div>
          `;
          document.getElementById("detail-modal-body").parentElement.appendChild(holdSection);

          const forceApproveBtn = document.createElement("button");
          forceApproveBtn.className = "btn btn-primary";
          forceApproveBtn.style.marginRight = "10px";
          forceApproveBtn.textContent = "✅ Force Approve";
          forceApproveBtn.onclick = async () => {
            try {
              const res = await ApiClient.request(`/api/holds/${holdObj.id}/decide`, "POST", { decision: "approved" });
              showToast(res.detail || "Draft manually approved!", "success");
              modal.style.display = "none";
              await loadDrafts();
            } catch (e) {
              showToast(e.message, "error");
            }
          };

          const rejectBtn = document.createElement("button");
          rejectBtn.className = "btn btn-danger";
          rejectBtn.style.marginRight = "auto";
          rejectBtn.textContent = "❌ Reject Draft";
          rejectBtn.onclick = async () => {
            try {
              const res = await ApiClient.request(`/api/holds/${holdObj.id}/decide`, "POST", { decision: "rejected" });
              showToast(res.detail || "Draft rejected.", "info");
              modal.style.display = "none";
              await loadDrafts();
            } catch (e) {
              showToast(e.message, "error");
            }
          };

          footer.appendChild(forceApproveBtn);
          footer.appendChild(rejectBtn);
        }
      } catch (e) {
        showToast("Error loading hold: " + e.message, "error");
      }
    }

    if (d.status === "awaiting_approval") {
      const approveBtn = document.createElement("a");
      approveBtn.href = "#approvals";
      approveBtn.className = "btn btn-primary";
      approveBtn.style.marginRight = "10px";
      approveBtn.textContent = "🤝 Go to Approvals Queue";
      footer.appendChild(approveBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn btn-secondary";
    closeBtn.textContent = "Close";
    closeBtn.onclick = () => modal.style.display = "none";
    footer.appendChild(closeBtn);

    modal.style.display = "flex";
  }

  // Bind close buttons
  document.getElementById("btn-close-detail").onclick = () => {
    document.getElementById("modal-card-detail").style.display = "none";
  };
  
  document.getElementById("btn-refresh-pipeline").onclick = loadDrafts;

  // Load immediately
  await loadDrafts();
}
