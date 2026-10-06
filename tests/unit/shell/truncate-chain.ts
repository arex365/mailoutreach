/**
 * A small layout check for rendered markup at phone width (M6 SCREENS-04…08, the ai-lines tab row and the wizard's
 * Review step): text cut with `truncate`, and a box that scrolls sideways (`overflow-x-auto`), only work when every box
 * above them takes its width from its parent. A CSS grid with the implicit auto column, or a flex row, instead grows to
 * its child's full min-content (a nowrap line's whole width) unless that child has `min-w-0`, so the "…" never appears
 * and the page scrolls sideways. `grid-cols-N` (Tailwind: `minmax(0, 1fr)`) has no such minimum.
 *
 * Only unprefixed classes count (a phone is below `sm:`). The markup is React's `renderToStaticMarkup` output.
 */

export type Box = {
  tag: string;
  /** Unprefixed class names (the ones that apply below `sm:`). */
  cls: Set<string>;
  attrs: Record<string, string>;
  parent: Box | null;
  children: Box[];
};

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Class names without a variant prefix (`md:`, `hover:`, `data-[…]:`); `[overflow-wrap:anywhere]` counts as unprefixed. */
function baseClasses(value: string): Set<string> {
  const out = new Set<string>();
  for (const c of value.split(/\s+/)) {
    if (!c) continue;
    if (c.replace(/\[[^\]]*\]/g, "").includes(":")) continue;
    out.add(c);
  }
  return out;
}

