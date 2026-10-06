import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LINKED_DOCS, OWNER_DOCS, ROOT, anchorsOf, headings, readRel, relativeLinks } from "./markdown";

/**
 * M6-DESIGN §6.7: the app and the scripts cite the owner's guides by title and step ("Going-live guide, step 3",
 * "Mailgun guide, step 9") or by file ("docs\setup\4-going-live.md, step 4", "docs\setup\1-install.md, Troubleshooting").
 * There is no in-app Help page, so a renumbered guide would silently break those sentences: this test finds every such
 * reference in src/**, worker/**, scripts/** (.ts, .mjs, .ps1) and the .bat files and checks that the guide has that
 * step ("## 3. …") or a "Troubleshooting" heading. It also checks that every relative link in the README and the guides
 * points at a file that exists, and that every "#anchor" is a heading there.
 */

/** The guide each title names, and its fixed first heading. */
const GUIDES: Record<string, { file: string; h1: string }> = {
  Install: { file: "1-install.md", h1: "Install guide" },
  Mailgun: { file: "2-mailgun-and-dns.md", h1: "Mailgun and DNS guide" },
  // MAIN-DOMAIN-DESIGN §6.1: the owner's own setup (sending through polygonparadise.com itself).
  "Own-mailbox": { file: "2-own-mailbox.md", h1: "Own-mailbox guide" },
  Cloudflare: { file: "3-cloudflare.md", h1: "Cloudflare guide (remote access)" },
  "Going-live": { file: "4-going-live.md", h1: "Going-live guide" },
};

/** How many numbered steps each guide has. The app cites them by number, so they only ever grow at the end. */
const STEP_COUNTS: Record<string, number> = {
  "1-install.md": 12,
  "2-mailgun-and-dns.md": 19,
  "2-own-mailbox.md": 16,
  "3-cloudflare.md": 16,
  "4-going-live.md": 13,
};

const SETUP_DIR = path.join(ROOT, "docs", "setup");

/** "Mailgun guide, step 9" (the title form). */
const TITLE_STEP = /\b(Install|Mailgun|Own-mailbox|Cloudflare|Going-live) guide, step (\d+)\b/g;
/** "docs\setup\3-cloudflare.md, step 7" (a TypeScript string writes each backslash twice). */
const FILE_STEP = /docs[\\/]+setup[\\/]+([\w.-]+\.md), step (\d+)\b/g;
/** "docs\setup\1-install.md, Troubleshooting". */
const FILE_NAMED = /docs[\\/]+setup[\\/]+([\w.-]+\.md), (Troubleshooting)\b/g;
/** Any mention of a guide file. */
const FILE_BARE = /docs[\\/]+setup[\\/]+([\w.-]+\.md)/g;

type Ref = { from: string; line: number; file: string; step: number | null; named: string | null; text: string };

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      walk(p, exts, out);
    } else if (exts.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/** The files the app and the scripts are made of (M6-DESIGN §6.7), relative, with "/". */
function codeFiles(): string[] {
  const files = [
    ...walk(path.join(ROOT, "src"), /\.(ts|tsx)$/),
    ...walk(path.join(ROOT, "worker"), /\.ts$/),
    ...walk(path.join(ROOT, "scripts"), /\.(ts|mjs|ps1)$/),
    ...fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.bat$/i.test(e.name))
      .map((e) => path.join(ROOT, e.name)),
  ];
  return files.map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
}

function lineOf(text: string, index: number | undefined): number {
  return text.slice(0, index ?? 0).split("\n").length;
}

