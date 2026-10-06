/**
 * The template engine (PLAN.md B6.3): pure, browser-safe, shared by the web app, the worker and tests.
 *   parse.ts      syntax → nodes (+ plain-language syntax problems)
 *   render.ts     one subject/body for one person: variables, fallbacks, stable variations, warnings
 *   email.ts      a whole email: subject ("Re: …" for follow-ups), text, HTML, footer
 *   html.ts       text → minimal HTML, and the footer
 *   context.ts    the variable values for a person + sender
 *   variables.ts  the standard variables (+ custom fields)
 *   steps.ts      sequence rules (first email + up to 3 follow-ups)
 *   defaults.ts   the default sequences from PLAN.md A7
 */

export * from "./types";
export * from "./variables";
export { fnv1a32, variationIndex, type VariationKey } from "./hash";
export { parseTemplate, unescapeTemplateText, type ParsedTemplate, type TemplateNode } from "./parse";
export {
  dedupeWarnings,
  lintTemplate,
  renderTemplateText,
  suggestVariable,
  variablesUsed,
  type RenderTextOptions,
  type RenderTextResult,
  type TemplateValues,
} from "./render";
export {
  escapeHtml,
  footerHtml,
  footerText,
  linkifyLine,
  textToHtml,
  FOOTER_SEPARATOR,
  UNSUBSCRIBE_PLACEHOLDER,
  UNSUBSCRIBE_PREVIEW_TEXT,
  type FooterSettings,
} from "./html";
export { followUpSubject, footerStart, renderEmail, renderFirstSubject, type RenderEmailInput } from "./email";
export {
  buildTemplateValues,
  customFieldText,
  websiteForTemplate,
  type TemplateCompany,
  type TemplatePerson,
  type TemplateSender,
  type TemplateValueInput,
} from "./context";
export * from "./steps";
export * from "./defaults";
