import { afterEach, describe, expect, test } from "bun:test";
import { migrate, openDb } from "../db/index.ts";
import { bech32Decode } from "./bech32.ts";
import { oauth1Header } from "./oauth1.ts";
import { validateBeeper, validateNostr, validateTelegram, validateX } from "./validators.ts";

const SAVED_ENV = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
});

describe("oauth1 signer", () => {
  test("matches the canonical X/Twitter documentation vector", () => {
    const header = oauth1Header(
      {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      "1318622958",
    );
    // Verified: base string is byte-identical to the documented vector, and
    // HMAC-SHA1(documented base, documented key) = hCtSmYh+iHYCEqBWrE7C7hYmtUk=
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });
});

describe("bech32", () => {
  test("decodes the BIP-173 minimal vector", () => {
    const { hrp, data } = bech32Decode("A12UEL5L");
    expect(hrp).toBe("a");
    expect(data.length).toBe(0);
  });

  test("decodes the NIP-19 nsec example to a 32-byte key", () => {
    const { hrp, data } = bech32Decode("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5");
    expect(hrp).toBe("nsec");
    expect(data.length).toBe(32);
    expect(data[0]).toBe(0x67);
    expect(data[1]).toBe(0xde);
  });

  test("rejects a corrupted checksum", () => {
    expect(() => bech32Decode("A12UEL5M")).toThrow(/checksum/);
  });
});

describe("validators (fetch-injected, zero writes)", () => {
  test("beeper: env missing fails fast without network", async () => {
    delete process.env.BEEPER_ACCESS_TOKEN;
    const result = await validateBeeper((() => {
      throw new Error("network must not be touched");
    }) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.checks[0]?.detail).toBe("missing");
  });

  test("beeper: token + reachable API passes", async () => {
    process.env.BEEPER_ACCESS_TOKEN = "tok";
    const fake = (async () => Response.json({ items: [{ id: "c1" }] })) as unknown as typeof fetch;
    const result = await validateBeeper(fake);
    expect(result.ok).toBe(true);
    expect(result.checks[1]?.detail).toContain("1 chat");
  });

  test("telegram: getMe round-trip", async () => {
    process.env.FOGHORN_TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.FOGHORN_TELEGRAM_CHAT_ID = "123456789";
    const fake = (async (input: string | URL | Request) => {
      expect(String(input)).toContain("/getMe");
      return Response.json({ ok: true, result: { username: "foghorn_bot" } });
    }) as unknown as typeof fetch;
    const result = await validateTelegram(fake);
    expect(result.ok).toBe(true);
    expect(result.checks.at(-1)?.detail).toContain("@foghorn_bot");
  });

  test("x: signs the read, records exactly one own-read ledger row", async () => {
    process.env.X_API_KEY = "k";
    process.env.X_API_KEY_SECRET = "ks";
    process.env.X_ACCESS_TOKEN = "t";
    process.env.X_ACCESS_TOKEN_SECRET = "ts";
    const db = openDb(":memory:");
    migrate(db);
    const fake = (async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      expect(auth).toContain("OAuth ");
      expect(auth).toContain("oauth_signature=");
      return Response.json({ data: { id: "1", username: "operator" } });
    }) as unknown as typeof fetch;
    const result = await validateX(db, fake);
    expect(result.ok).toBe(true);
    const ledger = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM spend_ledger WHERE category='x_own_read'").get();
    expect(ledger?.n).toBe(1);
    db.close();
  });

  test("nostr: format-validates the nsec locally", async () => {
    process.env.NOSTR_NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    const result = await validateNostr();
    expect(result.ok).toBe(true);
    process.env.NOSTR_NSEC = "nsec1corrupted";
    const bad = await validateNostr();
    expect(bad.ok).toBe(false);
  });
});
