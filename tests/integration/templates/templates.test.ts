import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("templates");
const { db, dbWrite } = await import("@/server/db");
const templates = await import("@/server/services/templates");
const { CREATORS_SEQUENCE, MASTER_SEQUENCE, NEW_FIRST_EMAIL_BODY } = await import("@/core/templates/defaults");

let ali: { id: number; name: string };
let arslan: { id: number; name: string };

beforeAll(async () => {
  ali = await dbWrite((c) =>
    c.user.create({ data: { name: "Ali", email: `ali.${Date.now()}@example.com`, role: "OWNER" }, select: { id: true, name: true } }),
  );
  arslan = await dbWrite((c) =>
    c.user.create({ data: { name: "Arslan", email: `arslan.${Date.now()}@example.com`, role: "MEMBER" }, select: { id: true, name: true } }),
  );
});

/** Lets the clock move on, so a changed updatedAt would really differ. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Every template's "Changed … by" data. */
async function changedStamps() {
  const rows = await db.template.findMany({ orderBy: { id: "asc" }, select: { id: true, updatedAt: true, updatedById: true } });
  return rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt.getTime(), updatedById: r.updatedById }));
}

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function masters() {
  return db.template.findMany({ where: { isMaster: true }, select: { id: true, name: true } });
}

const FIRST = { step: 0, enabled: true, subject: "Hello {{company}}", body: "Hi {{first_name|there}},\n\n{{sender_signature}}", delayDays: 0 };

describe("default templates (PLAN A7)", () => {
  it("are created exactly once, even when several pages load at the same time", async () => {
    expect(await db.template.count()).toBe(0);
    const results = await Promise.all([
      templates.ensureDefaultTemplates(),
      templates.ensureDefaultTemplates(),
      templates.ensureDefaultTemplates(),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await templates.ensureDefaultTemplates()).toBe(false);
    expect(await db.template.count()).toBe(2);
    expect(await db.activityLog.count({ where: { type: "template.created" } })).toBe(1);
    const log = await db.activityLog.findFirst({ where: { type: "template.created" } });
    expect(log?.actorId).toBeNull();
    expect(log?.summary).toBe('The default templates were added: "Master sequence" and "Creators"');
  });

  it("have the exact copy, one master, and the master's follow-up 3 switched off", async () => {
    const list = await templates.listTemplates();
    expect(list.map((x) => [x.name, x.isMaster, x.followUps, x.followUpsOn])).toEqual([
      ["Master sequence", true, 3, 2],
      ["Creators", false, 1, 1],
    ]);
    expect(await masters()).toHaveLength(1);
    const master = await templates.getTemplate(list[0]!.id);
    expect(master?.steps).toEqual(MASTER_SEQUENCE.steps);
    const creators = await templates.getTemplate(list[1]!.id);
    expect(creators?.steps).toEqual(CREATORS_SEQUENCE.steps);
    expect(master?.steps[0]?.body).toContain("{Hi|Hello} {{first_name|there}},\n\n{{personal_line|}}\n\nI'm {{sender_name}} from Polygon Paradise.");
    expect(master?.steps[1]?.body).toContain("{{portfolio_url}}");
    expect((await templates.getMasterTemplate()).name).toBe("Master sequence");
  });
});

describe("create, duplicate, rename", () => {
  it("creates a template with just a first email", async () => {
    const res = await templates.createTemplate(ali, "  Norway   printers ");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.template.name).toBe("Norway printers");
    const detail = await templates.getTemplate(res.template.id);
    expect(detail?.isMaster).toBe(false);
    expect(detail?.steps).toEqual([{ step: 0, enabled: true, subject: "", body: NEW_FIRST_EMAIL_BODY, delayDays: 0 }]);
    const log = await db.activityLog.findFirst({ where: { type: "template.created", actorId: ali.id } });
    expect(log?.summary).toBe('Ali created the template "Norway printers"');
  });

  it("refuses an empty or taken name, in plain words", async () => {
    expect(await templates.createTemplate(ali, "  ")).toMatchObject({ ok: false, error: "Give the template a name." });
    expect(await templates.createTemplate(ali, "MASTER sequence")).toMatchObject({
      ok: false,
      error: 'There\'s already a template called "Master sequence". Pick another name.',
    });
  });

  it("duplicates every step, never the star, with a free name", async () => {
    const master = (await templates.getMasterTemplate()).id;
    const a = await templates.duplicateTemplate(ali, master);
    const b = await templates.duplicateTemplate(ali, master);
    expect(a.ok && a.template.name).toBe("Master sequence (copy)");
    expect(b.ok && b.template.name).toBe("Master sequence (copy 2)");
    if (!a.ok) return;
    const copy = await templates.getTemplate(a.template.id);
    expect(copy?.isMaster).toBe(false);
    expect(copy?.steps).toEqual(MASTER_SEQUENCE.steps);
    expect(await masters()).toHaveLength(1);
    const again = await templates.duplicateTemplate(ali, a.template.id);
    expect(again.ok && again.template.name).toBe("Master sequence (copy 3)");
    expect(await templates.duplicateTemplate(ali, 999_999)).toMatchObject({ ok: false, error: templates.TEMPLATE_GONE });
  });

  it("renames, but not onto another template's name", async () => {
    const created = await templates.createTemplate(ali, "Temp name");
    if (!created.ok) throw new Error("setup failed");
    const renamed = await templates.renameTemplate(ali, created.template.id, "Better name");
    expect(renamed).toMatchObject({ ok: true, template: { name: "Better name" } });
    expect(await templates.renameTemplate(ali, created.template.id, "creators")).toMatchObject({ ok: false });
    expect(await templates.renameTemplate(ali, 999_999, "x")).toMatchObject({ ok: false, error: templates.TEMPLATE_GONE });
    const log = await db.activityLog.findFirst({ where: { type: "template.updated" }, orderBy: { id: "desc" } });
    expect(log?.summary).toBe('Ali renamed the template "Temp name" to "Better name"');
  });
});

