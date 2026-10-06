import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * First-subject rules on the template's Save (M4-DESIGN §2.13): "Re:" / "Fwd:" starts are refused with the rule's own
 * sentence under the subject; the Outlook warning ("Art: …") never blocks saving.
 */

const t = await createTestDb("templates-first-subject");
const { db, dbWrite } = await import("@/server/db");
const templates = await import("@/server/services/templates");
const { FIRST_SUBJECT_REPLY_ERROR } = await import("@/core/templates/subject-rules");
const { DEFAULT_TEMPLATES } = await import("@/core/templates/defaults");

let ali: { id: number; name: string };
let templateId = 0;

const BODY = "Hi {{first_name|there}},\n\n{{sender_signature}}";
const steps = (subject: string) => [
  { step: 0, enabled: true, subject, body: BODY, delayDays: 0 },
  { step: 1, enabled: true, subject: null, body: "Just checking in.", delayDays: 3 },
];

beforeAll(async () => {
  ali = await dbWrite((c) => c.user.create({ data: { name: "Ali", email: "ali@pp.test", role: "OWNER" }, select: { id: true, name: true } }));
  const created = await templates.createTemplate(ali, "Norway prints");
  if (!created.ok) throw new Error(created.error);
  templateId = created.template.id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function storedSubject(): Promise<string | null> {
  return (await db.templateStep.findFirstOrThrow({ where: { templateId, step: 0 } })).subject;
}

describe("saving a template's first subject", () => {
  it("refuses Re:, RE:, Fwd:, FW: and Fw: starts with the rule's sentence, and saves nothing", async () => {
    for (const subject of ["Re: 3D models for {{company}}", "RE : your shop", "Fwd: prices", "FW: 3D models", "Fw:models", "  re: spaced"]) {
      const res = await templates.saveTemplate(ali, templateId, { name: "Norway prints", steps: steps(subject) });
      expect(res, subject).toEqual({ ok: false, error: FIRST_SUBJECT_REPLY_ERROR, fieldErrors: { "step0.subject": [FIRST_SUBJECT_REPLY_ERROR] } });
    }
    expect(await storedSubject()).toBe("");
    expect(await db.activityLog.count({ where: { type: "template.updated" } })).toBe(0);
  });

  it("refuses it through saveSteps too (Save back to template from a campaign)", async () => {
    const res = await templates.saveSteps(ali, templateId, steps("Re: models"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors?.["step0.subject"]).toEqual([FIRST_SUBJECT_REPLY_ERROR]);
  });

  it("lists it with the other problems when there are more", async () => {
    const res = await templates.saveTemplate(ali, templateId, {
      name: "   ",
      steps: [{ step: 0, enabled: true, subject: "Fwd: models", body: "", delayDays: 0 }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.fieldErrors?.["step0.subject"]).toEqual([FIRST_SUBJECT_REPLY_ERROR]);
    expect(res.fieldErrors?.["step0.body"]).toBeTruthy();
    expect(res.fieldErrors?.name).toBeTruthy();
    expect(res.error).not.toBe(FIRST_SUBJECT_REPLY_ERROR);
    // An empty subject keeps its own message.
    const empty = await templates.saveTemplate(ali, templateId, { steps: steps("") });
    expect(!empty.ok && empty.fieldErrors?.["step0.subject"]).toEqual(["Write a subject for the first email."]);
  });

  it("saves subjects that only get the Outlook warning, and ordinary ones", async () => {
    for (const subject of ["Art: 3D models for {{company}}", "FYI: new models", "3D: models", "Refresh your catalogue"]) {
      const res = await templates.saveTemplate(ali, templateId, { steps: steps(subject) });
      expect(res.ok, subject).toBe(true);
      expect(await storedSubject()).toBe(subject);
    }
  });

  it("the default templates' first subjects pass the rule", () => {
    for (const d of DEFAULT_TEMPLATES) {
      const first = d.steps.find((s) => s.step === 0)!;
      expect(templates.firstSubjectFieldError([{ ...first, subject: first.subject ?? "" }]), d.name).toBeNull();
    }
  });
});
