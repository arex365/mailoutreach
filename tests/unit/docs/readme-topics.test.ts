import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OWNER_DOCS, ROOT, headings, readRel } from "./markdown";

/**
 * The README is the owner's manual (SPEC "Testing and definition of done", M6-DESIGN §6.2): it covers SPEC's seven
 * topics under fixed headings, keeps the outline of §6.2, carries PLAN B11's promises (firewall, Node 26, antivirus,
 * cloudflared, uninstall-services.bat), and neither it nor the guides speak in the builder's voice or with build-history
 * words ("Milestone", question numbers like Q11, "I'll", "until I", "tell me"). A bare " I " stays allowed: the
 * Going-live guide quotes the dialog's "I understand that…".
 */

const README = readRel("README.md");
const readmeHeadings = headings(README);

/** SPEC's README topics, by the exact headings the design fixes (M6-DESIGN §6.2, §10.4). */
const SPEC_TOPICS = [
  "Install and first run",
  "Mailgun, DNS and reply routes",
  "Tracking off, unsubscribe on",
  "Cloudflare Tunnel and optional Access",
  "Your team",
  "When the PC is off, and keeping it awake",
  "Backups and restore",
];

/** The README's sections, in order (M6-DESIGN §6.2 rows 2–13; row 1 is the title). */
const OUTLINE = [
  "Start here",
  "Everyday use",
  "Your team",
  "Sending safely",
  "When the PC is off, and keeping it awake",
  "Backups and restore",
  "Updating",
  "The double-click scripts",
  "Troubleshooting",
  "What it costs",
  "Where things live",
  "Words used here, getting help, for developers",
];

/** PLAN B11's firewall sentence, word for word. */
const FIREWALL_SENTENCE =
  'If Windows asks whether to allow Node.js through the firewall, tick only "Private networks" (untick "Public networks") and click Allow. If you clicked Cancel by mistake, run setup-pc.bat again: it removes the block rule that Cancel creates.';

/** Words that don't belong in a document for the owner (build history and the builder's voice). */
const FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Milestone", re: /milestone/i },
  { name: "a question number (Q8–Q14)", re: /\bQ(8|9|1[0-4])\b/ },
  { name: "I'll", re: /\bI['’]ll\b/ },
  { name: "until I", re: /\buntil I\b/ },
  { name: "tell me", re: /\btell me\b/i },
];

describe("the README covers SPEC's topics", () => {
  it.each(SPEC_TOPICS)('has the heading "%s"', (topic) => {
    expect(readmeHeadings.filter((h) => h.level >= 2 && h.level <= 4).map((h) => h.text)).toContain(topic);
  });

  it("the four setup topics are sub-sections of Start here", () => {
    const start = readmeHeadings.findIndex((h) => h.level === 2 && h.text === "Start here");
    const next = readmeHeadings.findIndex((h, i) => i > start && h.level === 2);
    const inside = readmeHeadings.slice(start + 1, next).filter((h) => h.level === 3).map((h) => h.text);
    expect(inside).toEqual(SPEC_TOPICS.slice(0, 4));
  });

  it("keeps the outline: title, then the sections in order", () => {
    expect(readmeHeadings[0]).toMatchObject({ level: 1, text: "Polygon Paradise Outreach" });
    expect(readmeHeadings.filter((h) => h.level === 1)).toHaveLength(1);
    expect(readmeHeadings.filter((h) => h.level === 2).map((h) => h.text)).toEqual(OUTLINE);
  });

  it("says in its first lines how to read these files", () => {
    const opening = README.split(/\r?\n/).slice(0, 12).join("\n");
    expect(opening).toContain(
      "These files are easiest to read in a browser or VS Code; in Notepad they show as plain text, which still works.",
    );
  });

  it("lists the four guides in order under Start here", () => {
    const start = README.indexOf("## Start here");
    const order = ["docs/setup/1-install.md", "docs/setup/2-mailgun-and-dns.md", "docs/setup/3-cloudflare.md", "docs/setup/4-going-live.md"].map(
      (g) => README.indexOf(`](${g})`, start),
    );
    expect(order.every((i) => i > start)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("carries PLAN B11's promises", () => {
    expect(README).toContain(FIREWALL_SENTENCE);
    for (const needle of ["uninstall-services.bat", "Private networks", "2026.8.0", "2026.8.1", "Node 26", "quarantin"]) {
      expect(README, needle).toContain(needle);
    }
    expect(README).toContain("https://nodejs.org/dist/latest-v24.x/");
  });

  it("points developers to docs/dev/README.md, which exists", () => {
    expect(README).toMatch(/Developers: see \[docs\/dev\/README\.md\]\(docs\/dev\/README\.md\)\./);
    expect(fs.existsSync(path.join(ROOT, "docs", "dev", "README.md"))).toBe(true);
  });

  it("the double-click scripts table names every .bat file in the app folder", () => {
    const bats = fs.readdirSync(ROOT).filter((f) => /\.bat$/i.test(f));
    expect(bats.length).toBeGreaterThanOrEqual(11);
    const section = README.slice(README.indexOf("## The double-click scripts"), README.indexOf("## Troubleshooting"));
    for (const bat of bats) expect(section, bat).toContain(`\`${bat}\``);
  });
});

describe("the owner's docs speak plainly", () => {
  it.each(OWNER_DOCS.map((rel) => [rel]))("%s has no build-history words or builder's voice", (rel) => {
    const lines = readRel(rel).split(/\r?\n/);
    const hits: string[] = [];
    lines.forEach((line, i) => {
      for (const f of FORBIDDEN) if (f.re.test(line)) hits.push(`${rel}:${i + 1} ${f.name}: ${line.trim().slice(0, 120)}`);
    });
    expect(hits).toEqual([]);
  });

  it("the check above really catches those words", () => {
    const sample = ["Arrives in Milestone 6.", "Ask me (Q11).", "I'll send it.", "Wait until I say so.", "Tell me the answers."];
    for (const [i, f] of FORBIDDEN.entries()) expect(f.re.test(sample[i]!), f.name).toBe(true);
    // A bare " I " is fine: the Going-live guide quotes "I understand that real prospects will get emails from now on."
    expect(FORBIDDEN.some((f) => f.re.test("I understand that real prospects will get emails from now on."))).toBe(false);
  });

  it("never says the backups folder keeps only 14, or pins Node.js 24.21.0", () => {
    for (const rel of OWNER_DOCS) {
      const text = readRel(rel);
      expect(text, rel).not.toMatch(/last 14 are kept/i);
      expect(text, rel).not.toContain("24.21.0");
    }
  });

  it("the Install guide gives the Node.js 24 download sentence", () => {
    expect(readRel("docs/setup/1-install.md")).toContain(
      "Install Node.js 24 (not 26): open https://nodejs.org/dist/latest-v24.x/ and download the file ending in -x64.msi. Any 24.x from 24.18 works; the app refuses 26.",
    );
  });
});
