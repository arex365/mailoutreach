/**
 * Text extraction for the website reader (docs/dev/M5-DESIGN.md §3.4.6; research ai-and-fetch-reference.md B6), linear
 * and capped because the page is untrusted: a hostile page must not stall the worker (the sending loop shares its
 * thread). Order: metadata first, then links, then the page text from our own iterative walker (an explicit stack,
 * never recursion) that leaves out removed elements, CSS-hidden text and small cookie/consent layers.
 *
 * Decoding: encoding-sniffer's `decodeBuffer`, exactly what `cheerio.loadBuffer` does (charset from the header, then
 * BOM / `<meta charset>` sniffing, windows-1252 by default). Parsing: htmlparser2 with its DomHandler (the parser and
 * DOM cheerio's htmlparser2 mode uses), driven by `parseCapped`, which stops building the document where it nests
 * deeper than MAX_DEPTH elements. The depth is counted from the parser's own open and close events on the decoded
 * text, so it is htmlparser2's real stack (`<div/>`, stray end tags, implied tags, noembed and UTF-16 pages included):
 * htmlparser2 keeps that stack with `unshift`/`indexOf`, O(depth) per tag, so an uncapped stack costs quadratic time.
 * Measured on this PC with a 2 MB page: parse5 (cheerio's default) took 44 s for 77,000 nested `<div>`s and 7.7 s for
 * 100,000 mis-nested `<b><i>` tags, htmlparser2 0.1 s for the latter and 0.04 s for a flat 2 MB page; browsers stop
 * nesting at 512 too.
 */
import { decodeBuffer } from "encoding-sniffer";
import { DomHandler, Parser, type Handler } from "htmlparser2";
import type { PickerLink } from "@/core/ai/picker";
import { MAX_URL_CHARS } from "@/core/ai/site-rules";
import { PAGE_TEXT_CAP } from "@/core/ai/types";
import type { PageNote } from "./types";

/** The walkers visit at most this many elements per pass; the rest of the page is ignored (and never built). */
export const MAX_ELEMENTS = 50_000;
/** Deeper nesting is cut off while parsing (browsers stop at 512 as well). */
export const MAX_DEPTH = 512;
/** A meta refresh's `content` is read up to this many characters (a real one is a delay and a URL). */
export const REFRESH_CONTENT_CAP = 2_048;
/** A cookie/consent layer (or a form) is removed only when its text is shorter than this. */
export const LAYER_TEXT_LIMIT = 3_000;
/** More CSS-hidden text than this gives the page the note `hidden-text`. */
export const HIDDEN_TEXT_NOTE_CHARS = 500;
/** `main`, `[role=main]` or the articles are used instead of the whole body when they hold at least this much text. */
export const MAIN_MIN_CHARS = 300;

const SATURATED = LAYER_TEXT_LIMIT + 1;
const TITLE_CAP = 300;
const META_PART_CAP = 1_000;
const LINK_TEXT_CAP = 200;
const MAX_LINKS = 2_000;
const NOSCRIPT_CAP = 1_000;
const JSONLD_CAP = 200_000;
const JSONLD_SCRIPTS = 20;
const JSONLD_OBJECTS = 300;
/** One text run without a block boundary longer than this is flushed as a line (a 2 MB text node stays bounded). */
const RUN_CAP = PAGE_TEXT_CAP * 4;

