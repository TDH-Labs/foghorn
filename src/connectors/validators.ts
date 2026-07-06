// One validator per service. Every check is a READ (or pure local parse) —
// validate-on-connect never writes, posts, or sends. X's users/me read costs
// $0.001 (owned read) and is recorded in the ledger by the CLI wrapper.

import type { Database } from "bun:sqlite";
import { bech32Decode } from "./bech32.ts";
import { envPresent, summarize, type ConnectCheck, type ConnectResult } from "./index.ts";
import { oauth1Header } from "./oauth1.ts";
import { record } from "../spend/ledger.ts";

async function checkedFetch(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  init: RequestInit,
  describe: (body: unknown) => string,
): Promise<ConnectCheck> {
  try {
    const res = await fetchImpl(url, init);
    if (!res.ok) return { name, ok: false, detail: `HTTP ${res.status}` };
    const body: unknown = await res.json().catch(() => null);
    return { name, ok: true, detail: describe(body) };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function validateBeeper(fetchImpl: typeof fetch = fetch): Promise<ConnectResult> {
  const checks: ConnectCheck[] = [envPresent("BEEPER_ACCESS_TOKEN")];
  if (checks[0]!.ok) {
    checks.push(
      await checkedFetch(
        fetchImpl,
        "desktop-api reachable + token accepted",
        "http://localhost:23373/v1/chats/search?limit=1",
        { headers: { Authorization: `Bearer ${process.env.BEEPER_ACCESS_TOKEN}` } },
        (body) => {
          const items = (body as { items?: unknown[] })?.items;
          return Array.isArray(items) ? `ok, ${items.length} chat(s) visible` : "ok";
        },
      ),
    );
  }
  return summarize("beeper", checks);
}

export async function validateTelegram(fetchImpl: typeof fetch = fetch): Promise<ConnectResult> {
  const checks: ConnectCheck[] = [envPresent("FOGHORN_TELEGRAM_BOT_TOKEN"), envPresent("FOGHORN_TELEGRAM_CHAT_ID")];
  if (checks[0]!.ok) {
    checks.push(
      await checkedFetch(
        fetchImpl,
        "bot token valid (getMe)",
        `https://api.telegram.org/bot${process.env.FOGHORN_TELEGRAM_BOT_TOKEN}/getMe`,
        {},
        (body) => {
          const username = (body as { result?: { username?: string } })?.result?.username;
          return username ? `bot @${username}` : "ok";
        },
      ),
    );
  }
  return summarize("telegram", checks);
}

export async function validateX(db: Database, fetchImpl: typeof fetch = fetch): Promise<ConnectResult> {
  const names = ["X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"] as const;
  const checks: ConnectCheck[] = names.map(envPresent);
  if (checks.every((c) => c.ok)) {
    const url = "https://api.x.com/2/users/me";
    const auth = oauth1Header(
      {
        consumerKey: process.env.X_API_KEY!,
        consumerSecret: process.env.X_API_KEY_SECRET!,
        accessToken: process.env.X_ACCESS_TOKEN!,
        accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET!,
      },
      "GET",
      url,
    );
    const check = await checkedFetch(fetchImpl, "user context valid (GET users/me)", url, {
      headers: { Authorization: auth },
    }, (body) => {
      const u = (body as { data?: { username?: string } })?.data?.username;
      return u ? `authenticated as @${u}` : "ok";
    });
    checks.push(check);
    if (check.ok) record(db, { category: "x_own_read", units: 1, unitCostUsd: 0.001, ref: "connect:users/me" });
  }
  return summarize("x", checks);
}

export async function validateLinkedIn(fetchImpl: typeof fetch = fetch): Promise<ConnectResult> {
  const checks: ConnectCheck[] = [envPresent("LINKEDIN_CLIENT_ID"), envPresent("LINKEDIN_CLIENT_SECRET")];
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (token) {
    checks.push(
      await checkedFetch(
        fetchImpl,
        "member token valid (GET /v2/userinfo)",
        "https://api.linkedin.com/v2/userinfo",
        { headers: { Authorization: `Bearer ${token}` } },
        (body) => {
          const name = (body as { name?: string })?.name;
          return name ? `member: ${name}` : "ok";
        },
      ),
    );
  } else {
    checks.push({
      name: "member token",
      ok: false,
      detail: "LINKEDIN_ACCESS_TOKEN missing — run the OAuth grant (Phase 3 user action)",
    });
  }
  return summarize("linkedin", checks);
}

export async function validateNostr(): Promise<ConnectResult> {
  const checks: ConnectCheck[] = [envPresent("NOSTR_NSEC")];
  const nsec = process.env.NOSTR_NSEC;
  if (nsec) {
    try {
      const { hrp, data } = bech32Decode(nsec);
      const ok = hrp === "nsec" && data.length === 32;
      checks.push({
        name: "nsec parses (bech32, 32-byte key)",
        ok,
        detail: ok ? "valid secret key format" : `hrp=${hrp} len=${data.length}`,
      });
    } catch (err) {
      checks.push({ name: "nsec parses", ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return summarize("nostr", checks);
}
