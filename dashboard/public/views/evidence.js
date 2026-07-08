import { ApiClient, runSseProcess, showToast } from "../app.js";

export async function render(container) {
  container.innerHTML = `
    <!-- Top controller bar -->
    <div class="dash-grid-2x2" style="margin-bottom:24px;">
      <!-- Manual insertion -->
      <div class="glass">
        <div class="glass-card-header">
          <h2>Add Factual Evidence</h2>
        </div>
        <div style="display:flex; flex-direction:column; gap:12px;">
          <div>
            <label class="stat-label">Topic / Category Tag</label>
            <input type="text" id="ev-add-topic" placeholder="e.g. beaverton-payroll, oregon-revenue" style="width:100%; padding:10px; background:rgba(0,0,0,0.2); border:1px solid var(--surface-border); border-radius:var(--radius-sm); color:var(--text-primary); font-family:inherit;">
          </div>
          <div>
            <label class="stat-label">Verified Fact Statement</label>
            <textarea id="ev-add-fact" placeholder="Beaverton payroll costs for early learners daycare run at $12k/mo as of Q2 2026." style="min-height:80px; margin-bottom:12px;"></textarea>
          </div>
          <button id="btn-add-evidence" class="btn btn-primary">➕ Save Approved Fact</button>
        </div>
      </div>

      <!-- LLM extract trigger -->
      <div class="glass" style="display:flex; flex-direction:column;">
        <div class="glass-card-header">
          <h2>AI Evidence Extractor</h2>
          <button id="btn-extract-evidence" class="btn btn-secondary btn-sm">🤖 Run Extractor</button>
        </div>
        <p class="text-muted" style="font-size:13px; margin-bottom:12px;">
          Analyzes ingested Beeper chats to discover factual statements and lists them for human ratification.
        </p>
        <div class="log-terminal" id="extract-terminal" style="height:140px;">
          <div class="log-line system">[system] Ready to extract from messages.</div>
        </div>
      </div>
    </div>

    <!-- 3 column Layout -->
    <div class="dash-grid-3col">
      <!-- Col 1: Pending review -->
      <div class="glass">
        <div class="glass-card-header">
          <h3>Proposed / Pending Review</h3>
          <span class="column-count" id="cnt-ev-proposed">0</span>
        </div>
        <div class="column-cards" id="ev-list-proposed" style="max-height: 500px; overflow-y: auto; display:flex; flex-direction:column; gap:12px; margin-top:12px;">
          <div class="text-muted">Loading proposed facts...</div>
        </div>
      </div>

      <!-- Col 2: Approved Bank -->
      <div class="glass">
        <div class="glass-card-header">
          <h3>Approved Bank</h3>
          <span class="column-count" id="cnt-ev-approved">0</span>
        </div>
        <div class="column-cards" id="ev-list-approved" style="max-height: 500px; overflow-y: auto; display:flex; flex-direction:column; gap:12px; margin-top:12px;">
          <div class="text-muted">Loading approved facts...</div>
        </div>
      </div>

      <!-- Col 3: Rejected Bank -->
      <div class="glass">
        <div class="glass-card-header">
          <h3>Rejected</h3>
          <span class="column-count" id="cnt-ev-rejected">0</span>
        </div>
        <div class="column-cards" id="ev-list-rejected" style="max-height: 500px; overflow-y: auto; display:flex; flex-direction:column; gap:12px; margin-top:12px;">
          <div class="text-muted">Loading rejected facts...</div>
        </div>
      </div>
    </div>
  `;

  const terminal = document.getElementById("extract-terminal");

  function logLine(text, level = "info") {
    const line = document.createElement("div");
    line.className = `log-line ${level}`;
    line.textContent = text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  async function loadEvidence() {
    try {
      const proposed = await ApiClient.request("/api/evidence?status=proposed");
      const approved = await ApiClient.request("/api/evidence?status=approved");
      const rejected = await ApiClient.request("/api/evidence?status=rejected");

      document.getElementById("cnt-ev-proposed").textContent = proposed.length;
      document.getElementById("cnt-ev-approved").textContent = approved.length;
      document.getElementById("cnt-ev-rejected").textContent = rejected.length;

      populateColumn("ev-list-proposed", proposed, true);
      populateColumn("ev-list-approved", approved, false);
      populateColumn("ev-list-rejected", rejected, false);

    } catch (e) {
      showToast(e.message, "error");
    }
  }

  function populateColumn(elementId, items, isProposed) {
    const col = document.getElementById(elementId);
    col.innerHTML = "";

    if (items.length === 0) {
      col.innerHTML = `<div class="text-muted" style="text-align:center; padding:16px;">No facts in this column</div>`;
      return;
    }

    for (const e of items) {
      const card = document.createElement("div");
      card.className = "kanban-card";
      card.style.cursor = "default";
      
      let srcHtml = "";
      if (e.source_quote) {
        srcHtml = `<div style="font-style:italic; font-size:11px; margin-top:8px; border-left:2px solid var(--accent); padding-left:8px; color:var(--text-muted);">"${e.source_quote}"</div>`;
      }

      let actionsHtml = "";
      if (isProposed) {
        actionsHtml = `
          <div style="display:flex; gap:10px; margin-top:12px; border-top:1px solid rgba(255,255,255,0.05); padding-top:10px;">
            <button class="btn btn-accent btn-sm btn-approve-ev" style="flex:1;">Approve</button>
            <button class="btn btn-danger btn-sm btn-reject-ev" style="flex:1;">Reject</button>
          </div>
        `;
      }

      card.innerHTML = `
        <span class="card-tag">${e.topic}</span>
        <div style="font-size:13px; font-weight:500;">${e.fact}</div>
        ${srcHtml}
        ${actionsHtml}
      `;

      if (isProposed) {
        card.querySelector(".btn-approve-ev").onclick = async () => {
          await ApiClient.request(`/api/evidence/${e.id}/approve`, "POST");
          showToast("Fact approved!", "success");
          loadEvidence();
        };
        card.querySelector(".btn-reject-ev").onclick = async () => {
          await ApiClient.request(`/api/evidence/${e.id}/reject`, "POST");
          showToast("Fact rejected", "info");
          loadEvidence();
        };
      }

      col.appendChild(card);
    }
  }

  // Bind Actions
  document.getElementById("btn-add-evidence").onclick = async () => {
    const topicInput = document.getElementById("ev-add-topic");
    const factInput = document.getElementById("ev-add-fact");
    const topic = topicInput.value.trim();
    const fact = factInput.value.trim();

    if (!topic || !fact) {
      showToast("Topic and Fact are required", "error");
      return;
    }

    try {
      await ApiClient.request("/api/evidence", "POST", { topic, fact });
      showToast("Factual evidence added successfully", "success");
      topicInput.value = "";
      factInput.value = "";
      loadEvidence();
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  document.getElementById("btn-extract-evidence").onclick = () => {
    terminal.innerHTML = "";
    logLine("[system] Starting extract...", "system");
    document.getElementById("btn-extract-evidence").disabled = true;

    runSseProcess(
      "/api/evidence/extract",
      {},
      (log) => {
        logLine(log.message, log.level === "error" ? "error" : "info");
      },
      (done) => {
        logLine(`Extraction complete: ${JSON.stringify(done.result)}`, "system");
        document.getElementById("btn-extract-evidence").disabled = false;
        loadEvidence();
      },
      (error) => {
        logLine(`Extraction failed: ${error}`, "error");
        document.getElementById("btn-extract-evidence").disabled = false;
        loadEvidence();
      }
    );
  };

  // Initial load
  await loadEvidence();
}