/** Parses React's static markup into a tree of elements (text is ignored). */
export function parseMarkup(html: string): Box {
  const root: Box = { tag: "#root", cls: new Set(), attrs: {}, parent: null, children: [] };
  let cur = root;
  for (const m of html.matchAll(/<(\/)?([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)\s*(\/)?>/g)) {
    const [, close, rawTag, attrText, selfClose] = m;
    const tag = rawTag!.toLowerCase();
    if (close) {
      let n: Box | null = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n?.parent) cur = n.parent;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (attrText ?? "").matchAll(/([^\s"'>/=]+)(?:="([^"]*)")?/g)) attrs[a[1]!] = a[2] ?? "";
    const box: Box = { tag, cls: baseClasses(attrs.class ?? ""), attrs, parent: cur, children: [] };
    cur.children.push(box);
    if (!selfClose && !VOID.has(tag)) cur = box;
  }
  return root;
}

type Display =
  | "none"
  | "contents"
  | "block"
  | "inline"
  | "inline-block"
  | "flex"
  | "inline-flex"
  | "grid"
  | "inline-grid"
  | "table-part";

const BLOCK_TAGS = new Set([
  "#root", "div", "p", "ul", "ol", "li", "section", "article", "nav", "header", "footer", "main", "aside", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "details", "summary", "fieldset", "figure", "dl", "dt", "dd", "pre",
  "legend",
]);
const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col"]);
const INLINE_BLOCK_TAGS = new Set(["button", "input", "select", "textarea", "img", "svg"]);
const DISPLAY_CLASSES: Record<string, Display> = {
  hidden: "none",
  contents: "contents",
  block: "block",
  "flow-root": "block",
  "list-item": "block",
  inline: "inline",
  "inline-block": "inline-block",
  flex: "flex",
  "inline-flex": "inline-flex",
  grid: "grid",
  "inline-grid": "inline-grid",
  table: "table-part",
  "table-cell": "table-part",
  "table-row": "table-part",
};

const NEVER_SHOWN = new Set(["script", "style", "template"]);

function ownDisplay(b: Box): Display {
  for (const c of b.cls) if (DISPLAY_CLASSES[c]) return DISPLAY_CLASSES[c]!;
  if (NEVER_SHOWN.has(b.tag)) return "none";
  if (BLOCK_TAGS.has(b.tag)) return "block";
  if (TABLE_TAGS.has(b.tag)) return "table-part";
  if (INLINE_BLOCK_TAGS.has(b.tag)) return "inline-block";
  return "inline";
}

/** Nearest ancestor that makes a box (display: contents is skipped). */
function layoutParent(b: Box): Box | null {
  let p = b.parent;
  while (p && ownDisplay(p) === "contents") p = p.parent;
  return p;
}

const isFlexOrGrid = (d: Display) => d === "flex" || d === "inline-flex" || d === "grid" || d === "inline-grid";

/** The display a box really gets: children of a flex or grid container are blockified. */
export function displayOf(b: Box): Display {
  const own = ownDisplay(b);
  const p = layoutParent(b);
  if (!p || !isFlexOrGrid(displayOf(p))) return own;
  if (own === "inline" || own === "inline-block") return "block";
  if (own === "inline-flex") return "flex";
  if (own === "inline-grid") return "grid";
  return own;
}

const OVERFLOW = /^(truncate|overflow-(hidden|auto|scroll|clip)|overflow-[xy]-(hidden|auto|scroll|clip))$/;
const SIDEWAYS_SCROLL = /^overflow-(x-)?(auto|scroll)$/;
const FIXED_WIDTH = /^(w-(\d|\[|px$)|size-)/;
const has = (b: Box, re: RegExp) => [...b.cls].some((c) => re.test(c));

/** An element whose content is cut or scrolls sideways (its min-content never reaches its parent's layout). */
const clips = (b: Box) => has(b, OVERFLOW);
const widthCapped = (b: Box) => b.cls.has("w-full") || b.cls.has("max-w-full") || has(b, FIXED_WIDTH);

/** Explicit columns at phone width: Tailwind's `grid-cols-N` are `minmax(0, 1fr)`; `grid-cols-none` is none. */
function explicitZeroMinColumns(b: Box): boolean {
  for (const c of b.cls) {
    if (/^grid-cols-\d+$/.test(c)) return true;
    if (c.startsWith("grid-cols-[")) return !/auto|content/.test(c);
  }
  return false;
}

function describe(b: Box): string {
  const name = b.attrs["aria-label"] ? ` aria-label="${b.attrs["aria-label"]}"` : "";
  return `<${b.tag}${name} class="${[...b.cls].join(" ")}">`;
}

function hidden(b: Box): boolean {
  for (let n: Box | null = b; n; n = n.parent) {
    if (ownDisplay(n) === "none" || n.cls.has("sr-only")) return true;
  }
  return false;
}

/** Why `a` (a box in `p`) can grow wider than `p` gives it, or null when it can't. */
function hopProblem(a: Box, p: Box): string | null {
  const pd = displayOf(p);
  if (pd === "grid" || pd === "inline-grid") {
    if (explicitZeroMinColumns(p) || a.cls.has("min-w-0") || clips(a)) return null;
    return `${describe(a)} sits in the auto column of ${describe(p)} without min-w-0 (use grid-cols-1, or min-w-0 on it)`;
  }
  if (pd === "flex" || pd === "inline-flex") {
    if (p.cls.has("flex-col") || p.cls.has("flex-col-reverse")) {
      const shrinkWrapped = ["items-start", "items-center", "items-end", "items-baseline"].some((c) => p.cls.has(c));
      if (!shrinkWrapped || widthCapped(a) || clips(a) || a.cls.has("self-stretch")) return null;
      return `${describe(a)} is shrink-wrapped in the column ${describe(p)} (give it w-full or max-w-full)`;
    }
    if (a.cls.has("shrink-0") && !widthCapped(a)) {
      return `${describe(a)} is a shrink-0 item of the flex row ${describe(p)}, so it never gets narrower than its content`;
    }
    if (a.cls.has("min-w-0") || clips(a)) return null;
    return `${describe(a)} is an item of the flex row ${describe(p)} without min-w-0, so it never shrinks below its content`;
  }
  return null;
}

/**
 * Every place where a cut line or a sideways-scrolling box in the markup would push the page wider than a phone
 * instead: one sentence per problem (empty when the markup is fine).
 */
export function phoneWidthProblems(html: string): string[] {
  const root = parseMarkup(html);
  const problems: string[] = [];
  const targets: Box[] = [];
  const walk = (b: Box) => {
    if (b.cls.has("truncate") || has(b, SIDEWAYS_SCROLL)) targets.push(b);
    b.children.forEach(walk);
  };
  walk(root);
  for (const target of targets) {
    if (hidden(target)) continue;
    const d = displayOf(target);
    if (target.cls.has("truncate") && (d === "inline" || d === "contents")) {
      problems.push(`${describe(target)} is inline, so truncate can't cut it`);
      continue;
    }
    let a = target;
    for (;;) {
      const p = layoutParent(a);
      if (!p) break;
      if (displayOf(a) === "inline-block" && !widthCapped(a) && !clips(a) && a !== target) {
        problems.push(`${describe(a)} is shrink-wrapped around ${describe(target)} (give it w-full or max-w-full)`);
        break;
      }
      const problem = hopProblem(a, p);
      if (problem) {
        problems.push(`${problem}; it holds ${describe(target)}`);
        break;
      }
      a = p;
      // A box that clips or scrolls, or has a fixed width, keeps its content's width to itself; so does a grid with
      // `minmax(0, 1fr)` columns (its min-content is zero: nothing inside can make its parent wider).
      if (clips(a) || has(a, FIXED_WIDTH) || a.cls.has("absolute") || a.cls.has("fixed")) break;
      if ((displayOf(a) === "grid" || displayOf(a) === "inline-grid") && explicitZeroMinColumns(a)) break;
    }
  }
  return [...new Set(problems)];
}