describe("master star", () => {
  it("keeps exactly one master", async () => {
    const creators = (await templates.listTemplates()).find((x) => x.name === "Creators")!;
    const res = await templates.starMaster(ali, creators.id);
    expect(res).toMatchObject({ ok: true, changed: true });
    expect((await masters()).map((m) => m.name)).toEqual(["Creators"]);
    expect(await templates.starMaster(ali, creators.id)).toMatchObject({ ok: true, changed: false });
    const log = await db.activityLog.findFirst({ where: { type: "template.starred" }, orderBy: { id: "desc" } });
    expect(log?.summary).toBe('Ali made "Creators" the master template');
    expect((await templates.listTemplates())[0]?.name).toBe("Creators");
    // Back to the master sequence for the next tests.
    const master = (await templates.listTemplates()).find((x) => x.name === "Master sequence")!;
    await templates.starMaster(ali, master.id);
    expect((await masters()).map((m) => m.name)).toEqual(["Master sequence"]);
  });

  it("repairs a missing or doubled master when the list loads", async () => {
    const master = (await masters())[0]!;
    await dbWrite((c) => c.template.updateMany({ data: { isMaster: false } }));
    let stamps = await changedStamps();
    await tick();
    expect(await templates.ensureDefaultTemplates()).toBe(false);
    const oldest = await db.template.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
    expect((await masters()).map((m) => m.id)).toEqual([oldest!.id]);
    expect(await changedStamps()).toEqual(stamps);
    await dbWrite((c) => c.template.updateMany({ data: { isMaster: true } }));
    stamps = await changedStamps();
    await tick();
    await templates.ensureDefaultTemplates();
    expect((await masters()).map((m) => m.id)).toEqual([oldest!.id]);
    expect(await changedStamps()).toEqual(stamps);
    await templates.starMaster(ali, master.id);
    expect((await masters()).map((m) => m.id)).toEqual([master.id]);
  });

  it("doesn't change 'Changed … by' on either template (the star is in the activity log)", async () => {
    const list = await templates.listTemplates();
    const creators = list.find((x) => x.name === "Creators")!;
    const master = list.find((x) => x.name === "Master sequence")!;
    // Ali edits Creators; a while later Arslan stars it.
    const saved = await templates.saveSteps(ali, creators.id, (await templates.getTemplate(creators.id))!.steps);
    expect(saved.ok).toBe(true);
    const before = await changedStamps();
    await tick();
    expect(await templates.starMaster(arslan, creators.id)).toMatchObject({ ok: true, changed: true });
    expect(await changedStamps()).toEqual(before);
    const after = await templates.listTemplates();
    expect(after.find((x) => x.id === creators.id)?.updatedBy?.name).toBe("Ali");
    expect(after.find((x) => x.id === master.id)?.updatedAt.getTime()).toBe(master.updatedAt.getTime());
    const log = await db.activityLog.findFirst({ where: { type: "template.starred" }, orderBy: { id: "desc" } });
    expect(log).toMatchObject({ actorId: arslan.id, summary: 'Arslan made "Creators" the master template' });
    // Back to the master sequence for the next tests.
    await tick();
    await templates.starMaster(arslan, master.id);
    expect((await masters()).map((m) => m.name)).toEqual(["Master sequence"]);
    expect(await changedStamps()).toEqual(before);
  });
});

