// Word n-gram shingle hashes for the private-leak gate.
// Others' messages index at n=8 (any overlap = hard block);
// own private-chat messages at n=13 (verbatim self-quotes blocked too).

import { createHash } from "node:crypto";
import { normalizeForShingles } from "./redact.ts";

export const OTHERS_N = 8;
export const SELF_N = 13;

export function shingleHashes(text: string, n: number): string[] {
  const words = normalizeForShingles(text);
  if (words.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) {
    const gram = words.slice(i, i + n).join(" ");
    out.push(createHash("sha256").update(`${n}|${gram}`).digest("hex").slice(0, 24));
  }
  return [...new Set(out)];
}
