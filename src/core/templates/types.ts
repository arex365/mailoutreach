/**
 * Shared types for the template engine (PLAN.md B6.3). Owned by the templates work package;
 * the sending engine and the campaign screens import these.
 */

export type TemplateWarningKind =
  /** An empty variable without a fallback, e.g. {{first_name}} for a "General inbox" person. */
  | "missing"
  /** A variable name that doesn't exist, e.g. {{frist_name}}. */
  | "unknown"
  /** Broken syntax: unbalanced {{ }} or { }, an empty variation option list … */
  | "syntax";

export type TemplateWarning = {
  kind: TemplateWarningKind;
  /** Variable name for "missing"/"unknown". */
  variable?: string;
  /** Where: "subject" or "body". */
  where: "subject" | "body";
  /** Plain-language message, e.g. "{{first_name}} is empty for this person and has no fallback." */
  message: string;
};

/** "preview" shows %unsubscribe_url% as "[unsubscribe link]"; "send" keeps it for Mailgun to replace. */
export type RenderPurpose = "preview" | "send";

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
  warnings: TemplateWarning[];
};
