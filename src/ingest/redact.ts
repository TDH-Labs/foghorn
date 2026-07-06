// Ingest-time PII tagging + text normalization for shingling.
// Tags are stored on the message row; the secrets-pii gate uses its own
// (stricter) pass at draft time — this is defense-in-depth bookkeeping.

const PII_PATTERNS: Record<string, RegExp> = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  phone: /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b/,
  card: /\b(?:\d[ -]*?){13,16}\b/,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
};

export function piiFlags(text: string): string[] {
  const flags: string[] = [];
  for (const [kind, re] of Object.entries(PII_PATTERNS)) {
    if (re.test(text)) flags.push(kind);
  }
  return flags;
}

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
export function normalizeForShingles(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}
