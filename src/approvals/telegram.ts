// Dedicated-bot approval loop (long-poll getUpdates). Deliberately decoupled
// from any Claude session and containing ZERO LLM calls: chat-id allowlist,
// single-use nonce in callback_data, first-write-wins decisions, message
// edited after decision to kill double-taps. pause/resume/status text commands
// are handled deterministically.

import type { Database } from "bun:sqlite";
import { getSetting, setSetting } from "../config/settings.ts";
import { isPaused, pause, resume } from "../killswitch.ts";
import { ratifyPromotion } from "../autonomy/ladder.ts";
import { recordDecision, renderApproval } from "./queue.ts";

interface TgResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

function botToken(): string {
  const t = process.env.FOGHORN_TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("FOGHORN_TELEGRAM_BOT_TOKEN not set");
  return t;
}

function approverChatId(): string {
  const id = process.env.FOGHORN_TELEGRAM_CHAT_ID;
  if (!id) throw new Error("Missing FOGHORN_TELEGRAM_CHAT_ID in environment. Check .env.local.");
  return id;
}

async function tg<T>(fetchImpl: typeof fetch, method: string, body: Record<string, unknown>): Promise<TgResponse<T>> {
  const res = await fetchImpl(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as TgResponse<T>;
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
  return json;
}

// Group-chat delivery (2026-07-09): posts via Hermes's own bot into the
// Foghorn topic instead of the dedicated FOGHORN_TELEGRAM_BOT_TOKEN bot -
// same identity the operator already talks to the foghorn-agent persona through, one
// bot instead of two. No inline buttons: nothing polls this bot's updates
// for a callback_query anymore (only Hermes's own gateway may long-poll its
// bot), so approve/reject/pause/resume/promote are resolved conversationally
// - Operator replies in the topic, the resident persona resolves it via
// `bun foghorn.ts approve|reject|pending|pause|resume|promote` (see
// conversational-approval.md's Foghorn section). The dedicated bot's own
// token/getUpdates polling (below) is dead code once the launchd daemon is
// stopped - kept only so `foghorn.ts approvals-daemon` still compiles if
// anyone runs it manually.
function hermesBotToken(): string {
  const t = process.env.FOGHORN_HERMES_BOT_TOKEN;
  if (!t) throw new Error("FOGHORN_HERMES_BOT_TOKEN not set");
  return t;
}

function hermesGroupChatId(): string {
  return process.env.FOGHORN_HERMES_GROUP_CHAT_ID ?? "-1004293863759";
}

function foghornTopicThreadId(): string {
  return process.env.FOGHORN_TOPIC_THREAD_ID ?? "255";
}

/** Send Telegram messages for approvals that don't have one yet. */
export async function sendPendingApprovals(db: Database, fetchImpl: typeof fetch = fetch): Promise<number> {
  const pending = db
    .query<{ id: number; nonce: string }, []>(
      "SELECT id, nonce FROM approvals WHERE decided_at IS NULL AND telegram_message_id IS NULL",
    )
    .all();
  for (const p of pending) {
    const text =
      `${renderApproval(db, p.id)}\n\n` +
      `Reply here to approve or reject (e.g. "approve ${p.id}" / "reject ${p.id}") - no button, just say it plainly.`;
    const res = await fetchImpl(`https://api.telegram.org/bot${hermesBotToken()}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: hermesGroupChatId(), message_thread_id: foghornTopicThreadId(), text }),
    });
    const json = (await res.json()) as TgResponse<{ message_id: number }>;
    if (!json.ok) throw new Error(`telegram sendMessage: ${json.description ?? res.status}`);
    db.run("UPDATE approvals SET telegram_message_id = ? WHERE id = ?", [String(json.result.message_id), p.id]);
  }
  return pending.length;
}

interface TgUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    text?: string;
  };
}

export interface PollReport {
  updates: number;
  decisions: number;
  commands: number;
}

/** One getUpdates cycle. timeoutS=0 in tests; ~25s in the daemon. */
export async function pollOnce(db: Database, fetchImpl: typeof fetch = fetch, timeoutS = 25): Promise<PollReport> {
  const offset = Number(getSetting(db, "telegram_offset") ?? "0");
  const { result: updates } = await tg<TgUpdate[]>(fetchImpl, "getUpdates", {
    offset: offset + 1,
    timeout: timeoutS,
    allowed_updates: ["callback_query", "message"],
  });

  let decisions = 0;
  let commands = 0;
  for (const u of updates) {
    setSetting(db, "telegram_offset", String(u.update_id));

    if (u.callback_query) {
      const cq = u.callback_query;
      const fromOk = String(cq.from.id) === approverChatId();
      const parts = (cq.data ?? "").split(":");
      if (!fromOk || parts.length !== 4 || parts[0] !== "a") {
        await tg(fetchImpl, "answerCallbackQuery", { callback_query_id: cq.id, text: "ignored" }).catch(() => {});
        continue;
      }
      const [, idStr, action, nonce] = parts;
      const approval = db
        .query<{ id: number; nonce: string; telegram_message_id: string | null }, [number]>(
          "SELECT id, nonce, telegram_message_id FROM approvals WHERE id = ?",
        )
        .get(Number(idStr));
      if (!approval || approval.nonce !== nonce) {
        await tg(fetchImpl, "answerCallbackQuery", { callback_query_id: cq.id, text: "stale or invalid" }).catch(() => {});
        continue;
      }

      let outcome = "";
      if (action === "pz") {
        pause(db, "telegram pause button", "telegram");
        outcome = "⏸ paused — nothing will publish until resume";
      } else if (action === "ap" || action === "rj") {
        const result = recordDecision(db, approval.id, action === "ap" ? "approved" : "rejected", "telegram");
        decisions++;
        outcome = result.ok
          ? `${action === "ap" ? "✅ approved" : "❌ rejected"} — ${result.detail}` +
            (result.promotionOffer
              ? `\n🎓 clean streak reached: reply "promote ${result.platform}/${result.contentClass}" to raise this to L${result.promotionOffer}`
              : "")
          : `⚠ ${result.detail}`;
      }
      await tg(fetchImpl, "answerCallbackQuery", { callback_query_id: cq.id, text: outcome.slice(0, 190) }).catch(() => {});
      if (cq.message) {
        await tg(fetchImpl, "editMessageText", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `${renderApproval(db, approval.id)}\n\n— ${outcome}`,
        }).catch(() => {});
      }
      continue;
    }

    if (u.message?.text && String(u.message.chat.id) === approverChatId()) {
      const text = u.message.text.trim().toLowerCase();
      if (text === "pause") {
        pause(db, "telegram text command", "telegram");
        await tg(fetchImpl, "sendMessage", { chat_id: u.message.chat.id, text: "⏸ paused" }).catch(() => {});
        commands++;
      } else if (text.startsWith("resume")) {
        const reason = u.message.text.slice(6).trim() || "telegram resume";
        resume(db, reason, "telegram");
        await tg(fetchImpl, "sendMessage", { chat_id: u.message.chat.id, text: "▶ resumed" }).catch(() => {});
        commands++;
      } else if (text === "status") {
        const pendingN = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM approvals WHERE decided_at IS NULL").get()?.n ?? 0;
        const holdsN = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM holds WHERE status='open'").get()?.n ?? 0;
        await tg(fetchImpl, "sendMessage", {
          chat_id: u.message.chat.id,
          text: `paused=${isPaused(db)} pending_approvals=${pendingN} open_holds=${holdsN}`,
        }).catch(() => {});
        commands++;
      } else if (/^promote\s+\S+\/\S+$/i.test(text)) {
        const [, platform, contentClass] = /^promote\s+(\S+)\/(\S+)$/i.exec(text)!;
        const current = db
          .query<{ level: number }, [string, string]>(
            "SELECT level FROM autonomy_state WHERE platform = ? AND content_class = ?",
          )
          .get(platform!, contentClass!);
        let reply: string;
        if (!current) {
          reply = `no autonomy state for ${platform}/${contentClass} yet`;
        } else {
          try {
            ratifyPromotion(db, platform!, contentClass!, current.level + 1);
            reply = `🎓 promoted ${platform}/${contentClass} to L${current.level + 1}`;
          } catch (err) {
            reply = `promotion failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        await tg(fetchImpl, "sendMessage", { chat_id: u.message.chat.id, text: reply }).catch(() => {});
        commands++;
      }
    }
  }
  return { updates: updates.length, decisions, commands };
}
