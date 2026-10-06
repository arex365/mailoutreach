/**
 * Template parser (PLAN.md B6.3). Pure and browser-safe: the editor runs it on every keystroke.
 *
 * Syntax (one line at a time: a variable or a variation never spans a line break, so a typo
 * can't swallow the rest of the email):
 *   {{first_name}}          a variable
 *   {{first_name|there}}    … with a fallback used when it's empty
 *   {{personal_line|}}      … optional: fine if empty
 *   {Hi|Hello|Hey}          a variation: one option per person, stable (see hash.ts)
 *   \{  \}  \|              a real brace or bar
 * Variations may contain variables and other variations: {Hi {{first_name|there}}|Hello}, and an
 * option may start with a variable: {{{first_name|there}}, good to see you|Hello}. They can be
 * nested up to MAX_VARIATION_DEPTH deep; a deeper one is kept as written, with a problem.
 * Problems never throw: they come back as plain-language messages and the text is kept as written.
 *
 * The cost stays linear in the length of the line, however many braces it has: a "{" that can't
 * close is remembered, and so is every variation around it (they can't close either), so no part
 * of the line is read more than a few times; variables find their "}}" through a table built once
 * per line; past the nesting limit, braces are matched with a plain stack instead of recursion;
 * and messages only quote a short piece of the line.
 */

export type TextNode = { type: "text"; value: string };

export type VariableNode = {
  type: "variable";
  /** Lowercased, trimmed name as written (may be invalid or unknown; the renderer decides). */
  name: string;
  /** Exactly as written, e.g. "{{first_name|there}}". */
  raw: string;
  /** null = no "|" (a missing value is a warning); "" = optional; otherwise the fallback text. */
  fallback: string | null;
};

export type VariationNode = {
  type: "variation";
  /** The text between the braces as written, e.g. "Hi|Hello" (part of the stable-pick hash). */
  source: string;
  options: TemplateNode[][];
  /** How many variations with the same `source` came before this one (in this subject or body). */
  occurrence: number;
};

export type TemplateNode = TextNode | VariableNode | VariationNode;

export type ParsedTemplate = {
  /** One node list per source line ("\r\n" and "\r" count as "\n"). */
  lines: TemplateNode[][];
  /** The raw source lines, same length as `lines`. */
  sourceLines: string[];
  /** Plain-language syntax problems, in order, without duplicates. */
  problems: string[];
};

/** How deep variations can be nested inside each other ({a|{b|{c|d}}} is 3 deep). */
export const MAX_VARIATION_DEPTH = 10;

export const TOO_DEEP_PROBLEM = `Variations can be nested up to ${MAX_VARIATION_DEPTH} deep, so the innermost ones are shown as written. Take out some of the inner { }, or write \\{ and \\} for real braces.`;

const UNREADABLE_PROBLEM = "Some braces in this text couldn't be read, so it's shown as written. Check the { and } in it.";

const ESCAPABLE = new Set(["{", "}", "|"]);

/** Messages quote at most this much of the line (so long lines stay cheap). */
const QUOTE_WINDOW = 200;

/** Removes the backslash in front of { } | (other backslashes stay). */
export function unescapeTemplateText(text: string): string {
  return text.replace(/\\([{}|])/g, "$1");
}

/** A short quote of text[from..to) around a problem, for the message. Only looks at a small window. */
function quote(text: string, from = 0, to = text.length): string {
  const end = Math.min(to, from + QUOTE_WINDOW);
  const clean = text.slice(from, end).replace(/\s+/g, " ").trim();
  return clean.length > 40 || end < to ? `${clean.slice(0, 40)}…` : clean;
}

type Sequence = { nodes: TemplateNode[]; end: "eof" | "|" | "}" };

class LineParser {
  private pos = 0;
  /**
   * Positions of "{" that can't close on this line. Everything around such a "{" can't close
   * either (its content reads the same one level up), which is what keeps parsing linear.
   */
  private readonly unclosed = new Set<number>();
  /** nextPair[i] = where the first "}}" at or after i starts (escapes respected), or -1. Built on first use. */
  private nextPair: Int32Array | null = null;
  private strayMessage: string | null = null;

  constructor(
    private readonly src: string,
    private readonly problems: string[],
  ) {}

  parse(): TemplateNode[] {
    return this.sequence(0)?.nodes ?? [];
  }

  private problem(message: string): void {
    this.problems.push(message);
  }

