/**
 * Renders a subject or body for one person (PLAN.md B6.3). Pure and browser-safe.
 *
 * Rules:
 *  - {{x}}            the value; when it's empty the output is empty and a "missing" warning is added.
 *  - {{x|fallback}}   the fallback when the value is empty.
 *  - {{x|}}           fine if empty. A line holding nothing but empty optional pieces is removed; when
 *                     it was a paragraph of its own, the blank line after it goes too, so no double gap
 *                     is left (right under a paragraph, that blank line is the paragraph break and
 *                     stays). Inline, an empty optional piece takes no stray space with it
 *                     ("We love {{niche|}} models").
 *  - {a|b|c}          one option per person, picked with a stable hash (hash.ts).
 *  - unknown names    an "unknown" warning; the text stays as written (or the fallback is used), so the
 *                     problem is visible in the preview.
 * Values are plain text and are never parsed again.
 */

import { variationIndex } from "./hash";
import { collectVariables, parseTemplate, type ParsedTemplate, type TemplateNode } from "./parse";
import type { TemplateWarning } from "./types";
import { isValidVariableName } from "./variables";

export type TemplateValues = Readonly<Record<string, string | null | undefined>>;

export type RenderTextOptions = {
  /** Whose email this is (drives the variation picks). Use 0 when there's no person. */
  personId: number;
  /** 0 = first email, 1..3 = follow-ups. */
  step: number;
  /** Every variable that exists (standard + custom fields) → this person's value ("" or null = empty). */
  values: TemplateValues;
  where: "subject" | "body";
};

export type RenderTextResult = { text: string; warnings: TemplateWarning[] };

/** Variables about the person rather than the company (for the wording of "missing" warnings). */
const PERSON_VARIABLES = new Set(["first_name", "contact_name"]);
const SENDER_VARIABLES = new Set(["sender_name", "sender_signature"]);

function cleanValue(v: string | null | undefined): string {
  return typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "";
}

function isKnown(values: TemplateValues, name: string): boolean {
  return isValidVariableName(name) && Object.prototype.hasOwnProperty.call(values, name);
}

