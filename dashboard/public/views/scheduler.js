import { ApiClient, showToast } from "../app.js";

export async function render() {
  document.getElementById("page-title").textContent = "Scheduled Posts";
  document.getElementById("page-subtitle").textContent = "View and edit upcoming scheduled posts";

  const container = document.getElementById("view-container");
  container.innerHTML = `
    <div class="scheduler-feed" id="scheduler-feed">
      <div class="loader-container"><div class="spinner"></div></div>
    </div>
  `;

  async function loadSchedule() {
    try {
      const schedule = await ApiClient.request("/api/schedule");
      const feed = document.getElementById("scheduler-feed");
      
      if (schedule.length === 0) {
        feed.innerHTML = \`<div class="empty-state">No scheduled posts found.</div>\`;
        return;
      }

      feed.innerHTML = schedule.map(s => \`
        <div class="card schedule-card" style="margin-bottom: 1rem;" id="schedule-card-\${s.id}">
          <div class="card-header" style="display: flex; justify-content: space-between; align-items: center;">
            <h4 style="margin:0;"><span class="badge" style="background:#333; padding:2px 6px; border-radius:4px; font-size:12px;">\${s.platform}</span> Draft #\${s.draft_id}</h4>
            <div>
              <span class="badge" style="background: \${s.state === 'firing' ? '#f39c12' : '#3498db'}; color: #fff; padding:2px 6px; border-radius:4px; margin-right: 10px;">\${s.state.toUpperCase()}</span>
              <input type="datetime-local" class="edit-schedule-time" data-id="\${s.id}" value="\${s.scheduled_for.slice(0, 16)}" style="background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; padding: 4px;">
            </div>
          </div>
          <div class="card-body" style="padding: 1rem 0;">
            <p style="margin:0; white-space: pre-wrap; font-family: monospace; font-size: 13px; background: #111; padding: 10px; border-radius: 6px;">\${s.body_text}</p>
          </div>
          <div class="card-footer" style="display: flex; justify-content: flex-end; gap: 10px;">
            <button class="btn btn-secondary btn-update-time" data-id="\${s.id}">Update Time</button>
            <button class="btn btn-danger btn-cancel-schedule" data-id="\${s.id}">Cancel Post</button>
          </div>
        </div>
      \`).join("");

      // Bind events
      document.querySelectorAll(".btn-update-time").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          const id = e.target.getAttribute("data-id");
          const input = document.querySelector(\`.edit-schedule-time[data-id="\${id}"]\`);
          try {
            const newTime = new Date(input.value).toISOString();
            await ApiClient.request(\`/api/schedule/\${id}\`, "PUT", { scheduled_for: newTime });
            showToast("Scheduled time updated", "success");
            loadSchedule();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-cancel-schedule").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          const id = e.target.getAttribute("data-id");
          if (!confirm("Are you sure you want to cancel this scheduled post?")) return;
          try {
            await ApiClient.request(\`/api/schedule/\${id}\`, "DELETE");
            showToast("Scheduled post cancelled", "success");
            loadSchedule();
          } catch (err) {
            showToast(err.message, "error");
          }
        });
      });

    } catch (e) {
      document.getElementById("scheduler-feed").innerHTML = \`<div class="error-state">Failed to load schedule: \${e.message}</div>\`;
    }
  }

  loadSchedule();
}
