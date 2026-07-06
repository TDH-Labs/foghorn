import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthUrl, exchangeCode, REDIRECT_URI, SCOPES, upsertEnvFile } from "./linkedin-oauth.ts";

describe("buildAuthUrl", () => {
  test("includes response_type, client_id, redirect_uri, scope, state", () => {
    const url = new URL(buildAuthUrl("client-123", "state-abc"));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(SCOPES);
    expect(url.searchParams.get("state")).toBe("state-abc");
  });
});

describe("exchangeCode", () => {
  test("posts the correct form body and returns the parsed token", async () => {
    let captured: { url: string; contentType: string | undefined; body: string } | undefined;
    const fake = (async (input: string | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        contentType: (init?.headers as Record<string, string>)["content-type"],
        body: String(init?.body),
      };
      return Response.json({ access_token: "at-1", expires_in: 5184000, refresh_token: "rt-1" });
    }) as unknown as typeof fetch;

    const token = await exchangeCode(fake, "client-1", "secret-1", "code-1");
    expect(token.access_token).toBe("at-1");
    expect(token.refresh_token).toBe("rt-1");
    expect(captured?.url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(captured?.contentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(captured?.body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code-1");
    expect(params.get("client_id")).toBe("client-1");
    expect(params.get("client_secret")).toBe("secret-1");
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  test("throws on an error response, HTTP-level or in-body", async () => {
    const httpErr = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode(httpErr, "c", "s", "code")).rejects.toThrow(/400/);

    const bodyErr = (async () => Response.json({ error: "invalid_grant", error_description: "code expired" })) as unknown as typeof fetch;
    await expect(exchangeCode(bodyErr, "c", "s", "code")).rejects.toThrow(/invalid_grant/);
  });
});

describe("upsertEnvFile", () => {
  test("creates a new file when none exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "foghorn-env-"));
    const path = join(dir, ".env.local");
    upsertEnvFile(path, { LINKEDIN_ACCESS_TOKEN: "tok-1" });
    expect(readFileSync(path, "utf8")).toBe("LINKEDIN_ACCESS_TOKEN=tok-1\n");
  });

  test("replaces an existing key in place, appends new keys, preserves everything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "foghorn-env-"));
    const path = join(dir, ".env.local");
    writeFileSync(path, "ANTHROPIC_API_KEY=sk-ant-existing\nLINKEDIN_ACCESS_TOKEN=old-token\n");
    upsertEnvFile(path, { LINKEDIN_ACCESS_TOKEN: "new-token", LINKEDIN_REFRESH_TOKEN: "refresh-1" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toEqual([
      "ANTHROPIC_API_KEY=sk-ant-existing",
      "LINKEDIN_ACCESS_TOKEN=new-token",
      "LINKEDIN_REFRESH_TOKEN=refresh-1",
    ]);
  });
});
