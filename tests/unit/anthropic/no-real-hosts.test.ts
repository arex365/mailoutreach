import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * M5-DESIGN §0.2 rule 5 and §7.4: Anthropic's real host name appears in exactly one file,
 * src/server/anthropic/base-url.ts, where the fake-mode and test-run rules guard it. Any other file in src/** or
 * worker/** that mentions "api.anthropic.com" fails this test, so no code path can call the real API by accident
 * (the twin of tests/unit/mailgun-client/no-real-hosts.test.ts). The SDK itself is only imported by that folder.
 */

const ROOT = path.resolve(__dirname, "../../..");
const ALLOWED = new Set(["src/server/anthropic/base-url.ts"]);
const NEEDLE = /api\.anthropic\.com/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|mjs|cjs|mts|json)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function sourceFiles(): string[] {
  return [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "worker"))].map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
}

describe("the real Anthropic host name", () => {
  it("appears only in src/server/anthropic/base-url.ts", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((rel) => !ALLOWED.has(rel)).filter((rel) => NEEDLE.test(fs.readFileSync(path.join(ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("is really in base-url.ts (so the test above guards something)", () => {
    const text = fs.readFileSync(path.join(ROOT, "src/server/anthropic/base-url.ts"), "utf8");
    expect(NEEDLE.test(text)).toBe(true);
  });

  it("the SDK is imported only by src/server/anthropic (and the worker's --self-test, which only loads it)", () => {
    const offenders = sourceFiles()
      .filter((rel) => !rel.startsWith("src/server/anthropic/") && rel !== "worker/index.ts")
      .filter((rel) => /from\s+["']@anthropic-ai\/sdk|import\(\s*["']@anthropic-ai\/sdk|require\(\s*["']@anthropic-ai\/sdk/.test(fs.readFileSync(path.join(ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });
});
