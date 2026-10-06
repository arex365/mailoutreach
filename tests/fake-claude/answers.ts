import fs from "node:fs";
import path from "node:path";

/**
 * How the fake Claude server (and stubClaudeApi) decide what to answer (M5-DESIGN §7.2): after queued faults and
 * scripts, the fixture site's `claude.json` for the homepage URL found in <website_pages>, else the "echo" answer
 * (the first 8 words of the homepage text as the quote, and a line that passes the automatic checks).
 */

/** A page line of the user message's <website_pages> block (M5-DESIGN §3.5.3). */
export type FakePage = { source: string; url: string; lang: string | null; title: string | null; text: string };

/**
 * The echo answer's line: 11 words, no names or numbers, so it passes every check. (The first echo line, "Your homepage
 * describes the products your company makes and sells.", is what the lead saw on the cyrillic.example card: it now
 * fails the banned "your homepage" wording and gets the "may be too general" warning, M5 review LEAD-1.)
 */
export const ECHO_LINE = "Your company tells visitors about its own work in plain words.";
/** How many words of the homepage text the echo answer quotes. */
export const ECHO_QUOTE_WORDS = 8;

/** The user message's text: the last user turn (a string, or its text blocks joined). */
export function userTextOf(body: unknown): string {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
        .join("\n");
    }
    return "";
  }
  return "";
}

/** The pages of a user message: one JSON object per line between <website_pages> and </website_pages>. */
export function pagesFromUserText(text: string): FakePage[] {
  const start = text.indexOf("<website_pages>");
  if (start < 0) return [];
  const end = text.indexOf("</website_pages>", start);
  const block = text.slice(start + "<website_pages>".length, end < 0 ? undefined : end);
  const out: FakePage[] = [];
  for (const line of block.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Partial<FakePage>;
      out.push({
        source: typeof o.source === "string" ? o.source : "",
        url: typeof o.url === "string" ? o.url : "",
        lang: typeof o.lang === "string" ? o.lang : null,
        title: typeof o.title === "string" ? o.title : null,
        text: typeof o.text === "string" ? o.text : "",
      });
    } catch {
      // not a page line
    }
  }
  return out;
}

/** The default answer: quote the homepage's first 8 words; no homepage text means "too little text". */
export function echoAnswer(userText: string): Record<string, unknown> {
  const home = pagesFromUserText(userText).find((p) => p.source === "homepage");
  const words = (home?.text ?? "").split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return { evidence_source: "none", evidence_quote: null, line: null, reason_if_null: "too_little_text" };
  }
  return {
    evidence_source: "homepage",
    evidence_quote: words.slice(0, ECHO_QUOTE_WORDS).join(" "),
    line: ECHO_LINE,
    reason_if_null: null,
  };
}

/** The origins a fixture site answers for: `origin`, plus `origins` / `aliases` when the site has several. */
function siteOrigins(site: unknown): string[] {
  const o = (site && typeof site === "object" ? site : {}) as { origin?: unknown; origins?: unknown; aliases?: unknown };
  const list: unknown[] = [o.origin, ...(Array.isArray(o.origins) ? o.origins : []), ...(Array.isArray(o.aliases) ? o.aliases : [])];
  return list.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Same site: the same origin, or the same host once a leading "www." is ignored. */
function sameSite(a: URL, origin: string): boolean {
  let b: URL;
  try {
    b = new URL(origin);
  } catch {
    return false;
  }
  if (a.origin === b.origin) return true;
  const host = (h: string) => h.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return host(a.hostname) === host(b.hostname);
}

/**
 * The fixture site's `claude.json` for the homepage URL in the user message (M5-DESIGN §7.3), or null when there is
 * no fixtures folder, no homepage, no matching site or no readable answer file.
 */
export function fixtureAnswer(sitesDir: string | null | undefined, userText: string): Record<string, unknown> | string | null {
  if (!sitesDir) return null;
  const home = pagesFromUserText(userText).find((p) => p.source === "homepage");
  if (!home?.url) return null;
  let url: URL;
  try {
    url = new URL(home.url);
  } catch {
    return null;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sitesDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sitesDir, entry.name);
    let site: unknown;
    try {
      site = JSON.parse(fs.readFileSync(path.join(dir, "site.json"), "utf8"));
    } catch {
      continue;
    }
    if (!siteOrigins(site).some((o) => sameSite(url, o))) continue;
    const file = path.join(dir, "claude.json");
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : raw;
    } catch {
      // A broken claude.json is answered as it is (a "bad JSON" answer).
      return raw;
    }
  }
  return null;
}

/** Characters counted by the fake's count_tokens: the system prompt and every text of the messages. */
export function promptCharacters(body: unknown): number {
  const b = (body && typeof body === "object" ? body : {}) as { system?: unknown; messages?: unknown };
  let n = 0;
  if (typeof b.system === "string") n += b.system.length;
  else if (Array.isArray(b.system)) {
    for (const s of b.system) if (s && typeof (s as { text?: unknown }).text === "string") n += (s as { text: string }).text.length;
  }
  if (Array.isArray(b.messages)) {
    for (const m of b.messages) {
      const c = (m as { content?: unknown } | null)?.content;
      if (typeof c === "string") n += c.length;
      else if (Array.isArray(c)) for (const x of c) if (x && typeof (x as { text?: unknown }).text === "string") n += (x as { text: string }).text.length;
    }
  }
  return n;
}