/** Removed with their content (research B6 step 3; `head`/`title` too, for pages without a body). */
const REMOVED_TAGS: ReadonlySet<string> = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "button", "select",
  "textarea", "nav", "footer", "head", "title",
]);
/** Block elements: a line break before and after (so `<p>A</p><p>B</p>` isn't "AB"). */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p", "div", "section", "article", "main", "header", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "dl",
  "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "figure", "figcaption", "blockquote", "pre",
  "address", "br", "hr", "center", "details", "summary", "fieldset", "legend", "body", "html",
]);
/** Research B6, verbatim: cookie and consent layers, matched on id and class. */
export const CONSENT_PATTERN = /cookie|consent|gdpr|\bcmp\b|onetrust|usercentrics|borlabs|complianz|cookiebot|iubenda|klaro|didomi|cc-window/i;
/** Never removed as a consent layer, whatever their classes say (WordPress puts "cookies-not-set" on body). */
const NEVER_LAYER: ReadonlySet<string> = new Set(["html", "body", "main"]);
/** Inline styles that hide text from visitors (§3.4.6). */
export const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])/i;
const HIDDEN_CLASSES: ReadonlySet<string> = new Set(["sr-only", "visually-hidden", "screen-reader-text"]);
const APP_ROOT_IDS: ReadonlySet<string> = new Set(["root", "__next", "__nuxt", "app"]);
const NOSCRIPT_ASKS_FOR_JS = /enable javascript|javascript aktivieren|aktiver javascript/i;
const JSONLD_TYPES: ReadonlySet<string> = new Set(["Organization", "LocalBusiness", "Store", "Product", "WebSite"]);

const STOP_WORDS: ReadonlyArray<readonly ["de" | "nb" | "en", ReadonlySet<string>]> = [
  ["de", new Set(["und", "der", "die", "das", "mit", "fuer", "für", "nicht"])],
  ["nb", new Set(["og", "det", "er", "med", "til", "på", "av", "ikke"])],
  ["en", new Set(["the", "and", "with", "for"])],
];

/** The DOM shape we walk: the fields of domhandler's nodes (htmlparser2's DomHandler builds them) that we read. */
export type DomNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
};

export type ExtractedPage = {
  title: string | null;
  lang: "de" | "nb" | "en" | null;
  /** Cleaned page text: lines, whitespace collapsed, short and repeated lines dropped, ≤ PAGE_TEXT_CAP characters. */
  text: string;
  /** Title + meta description + og tags + JSON-LD names/descriptions (≤ PAGE_TEXT_CAP). */
  metaText: string;
  links: PickerLink[];
  /** `<meta http-equiv="refresh">`: delay in seconds and target (null = reload itself). */
  refresh: { delaySec: number; url: string | null } | null;
  /** `<meta name="robots">` says noai. */
  noai: boolean;
  /** Characters of CSS-hidden text removed (each block counted up to 3,001). */
  hiddenChars: number;
  notes: PageNote[];
  emptyAppRoot: boolean;
  noscriptAsksForJs: boolean;
  externalScripts: number;
  /** The document nested deeper than MAX_DEPTH and was cut there. */
  depthCut: boolean;
};

// ───────────────────────── decoding and the capped parse ─────────────────────────

/** htmlparser2's options in cheerio's htmlparser2 mode (HTML, entities decoded). */
const PARSER_OPTIONS = { xmlMode: false, decodeEntities: true } as const;
/** One element more than the walkers visit, so the survey still sees that the page went on. */
const PARSE_ELEMENT_CAP = MAX_ELEMENTS + 1;
/** htmlparser2's void elements (its own list): opened and closed at once, so they never make the tree deeper. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area", "base", "basefont", "br", "col", "command", "embed", "frame", "hr", "img", "input", "isindex", "keygen", "link",
  "meta", "param", "source", "track", "wbr",
]);
/**
 * htmlparser2 keeps an "inside svg/math" flag per open element of these names (its foreign-context stack, also shifted
 * with `unshift`). Only an end tag with the same name removes a flag, so a self-closed `<svg/>` inside an svg or an
 * implied close (`<b><svg></b>`) leaves one behind: without a cap, a flat page can grow that stack as well.
 */
const FOREIGN_CONTEXT_TAGS: ReadonlySet<string> = new Set([
  "math", "svg", "mi", "mo", "mn", "ms", "mtext", "annotation-xml", "foreignobject", "desc", "title",
]);

/**
 * The page's bytes as text, with cheerio.loadBuffer's rules. A header charset iconv can't decode is ignored (the bytes
 * are sniffed as if there were none), and a sniffed one it can't decode gives latin1, so page content never throws.
 */
