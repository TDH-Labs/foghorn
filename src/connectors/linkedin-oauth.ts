// One-time interactive OAuth2 authorization-code grant for LinkedIn's Posts
// API (w_member_social). LinkedIn requires a human to click "Allow" in a
// browser -- this is NOT something Foghorn (or an agent) should ever do on
// the user's behalf. Run once per LinkedIn app: `foghorn connect linkedin authorize`.
//
// The pure pieces (URL construction, token exchange, env-file upsert) are
// unit tested with injected fetch/paths. The interactive orchestrator
// (local redirect listener + real browser click-through) is not -- same
// posture as the rest of this codebase's genuinely-live-only steps.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REDIRECT_PORT = 8934;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
export const SCOPES = "openid profile w_member_social";

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export function buildAuthUrl(clientId: string, state: string): string {
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(
  fetchImpl: typeof fetch,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<TokenResponse> {
  const res = await fetchImpl("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`token exchange failed: ${res.status} ${detail.slice(0, 200)}`.trim());
  }
  const token = (await res.json()) as TokenResponse;
  if (token.error) {
    throw new Error(`token exchange failed: ${token.error} ${token.error_description ?? ""}`.trim());
  }
  return token;
}

/** Upsert KEY=value lines into an .env-style file, preserving everything else. */
export function upsertEnvFile(path: string, entries: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  // split() on a trailing "\n" leaves a dangling "" element -- drop it or
  // appended keys land after a stray blank line instead of at the true end.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of Object.entries(entries)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(path, `${lines.join("\n").replace(/\n+$/, "")}\n`);
}

interface AuthorizeOpts {
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  envPath?: string;
  timeoutMs?: number;
}

export async function authorizeLinkedIn(opts: AuthorizeOpts = {}): Promise<void> {
  const clientId = opts.clientId ?? process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not set — create the app first, then set these in .env.local");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const envPath = opts.envPath ?? join(process.cwd(), ".env.local");
  const state = randomBytes(16).toString("hex");

  console.log(`\n1. Confirm this EXACT redirect URI is registered on your LinkedIn app (Auth tab):\n   ${REDIRECT_URI}\n`);
  console.log(`2. Open this URL, sign in, and click Allow:\n\n   ${buildAuthUrl(clientId, state)}\n`);
  console.log(`Waiting for the redirect (${Math.round((opts.timeoutMs ?? 120_000) / 1000)}s)...\n`);

  let stopped = false;
  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!stopped) { stopped = true; server.stop(); }
      reject(new Error("timed out waiting for the LinkedIn redirect"));
    }, opts.timeoutMs ?? 120_000);

    const finish = (fn: () => void) => {
      clearTimeout(timer);
      fn();
      if (!stopped) { stopped = true; setTimeout(() => server.stop(), 200); }
    };

    const server = Bun.serve({
      port: REDIRECT_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
        const err = url.searchParams.get("error");
        const returnedState = url.searchParams.get("state");
        const returnedCode = url.searchParams.get("code");
        if (err) {
          finish(() => reject(new Error(`linkedin denied: ${err} ${url.searchParams.get("error_description") ?? ""}`.trim())));
          return new Response("Denied — close this tab and check the terminal.");
        }
        if (returnedState !== state) {
          finish(() => reject(new Error("state mismatch on redirect — possible CSRF, aborting")));
          return new Response("State mismatch — close this tab and try again.");
        }
        if (!returnedCode) {
          finish(() => reject(new Error("no code in redirect")));
          return new Response("No code received — close this tab.");
        }
        finish(() => resolve(returnedCode));
        return new Response("Authorized — you can close this tab and return to the terminal.");
      },
    });
  });

  const token = await exchangeCode(fetchImpl, clientId, clientSecret, code);
  const entries: Record<string, string> = { LINKEDIN_ACCESS_TOKEN: token.access_token };
  if (token.refresh_token) entries.LINKEDIN_REFRESH_TOKEN = token.refresh_token;
  upsertEnvFile(envPath, entries);

  console.log(`\nwrote LINKEDIN_ACCESS_TOKEN (len=${token.access_token.length}, expires in ~${Math.round(token.expires_in / 86400)}d) to ${envPath}`);
  if (token.refresh_token) console.log(`wrote LINKEDIN_REFRESH_TOKEN (len=${token.refresh_token.length})`);
  console.log("verify with: foghorn connect linkedin\n");
}
