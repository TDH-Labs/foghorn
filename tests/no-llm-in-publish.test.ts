// Structural guarantee: the send path contains zero LLM reachability.
// Walks the import graph from every file under src/publish/ and fails if it
// reaches src/llm/ or any LLM SDK package. This is the codified Friday/Leo
// lesson — "never put an LLM in the send path" — as a test, not a convention.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH_DIR = join(ROOT, "src", "publish");
const FORBIDDEN_DIRS = [join(ROOT, "src", "llm")];
const FORBIDDEN_PACKAGES = [
  /^@anthropic-ai\//,
  /^ai$/,
  /^@ai-sdk\//,
  /^openai$/,
  /openrouter/i,
  /^@google\/generative-ai$/,
];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  const patterns = [
    /import\s+[^"']*?from\s+["']([^"']+)["']/g,
    /import\s+["']([^"']+)["']/g,
    /export\s+[^"']*?from\s+["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) specs.push(m[1]!);
  }
  return specs;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

describe("no LLM in the send path", () => {
  test("import graph from src/publish/** never reaches src/llm or an LLM SDK", () => {
    const queue = tsFilesUnder(PUBLISH_DIR);
    const seen = new Set<string>(queue);
    const violations: string[] = [];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (FORBIDDEN_DIRS.some((d) => file.startsWith(d + "/") || file === d)) {
        violations.push(`reached forbidden module: ${file}`);
        continue;
      }
      for (const spec of importSpecifiers(file)) {
        if (spec.startsWith(".")) {
          const resolved = resolveRelative(file, spec);
          if (resolved && !seen.has(resolved)) {
            seen.add(resolved);
            queue.push(resolved);
          }
        } else if (spec.startsWith("node:") || spec === "bun:sqlite" || spec === "bun:test") {
          // runtime builtins are fine
        } else if (FORBIDDEN_PACKAGES.some((re) => re.test(spec))) {
          violations.push(`${file} imports forbidden package '${spec}'`);
        }
      }
    }

    expect(seen.size).toBeGreaterThan(3); // sanity: the walk actually traversed
    expect(violations).toEqual([]);
  });

  test("meta: the walker DOES catch a forbidden import (self-test)", () => {
    // If src/llm/generate.ts ever stops matching the forbidden list, this fails
    // and the structural test above is known to be toothless.
    const llmFile = join(ROOT, "src", "llm", "generate.ts");
    const specs = importSpecifiers(llmFile);
    expect(specs.some((s) => FORBIDDEN_PACKAGES.some((re) => re.test(s)))).toBe(true);
  });
});
