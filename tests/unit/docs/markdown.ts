import fs from "node:fs";
import path from "node:path";

/**
 * Small Markdown readers for the docs tests (M6-DESIGN §6.7): the headings of a file (outside code blocks), the anchor
 * each heading gets on GitHub and in VS Code's preview, and the relative links a file makes. No Markdown package: the
 * owner's docs use plain ATX headings ("## 3. Title") and inline links only, and these tests pin that.
 */

export const ROOT = path.resolve(__dirname, "../../..");

/**
 * The owner's docs: the README and the guides (M6-DESIGN §6.2–§6.4), with the own-mailbox guide (MAIN-DOMAIN-DESIGN §6.1,
 * the owner's own setup), so every owner-doc rule applies to it too.
 */
export const OWNER_DOCS = [
  "README.md",
  "docs/setup/1-install.md",
  "docs/setup/2-mailgun-and-dns.md",
  "docs/setup/2-own-mailbox.md",
  "docs/setup/3-cloudflare.md",
  "docs/setup/4-going-live.md",
] as const;

/** Every Markdown file whose links are checked: the owner's docs and the developers' README. */
export const LINKED_DOCS = [...OWNER_DOCS, "docs/dev/README.md"] as const;

export function readRel(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

export type Heading = { level: number; text: string; line: number };

/** Lines outside fenced code blocks (``` or ~~~), with their 1-based line numbers. */
export function proseLines(markdown: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let fence: string | null = null;
  markdown.split(/\r?\n/).forEach((text, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(text);
    if (m) {
      if (fence === null) fence = m[1]![0]!;
      else if (m[1]![0] === fence) fence = null;
      return;
    }
    if (fence === null) out.push({ text, line: i + 1 });
  });
  return out;
}

/** ATX headings ("## 3. Title"), outside code blocks. */
export function headings(markdown: string): Heading[] {
  const out: Heading[] = [];
  for (const { text, line } of proseLines(markdown)) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (m) out.push({ level: m[1]!.length, text: m[2]!, line });
  }
  return out;
}

/** A heading's visible text: inline links and images become their text, code and emphasis marks go. */
export function plainHeadingText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
}

/**
 * GitHub's anchor for a heading (VS Code's preview uses the same rule): lower case, every character that isn't a letter,
 * a digit, "_", "-" or a space removed, spaces turned into "-". "## 6. Prepare the PC (setup-pc.bat)" →
 * "6-prepare-the-pc-setup-pcbat".
 */
export function slugOf(text: string): string {
  return plainHeadingText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** Every anchor of a file, with GitHub's "-1", "-2" suffixes for repeated headings. */
export function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const h of headings(markdown)) {
    const base = slugOf(h.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

export type DocLink = { target: string; line: number };

/** Inline links "[text](target)" outside code blocks and inline code; external ones (http, mailto) left out. */
export function relativeLinks(markdown: string): DocLink[] {
  const out: DocLink[] = [];
  for (const { text, line } of proseLines(markdown)) {
    const withoutCode = text.replace(/`[^`]*`/g, "");
    for (const m of withoutCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      out.push({ target, line });
    }
  }
  return out;
}
