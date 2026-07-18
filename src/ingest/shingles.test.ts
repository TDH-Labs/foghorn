import { describe, expect, test } from "bun:test";
import { OTHERS_N, SELF_N, shingleHashes } from "./shingles.ts";
import { normalizeForShingles, piiFlags } from "./redact.ts";

describe("normalization", () => {
  test("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeForShingles("Hello,   WORLD!! It's-me…")).toEqual([
      "hello", "world", "it", "s", "me",
    ]);
  });
  test("handles unicode letters", () => {
    expect(normalizeForShingles("café Ölpreis 42%")).toEqual(["café", "ölpreis", "42"]);
  });
});

describe("shingles", () => {
  const words12 = "one two three four five six seven eight nine ten eleven twelve";

  test("returns empty when text shorter than n", () => {
    expect(shingleHashes("too short", OTHERS_N)).toEqual([]);
    expect(shingleHashes(words12, SELF_N)).toEqual([]);
  });

  test("n-gram count = words - n + 1", () => {
    expect(shingleHashes(words12, 8)).toHaveLength(12 - 8 + 1);
  });

  test("deterministic and n-scoped (same gram, different n => different hash)", () => {
    const a = shingleHashes(words12, 8);
    const b = shingleHashes(words12, 8);
    expect(a).toEqual(b);
    const wider = shingleHashes(words12, 12);
    expect(wider).toHaveLength(1);
    expect(a).not.toContain(wider[0]);
  });

  test("punctuation/case variants collide (normalized before hashing)", () => {
    const x = shingleHashes("The Quick, Brown Fox! jumps over the lazy dog", 8);
    const y = shingleHashes("the quick brown fox jumps over the lazy DOG", 8);
    expect(x.some((h) => y.includes(h))).toBe(true);
  });
});

describe("pii flags", () => {
  test("detects email, phone, card, ssn", () => {
    expect(piiFlags("mail me at user@example.com")).toContain("email");
    expect(piiFlags("call (913) 555-0142 tonight")).toContain("phone");
    expect(piiFlags("card 4111 1111 1111 1111 exp 09/28")).toContain("card");
    expect(piiFlags("ssn 123-45-6789")).toContain("ssn");
  });
  test("clean text has no flags", () => {
    expect(piiFlags("let's ship the gate chain tomorrow")).toEqual([]);
  });
});