export function decodePage(input: Buffer, charset?: string | null): string {
  const sniffed = { defaultEncoding: "windows-1252" };
  for (const options of charset ? [{ ...sniffed, transportLayerEncodingLabel: charset }, sniffed] : [sniffed]) {
    try {
      return decodeBuffer(input, options);
    } catch {
      /* an encoding iconv doesn't know: try the next way */
    }
  }
  return input.toString("latin1");
}

/**
 * Parses decoded HTML into a DOM (htmlparser2 + DomHandler, as cheerio does) and stops, keeping everything before that
 * tag, when htmlparser2's open-element stack (or its foreign-context stack) would pass `maxDepth` (`depthCut`), or
 * after PARSE_ELEMENT_CAP elements (the walkers never look further). Both stacks stay ≤ `maxDepth`, so every tag costs
 * at most O(maxDepth) and the whole pass is linear in the page's length.
 *
 * Depth = open events minus close events: htmlparser2 reports a close for every element it pops (implied closes, void
 * elements and the end of the document included), so the count is its real stack. The foreign-context count is an
 * upper bound: +1 for each opened FOREIGN_CONTEXT_TAGS element, −1 only for an explicit, matching end tag.
 */
export function parseCapped(html: string, maxDepth = MAX_DEPTH): { root: DomNode; depthCut: boolean } {
  const dom = new DomHandler();
  let depth = 0;
  let foreign = 1;
  let opened = 0;
  let stop: "depth" | "elements" | null = null;
  const cbs: Partial<Handler> = {
    onparserinit: (p) => dom.onparserinit(p),
    onopentagname(name) {
      if (stop) return;
      depth++;
      opened++;
      if (FOREIGN_CONTEXT_TAGS.has(name)) foreign++;
      if ((depth > maxDepth && !VOID_ELEMENTS.has(name)) || foreign > maxDepth) stop = "depth";
      else if (opened > PARSE_ELEMENT_CAP) stop = "elements";
      // Pausing stops the tokenizer after this tag; the events it still sends are ignored, so the DOM ends before it.
      if (stop) parser.pause();
    },
    onopentag(name, attribs) {
      if (!stop) dom.onopentag(name, attribs);
    },
    onclosetag(name, isImplied) {
      if (stop) return;
      depth--;
      if (!isImplied && FOREIGN_CONTEXT_TAGS.has(name)) foreign--;
      dom.onclosetag();
    },
    ontext(data) {
      if (!stop) dom.ontext(data);
    },
    oncomment(data) {
      if (!stop) dom.oncomment(data);
    },
    oncommentend() {
      if (!stop) dom.oncommentend();
    },
    oncdatastart() {
      if (!stop) dom.oncdatastart();
    },
    oncdataend() {
      if (!stop) dom.oncdataend();
    },
    onprocessinginstruction(name, data) {
      if (!stop) dom.onprocessinginstruction(name, data);
    },
    onend() {
      if (!stop) dom.onend();
    },
  };
  const parser = new Parser(cbs, PARSER_OPTIONS);
  parser.write(html);
  if (!stop) parser.end();
  return { root: dom.root as unknown as DomNode, depthCut: stop === "depth" };
}

// ───────────────────────── helpers ─────────────────────────

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g;

/** One line cleaned: control characters removed, whitespace collapsed, trimmed. */
export function cleanLine(s: string): string {
  return s.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
}

/** Cuts text to `max` characters, at the last space when there is one in the final 20 %. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return (space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd();
}

function attr(node: DomNode, name: string): string | undefined {
  return node.attribs?.[name];
}

function isElement(node: DomNode): boolean {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

function classTokens(node: DomNode): string[] {
  return (attr(node, "class") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function isCssHidden(node: DomNode): boolean {
  const style = attr(node, "style");
  if (style && HIDDEN_STYLE.test(style)) return true;
  return classTokens(node).some((c) => HIDDEN_CLASSES.has(c));
}

function isConsentLayer(node: DomNode): boolean {
  if (NEVER_LAYER.has(node.name ?? "")) return false;
  const idClass = `${attr(node, "id") ?? ""} ${attr(node, "class") ?? ""}`;
  return idClass.trim() !== "" && CONSENT_PATTERN.test(idClass);
}

function isAppRoot(node: DomNode): boolean {
  const id = (attr(node, "id") ?? "").toLowerCase();
  return APP_ROOT_IDS.has(id) || attr(node, "ng-version") !== undefined;
}

/** Text directly inside a raw-text element (script, style, title: only text children). */
function rawText(node: DomNode, cap: number): string {
  let out = "";
  for (const c of node.children ?? []) {
    if (c.type === "text" && c.data) {
      out += c.data;
      if (out.length >= cap) return out.slice(0, cap);
    }
  }
  return out;
}

