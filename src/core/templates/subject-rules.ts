/**
 * First-subject rules (M4-DESIGN §2.13; research notifications-and-threading B3.1–B3.2). Follow-ups get "Re: " + the
 * first subject automatically, so the first subject itself may not pretend to be a reply or a forward (Gmail's sender
 * rules), and a short "Xyz: " start would make Outlook show the follow-ups as a separate conversation. Used by the
 * template editor, the wizard's Message step, per-person first-subject edits and the launch check. Pure and
 * browser-safe.
 */

/** The error for a first subject that starts with "Re:", "Fwd:" or "FW:". */
export const FIRST_SUBJECT_REPLY_ERROR =
  "Don't start a first email with “Re:” or “Fwd:”. Gmail's rules forbid it for emails that aren't real replies. Follow-ups get “Re:” automatically.";
/** The warning for a first subject that starts with a short word and a colon ("Art: …"). */
export const FIRST_SUBJECT_OUTLOOK_WARNING =
  "Outlook would show the follow-ups as a separate conversation, because the subject starts with a short word and a colon. Reword the start of the subject.";

/** "Re:", "RE:", "Fwd:", "FW:", "Fw:" in any case, spaces allowed before the colon. */
const REPLY_OR_FORWARD = /^(?:re|fwd?)\s*:/i;
/** Outlook's subject-prefix rule: one to three letters, an optional space, a colon and a space (the one regex). */
const OUTLOOK_PREFIX = /^\p{L}{1,3}\s?:\s/u;

/**
 * The problem with a first subject, or null: an error for "Re:" / "Fwd:" / "FW:" starts (enforced on save and at
 * launch), a warning for the Outlook "Xyz: " trap (shown in the editors only). Subjects starting with digits ("3D: …")
 * are fine. Leading spaces are ignored (subjects are trimmed when rendered).
 */
export function firstSubjectProblem(subject: string): { level: "error" | "warning"; text: string } | null {
  if (typeof subject !== "string") return null;
  const s = subject.trimStart();
  if (REPLY_OR_FORWARD.test(s)) return { level: "error", text: FIRST_SUBJECT_REPLY_ERROR };
  if (OUTLOOK_PREFIX.test(s)) return { level: "warning", text: FIRST_SUBJECT_OUTLOOK_WARNING };
  return null;
}
