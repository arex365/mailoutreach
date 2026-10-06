/**
 * Puts a whole email together for one person (PLAN.md B6.3, B6.4, A7): subject, body, footer,
 * plain text + minimal HTML, and the warnings. Pure: the server loads the data (render.ts in
 * src/server/services) and the browser can call this too.
 */

import { footerHtml, footerText, textToHtml, type FooterSettings } from "./html";
import { dedupeWarnings, renderTemplateText, type TemplateValues } from "./render";
import type { RenderedEmail, RenderPurpose, TemplateWarning } from "./types";

export type RenderEmailInput = {
  /** 0 = first email, 1..3 = follow-ups. */
  step: number;
  /**
   * The FIRST email's subject template. Step 0 renders it as the subject; follow-ups use
   * "Re: " + it (rendered as step 0 for this person) when `firstSubject` isn't given.
   */
  subject: string | null;
  /** This step's body template. */
  body: string;
  /** Follow-ups: the first email's subject exactly as this person received it (e.g. from the sent email). */
  firstSubject?: string | null;
  personId: number;
  values: TemplateValues;
  footer: FooterSettings;
  purpose: RenderPurpose;
};

/** "Re: " + the first subject, never "Re: Re: …". */
export function followUpSubject(firstSubject: string): string {
  const s = (firstSubject ?? "").replace(/\s+/g, " ").trim();
  if (/^re\s*:/i.test(s)) return s;
  return s ? `Re: ${s}` : "Re:";
}

/** The first email's subject for this person (variations picked as step 0, like the real first email). */
export function renderFirstSubject(subject: string | null, personId: number, values: TemplateValues) {
  return renderTemplateText(subject ?? "", { personId, step: 0, values, where: "subject" });
}

/** Renders one email. Deterministic: the same input always gives the same output. */
export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const { step, personId, values, footer, purpose } = input;
  let subject: string;
  const warnings: TemplateWarning[] = [];
  if (step === 0) {
    const r = renderFirstSubject(input.subject, personId, values);
    subject = r.text;
    warnings.push(...r.warnings);
  } else if (input.firstSubject !== undefined && input.firstSubject !== null) {
    subject = followUpSubject(input.firstSubject);
  } else {
    // The first subject's own warnings belong to the first email; they aren't repeated here.
    subject = followUpSubject(renderFirstSubject(input.subject, personId, values).text);
  }
  const body = renderTemplateText(input.body ?? "", { personId, step, values, where: "body" });
  warnings.push(...body.warnings);
  const text = [body.text, footerText(footer, purpose)].filter(Boolean).join("\n\n");
  const html = [textToHtml(body.text), footerHtml(footer, purpose)].filter(Boolean).join("\n");
  return { subject, text, html, warnings: dedupeWarnings(warnings) };
}

/** Where the footer starts in a rendered text (for showing it muted in previews); -1 if absent. */
export function footerStart(text: string): number {
  const i = text.lastIndexOf("\n--\n");
  if (i >= 0) return i + 1;
  return text.startsWith("--\n") ? 0 : -1;
}