function langCode(value: string | null | undefined): "de" | "nb" | "en" | null | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase().replace(/_/g, "-");
  if (!/^[a-z]{2,3}(-|$)/.test(v)) return undefined;
  const base = v.split("-")[0];
  if (base === "de") return "de";
  if (base === "nb" || base === "no" || base === "nn" || base === "nob") return "nb";
  if (base === "en") return "en";
  return null;
}

/** Stop-word guess (research B6): the language with the most hits, at least 3 and more than any other. */
export function guessLanguage(text: string): "de" | "nb" | "en" | null {
  const counts = new Map<string, number>();
  for (const word of text.slice(0, 5_000).toLowerCase().split(/[^\p{L}]+/u)) {
    for (const [lang, words] of STOP_WORDS) if (words.has(word)) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < 3 || (second && second[1] === best[1])) return null;
  return best[0] as "de" | "nb" | "en";
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** Digits with an optional fraction ("5", "0.5"), checked by hand. */
function isDelay(s: string): boolean {
  let i = 0;
  while (i < s.length && isDigit(s.charCodeAt(i))) i++;
  if (i === 0) return false;
  if (i === s.length) return true;
  if (s[i] !== ".") return false;
  const fraction = ++i;
  while (i < s.length && isDigit(s.charCodeAt(i))) i++;
  return i > fraction && i === s.length;
}

/**
 * `content` of a meta refresh: "5; url=https://…" → {delaySec: 5, url}. A linear hand parser on at most
 * REFRESH_CONTENT_CAP characters (the page controls this text): the delay is what comes before the first ";" or ","
 * (digits with an optional fraction, or nothing), the target is the rest without an optional "url =" and one pair of
 * quotes. Anything else in the delay part means it isn't a refresh (null).
 */
export function parseRefresh(content: string, base: URL): { delaySec: number; url: string | null } | null {
  const raw = content.slice(0, REFRESH_CONTENT_CAP);
  let sep = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === ";" || c === ",") {
      sep = i;
      break;
    }
  }
  const delayText = (sep < 0 ? raw : raw.slice(0, sep)).trim();
  if (delayText !== "" && !isDelay(delayText)) return null;
  let rest = sep < 0 ? "" : raw.slice(sep + 1).trim();
  if (rest.slice(0, 3).toLowerCase() === "url") {
    const afterWord = rest.slice(3).trimStart();
    if (afterWord.startsWith("=")) rest = afterWord.slice(1).trim();
  }
  if (delayText === "" && rest === "") return null;
  const delaySec = delayText === "" ? 0 : Number(delayText);
  let target = rest;
  if (target.startsWith("'") || target.startsWith('"')) target = target.slice(1);
  if (target.endsWith("'") || target.endsWith('"')) target = target.slice(0, -1);
  target = target.trim();
  if (!target) return { delaySec, url: null };
  try {
    return { delaySec, url: new URL(target, base).href };
  } catch {
    return { delaySec, url: null };
  }
}

