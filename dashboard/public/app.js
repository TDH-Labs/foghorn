// SPA Router, API client, SSE stream management, and Global state coordinating

export class ApiClient {
  static async request(endpoint, method = "GET", body = null) {
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
    };
    if (body) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(endpoint, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP error ${res.status}`);
    }
    return res.json();
  }
}

// Global state
export const state = {
  status: null,
  activeView: null,
  activeSseSource: null,
};

// Toast system
export function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  
  let icon = "ℹ️";
  if (type === "success") icon = "✅";
  if (type === "error") icon = "❌";
  
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Global status bar and headers updater
export async function refreshGlobalStatus() {
  try {
    const status = await ApiClient.request("/api/status");
    state.status = status;

    // Update global status row
    const platEl = document.getElementById("stat-platform");
    const profEl = document.getElementById("stat-profile");
    const llmEl = document.getElementById("stat-spend-llm");
    const spendPlatEl = document.getElementById("stat-spend-platform");

    if (platEl) {
      platEl.querySelector(".stat-value").textContent = status.ratified_platform ? status.ratified_platform.toUpperCase() : "NONE";
    }
    if (profEl) {
      profEl.querySelector(".stat-value").textContent = status.active_profile_version ? `v${status.active_profile_version}` : "NONE";
    }

    if (llmEl && status.spend?.llm) {
      const llm = status.spend.llm;
      llmEl.querySelector(".fill").className = `fill ${llm.level > 0.9 ? 'red' : llm.level > 0.7 ? 'orange' : 'green'}`;
      llmEl.querySelector(".fill").style.width = `${Math.min(llm.level * 100, 100)}%`;
      llmEl.querySelector(".stat-value").textContent = `$${llm.spentUsd.toFixed(2)} / $${llm.capUsd.toFixed(2)}`;
    }

    if (spendPlatEl && status.spend?.x) {
      const platSpend = status.spend.x;
      spendPlatEl.querySelector(".fill").className = `fill ${platSpend.level > 0.9 ? 'red' : platSpend.level > 0.7 ? 'orange' : 'green'}`;
      spendPlatEl.querySelector(".fill").style.width = `${Math.min(platSpend.level * 100, 100)}%`;
      spendPlatEl.querySelector(".stat-value").textContent = `$${platSpend.spentUsd.toFixed(2)} / $${platSpend.capUsd.toFixed(2)}`;
    }

    // Update killswitch button state
    const killBtn = document.getElementById("btn-killswitch");
    if (killBtn) {
      if (status.paused) {
        killBtn.textContent = "▶ Resume Pipeline";
        killBtn.className = "btn btn-accent btn-block";
        document.querySelector(".badge-status").className = "badge-status paused";
        document.querySelector(".badge-status").innerHTML = `<span class="dot red"></span> Paused`;
      } else {
        killBtn.textContent = "⏸ Pause Pipeline";
        killBtn.className = "btn btn-danger btn-block";
        document.querySelector(".badge-status").className = "badge-status";
        document.querySelector(".badge-status").innerHTML = `<span class="dot green"></span> Running`;
      }
    }

    // Sidebar counter
    const sidebarBadge = document.getElementById("sidebar-approval-count");
    if (sidebarBadge) {
      if (status.counts.holds_open > 0 || status.counts.drafts > 0) {
        // Fetch approvals count specifically
        const approvals = await ApiClient.request("/api/approvals");
        if (approvals.length > 0) {
          sidebarBadge.textContent = approvals.length;
          sidebarBadge.style.display = "inline-block";
        } else {
          sidebarBadge.style.display = "none";
        }
      } else {
        sidebarBadge.style.display = "none";
      }
    }

  } catch (err) {
    console.error("Global status refresh failed:", err);
  }
}

// SSE stream runner for long processes (Engine, Scanner, Extractor, Profile build, platform score)
export function runSseProcess(url, postBody, onLog, onDone, onError) {
  if (state.activeSseSource) {
    state.activeSseSource.close();
  }

  // We start the background stream via fetch, which returns text/event-stream
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(postBody),
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`SSE Initialization failed: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const packet = JSON.parse(line.slice(6));
          
          if (packet.type === "log") {
            onLog(packet);
          } else if (packet.type === "question") {
            triggerIdeateModal(packet.question);
          } else if (packet.type === "progress") {
            onLog({ level: "info", message: `Step ${packet.stepIndex + 1}: ${packet.detail || packet.status}` });
            if (onLog.progressUpdate) {
              onLog.progressUpdate(packet);
            }
          } else if (packet.type === "done") {
            showToast("Process complete", "success");
            onDone(packet);
            refreshGlobalStatus();
            break;
          } else if (packet.type === "error") {
            showToast(packet.message, "error");
            onError(packet.message);
            break;
          }
        } catch (e) {
          console.error("Failed to parse SSE line:", line, e);
        }
      }
    }
  }).catch((err) => {
    showToast(err.message, "error");
    onError(err.message);
  });
}

