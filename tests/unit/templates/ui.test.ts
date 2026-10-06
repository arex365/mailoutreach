import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MASTER_SEQUENCE } from "@/core/templates/defaults";
import { renderEmail } from "@/core/templates/email";
import { mergeVariables } from "@/core/templates/variables";
import {
  addFollowUp,
  canAddFollowUp,
  firstErrorStep,
  removeFollowUp,
  snapshot,
  tabLabel,
  toEditorSteps,
  toSequence,
} from "@/components/templates/editor-state";
import { EmailPreview } from "@/components/templates/email-preview";
import { changedLabel, sequenceSummary } from "@/components/templates/format";
import { StepEditor } from "@/components/templates/step-editor";
import { TemplateWarningList } from "@/components/templates/warnings";

describe("list wording", () => {
  it("summarises the sequence", () => {
    expect(sequenceSummary({ followUps: 0, followUpsOn: 0 })).toBe("First email only");
    expect(sequenceSummary({ followUps: 1, followUpsOn: 1 })).toBe("First email + 1 follow-up");
    expect(sequenceSummary({ followUps: 3, followUpsOn: 2 })).toBe("First email + 3 follow-ups (1 switched off)");
  });

  it("says who changed it and when", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const t = { updatedAt: new Date("2026-09-20T12:00:00Z"), updatedBy: { id: 2, name: "Ali" } };
    expect(changedLabel(t, { id: 1 }, now)).toBe("Changed 3 days ago by Ali");
    expect(changedLabel(t, { id: 2 }, now)).toBe("Changed 3 days ago by you");
    expect(changedLabel({ ...t, updatedBy: null }, { id: 1 }, now)).toBe("Changed 3 days ago");
  });
});

describe("editor state", () => {
  const start = toEditorSteps(MASTER_SEQUENCE.steps);

  it("loads the steps as tabs", () => {
    expect(start.map((s) => tabLabel(s))).toEqual(["First email", "Follow-up 1", "Follow-up 2", "Follow-up 3 (off)"]);
    expect(canAddFollowUp(start)).toBe(false);
    expect(toSequence(start)).toEqual(MASTER_SEQUENCE.steps.map((s) => ({ ...s, subject: s.step === 0 ? s.subject : null })));
  });

  it("adds follow-ups with the usual waits, up to three", () => {
    let steps = toEditorSteps([MASTER_SEQUENCE.steps[0]!]);
    steps = addFollowUp(steps);
    steps = addFollowUp(steps);
    steps = addFollowUp(steps);
    expect(steps.map((s) => [s.step, s.delayDays, s.enabled])).toEqual([
      [0, 0, true],
      [1, 3, true],
      [2, 4, true],
      [3, 7, true],
    ]);
    expect(addFollowUp(steps)).toHaveLength(4);
    expect(new Set(steps.map((s) => s.key)).size).toBe(4);
  });

  it("renumbers the later follow-ups when one is removed, and never removes the first email", () => {
    const removed = removeFollowUp(start, 1);
    expect(removed.map((s) => [s.step, s.delayDays])).toEqual([
      [0, 0],
      [1, 4],
      [2, 7],
    ]);
    expect(removed[1]!.key).toBe(start[2]!.key);
    expect(removeFollowUp(start, 0)).toHaveLength(4);
  });

  it("counts only real changes as unsaved", () => {
    const base = snapshot("Master sequence", start);
    const spaces = start.map((s) => (s.step === 1 ? { ...s, body: `${s.body}   \n\n` } : s));
    expect(snapshot("  Master   sequence ", spaces)).toBe(base);
    expect(snapshot("Master sequence", start.map((s) => (s.step === 2 ? { ...s, enabled: !s.enabled } : s)))).not.toBe(base);
    expect(snapshot("Master sequence", start.map((s) => (s.step === 1 ? { ...s, delayDays: Number.NaN } : s)))).not.toBe(base);
  });

  it("finds the first tab with a problem", () => {
    expect(firstErrorStep({ name: ["x"], "step2.body": ["y"], "step1.delayDays": ["z"] })).toBe(1);
    expect(firstErrorStep({ name: ["x"] })).toBeNull();
    expect(firstErrorStep({ "step0.subject": [] })).toBeNull();
  });
});

describe("StepEditor", () => {
  const variables = mergeVariables([{ key: "est_revenue", label: "Est. revenue" }]);
  const render = (props: Partial<Parameters<typeof StepEditor>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(StepEditor, {
        id: "s",
        value: { subject: "Hi {{company}}", body: "Hello {{frist_name}}" },
        onChange: () => undefined,
        variables,
        showSubject: true,
        ...props,
      }),
    );

  it("shows the subject only for the first email", () => {
    expect(render()).toContain('id="s-subject"');
    expect(render({ showSubject: false })).not.toContain('id="s-subject"');
  });

  it("has a one-click button per variable, custom fields included", () => {
    const html = render();
    expect(html).toContain('aria-label="Insert First name ({{first_name}})"');
    expect(html).toContain('aria-label="Insert Est. revenue ({{est_revenue}})"');
    expect(html).toContain("From your imports:");
  });

  it("shows live warnings and the cheat-sheet", () => {
    const html = render();
    expect(html).toContain("{{frist_name}} isn&#x27;t a variable we know. Did you mean {{first_name}}?");
    expect(html).toContain("How variables, fallbacks and variations work");
    expect(render({ warnings: null })).not.toContain("isn&#x27;t a variable we know");
    expect(render({ warnings: createElement("p", null, "Custom slot") })).toContain("Custom slot");
  });

  it("puts the preview slot beside the editor", () => {
    expect(render({ preview: createElement("div", { id: "pv" }, "Preview here") })).toContain('<div id="pv">Preview here</div>');
  });

  it("shows field errors in plain words", () => {
    const html = render({ subjectError: "Write a subject for the first email.", bodyError: "Write the first email." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Write a subject for the first email.");
    expect(html).toContain("Write the first email.");
  });
});

describe("EmailPreview", () => {
  it("shows the subject, the text and the footer, with missing details listed", () => {
    const email = renderEmail({
      step: 0,
      subject: "Hello {{company}}",
      body: "Hi {{first_name}},\n\nThanks",
      personId: 1,
      values: { first_name: "", company: "Acme" },
      footer: { companyName: "Polygon Paradise", address: "Lahore", unsubscribeText: "Unsubscribe here:" },
      purpose: "preview",
    });
    const html = renderToStaticMarkup(createElement(EmailPreview, { email }));
    expect(html).toContain("Hello Acme");
    expect(html).toContain("Hi ,\n\nThanks");
    expect(html).toContain("--\nPolygon Paradise · Lahore\nUnsubscribe here: [unsubscribe link]");
    expect(html).toContain("Missing for this contact");
    expect(html).toContain("{{first_name}} is empty for this person and has no fallback.");
  });

  it("explains an empty preview and errors", () => {
    expect(renderToStaticMarkup(createElement(EmailPreview, { email: null }))).toContain("Pick a contact to see the email.");
    expect(renderToStaticMarkup(createElement(EmailPreview, { email: null, error: "This contact was deleted." }))).toContain(
      "This contact was deleted.",
    );
  });

  it("renders nothing for no warnings", () => {
    expect(renderToStaticMarkup(createElement(TemplateWarningList, { warnings: [] }))).toBe("");
  });
});