  /**
   * Reads up to the end of the line or, inside a variation (depth > 0), up to its next "|" or "}".
   * Inside a variation, returns null as soon as a "{" in it can't close: then this one can't either.
   */
  private sequence(depth: number): Sequence | null {
    const nodes: TemplateNode[] = [];
    const src = this.src;
    let buf = "";
    const flush = () => {
      if (buf) nodes.push({ type: "text", value: buf });
      buf = "";
    };
    while (this.pos < src.length) {
      const start = this.pos;
      const ch = src[start]!;
      const next = src[start + 1];
      if (ch === "\\" && next !== undefined && ESCAPABLE.has(next)) {
        buf += next;
        this.pos += 2;
        continue;
      }
      if (ch === "{") {
        const doubled = next === "{";
        // "{{{first_name}}, …|Hello}": the first "{" starts a variation whose option begins with a variable.
        const variationFirst = !doubled || (src[start + 2] === "{" && this.variableEnd(start) >= 0);
        if (variationFirst) {
          const node = this.unclosed.has(start) ? null : this.variation(depth + 1);
          if (node?.type === "text") {
            buf += node.value;
            continue;
          }
          if (node) {
            flush();
            nodes.push(node);
            continue;
          }
          // This "{" can't close, so neither can the variation we're in.
          if (depth > 0) return null;
          if (!doubled) {
            this.problem(
              `There's a "{" without a matching "}" in "${quote(src, start)}". Close it, like {Hi|Hello}, or write \\{ for a real brace.`,
            );
            buf += "{";
            this.pos = start + 1;
            continue;
          }
          // "{{{…}}" that isn't a variation after all: read it as a variable, as written.
          this.pos = start;
        }
        const node = this.variable();
        if (node) {
          flush();
          nodes.push(node);
        } else {
          buf += "{{";
        }
        continue;
      }
      if (depth > 0 && (ch === "|" || ch === "}")) {
        flush();
        return { nodes, end: ch };
      }
      if (ch === "}") this.problem(this.strayBraceMessage());
      buf += ch;
      this.pos++;
    }
    flush();
    return { nodes, end: "eof" };
  }

  private strayBraceMessage(): string {
    this.strayMessage ??= `There's a "}" without a matching "{" in "${quote(this.src)}". Remove it, or write \\} for a real brace.`;
    return this.strayMessage;
  }

  /** Where the "}}" that closes a "{{" at `start` begins, or -1 when there's none on this line. */
  private variableEnd(start: number): number {
    if (!this.nextPair) {
      const src = this.src;
      const n = src.length;
      // A "}" right after a backslash is a real brace, not half of a "}}".
      const escaped = new Uint8Array(n);
      for (let i = 0; i < n - 1; i++) {
        if (src[i] === "\\" && ESCAPABLE.has(src[i + 1]!)) {
          escaped[i + 1] = 1;
          i++;
        }
      }
      const next = new Int32Array(n + 1).fill(-1);
      for (let i = n - 2; i >= 0; i--) {
        next[i] = !escaped[i] && src[i] === "}" && src[i + 1] === "}" ? i : next[i + 1]!;
      }
      this.nextPair = next;
    }
    return this.nextPair[start + 2] ?? -1;
  }