// Q&A Modal state
function triggerIdeateModal(question) {
  const modal = document.getElementById("modal-ideate-qa");
  const qBlock = document.getElementById("modal-qa-question");
  const answerInput = document.getElementById("modal-qa-answer");

  if (!modal || !qBlock || !answerInput) return;

  qBlock.textContent = question;
  answerInput.value = "";
  modal.style.display = "flex";
}

function initModalEvents() {
  const modal = document.getElementById("modal-ideate-qa");
  const closeBtn = document.getElementById("modal-qa-close");
  const skipBtn = document.getElementById("modal-qa-skip");
  const submitBtn = document.getElementById("modal-qa-submit");
  const answerInput = document.getElementById("modal-qa-answer");

  if (!modal) return;

  const closeModal = () => {
    modal.style.display = "none";
  };

  const submitAnswer = async (answerVal) => {
    try {
      await ApiClient.request("/api/ideate-chat/answer", "POST", { answer: answerVal });
      showToast("Factual answer submitted to engine", "success");
      closeModal();
    } catch (e) {
      showToast(e.message, "error");
    }
  };

  closeBtn.addEventListener("click", closeModal);
  skipBtn.addEventListener("click", () => submitAnswer(""));
  submitBtn.addEventListener("click", () => submitAnswer(answerInput.value));
}

// Router map
const routes = {
  "#dashboard": "dashboard",
  "#pipeline": "pipeline",
  "#engine": "engine",
  "#approvals": "approvals",
  "#evidence": "evidence",
  "#research": "research",
  "#profiles": "profiles",
  "#platforms": "platforms",
  "#automations": "automations",
  "#settings": "settings",
};

async function handleRouting() {
  const hash = window.location.hash || "#dashboard";
  const viewName = routes[hash] || "dashboard";

  // Navigation UI Highlight
  document.querySelectorAll(".sidebar-nav a").forEach((a) => a.classList.remove("active"));
  const activeNav = document.getElementById(`nav-${viewName}`);
  if (activeNav) activeNav.classList.add("active");

  // Load view content dynamically
  const container = document.getElementById("view-container");
  container.innerHTML = '<div class="loader-container"><div class="spinner"></div></div>';

  const pageTitle = document.getElementById("page-title");
  const pageSubtitle = document.getElementById("page-subtitle");

  pageTitle.textContent = viewName.toUpperCase();
  pageSubtitle.textContent = `Managing ${viewName} details`;

  try {
    const viewModule = await import(`./views/${viewName}.js`);
    container.innerHTML = "";
    await viewModule.render(container);
  } catch (err) {
    console.error(`Failed to load view ${viewName}:`, err);
    container.innerHTML = `
      <div class="glass">
        <h2 style="color:var(--danger)">Error Loading View</h2>
        <p style="margin-top:10px">${err.message}</p>
      </div>
    `;
  }
}

// App Initialization
document.addEventListener("DOMContentLoaded", async () => {
  // Bind killswitch button
  const killBtn = document.getElementById("btn-killswitch");
  killBtn.addEventListener("click", async () => {
    if (!state.status) return;
    try {
      if (state.status.paused) {
        const reason = prompt("Enter a reason to resume publication:");
        if (reason) {
          await ApiClient.request("/api/resume", "POST", { reason });
          showToast("Pipeline resumed", "success");
        }
      } else {
        const reason = prompt("Enter a reason to PAUSE all operations:");
        if (reason) {
          await ApiClient.request("/api/pause", "POST", { reason });
          showToast("Pipeline PAUSED", "warning");
        }
      }
      refreshGlobalStatus();
    } catch (e) {
      showToast(e.message, "error");
    }
  });

  // Modal events setup
  initModalEvents();

  // Load status immediately, then poll
  await refreshGlobalStatus();
  setInterval(refreshGlobalStatus, 20000);

  // Router events
  window.addEventListener("hashchange", handleRouting);
  // Trigger initial routing
  handleRouting();
});
