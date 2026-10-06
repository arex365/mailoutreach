import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * No "Milestone N" in anything a person can see (M6-DESIGN §0.2 rule 3, §2.7, §8 P10, D36). The owner never hears about
 * the build's milestones: not on a screen, in a toast, an email, a script's window or the manual.
 *
 * - Code (`src/**` and `worker/**` .ts/.tsx, `scripts/**` .ts/.mjs): only what can reach a person is read: string
 *   literals, the parts of template literals and JSX text, collected with the TypeScript parser. Comments are skipped,
 *   so the milestone history in doc comments stays.
 * - PowerShell (`scripts/**` .ps1): every line that isn't a comment (`# …` lines and `<# … #>` blocks).
 * - The double-click scripts (the root `*.bat` files), `README.md` and `docs/setup/**`: the whole file.
 *
 * The developers' files (`docs/dev/**`, `tests/**`) may name milestones: they are build history.
 */

const ROOT = path.resolve(__dirname, "../../..");
const MILESTONE = /\bMilestone\s*\d/i;

type Hit = { file: string; line: number; text: string };

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      walk(p, accept, out);
    } else if (accept(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).replace(/\\/g, "/");

/**
 * The text of a TypeScript/JavaScript file a person could see: string literals, template literal parts (head, middle,
 * tail, or a template without substitutions) and JSX text, each with its 1-based line. Comments never appear here.
 */
function visibleStrings(fileName: string, text: string): Array<{ text: string; line: number }> {
  const kind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : /\.(mjs|cjs|js)$/.test(fileName)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out: Array<{ text: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      out.push({ text: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** A PowerShell file's lines without its comments (`<# … #>` blocks and lines that start with `#`), with line numbers. */
function powershellCodeLines(text: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("#>");
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (let start = line.indexOf("<#"); start >= 0; start = line.indexOf("<#")) {
      const end = line.indexOf("#>", start + 2);
      if (end < 0) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    out.push({ text: line, line: i + 1 });
  });
  return out;
}

function hitsIn(file: string, pieces: Array<{ text: string; line: number }>): Hit[] {
  return pieces.filter((p) => MILESTONE.test(p.text)).map((p) => ({ file: rel(file), line: p.line, text: p.text.trim().slice(0, 120) }));
}

function wholeFileHits(file: string): Hit[] {
  return hitsIn(
    file,
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((text, i) => ({ text, line: i + 1 })),
  );
}

const codeFiles = [
  ...walk(path.join(ROOT, "src"), (n) => /\.(ts|tsx)$/.test(n)),
  ...walk(path.join(ROOT, "worker"), (n) => /\.(ts|tsx)$/.test(n)),
  ...walk(path.join(ROOT, "scripts"), (n) => /\.(ts|mjs)$/.test(n)),
];
const powershellFiles = walk(path.join(ROOT, "scripts"), (n) => n.endsWith(".ps1"));
const batFiles = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".bat"))
  .map((e) => path.join(ROOT, e.name));
const ownerDocs = [path.join(ROOT, "README.md"), ...walk(path.join(ROOT, "docs", "setup"), () => true)];

describe("the collectors", () => {
  it("find strings, template parts and JSX text, and never comments", () => {
    const code = [
      "// Milestone 6 (a comment)",
      "/** Milestone 5: a doc comment */",
      'const a = "Dashboard arrives in Milestone 6";',
      "const b = `Step ${n}: Milestone 7 soon`;",
      "const c = `plain Milestone 8 text`;",
      "export const E = () => <p title=\"Milestone 9\">Coming in Milestone 10</p>;",
    ].join("\n");
    const found = visibleStrings("x.tsx", code).filter((s) => MILESTONE.test(s.text));
    expect(found.map((s) => [s.line, s.text.match(/Milestone \d+/)![0]])).toEqual([
      [3, "Milestone 6"],
      [4, "Milestone 7"],
      [5, "Milestone 8"],
      [6, "Milestone 9"],
      [6, "Milestone 10"],
    ]);
  });

  it("read .mjs files as JavaScript", () => {
    expect(visibleStrings("x.mjs", 'console.log("Milestone 3 update"); // Milestone 4').map((s) => s.text)).toEqual(["Milestone 3 update"]);
  });

  it("skip PowerShell comments, whole lines and blocks", () => {
    const ps = [
      "# Milestone 1 note",
      "<# Milestone 2",
      "   still a comment #>",
      'Write-Host "Milestone 3 update"',
      "$x = 1 <# Milestone 4 #> + 1",
    ].join("\r\n");
    expect(powershellCodeLines(ps).filter((l) => MILESTONE.test(l.text)).map((l) => l.line)).toEqual([4]);
  });
});

describe("no \"Milestone N\" that a person can see", () => {
  it("scans the app, the worker, the scripts, the double-click files and the owner's docs", () => {
    expect(codeFiles.length).toBeGreaterThan(400);
    expect(codeFiles.some((f) => rel(f) === "src/app/(app)/dashboard/page.tsx")).toBe(true);
    expect(powershellFiles.length).toBeGreaterThan(3);
    expect(batFiles.map((f) => path.basename(f).toLowerCase())).toEqual(expect.arrayContaining(["start.bat", "setup.bat", "update.bat", "restore.bat"]));
    expect(ownerDocs.map(rel)).toEqual(expect.arrayContaining(["README.md", "docs/setup/4-going-live.md"]));
  });

  it("in the code's strings, template literals and JSX text", () => {
    const hits = codeFiles.flatMap((f) => hitsIn(f, visibleStrings(f, fs.readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
  });

  it("in the PowerShell scripts' code lines", () => {
    const hits = powershellFiles.flatMap((f) => hitsIn(f, powershellCodeLines(fs.readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
  });

  it("in the double-click .bat files, the README and the setup guides", () => {
    const hits = [...batFiles, ...ownerDocs].flatMap(wholeFileHits);
    expect(hits).toEqual([]);
  });

  it("while the code's comments keep their milestone history (so skipping comments is what lets this pass)", () => {
    const commented = codeFiles.filter((f) => MILESTONE.test(fs.readFileSync(f, "utf8")));
    expect(commented.length).toBeGreaterThan(10);
  });
});
