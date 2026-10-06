import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * M5-DESIGN §7.4 item 3 and §8 P3 "Done when": website reading and drafting stay in the worker. No file under
 * src/app, src/components or src/lib imports src/server/web, src/server/ai, undici, cheerio or the HTML parser and
 * charset sniffer the extractor uses directly (htmlparser2, encoding-sniffer) (static or dynamic import, require, or a
 * relative path into those folders).
 */

const ROOT = path.resolve(__dirname, "../../..");
const WEB_DIRS = ["src/app", "src/components", "src/lib"];

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["@/server/web", /["'](?:@\/server\/web|(?:\.\.\/)+(?:src\/)?server\/web)(?:\/[^"']*)?["']/],
  ["@/server/ai", /["'](?:@\/server\/ai|(?:\.\.\/)+(?:src\/)?server\/ai)(?:\/[^"']*)?["']/],
  ["undici", /["']undici(?:\/[^"']*)?["']/],
  ["cheerio", /["']cheerio(?:\/[^"']*)?["']/],
  ["htmlparser2", /["']htmlparser2(?:\/[^"']*)?["']/],
  ["encoding-sniffer", /["']encoding-sniffer(?:\/[^"']*)?["']/],
];
const IMPORT_LINE = /\b(?:import|export)\b[^;]*?\bfrom\s*["'][^"']+["']|\bimport\s*\(\s*["'][^"']+["']\s*\)|\brequire\s*\(\s*["'][^"']+["']\s*\)|^\s*import\s*["'][^"']+["']/gm;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

function offenders(files: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const statement of text.match(IMPORT_LINE) ?? []) {
      for (const [name, re] of FORBIDDEN) {
        if (re.test(statement)) found.push(`${path.relative(ROOT, file).replace(/\\/g, "/")} imports ${name}`);
      }
    }
  }
  return found;
}

describe("web code never imports the website reader or the drafting code", () => {
  it("src/app, src/components and src/lib are clean", () => {
    const files = WEB_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
    expect(files.length).toBeGreaterThan(50);
    expect(offenders(files)).toEqual([]);
  });

  it("the check catches every import form (so the test above guards something)", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, "data", "grep-web-"));
    try {
      const samples = [
        'import { defaultWebsiteReader } from "@/server/web";',
        'import type { ReadPage } from "@/server/web/types";',
        'export { createReader } from "../../server/web/reader";',
        'const m = await import("@/server/ai/run");',
        'import { fetch } from "undici";',
        'const cheerio = require("cheerio");',
        'import "cheerio/slim";',
        'import { Parser } from "htmlparser2";',
        'const { decodeBuffer } = await import("encoding-sniffer");',
      ];
      samples.forEach((s, i) => fs.writeFileSync(path.join(tmp, `s${i}.ts`), `${s}\n`));
      fs.writeFileSync(path.join(tmp, "ok.ts"), 'import { webhook } from "@/server/webhooks";\nconst s = "undici";\n');
      const found = offenders(walk(tmp));
      expect(found).toHaveLength(samples.length);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