describe("two people editing the same template", () => {
  let id: number;

  beforeAll(async () => {
    const res = await templates.createTemplate(ali, "Shared template");
    if (!res.ok) throw new Error("setup failed");
    id = res.template.id;
  });

  it("refuses a save made from an older copy, and says who changed it", async () => {
    const opened = (await templates.getTemplate(id))!.updatedAt.toISOString(); // Ali and Arslan both open the editor
    await tick();
    const arslanSave = await templates.saveTemplate(arslan, id, {
      name: "Shared template",
      steps: [FIRST, { step: 1, enabled: true, body: "Arslan's follow-up", delayDays: 3 }],
      expectedUpdatedAt: opened,
    });
    expect(arslanSave.ok).toBe(true);
    if (!arslanSave.ok) return;
    await tick();
    const aliSave = await templates.saveTemplate(ali, id, { name: "Shared template", steps: [FIRST], expectedUpdatedAt: opened });
    expect(aliSave).toEqual({
      ok: false,
      error: "Arslan changed this template after you opened it. Reload to see their changes; copy your text first if you need it.",
    });
    // Arslan's follow-up is still there.
    expect((await templates.getTemplate(id))?.steps.map((s) => s.body)).toEqual([FIRST.body, "Arslan's follow-up"]);

    // After reloading, Ali's save goes through; his next save from the same editor too.
    const reloaded = arslanSave.template.updatedAt;
    const again = await templates.saveTemplate(ali, id, { name: "Shared template", steps: [FIRST], expectedUpdatedAt: reloaded });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    await tick();
    const next = await templates.saveSteps(ali, id, [FIRST], { expectedUpdatedAt: again.template.updatedAt });
    expect(next.ok).toBe(true);
  });

  it("words it for the same person saving from another tab", async () => {
    const opened = (await templates.getTemplate(id))!.updatedAt;
    await tick();
    expect((await templates.saveSteps(ali, id, [FIRST], { expectedUpdatedAt: opened })).ok).toBe(true);
    await tick();
    expect(await templates.saveSteps(ali, id, [FIRST], { expectedUpdatedAt: opened })).toEqual({
      ok: false,
      error:
        "You saved this template in another tab or from a campaign after you opened it here. Reload to see that version; copy your text first if you need it.",
    });
  });

  it("isn't tripped by starring, and is skipped without a version (Save back from a campaign)", async () => {
    const opened = (await templates.getTemplate(id))!.updatedAt;
    await tick();
    await templates.starMaster(arslan, id);
    expect((await templates.saveSteps(ali, id, [FIRST], { expectedUpdatedAt: opened })).ok).toBe(true);
    const master = (await templates.listTemplates()).find((x) => x.name === "Master sequence")!;
    await templates.starMaster(arslan, master.id);
    // No version: the check is skipped, so an older copy still saves (the campaign's Save back).
    await tick();
    expect((await templates.saveSteps(arslan, id, [FIRST], { expectedUpdatedAt: opened })).ok).toBe(false);
    expect((await templates.saveSteps(arslan, id, [FIRST])).ok).toBe(true);
  });

  it("says 'Someone' when it doesn't know who", () => {
    expect(templates.changedSinceMessage(null, ali)).toBe(
      "Someone changed this template after you opened it. Reload to see their changes; copy your text first if you need it.",
    );
  });
});

