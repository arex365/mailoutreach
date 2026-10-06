import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * M3-DESIGN §0.2 rule 3 and §6.4: Mailgun's real host names appear in exactly one file,
 * src/server/mailgun/base-url.ts, where the fake-mode and test-run rules guard them. Any other file in src/** or
 * worker/** that mentions "mailgun.net" fails this test, so no code path can call the real Mailgun by accident.
 */

const ROOT = path.resolve(__dirname, "../../..");
const ALLOWED = new Set(["src/server/mailgun/base-url.ts"]);
const NEEDLE = /mailgun\.net/i;

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

describe("real Mailgun host names", () => {
  it("appear only in src/server/mailgun/base-url.ts", () => {
    const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "worker"))];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => NEEDLE.test(fs.readFileSync(path.join(ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("are really in base-url.ts (so the test above guards something)", () => {
    const text = fs.readFileSync(path.join(ROOT, "src/server/mailgun/base-url.ts"), "utf8");
    expect(NEEDLE.test(text)).toBe(true);
  });
});