function missingMessage(name: string): string {
  if (SENDER_VARIABLES.has(name)) {
    return `{{${name}}} is empty for this sender and has no fallback. They can fill it in under Settings › My profile.`;
  }
  if (name === "portfolio_url") {
    return "{{portfolio_url}} is empty and has no fallback. The Owner can set the portfolio link in Settings.";
  }
  const who = PERSON_VARIABLES.has(name) ? "this person" : "this company";
  return `{{${name}}} is empty for ${who} and has no fallback.`;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The closest known variable name, if one is close enough to be a typo. */
export function suggestVariable(name: string, known: Iterable<string>): string | null {
  const names = [...known].filter(isValidVariableName);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug && slug !== name && names.includes(slug)) return slug;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of names) {
    const d = levenshtein(slug || name, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  const limit = Math.max(1, Math.min(2, Math.floor((slug || name).length / 3)));
  return best !== null && bestDistance <= limit ? best : null;
}

function unknownMessage(raw: string, name: string, known: Iterable<string>): string {
  const shown = raw.length <= 60 ? raw : name.length <= 40 ? `{{${name}}}` : `{{${name.slice(0, 40)}…}}`;
  const suggestion = suggestVariable(name, known);
  return suggestion
    ? `${shown} isn't a variable we know. Did you mean {{${suggestion}}}?`
    : `${shown} isn't a variable we know. Use one of the variable buttons, or check the spelling.`;
}

/** Warnings that don't depend on the person: broken syntax and unknown variable names. */
function staticWarnings(parsed: ParsedTemplate, known: ReadonlySet<string>, where: "subject" | "body"): TemplateWarning[] {
  const out: TemplateWarning[] = parsed.problems.map((message) => ({ kind: "syntax" as const, where, message }));
  for (const line of parsed.lines) {
    for (const v of collectVariables(line)) {
      if (isValidVariableName(v.name) && known.has(v.name)) continue;
      out.push({ kind: "unknown", variable: v.name, where, message: unknownMessage(v.raw, v.name, known) });
    }
  }
  return out;
}

export function dedupeWarnings(warnings: readonly TemplateWarning[]): TemplateWarning[] {
  const seen = new Set<string>();
  const out: TemplateWarning[] = [];
  for (const w of warnings) {
    const key = `${w.kind}\u0000${w.where}\u0000${w.variable ?? ""}\u0000${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * Live warnings for the editor, without a person: syntax problems and unknown variable names
 * ("missing" needs real data, so it only comes from rendering).
 */
export function lintTemplate(source: string, knownNames: Iterable<string>, where: "subject" | "body"): TemplateWarning[] {
  const known = new Set([...knownNames].filter(isValidVariableName));
  return dedupeWarnings(staticWarnings(parseTemplate(source), known, where));
}

/** Variable names a subject or body uses (lowercased, first use first, every variation option included). */
export function variablesUsed(source: string): string[] {
  const parsed = parseTemplate(source);
  const names: string[] = [];
  for (const line of parsed.lines) for (const v of collectVariables(line)) if (!names.includes(v.name)) names.push(v.name);
  return names;
}

// ───────────────────────── rendering ─────────────────────────

/** A rendered piece of a line. `soft` = an optional piece ({{x|}} or a variation) that came out empty. */
type Segment = { text: string; soft: boolean };

type Ctx = RenderTextOptions & { missing: TemplateWarning[] };

function renderNodes(nodes: readonly TemplateNode[], ctx: Ctx): Segment[] {
  return nodes.map((node): Segment => {
    if (node.type === "text") return { text: node.value, soft: false };
    if (node.type === "variable") {
      if (!isKnown(ctx.values, node.name)) {
        // Unknown: keep it visible (or use the fallback the writer gave). Warned about statically.
        return { text: node.fallback ? node.fallback : node.raw, soft: false };
      }
      const value = cleanValue(ctx.values[node.name]);
      if (value) return { text: value, soft: false };
      if (node.fallback === null) {
        ctx.missing.push({ kind: "missing", variable: node.name, where: ctx.where, message: missingMessage(node.name) });
        return { text: "", soft: false };
      }
      if (node.fallback === "") return { text: "", soft: true };
      return { text: node.fallback, soft: false };
    }
    // Variation: the picked option, rendered with the same rules.
    const index = variationIndex(
      { personId: ctx.personId, step: ctx.step, options: node.source, occurrence: node.occurrence },
      node.options.length,
    );
    const text = joinSegments(renderNodes(node.options[index] ?? [], ctx));
    return text === "" ? { text: "", soft: true } : { text, soft: false };
  });
}

/** Joins a line's pieces; an empty optional piece doesn't leave a double space or a space before punctuation. */
function joinSegments(segments: readonly Segment[]): string {
  let out = "";
  let trimNextLead = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!seg.soft) {
      if (trimNextLead && seg.text) {
        out += seg.text.replace(/^[ \t]+/, "");
        trimNextLead = false;
      } else {
        out += seg.text;
      }
      continue;
    }
    let nextChar = "";
    for (let j = i + 1; j < segments.length && !nextChar; j++) nextChar = segments[j]!.text.charAt(0);
    if (/[ \t]$/.test(out) && (nextChar === "" || /[ \t,.;:!?)]/.test(nextChar))) {
      out = out.replace(/[ \t]+$/, "");
    } else if (out === "") {
      trimNextLead = true;
    }
  }
  return out;
}

/** A line with nothing but empty optional pieces (and spaces): it disappears. */
function isRemovableLine(nodes: readonly TemplateNode[], segments: readonly Segment[]): boolean {
  let anySoft = false;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const seg = segments[i]!;
    if (seg.soft) {
      anySoft = true;
      continue;
    }
    if (node.type === "text" && node.value.trim() === "") continue;
    return false;
  }
  return anySoft;
}

/** Renders a subject or body for one person. */
export function renderTemplateText(source: string, options: RenderTextOptions): RenderTextResult {
  const parsed = parseTemplate(source);
  const known = new Set(Object.keys(options.values).filter(isValidVariableName));
  const ctx: Ctx = { ...options, missing: [] };

  const out: string[] = [];
  for (let i = 0; i < parsed.lines.length; i++) {
    const nodes = parsed.lines[i]!;
    const segments = renderNodes(nodes, ctx);
    if (isRemovableLine(nodes, segments)) {
      // When the line was a paragraph of its own (first, or after a blank line), drop the blank
      // line after it too, so no double gap is left. Right under a paragraph, the blank line after
      // it is that paragraph's break and stays.
      const ownParagraph = out.length === 0 || out[out.length - 1]!.trim() === "";
      if (ownParagraph && i + 1 < parsed.lines.length && parsed.sourceLines[i + 1]!.trim() === "") i++;
      continue;
    }
    out.push(joinSegments(segments));
  }

  let text: string;
  if (options.where === "subject") {
    text = out.join(" ").replace(/\s+/g, " ").trim();
  } else {
    text = out
      .join("\n")
      .replace(/^(?:[ \t]*\n)+/, "")
      .replace(/\s+$/, "");
  }
  const warnings = dedupeWarnings([...staticWarnings(parsed, known, options.where), ...ctx.missing]);
  return { text, warnings };
}