  /** At "{{". Returns null (and notes the problem) when there's no "}}" on this line. */
  private variable(): TemplateNode | null {
    const src = this.src;
    const start = this.pos;
    const close = this.variableEnd(start);
    if (close < 0) {
      this.problem(
        `"{{" isn't closed with "}}" in "${quote(src, start)}". Finish it, like {{first_name}}, or write \\{\\{ for real braces.`,
      );
      this.pos = start + 2;
      return null;
    }
    const inner = src.slice(start + 2, close);
    const raw = src.slice(start, close + 2);
    this.pos = close + 2;

    let namePart = inner;
    let fallbackPart: string | null = null;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "\\" && ESCAPABLE.has(inner[i + 1] ?? "")) {
        i++;
        continue;
      }
      if (inner[i] === "|") {
        namePart = inner.slice(0, i);
        fallbackPart = inner.slice(i + 1);
        break;
      }
    }
    const name = unescapeTemplateText(namePart).trim().toLowerCase();
    if (!name) {
      this.problem(`"${quote(raw)}" has no variable name. Put one inside, like {{first_name}}.`);
      return { type: "text", value: raw };
    }
    if (fallbackPart !== null && /(^|[^\\])[{}]/.test(fallbackPart)) {
      this.problem(`The fallback in "${quote(raw)}" can only be plain text. Leave out { and }, or write \\{ and \\}.`);
    }
    const fallback = fallbackPart === null ? null : unescapeTemplateText(fallbackPart).trim();
    return { type: "variable", name, raw, fallback };
  }

  /**
   * At "{", `depth` variations deep (1 = not inside another one). Returns null when it can't close
   * on this line (the caller then treats "{" as plain text, or gives up too). Past the nesting
   * limit, a variation that does close comes back as plain text, as written.
   */
  private variation(depth: number): VariationNode | TextNode | null {
    const src = this.src;
    const start = this.pos;
    if (depth > MAX_VARIATION_DEPTH) {
      const close = this.matchingClose(start);
      if (close < 0) {
        this.pos = start;
        return null;
      }
      this.problem(TOO_DEEP_PROBLEM);
      this.pos = close + 1;
      return { type: "text", value: src.slice(start, close + 1) };
    }
    const problemsBefore = this.problems.length;
    this.pos = start + 1;
    const options: TemplateNode[][] = [];
    for (;;) {
      const seq = this.sequence(depth);
      if (!seq || seq.end === "eof") {
        // No "}" on this line: undo what the options noted.
        this.problems.length = problemsBefore;
        this.unclosed.add(start);
        this.pos = start;
        return null;
      }
      options.push(seq.nodes);
      this.pos++; // past the "|" or "}"
      if (seq.end === "}") break;
    }
    const source = src.slice(start + 1, this.pos - 1);
    if (options.every((o) => o.every((n) => n.type === "text" && n.value.trim() === ""))) {
      this.problem(`"${quote(src, start, this.pos)}" has no options. Put the choices inside, separated by |, like {Hi|Hello}.`);
    } else if (options.length === 1) {
      this.problem(
        `"${quote(src, start, this.pos)}" has only one option. Add another with |, like {Hi|Hello}, or write \\{ and \\} for real braces.`,
      );
    }
    // `occurrence` is numbered once the whole text is read (numberOccurrences).
    return { type: "variation", source, options, occurrence: 0 };
  }

  /**
   * The "}" that closes the "{" at `start`, or -1 when nothing closes it (then every "{" still open
   * is remembered as unclosed). Uses a plain stack, not recursion, with the same rules as sequence(),
   * so it agrees with a full read.
   */
  private matchingClose(start: number): number {
    const src = this.src;
    const open: number[] = [];
    let i = start;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\" && ESCAPABLE.has(src[i + 1] ?? "")) {
        i += 2;
        continue;
      }
      if (ch === "{") {
        if (this.unclosed.has(i)) break;
        if (src[i + 1] === "{") {
          const end = this.variableEnd(i);
          if (end >= 0 && src[i + 2] === "{") {
            open.push(i); // "{{{": a variation first, as in sequence()
            i++;
          } else {
            i = end >= 0 ? end + 2 : i + 2;
          }
          continue;
        }
        open.push(i);
        i++;
        continue;
      }
      if (ch === "}") {
        open.pop();
        if (open.length === 0) return i;
      }
      i++;
    }
    for (const p of open) this.unclosed.add(p);
    return -1;
  }
}

/**
 * Numbers repeated option lists in reading order, the inner ones before the variation around them
 * (the order they close in), across every line of the subject or body.
 */
function numberOccurrences(lines: readonly TemplateNode[][]): void {
  const counts = new Map<string, number>();
  const visit = (nodes: readonly TemplateNode[]) => {
    for (const n of nodes) {
      if (n.type !== "variation") continue;
      for (const o of n.options) visit(o);
      const seen = counts.get(n.source) ?? 0;
      n.occurrence = seen;
      counts.set(n.source, seen + 1);
    }
  };
  for (const line of lines) visit(line);
}

/** Splits a subject or body into lines and parses each one. Never throws. */
export function parseTemplate(source: string): ParsedTemplate {
  const sourceLines = (source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const problems: string[] = [];
  let lines: TemplateNode[][];
  try {
    lines = sourceLines.map((line) => new LineParser(line, problems).parse());
    numberOccurrences(lines);
  } catch {
    // Not expected (the parser has no deep recursion); kept so nothing can break the editor or the sender.
    lines = sourceLines.map((line): TemplateNode[] => (line ? [{ type: "text", value: line }] : []));
    problems.length = 0;
    problems.push(UNREADABLE_PROBLEM);
  }
  return { lines, sourceLines, problems: [...new Set(problems)] };
}

/** Every variable node, including those inside every option of every variation. */
export function collectVariables(nodes: readonly TemplateNode[], out: VariableNode[] = []): VariableNode[] {
  for (const n of nodes) {
    if (n.type === "variable") out.push(n);
    else if (n.type === "variation") for (const o of n.options) collectVariables(o, out);
  }
  return out;
}
