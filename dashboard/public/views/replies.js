import { ApiClient, showToast } from "../app.js";

export async function render() {
  document.getElementById("page-title").textContent = "Replies Engine";
  document.getElementById("page-subtitle").textContent = "Mentions, threads, and automated replies";

  const container = document.getElementById("view-container");
  container.innerHTML = `
    <div class="view-header">
      <button id="btn-run-replies" class="btn btn-accent">Run Replies Engine</button>
    </div>
    <div class="mentions-feed" id="mentions-feed">
      <div class="loader-container"><div class="spinner"></div></div>
    </div>
  `;

  document.getElementById("btn-run-replies").addEventListener("click", async () => {
    try {
      document.getElementById("btn-run-replies").disabled = true;
      document.getElementById("btn-run-replies").textContent = "Running...";
      const res = await ApiClient.request("/api/engine/replies", "POST");
      showToast(\`Engine run complete. Escalated: \${res.escalated}, No Reply: \${res.noReply}\`, "success");
      loadMentions();
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      document.getElementById("btn-run-replies").disabled = false;
      document.getElementById("btn-run-replies").textContent = "Run Replies Engine";
    }
  });

  async function loadMentions() {
    try {
      const mentions = await ApiClient.request("/api/replies");
      const feed = document.getElementById("mentions-feed");
      
      if (mentions.length === 0) {
        feed.innerHTML = \`<div class="empty-state">No mentions collected yet.</div>\`;
        return;
      }

      feed.innerHTML = mentions.map(m => \`
        <div class="card mention-card" style="margin-bottom: 1rem;">
          <div class="card-header" style="display: flex; justify-content: space-between; align-items: center;">
            <h4 style="margin:0;">\${m.author_handle || 'Unknown User'} <span class="badge" style="background:#333; padding:2px 6px; border-radius:4px; font-size:12px;">\${m.platform}</span></h4>
            <span class="text-muted" style="font-size: 12px;">\${new Date(m.posted_at).toLocaleString()}</span>
          </div>
          <div class="card-body" style="padding: 1rem 0;">
            <p class="mention-text" style="font-style: italic; border-left: 3px solid #555; padding-left: 10px;">\${m.text}</p>
            \${m.draft_body ? \`<div class="draft-preview" style="margin-top: 1rem; background: #222; padding: 10px; border-radius: 6px;"><strong>Drafted Reply (\${m.content_class}):</strong><p style="margin-bottom:0;">\${m.draft_body}</p></div>\` : ''}
          </div>
          <div class="card-footer" style="font-size: 12px; color: #aaa;">
            <span class="badge" style="background: \${m.triage === 'reply' ? '#2ecc71' : '#555'}; color: #fff; padding:2px 6px; border-radius:4px;">Triage: \${m.triage || m.status}</span>
          </div>
        </div>
      \`).join("");
    } catch (e) {
      document.getElementById("mentions-feed").innerHTML = \`<div class="error-state">Failed to load mentions: \${e.message}</div>\`;
    }
  }

  loadMentions();
}
