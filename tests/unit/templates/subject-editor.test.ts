import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FIRST_SUBJECT_OUTLOOK_WARNING, FIRST_SUBJECT_REPLY_ERROR } from "@/core/templates/subject-rules";
import { mergeVariables } from "@/core/templates/variables";
import { firstSubjectError, subjectHint } from "@/components/templates/editor-state";
import { StepEditor } from "@/components/templates/step-editor";

/** The template editor's first-subject rules (M4-DESIGN §2.13): an error on Save, a warning while typing. */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
}

describe("first-subject rules in the template editor", () => {
  it("makes Re: and Fwd: starts a Save error, and nothing else", () => {
    for (const s of ["Re: 3D models for {{company}}", "RE : Your shop", "Fwd: prices", "FW: models", "fw:x", "  re: spaced"]) {
      expect(firstSubjectError(s), s).toBe(FIRST_SUBJECT_REPLY_ERROR);
    }
    for (const s of ["Art: 3D models", "3D: models", "Reply wanted?", "Refresh your catalogue", ""]) {
      expect(firstSubjectError(s), s).toBeNull();
    }
  });

  it("warns about the Outlook trap while typing, and repeats the error live", () => {
    expect(subjectHint("Art: 3D models for {{company}}")).toEqual({ level: "warning", text: FIRST_SUBJECT_OUTLOOK_WARNING });
    expect(subjectHint("FYI: new models")).toEqual({ level: "warning", text: FIRST_SUBJECT_OUTLOOK_WARNING });
    expect(subjectHint("Re: models")).toEqual({ level: "error", text: FIRST_SUBJECT_REPLY_ERROR });
    expect(subjectHint("3D models for {{company}}")).toBeNull();
  });
});

describe("StepEditor subject line", () => {
  const variables = mergeVariables([]);
  const render = (props: Partial<Parameters<typeof StepEditor>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(StepEditor, {
        id: "s",
        value: { subject: "Art: 3D models", body: "Hello" },
        onChange: () => undefined,
        variables,
        showSubject: true,
        ...props,
      }),
    );

  it("shows the Outlook warning under the subject, tied to the field", () => {
    const html = render({ subjectProblem: subjectHint("Art: 3D models") });
    expect(html).toContain(esc(FIRST_SUBJECT_OUTLOOK_WARNING));
    expect(html).toContain('aria-describedby="s-subject-problem"');
    expect(html).toContain("text-warning");
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain("Follow-ups use");
  });

  it("marks the field invalid for the Re: error, and a Save error wins", () => {
    const live = render({ value: { subject: "Re: models", body: "Hello" }, subjectProblem: subjectHint("Re: models") });
    expect(live).toContain(esc(FIRST_SUBJECT_REPLY_ERROR));
    expect(live).toContain('aria-invalid="true"');
    expect(live).toContain("text-destructive");
    const saved = render({ subjectError: "Write a subject for the first email.", subjectProblem: subjectHint("Art: x") });
    expect(saved).toContain("Write a subject for the first email.");
    expect(saved).not.toContain(esc(FIRST_SUBJECT_OUTLOOK_WARNING));
  });

  it("shows the usual hint when there is no problem (and without the prop, as the wizard uses it)", () => {
    expect(render({ subjectProblem: null })).toContain("Follow-ups use");
    expect(render()).toContain("Follow-ups use");
  });
});