describe("saveSteps", () => {
  let id: number;

  beforeAll(async () => {
    const res = await templates.createTemplate(ali, "Save tests");
    if (!res.ok) throw new Error("setup failed");
    id = res.template.id;
  });

  it("needs a subject and a body on the first email", async () => {
    const res = await templates.saveSteps(ali, id, [{ ...FIRST, subject: " ", body: "" }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.fieldErrors).toEqual({
      "step0.subject": ["Write a subject for the first email."],
      "step0.body": ["Write the first email."],
    });
  });

  it("needs follow-ups in order, with a body and at least one day", async () => {
    const bad = await templates.saveSteps(ali, id, [FIRST, { step: 1, enabled: true, body: "Again", delayDays: 0 }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fieldErrors).toEqual({ "step1.delayDays": ["Pick a whole number of days from 1 to 90."] });
    const gap = await templates.saveSteps(ali, id, [FIRST, { step: 2, enabled: true, body: "Again", delayDays: 2 }]);
    expect(gap.ok).toBe(false);
    const empty = await templates.saveSteps(ali, id, [FIRST, { step: 1, enabled: false, body: "  ", delayDays: 2 }]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.fieldErrors).toEqual({ "step1.body": ["Write follow-up 1, or remove it."] });
  });

  it("saves follow-ups without subjects, and removes the ones taken out", async () => {
    const three = await templates.saveSteps(ali, id, [
      FIRST,
      { step: 1, enabled: true, subject: "ignored", body: "Follow one", delayDays: 3 },
      { step: 2, enabled: false, body: "Follow two", delayDays: 5 },
    ]);
    expect(three.ok).toBe(true);
    if (!three.ok) return;
    expect(three.template.steps).toEqual([
      { step: 0, enabled: true, subject: "Hello {{company}}", body: "Hi {{first_name|there}},\n\n{{sender_signature}}", delayDays: 0 },
      { step: 1, enabled: true, subject: null, body: "Follow one", delayDays: 3 },
      { step: 2, enabled: false, subject: null, body: "Follow two", delayDays: 5 },
    ]);
    const stored = await db.templateStep.findMany({ where: { templateId: id }, orderBy: { step: "asc" } });
    expect(stored.map((s) => s.subject)).toEqual(["Hello {{company}}", null, null]);

    const one = await templates.saveSteps(ali, id, [FIRST]);
    expect(one.ok && one.template.steps.map((s) => s.step)).toEqual([0]);
    expect(await db.templateStep.count({ where: { templateId: id } })).toBe(1);
    const log = await db.activityLog.findFirst({ where: { type: "template.updated" }, orderBy: { id: "desc" } });
    expect(log?.summary).toBe('Ali saved the template "Save tests"');
    expect((await templates.getTemplate(id))?.updatedBy?.name).toBe("Ali");
  });

  it("saves a new name together with the steps", async () => {
    const res = await templates.saveTemplate(ali, id, { name: "Saved tests", steps: [FIRST] });
    expect(res.ok && res.template.name).toBe("Saved tests");
    const taken = await templates.saveTemplate(ali, id, { name: "Creators", steps: [FIRST] });
    expect(taken).toMatchObject({ ok: false, fieldErrors: { name: ['There\'s already a template called "Creators". Pick another name.'] } });
    const both = await templates.saveTemplate(ali, id, { name: "", steps: [{ ...FIRST, subject: "" }] });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(Object.keys(both.fieldErrors ?? {}).sort()).toEqual(["name", "step0.subject"]);
    expect(await templates.saveSteps(ali, 999_999, [FIRST])).toMatchObject({ ok: false, error: templates.TEMPLATE_GONE });
  });
});

describe("delete", () => {
  it("stars another template when the master is deleted", async () => {
    const master = await templates.getMasterTemplate();
    const before = await changedStamps();
    await tick();
    const res = await templates.deleteTemplate(ali, master.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.name).toBe("Master sequence");
    expect(res.newMaster).not.toBeNull();
    expect((await masters()).map((m) => m.id)).toEqual([res.newMaster!.id]);
    // Becoming the master isn't an edit: its "Changed … by" stays.
    expect(await changedStamps()).toEqual(before.filter((s) => s.id !== master.id));
    expect(await db.templateStep.count({ where: { templateId: master.id } })).toBe(0);
    const log = await db.activityLog.findFirst({ where: { type: "template.deleted" } });
    expect(log?.summary).toBe('Ali deleted the template "Master sequence"');
  });

  it("refuses to delete the last template", async () => {
    const all = await templates.listTemplates();
    for (const x of all.slice(1)) {
      const r = await templates.deleteTemplate(ali, x.id);
      expect(r.ok).toBe(true);
    }
    const last = (await templates.listTemplates())[0]!;
    expect(last.isMaster).toBe(true);
    expect(await templates.deleteTemplate(ali, last.id)).toEqual({ ok: false, error: "Keep at least one template." });
    expect(await db.template.count()).toBe(1);
    expect(await templates.deleteTemplate(ali, 999_999)).toMatchObject({ ok: false, error: templates.TEMPLATE_GONE });
    // Defaults never come back while any template exists.
    expect(await templates.ensureDefaultTemplates()).toBe(false);
  });
});

describe("templateVariables", () => {
  it("lists the standard variables plus custom fields with their labels", async () => {
    await dbWrite((c) =>
      c.customField.createMany({
        data: [
          { key: "est_revenue", label: "Est. revenue", entity: "COMPANY" },
          { key: "followers", label: "Followers", entity: "COMPANY" },
        ],
      }),
    );
    const vars = await templates.templateVariables();
    expect(vars.slice(0, 3).map((v) => v.name)).toEqual(["first_name", "contact_name", "company"]);
    expect(vars.filter((v) => v.custom)).toEqual([
      expect.objectContaining({ name: "est_revenue", label: "Est. revenue", custom: true }),
      expect.objectContaining({ name: "followers", label: "Followers", custom: true }),
    ]);
  });
});
