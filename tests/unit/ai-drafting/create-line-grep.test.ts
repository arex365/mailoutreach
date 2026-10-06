import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * M5-DESIGN §3.3 and §7.4 item 3: the spend guard is valid in-process only because nothing but the drafting job
 * (src/server/ai/**) calls Claude's paid `messages.create` through `ClaudeApi.createLine`. Any other file in src/** or
 * worker/** that calls `.createLine(` fails this test (tests may call it: they talk to the fake Claude or a stub).
 */

const ROOT = path.resolve(__dirname, "../../..");
const NEEDLE = /\.createLine\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function rel(file: string): string {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

describe("Claude's paid call", () => {
  it("is made only by the drafting job (src/server/ai/**)", () => {
    const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "worker"))].map(rel);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((f) => !f.startsWith("src/server/ai/"))
      .filter((f) => NEEDLE.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("is really made there (so the test above guards something)", () => {
    const text = fs.readFileSync(path.join(ROOT, "src/server/ai/drafter.ts"), "utf8");
    expect(NEEDLE.test(text)).toBe(true);
  });

  it("the needle catches the call forms and not the method's own definition", () => {
    expect(NEEDLE.test("await cx.api.createLine(req)")).toBe(true);
    expect(NEEDLE.test("api?.createLine (req)")).toBe(true);
    expect(NEEDLE.test("  async createLine(params) {")).toBe(false);
    expect(NEEDLE.test("createLine(params: LineRequest): Promise<ClaudeAnswer>;")).toBe(false);
  });
});
