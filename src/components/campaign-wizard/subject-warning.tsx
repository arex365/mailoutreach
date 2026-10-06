import { TriangleAlert } from "lucide-react";
import { firstSubjectProblem } from "@/core/templates/subject-rules";

/**
 * The first subject's Outlook warning ("Art: …", M4-DESIGN §2.13): a hint under the subject field that never blocks
 * saving. Used by the wizard's Message step and the campaign page's "Edit this email" for a first email.
 */
export function SubjectWarning({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-sm text-warning" role="status">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  );
}

/**
 * The first-subject rules as you type (M4-DESIGN §2.13): `error` for a "Re:"/"Fwd:" start (shown under the subject,
 * and refused on save), `warning` for the Outlook "Xyz: " trap (shown as a hint). Both null for a fine subject.
 */
export function liveSubjectProblem(subject: string | null | undefined): { error: string | null; warning: string | null } {
  const problem = firstSubjectProblem(subject ?? "");
  return { error: problem?.level === "error" ? problem.text : null, warning: problem?.level === "warning" ? problem.text : null };
}