/** Names and descriptions of Organization, LocalBusiness, Store, Product and WebSite items (`@graph` flattened). */
export function jsonLdTexts(scripts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of scripts.slice(0, JSONLD_SCRIPTS)) {
    let data: unknown;
    try {
      data = JSON.parse(text.slice(0, JSONLD_CAP));
    } catch {
      continue;
    }
    const queue: unknown[] = [data];
    let visited = 0;
    while (queue.length > 0 && visited < JSONLD_OBJECTS) {
      const item = queue.shift();
      visited++;
      if (Array.isArray(item)) {
        queue.push(...item.slice(0, 100));
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const graph = obj["@graph"];
      if (Array.isArray(graph)) queue.push(...graph.slice(0, 100));
      const types = ([] as unknown[]).concat(obj["@type"] ?? []);
      const kept = types.some((t) => typeof t === "string" && JSONLD_TYPES.has(t.split(/[/:#]/).pop() ?? ""));
      if (!kept) continue;
      for (const key of ["name", "description"]) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) out.push(v);
      }
    }
  }
  return out;
}

// ───────────────────────── the survey pass ─────────────────────────

type Survey = {
  title: string | null;
  htmlLang: string | null;
  meta: { description: string | null; ogTitle: string | null; ogDescription: string | null; ogSiteName: string | null; ogLocale: string | null };
  refresh: string | null;
  noai: boolean;
  jsonLd: string[];
  externalScripts: number;
  links: PickerLink[];
  body: DomNode | null;
  main: DomNode | null;
  articles: DomNode[];
  appRoots: DomNode[];
  noscriptText: string;
  /** Saturating text lengths (≤ 3,001) of the elements whose removal depends on them. */
  lengths: Map<DomNode, number>;
};

/**
 * A form or consent layer around a `main`/`article` candidate. Whether the text walk removes it (text under
 * LAYER_TEXT_LIMIT) is only known once it is finished, so candidates keep a pointer and are checked after the pass.
 */
type LayerRec = { parent: LayerRec | null; removed: boolean; inRemoved?: boolean };
type Candidate = { node: DomNode; layer: LayerRec | null };

type SurveyFrame = {
  node: DomNode;
  i: number;
  /** Saturating text length of the children finished so far. */
  sum: number;
  inNav: boolean;
  link: PickerLink | null;
  inNoscript: boolean;
  inSvg: boolean;
  /** Store this element's length (its removal depends on it). */
  keep: boolean;
  /** The text walk leaves this element out (it, or an ancestor, is removed or hidden): never a `main`/`article`. */
  excluded: boolean;
  /** The innermost form or consent layer this element is in (itself included). */
  layer: LayerRec | null;
  /** This element's own layer record, when it is a form or consent layer. */
  ownLayer: LayerRec | null;
};

/** Removed with their content by the text walk, except `head`: body content a sloppy page left in it is still shown. */
const EXCLUDING_TAGS: ReadonlySet<string> = new Set([...REMOVED_TAGS].filter((t) => t !== "head"));

/** True when the text walk leaves this element out whatever its length (walkText's rules, forms and layers aside). */
function hidesItsContent(node: DomNode, name: string, role: string, cssHidden: boolean): boolean {
  if (cssHidden || EXCLUDING_TAGS.has(name)) return true;
  if (attr(node, "hidden") !== undefined || (attr(node, "aria-hidden") ?? "").toLowerCase() === "true") return true;
  return role === "navigation" || role === "contentinfo";
}

/** True when a candidate sits in a form or consent layer the text walk removes (memoised up the chain). */
function insideRemovedLayer(layer: LayerRec | null): boolean {
  const chain: LayerRec[] = [];
  let result = false;
  for (let r = layer; r; r = r.parent) {
    if (r.inRemoved !== undefined) {
      result = r.inRemoved;
      break;
    }
    chain.push(r);
    if (r.removed) {
      result = true;
      break;
    }
  }
  for (const r of chain) r.inRemoved = result;
  return result;
}

/**
 * One iterative pass over the whole document (at most MAX_ELEMENTS elements): metadata, links (with nav/header
 * membership), script and noscript facts, `main`/`article` (only where the text walk would keep them: not inside a
 * removed, hidden or navigation element, nor a small form or consent layer), app roots, and, post-order, the saturating
 * text length of every element whose removal depends on it (consent layers, forms, CSS-hidden blocks, app roots).
 */
function survey(root: DomNode, base: URL): Survey {
  const s: Survey = {
    title: null,
    htmlLang: null,
    meta: { description: null, ogTitle: null, ogDescription: null, ogSiteName: null, ogLocale: null },
    refresh: null,
    noai: false,
    jsonLd: [],
    externalScripts: 0,
    links: [],
    body: null,
    main: null,
    articles: [],
    appRoots: [],
    noscriptText: "",
    lengths: new Map(),
  };
  const stack: SurveyFrame[] = [
    { node: root, i: 0, sum: 0, inNav: false, link: null, inNoscript: false, inSvg: false, keep: false, excluded: false, layer: null, ownLayer: null },
  ];
  const mains: Candidate[] = [];
  const articles: Candidate[] = [];
  let elements = 0;
  let stopped = false;
  let articleDepth = 0;
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const children = top.node.children ?? [];
    if (stopped || top.i >= children.length) {
      stack.pop();
      // Unfinished elements (the pass stopped) count as long, so they are never removed as small layers.
      const len = stopped ? SATURATED : Math.min(SATURATED, top.sum);
      if (top.keep) s.lengths.set(top.node, len);
      if (top.ownLayer) top.ownLayer.removed = len < LAYER_TEXT_LIMIT;
      if (top.node.name === "article" && articleDepth > 0) articleDepth--;
      const parent = stack[stack.length - 1];
      if (parent) parent.sum = Math.min(SATURATED, parent.sum + len);
      continue;
    }
    const node = children[top.i++]!;
    if (node.type === "text") {
      const data = node.data ?? "";
      top.sum = Math.min(SATURATED, top.sum + data.trim().length);
      if (top.link && top.link.text.length < LINK_TEXT_CAP) top.link.text += data;
      if (top.inNoscript && s.noscriptText.length < NOSCRIPT_CAP) s.noscriptText += ` ${data}`;
      continue;
    }
    if (!isElement(node)) continue;
    elements++;
    if (elements > MAX_ELEMENTS) {
      stopped = true;
      continue;
    }
    const name = node.name ?? "";
    if (node.type === "script") {
      const type = (attr(node, "type") ?? "").toLowerCase();
      if (attr(node, "src")) s.externalScripts++;
      if (type.includes("ld+json") && s.jsonLd.length < JSONLD_SCRIPTS) s.jsonLd.push(rawText(node, JSONLD_CAP));
      continue;
    }
    if (node.type === "style") continue;
    switch (name) {
      case "title":
        // An inline SVG's <title> is a tooltip, not the page's title.
        if (s.title === null && !top.inSvg) s.title = cleanLine(rawText(node, TITLE_CAP * 4)).slice(0, TITLE_CAP) || null;
        continue;
      case "meta": {
        const key = (attr(node, "name") ?? attr(node, "property") ?? "").toLowerCase();
        const content = attr(node, "content") ?? "";
        const equiv = (attr(node, "http-equiv") ?? "").toLowerCase();
        if (equiv === "refresh" && s.refresh === null) s.refresh = content.slice(0, REFRESH_CONTENT_CAP);
        if (key === "robots" && /(^|[\s,])noai($|[\s,])/i.test(content)) s.noai = true;
        if (key === "description") s.meta.description ??= content;
        if (key === "og:title") s.meta.ogTitle ??= content;
        if (key === "og:description") s.meta.ogDescription ??= content;
        if (key === "og:site_name") s.meta.ogSiteName ??= content;
        if (key === "og:locale") s.meta.ogLocale ??= content;
        continue;
      }
      case "html":
        s.htmlLang ??= attr(node, "lang") ?? null;
        break;
      case "body":
        s.body ??= node;
        break;
    }
    const role = (attr(node, "role") ?? "").toLowerCase();
    const cssHidden = isCssHidden(node);
    const layered = name === "form" || isConsentLayer(node);
    const ownLayer: LayerRec | null = layered ? { parent: top.layer, removed: false } : null;
    const layer = ownLayer ?? top.layer;
    const excluded = top.excluded || hidesItsContent(node, name, role, cssHidden);
    if (!excluded && (name === "main" || role === "main")) mains.push({ node, layer });
    if (name === "article") {
      if (articleDepth === 0 && !excluded) articles.push({ node, layer });
      articleDepth++;
    }
    let link = top.link;
    const inNav = top.inNav || name === "nav" || name === "header" || role === "navigation";
    if (name === "a") {
      const href = attr(node, "href")?.trim();
      link = null;
      // An address longer than the URL rules allow is never read, so it isn't collected either.
      if (href && href.length <= MAX_URL_CHARS && s.links.length < MAX_LINKS) {
        try {
          link = { href: new URL(href, base).href, text: "", inNav };
          s.links.push(link);
        } catch {
          /* not a URL */
        }
      }
    }
    const appRoot = isAppRoot(node);
    if (appRoot) s.appRoots.push(node);
    const keep = appRoot || layered || cssHidden;
    stack.push({
      node,
      i: 0,
      sum: 0,
      inNav,
      link,
      inNoscript: top.inNoscript || name === "noscript",
      inSvg: top.inSvg || name === "svg",
      keep,
      excluded,
      layer,
      ownLayer,
    });
  }
  for (const link of s.links) link.text = cleanLine(link.text).slice(0, LINK_TEXT_CAP);
  // Now every layer's length is known: a candidate in a layer the text walk removes can't stand for the page.
  s.main = mains.find((c) => !insideRemovedLayer(c.layer))?.node ?? null;
  s.articles = articles.filter((c) => !insideRemovedLayer(c.layer)).map((c) => c.node);
  return s;
}

// ───────────────────────── the text walk ─────────────────────────

/** Collects lines: collapsed, at least 3 characters, each only once, until the page's text cap is reached. */
class LineCollector {
  readonly lines: string[] = [];
  private readonly seen = new Set<string>();
  private run = "";
  size = 0;
  get full(): boolean {
    return this.size >= PAGE_TEXT_CAP;
  }
  add(text: string): void {
    if (this.full) return;
    this.run += text;
    if (this.run.length > RUN_CAP) this.flush();
  }
  flush(): void {
    const line = cleanLine(this.run);
    this.run = "";
    if (line.length < 3 || this.seen.has(line) || this.full) return;
    this.seen.add(line);
    this.lines.push(line);
    this.size += line.length + 1;
  }
}

type WalkResult = { text: string; hiddenChars: number; alts: string[] };

/**
 * The page text under `roots`: text nodes appended, line breaks around block tags, removed elements skipped with their
 * content (research B6 list, `[hidden]`, `[aria-hidden=true]`, navigation and footer roles, CSS-hidden elements, cookie
 * layers and forms under 3,000 characters), `img[alt]` texts of 3+ words kept for the end. An explicit stack, at most
 * MAX_ELEMENTS elements, stops once the text cap is reached.
 */
function walkText(roots: readonly DomNode[], lengths: ReadonlyMap<DomNode, number>): WalkResult {
  const out = new LineCollector();
  const alts: string[] = [];
  let hiddenChars = 0;
  let elements = 0;
  type Frame = { nodes: readonly DomNode[]; i: number; block: boolean };
  const stack: Frame[] = [{ nodes: roots, i: 0, block: false }];
  while (stack.length > 0 && !out.full) {
    const top = stack[stack.length - 1]!;
    if (top.i >= top.nodes.length) {
      stack.pop();
      if (top.block) out.flush();
      continue;
    }
    const node = top.nodes[top.i++]!;
    if (node.type === "text") {
      out.add(node.data ?? "");
      continue;
    }
    if (node.type !== "tag") continue;
    if (++elements > MAX_ELEMENTS) break;
    const name = node.name ?? "";
    if (REMOVED_TAGS.has(name)) continue;
    if (attr(node, "hidden") !== undefined || (attr(node, "aria-hidden") ?? "").toLowerCase() === "true") continue;
    const role = (attr(node, "role") ?? "").toLowerCase();
    if (role === "navigation" || role === "contentinfo") continue;
    if (isCssHidden(node)) {
      hiddenChars += lengths.get(node) ?? 0;
      continue;
    }
    const known = lengths.get(node);
    if ((name === "form" || isConsentLayer(node)) && known !== undefined && known < LAYER_TEXT_LIMIT) continue;
    if (name === "img") {
      const alt = cleanLine(attr(node, "alt") ?? "");
      if (alt.split(" ").filter(Boolean).length >= 3) alts.push(alt);
      continue;
    }
    const block = BLOCK_TAGS.has(name);
    if (block) out.flush();
    if (name === "br" || name === "hr") continue;
    stack.push({ nodes: node.children ?? [], i: 0, block });
  }
  out.flush();
  return { text: out.lines.join("\n"), hiddenChars, alts };
}

function withAlts(walk: WalkResult): string {
  const out = new LineCollector();
  for (const line of walk.text ? walk.text.split("\n") : []) {
    out.add(line);
    out.flush();
  }
  for (const alt of walk.alts) {
    out.add(alt);
    out.flush();
  }
  return cutText(out.lines.join("\n"), PAGE_TEXT_CAP);
}

// ───────────────────────── the page ─────────────────────────

/**
 * Extracts one page. `charset` is the Content-Type header's (the transport-layer label); `contentLanguage` the
 * Content-Language header. Never throws for page content. Every step is linear in the page's length and capped
 * (decode, the capped parse, the survey and the walks), so a hostile page can't hold the worker's thread.
 */
export function extractPage(
  input: Buffer,
  opts: { finalUrl: string; charset?: string | null; contentLanguage?: string | null },
): ExtractedPage {
  const base = new URL(opts.finalUrl);
  const { root, depthCut } = parseCapped(decodePage(input, opts.charset));
  const s = survey(root, base);

  let walk: WalkResult | null = null;
  if (s.main) {
    const w = walkText([s.main], s.lengths);
    if (w.text.length >= MAIN_MIN_CHARS) walk = w;
  }
  if (!walk && s.articles.length > 0) {
    const w = walkText(s.articles, s.lengths);
    if (w.text.length >= MAIN_MIN_CHARS) walk = w;
  }
  walk ??= walkText(s.body ? [s.body] : (root.children ?? []), s.lengths);
  const text = withAlts(walk);

  const metaParts = [
    s.title,
    s.meta.description,
    s.meta.ogTitle,
    s.meta.ogDescription,
    s.meta.ogSiteName,
    ...jsonLdTexts(s.jsonLd),
  ];
  const metaLines: string[] = [];
  for (const part of metaParts) {
    // A meta value can be as long as the page: only its start is cleaned.
    const line = cleanLine((part ?? "").slice(0, META_PART_CAP * 4)).slice(0, META_PART_CAP);
    if (line && !metaLines.includes(line)) metaLines.push(line);
  }
  const metaText = cutText(metaLines.join("\n"), PAGE_TEXT_CAP);

  let lang: "de" | "nb" | "en" | null | undefined;
  for (const source of [s.htmlLang, s.meta.ogLocale, opts.contentLanguage?.split(",")[0]]) {
    lang = langCode(source);
    if (lang !== undefined) break;
  }
  if (lang === undefined) lang = guessLanguage(text);

  const emptyAppRoot = s.appRoots.some((n) => (s.lengths.get(n) ?? SATURATED) === 0);
  const notes: PageNote[] = walk.hiddenChars > HIDDEN_TEXT_NOTE_CHARS ? ["hidden-text"] : [];
  return {
    title: s.title,
    lang,
    text,
    metaText,
    links: s.links,
    refresh: s.refresh !== null ? parseRefresh(s.refresh, base) : null,
    noai: s.noai,
    hiddenChars: walk.hiddenChars,
    notes,
    emptyAppRoot,
    noscriptAsksForJs: NOSCRIPT_ASKS_FOR_JS.test(s.noscriptText),
    externalScripts: s.externalScripts,
    depthCut,
  };
}