/** Every guide reference in one file's text. */
function refsIn(from: string, text: string): Ref[] {
  const out: Ref[] = [];
  for (const m of text.matchAll(TITLE_STEP)) {
    out.push({ from, line: lineOf(text, m.index), file: GUIDES[m[1]!]!.file, step: Number(m[2]), named: null, text: m[0] });
  }
  for (const m of text.matchAll(FILE_STEP)) {
    out.push({ from, line: lineOf(text, m.index), file: m[1]!, step: Number(m[2]), named: null, text: m[0] });
  }
  for (const m of text.matchAll(FILE_NAMED)) {
    out.push({ from, line: lineOf(text, m.index), file: m[1]!, step: null, named: m[2]!, text: m[0] });
  }
  for (const m of text.matchAll(FILE_BARE)) {
    out.push({ from, line: lineOf(text, m.index), file: m[1]!, step: null, named: null, text: m[0] });
  }
  return out;
}

const guideText = new Map<string, string>();
function guide(file: string): string | null {
  if (!guideText.has(file)) {
    const p = path.join(SETUP_DIR, file);
    guideText.set(file, fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
  }
  const text = guideText.get(file)!;
  return text === "" ? null : text;
}

/** The step numbers of a guide's "## N. Title" headings, in file order. */
function stepNumbers(markdown: string): number[] {
  return headings(markdown)
    .filter((h) => h.level === 2)
    .map((h) => /^(\d+)\.\s/.exec(h.text))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
}

/** Why a reference doesn't resolve, or null when it does. */
function problemOf(ref: Ref): string | null {
  const text = guide(ref.file);
  if (text === null) return `docs/setup/${ref.file} doesn't exist`;
  if (ref.step !== null && !stepNumbers(text).includes(ref.step)) return `docs/setup/${ref.file} has no heading "## ${ref.step}. …"`;
  if (ref.named !== null && !headings(text).some((h) => h.text.includes(ref.named!))) {
    return `docs/setup/${ref.file} has no heading with "${ref.named}"`;
  }
  return null;
}

const allCodeRefs = codeFiles().flatMap((rel) => refsIn(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")));

describe("guide references in the app and the scripts", () => {
  it("finds the references the app and the scripts are known to make (so the scan works)", () => {
    const has = (from: string, text: string) => allCodeRefs.some((r) => r.from === from && r.text.replace(/\\\\/g, "\\") === text);
    expect(has("src/core/sending/mode-gates.ts", "Going-live guide, step 3")).toBe(true);
    expect(has("src/core/sending/mode-gates.ts", "Going-live guide, step 4")).toBe(true);
    expect(has("src/core/sending/mode-gates.ts", "Going-live guide, step 5")).toBe(true);
    expect(has("src/core/sending/mode-gates.ts", "Mailgun guide, step 9")).toBe(true);
    expect(has("src/core/dns/checklist.ts", "Cloudflare guide, step 6")).toBe(true);
    expect(has("scripts/status.ps1", "docs\\setup\\3-cloudflare.md, step 7")).toBe(true);
    expect(has("scripts/status.ps1", "docs\\setup\\4-going-live.md, step 4")).toBe(true);
    expect(has("scripts/install-services.ps1", "docs\\setup\\1-install.md, Troubleshooting")).toBe(true);
    expect(has("scripts/update.mjs", "docs\\setup\\1-install.md, Troubleshooting")).toBe(true);
    expect(has("setup.bat", "docs\\setup\\1-install.md")).toBe(true);
    // MAIN-DOMAIN-DESIGN §3.4: the go-live card and its recommendations cite the own-mailbox guide.
    expect(has("src/core/sending/go-live-copy.ts", "Own-mailbox guide, step 11")).toBe(true);
    expect(has("src/core/sending/mode-gates.ts", "Own-mailbox guide, step 14")).toBe(true);
    expect(has("src/core/sending/mode-gates.ts", "Own-mailbox guide, step 15")).toBe(true);
    expect(allCodeRefs.length).toBeGreaterThan(20);
  });

  it("every cited guide, step and heading exists", () => {
    const problems = allCodeRefs
      .map((r) => ({ r, problem: problemOf(r) }))
      .filter((x) => x.problem !== null)
      .map(({ r, problem }) => `${r.from}:${r.line} "${r.text}": ${problem}`);
    expect(problems).toEqual([]);
  });

  it("the owner's docs cite guide steps that exist too", () => {
    const problems = LINKED_DOCS.flatMap((rel) => refsIn(rel, readRel(rel)))
      .filter((r) => r.step !== null || r.named !== null)
      .map((r) => ({ r, problem: problemOf(r) }))
      .filter((x) => x.problem !== null)
      .map(({ r, problem }) => `${r.from}:${r.line} "${r.text}": ${problem}`);
    expect(problems).toEqual([]);
  });

  it("problemOf really refuses a missing step, a missing file and a missing heading", () => {
    const base = { from: "x", line: 1, text: "x" };
    expect(problemOf({ ...base, file: "4-going-live.md", step: 99, named: null })).toMatch(/no heading "## 99\./);
    expect(problemOf({ ...base, file: "5-nothing.md", step: 1, named: null })).toMatch(/doesn't exist/);
    expect(problemOf({ ...base, file: "4-going-live.md", step: null, named: "Troubleshooting" })).toMatch(/no heading with/);
    expect(problemOf({ ...base, file: "1-install.md", step: null, named: "Troubleshooting" })).toBeNull();
  });
});

describe("the guides", () => {
  it.each(Object.entries(GUIDES))("the %s guide keeps its title", (_name, g) => {
    const first = headings(guide(g.file) ?? "")[0];
    expect(first).toMatchObject({ level: 1, text: g.h1 });
  });

  it.each(Object.entries(STEP_COUNTS))("%s numbers its steps 1, 2, 3 … without gaps", (file, count) => {
    const steps = stepNumbers(guide(file) ?? "");
    expect(steps).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  });

  it("the Install guide keeps its Troubleshooting heading (the scripts name it)", () => {
    expect(headings(guide("1-install.md") ?? "").some((h) => h.text === "12. Troubleshooting")).toBe(true);
  });
});

describe("links in the README and the guides", () => {
  it.each(LINKED_DOCS.map((rel) => [rel]))("%s: every relative link points at a file and, with #, at a heading there", (rel) => {
    const source = readRel(rel);
    const problems: string[] = [];
    for (const link of relativeLinks(source)) {
      const [rawPath, anchor] = link.target.split("#", 2) as [string, string | undefined];
      const targetRel = rawPath === "" ? rel : path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), decodeURIComponent(rawPath))).replace(/\\/g, "/");
      const targetAbs = path.join(ROOT, targetRel);
      if (!fs.existsSync(targetAbs)) {
        problems.push(`${rel}:${link.line} ${link.target}: ${targetRel} doesn't exist`);
        continue;
      }
      if (anchor !== undefined && anchor !== "") {
        if (!targetRel.endsWith(".md")) {
          problems.push(`${rel}:${link.line} ${link.target}: an anchor into a file that isn't Markdown`);
        } else if (!anchorsOf(readRel(targetRel)).has(anchor)) {
          problems.push(`${rel}:${link.line} ${link.target}: ${targetRel} has no heading for #${anchor}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("the owner's docs link each other (so the check above has something to check)", () => {
    const count = OWNER_DOCS.reduce((n, rel) => n + relativeLinks(readRel(rel)).length, 0);
    expect(count).toBeGreaterThan(40);
    expect(relativeLinks(readRel("README.md")).map((l) => l.target)).toContain("docs/setup/4-going-live.md");
  });

  it("anchors follow GitHub's rule, including repeated headings", () => {
    const anchors = anchorsOf("# A\n\n## 6. Prepare the PC (setup-pc.bat)\n\n```\n## Not a heading\n```\n\n## Notes\n\n## Notes\n\n## Two policies: who may log in, and what is public\n");
    expect([...anchors]).toEqual(["a", "6-prepare-the-pc-setup-pcbat", "notes", "notes-1", "two-policies-who-may-log-in-and-what-is-public"]);
  });
});
