import type { Prisma } from "@/generated/prisma/client";
import { GENERAL_INBOX_NAME } from "@/core/email-address";
import { DEFAULT_TEMPLATES, NEW_FIRST_EMAIL_BODY, type DefaultTemplate } from "@/core/templates/defaults";
import {
  cleanTemplateName,
  templateNameProblem,
  validateSequence,
  type SequenceStep,
  type StepFieldErrors,
} from "@/core/templates/steps";
import { firstSubjectProblem } from "@/core/templates/subject-rules";
import { mergeVariables, type TemplateVariable } from "@/core/templates/variables";
import { normalizeText } from "@/core/text";
import { logActivity } from "@/server/activity";
import { db, dbTx, type DbOrTx, type Tx } from "@/server/db";

/**
 * Templates (PLAN.md A5.10, B4, B6.3; SPEC §5). A template is a sequence: the first email (step 0,
 * with the subject) plus up to three follow-ups (steps 1..3, each "N days after the previous step
 * if there's no reply", switchable on/off). Exactly one template is the master: new campaigns start
 * from it. At least one template always remains. Members and the Owner can both edit templates.
 */

export type Actor = { id: number; name: string };

export type TemplateStepData = {
  step: number;
  enabled: boolean;
  subject: string | null;
  body: string;
  delayDays: number;
};

export type TemplateSummary = {
  id: number;
  name: string;
  isMaster: boolean;
  /** The first email's subject template (may be empty for a brand-new template). */
  firstSubject: string | null;
  /** Follow-ups written (1..3), and how many of them are switched on. */
  followUps: number;
  followUpsOn: number;
  updatedAt: Date;
  updatedBy: { id: number; name: string } | null;
};

export type TemplateDetail = {
  id: number;
  name: string;
  isMaster: boolean;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: { id: number; name: string } | null;
  /** Sorted by step: 0 = first email, then follow-ups. */
  steps: TemplateStepData[];
};

export type TemplateResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; fieldErrors?: StepFieldErrors };

export const TEMPLATE_GONE = "This template doesn't exist any more. It may have been deleted: reload the page.";
export const KEEP_ONE_TEMPLATE = "Keep at least one template.";

function takenMessage(name: string): string {
  return `There's already a template called "${name}". Pick another name.`;
}

/** Another template with the same name, ignoring upper/lower case, accents and extra spaces. */
async function findTemplateByName(client: DbOrTx, name: string, exceptId?: number) {
  const key = normalizeText(cleanTemplateName(name));
  const all = await client.template.findMany({ select: { id: true, name: true } });
  return all.find((t) => t.id !== exceptId && normalizeText(t.name) === key) ?? null;
}

/** "Master sequence (copy)", then "(copy 2)", "(copy 3)" … — whichever is free. */
async function freeCopyName(client: DbOrTx, name: string): Promise<string> {
  const base = cleanTemplateName(name).replace(/\s*\(copy(?: \d+)?\)$/i, "");
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    if (!(await findTemplateByName(client, candidate))) return candidate;
  }
  return `${base.slice(0, 60)} (copy ${Date.now()})`;
}

function toStepData(s: { step: number; enabled: boolean; subject: string | null; body: string; delayDays: number }): TemplateStepData {
  return { step: s.step, enabled: s.enabled, subject: s.step === 0 ? (s.subject ?? "") : null, body: s.body, delayDays: s.delayDays };
}

async function userNames(ids: Array<number | null>): Promise<Map<number, { id: number; name: string }>> {
  const unique = [...new Set(ids.filter((id): id is number => typeof id === "number"))];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u]));
}

// ───────────────────────── reading ─────────────────────────

/** Every template, the master first, then by name. */
export async function listTemplates(): Promise<TemplateSummary[]> {
  const rows = await db.template.findMany({
    select: {
      id: true,
      name: true,
      isMaster: true,
      updatedAt: true,
      updatedById: true,
      createdById: true,
      steps: { select: { step: true, enabled: true, subject: true } },
    },
  });
  const users = await userNames(rows.map((r) => r.updatedById ?? r.createdById));
  return rows
    .map((r) => {
      const followUps = r.steps.filter((s) => s.step > 0);
      const by = r.updatedById ?? r.createdById;
      return {
        id: r.id,
        name: r.name,
        isMaster: r.isMaster,
        firstSubject: r.steps.find((s) => s.step === 0)?.subject ?? null,
        followUps: followUps.length,
        followUpsOn: followUps.filter((s) => s.enabled).length,
        updatedAt: r.updatedAt,
        updatedBy: by ? (users.get(by) ?? null) : null,
      };
    })
    .sort((a, b) => Number(b.isMaster) - Number(a.isMaster) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id - b.id);
}

export async function getTemplate(id: number, client: DbOrTx = db): Promise<TemplateDetail | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const t = await client.template.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      isMaster: true,
      createdAt: true,
      updatedAt: true,
      updatedById: true,
      createdById: true,
      steps: { orderBy: { step: "asc" }, select: { step: true, enabled: true, subject: true, body: true, delayDays: true } },
    },
  });
  if (!t) return null;
  const by = t.updatedById ?? t.createdById;
  const user = by ? await client.user.findUnique({ where: { id: by }, select: { id: true, name: true } }) : null;
  return {
    id: t.id,
    name: t.name,
    isMaster: t.isMaster,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    updatedBy: user,
    steps: t.steps.map(toStepData),
  };
}

/**
 * The master template (new campaigns start from it). Adds the default templates first when there
 * are none, so a fresh database always has one.
 */
export async function getMasterTemplate(): Promise<TemplateDetail> {
  await ensureDefaultTemplates();
  const master =
    (await db.template.findFirst({ where: { isMaster: true }, orderBy: { id: "asc" }, select: { id: true } })) ??
    (await db.template.findFirst({ orderBy: { id: "asc" }, select: { id: true } }));
  const detail = master ? await getTemplate(master.id) : null;
  if (!detail) throw new Error("No template found after adding the defaults.");
  return detail;
}

// ───────────────────────── preview helpers ─────────────────────────

/** A real contact to preview an email for (people with an email address only). */
export type PreviewPerson = {
  id: number;
  /** The person's name, or "General inbox". */
  name: string;
  email: string;
  companyId: number;
  companyName: string;
};

const PREVIEW_PERSON_SELECT = {
  id: true,
  name: true,
  isGeneric: true,
  email: true,
  emailNorm: true,
  company: { select: { id: true, name: true } },
} satisfies Prisma.PersonSelect;

type PreviewPersonRow = Prisma.PersonGetPayload<{ select: typeof PREVIEW_PERSON_SELECT }>;

function toPreviewPerson(p: PreviewPersonRow): PreviewPerson {
  return {
    id: p.id,
    name: p.isGeneric ? GENERAL_INBOX_NAME : p.name.trim() || (p.email ?? ""),
    email: p.email ?? p.emailNorm ?? "",
    companyId: p.company.id,
    companyName: p.company.name,
  };
}

const LIVE_PERSON_WITH_EMAIL = {
  deletedAt: null,
  emailNorm: { not: null },
  company: { deletedAt: null },
} satisfies Prisma.PersonWhereInput;

/**
 * People with an email address whose company matches every word (name, website, people's names
 * and emails). The person's own name or email matching comes first. An empty search gives the
 * most recently changed people.
 */
export async function searchPeopleForPreview(q: string, limit = 12): Promise<PreviewPerson[]> {
  const words = normalizeText(q).split(" ").filter(Boolean).slice(0, 6);
  if (words.length === 0) {
    const recent = await db.person.findMany({
      where: LIVE_PERSON_WITH_EMAIL,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: PREVIEW_PERSON_SELECT,
    });
    return recent.map(toPreviewPerson);
  }
  const rows = await db.person.findMany({
    where: { ...LIVE_PERSON_WITH_EMAIL, company: { deletedAt: null, AND: words.map((w) => ({ searchText: { contains: w } })) } },
    orderBy: [{ company: { nameNorm: "asc" } }, { id: "asc" }],
    take: 200,
    select: PREVIEW_PERSON_SELECT,
  });
  const own = (p: PreviewPersonRow) => {
    const text = normalizeText(`${p.name} ${p.emailNorm ?? ""}`);
    return words.every((w) => text.includes(w));
  };
  return [...rows.filter(own), ...rows.filter((p) => !own(p))].slice(0, limit).map(toPreviewPerson);
}

/**
 * A good first contact for the preview: a named person whose company has an approved personal line
 * (so most variables show), else any person with an email. Null when there are none yet.
 */
export async function defaultPreviewPerson(): Promise<PreviewPerson | null> {
  const best =
    (await db.person.findFirst({
      where: { ...LIVE_PERSON_WITH_EMAIL, isGeneric: false, company: { deletedAt: null, personalLine: { not: null } } },
      orderBy: { id: "asc" },
      select: PREVIEW_PERSON_SELECT,
    })) ??
    (await db.person.findFirst({ where: { ...LIVE_PERSON_WITH_EMAIL, isGeneric: false }, orderBy: { id: "asc" }, select: PREVIEW_PERSON_SELECT })) ??
    (await db.person.findFirst({ where: LIVE_PERSON_WITH_EMAIL, orderBy: { id: "asc" }, select: PREVIEW_PERSON_SELECT }));
  return best ? toPreviewPerson(best) : null;
}

/** Active teammates, by name: anyone can preview (and send) as any of them. */
export async function listActiveSenders(): Promise<Array<{ id: number; name: string }>> {
  const users = await db.user.findMany({ where: { active: true }, select: { id: true, name: true } });
  return users.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id - b.id);
}

/** The standard variables plus every custom field from imports (with their labels), for the buttons. */
export async function templateVariables(client: DbOrTx = db): Promise<TemplateVariable[]> {
  const fields = await client.customField.findMany({ select: { key: true, label: true }, orderBy: { id: "asc" } });
  return mergeVariables(fields);
}

// ───────────────────────── defaults ─────────────────────────

async function createFromDefault(tx: Tx, t: DefaultTemplate, isMaster: boolean): Promise<number> {
  const created = await tx.template.create({ data: { name: t.name, isMaster }, select: { id: true } });
  await tx.templateStep.createMany({
    data: t.steps.map((s) => ({
      templateId: created.id,
      step: s.step,
      enabled: s.enabled,
      subject: s.step === 0 ? s.subject : null,
      body: s.body,
      delayDays: s.delayDays,
    })),
  });
  return created.id;
}

/**
 * When there are NO templates at all, adds "Master sequence" (the master: first email + follow-ups
 * after 3, 4 and 7 days, the last one switched off) and "Creators" (first email + one follow-up
 * after 4 days), with the copy from PLAN.md A7. Safe to call on every page load: does nothing
 * once any template exists. Returns true when it added them.
 */
export async function ensureDefaultTemplates(): Promise<boolean> {
  if ((await db.template.count()) > 0) {
    await ensureOneMaster();
    return false;
  }
  return dbTx(async (tx) => {
    if ((await tx.template.count()) > 0) return false;
    for (const t of DEFAULT_TEMPLATES) await createFromDefault(tx, t, t.isMaster);
    await logActivity(
      {
        actorId: null,
        type: "template.created",
        summary: `The default templates were added: ${DEFAULT_TEMPLATES.map((t) => `"${t.name}"`).join(" and ")}`,
        data: { defaults: DEFAULT_TEMPLATES.map((t) => t.name) },
      },
      tx,
    );
    return true;
  });
}

/**
 * Moves the master star. Starring isn't an edit, so each template keeps its "Changed … by"
 * (an explicit updatedAt stops @updatedAt from moving it); the activity log records the star.
 */
async function setMasterFlag(tx: Tx, rows: ReadonlyArray<{ id: number; updatedAt: Date }>, isMaster: boolean): Promise<void> {
  for (const r of rows) await tx.template.update({ where: { id: r.id }, data: { isMaster, updatedAt: r.updatedAt } });
}

/**
 * Keeps "exactly one master" true even after unusual data (an old backup, a manual edit):
 * no master → the oldest template becomes it; several → only the oldest of them stays.
 */
export async function ensureOneMaster(): Promise<void> {
  if ((await db.template.count({ where: { isMaster: true } })) === 1) return;
  await dbTx(async (tx) => {
    const masters = await tx.template.findMany({ where: { isMaster: true }, orderBy: { id: "asc" }, select: { id: true, updatedAt: true } });
    if (masters.length === 1) return;
    if (masters.length > 1) {
      await setMasterFlag(tx, masters.slice(1), false);
      return;
    }
    const oldest = await tx.template.findFirst({ orderBy: { id: "asc" }, select: { id: true, name: true, updatedAt: true } });
    if (!oldest) return;
    await setMasterFlag(tx, [oldest], true);
    await logActivity(
      {
        actorId: null,
        type: "template.starred",
        summary: `"${oldest.name}" became the master template because no template was starred`,
        data: { templateId: oldest.id, reason: "no master" },
      },
      tx,
    );
  });
}

// ───────────────────────── changes ─────────────────────────

/** A new template with just a first email (empty subject, a greeting and the signature). */
export async function createTemplate(actor: Actor, name: string): Promise<TemplateResult<{ template: { id: number; name: string } }>> {
  const problem = templateNameProblem(name);
  if (problem) return { ok: false, error: problem, fieldErrors: { name: [problem] } };
  const clean = cleanTemplateName(name);
  return dbTx(async (tx) => {
    const taken = await findTemplateByName(tx, clean);
    if (taken) return { ok: false as const, error: takenMessage(taken.name), fieldErrors: { name: [takenMessage(taken.name)] } };
    const hasMaster = (await tx.template.count({ where: { isMaster: true } })) > 0;
    const template = await tx.template.create({
      data: { name: clean, isMaster: !hasMaster, createdById: actor.id, updatedById: actor.id },
      select: { id: true, name: true },
    });
    await tx.templateStep.create({
      data: { templateId: template.id, step: 0, enabled: true, subject: "", body: NEW_FIRST_EMAIL_BODY, delayDays: 0 },
    });
    await logActivity(
      { actorId: actor.id, type: "template.created", summary: `${actor.name} created the template "${template.name}"`, data: { templateId: template.id } },
      tx,
    );
    return { ok: true as const, template };
  });
}

/** A copy with every step (never the master star). */
export async function duplicateTemplate(actor: Actor, id: number): Promise<TemplateResult<{ template: { id: number; name: string } }>> {
  return dbTx(async (tx) => {
    const source = await tx.template.findUnique({
      where: { id },
      select: { id: true, name: true, steps: { select: { step: true, enabled: true, subject: true, body: true, delayDays: true } } },
    });
    if (!source) return { ok: false as const, error: TEMPLATE_GONE };
    const name = await freeCopyName(tx, source.name);
    const template = await tx.template.create({
      data: { name, isMaster: false, createdById: actor.id, updatedById: actor.id },
      select: { id: true, name: true },
    });
    if (source.steps.length > 0) {
      await tx.templateStep.createMany({ data: source.steps.map((s) => ({ ...s, templateId: template.id })) });
    }
    await logActivity(
      {
        actorId: actor.id,
        type: "template.created",
        summary: `${actor.name} duplicated the template "${source.name}" as "${template.name}"`,
        data: { templateId: template.id, fromTemplateId: source.id },
      },
      tx,
    );
    return { ok: true as const, template };
  });
}

export async function renameTemplate(actor: Actor, id: number, name: string): Promise<TemplateResult<{ template: { id: number; name: string } }>> {
  const problem = templateNameProblem(name);
  if (problem) return { ok: false, error: problem, fieldErrors: { name: [problem] } };
  const clean = cleanTemplateName(name);
  return dbTx(async (tx) => {
    const current = await tx.template.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!current) return { ok: false as const, error: TEMPLATE_GONE };
    if (current.name === clean) return { ok: true as const, template: current };
    const taken = await findTemplateByName(tx, clean, id);
    if (taken) return { ok: false as const, error: takenMessage(taken.name), fieldErrors: { name: [takenMessage(taken.name)] } };
    const template = await tx.template.update({ where: { id }, data: { name: clean, updatedById: actor.id }, select: { id: true, name: true } });
    await logActivity(
      {
        actorId: actor.id,
        type: "template.updated",
        summary: `${actor.name} renamed the template "${current.name}" to "${template.name}"`,
        data: { templateId: id, from: current.name, to: template.name },
      },
      tx,
    );
    return { ok: true as const, template };
  });
}

/**
 * Deletes a template. The last one can't be deleted. When the master goes, the most recently
 * changed remaining template becomes the master. Campaigns keep their own copy of the text.
 */
export async function deleteTemplate(
  actor: Actor,
  id: number,
): Promise<TemplateResult<{ name: string; newMaster: { id: number; name: string } | null }>> {
  return dbTx(async (tx) => {
    const template = await tx.template.findUnique({ where: { id }, select: { id: true, name: true, isMaster: true } });
    if (!template) return { ok: false as const, error: TEMPLATE_GONE };
    if ((await tx.template.count()) <= 1) return { ok: false as const, error: KEEP_ONE_TEMPLATE };
    await tx.template.delete({ where: { id } }); // steps go with it (onDelete: Cascade)
    await logActivity(
      {
        actorId: actor.id,
        type: "template.deleted",
        summary: `${actor.name} deleted the template "${template.name}"`,
        data: { templateId: id, name: template.name, wasMaster: template.isMaster },
      },
      tx,
    );
    let newMaster: { id: number; name: string } | null = null;
    if ((await tx.template.count({ where: { isMaster: true } })) === 0) {
      const next = await tx.template.findFirst({
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: { id: true, name: true, updatedAt: true },
      });
      if (next) {
        await setMasterFlag(tx, [next], true);
        newMaster = { id: next.id, name: next.name };
        await logActivity(
          {
            actorId: actor.id,
            type: "template.starred",
            summary: `"${next.name}" became the master template because "${template.name}" was deleted`,
            data: { templateId: next.id, reason: "master deleted" },
          },
          tx,
        );
      }
    }
    return { ok: true as const, name: template.name, newMaster };
  });
}

/** Stars a template as the master: exactly one template is the master afterwards. */
export async function starMaster(actor: Actor, id: number): Promise<TemplateResult<{ template: { id: number; name: string }; changed: boolean }>> {
  return dbTx(async (tx) => {
    const template = await tx.template.findUnique({ where: { id }, select: { id: true, name: true, isMaster: true, updatedAt: true } });
    if (!template) return { ok: false as const, error: TEMPLATE_GONE };
    const others = await tx.template.findMany({ where: { isMaster: true, id: { not: id } }, select: { id: true, updatedAt: true } });
    if (template.isMaster && others.length === 0) return { ok: true as const, template: { id, name: template.name }, changed: false };
    await setMasterFlag(tx, others, false);
    if (!template.isMaster) await setMasterFlag(tx, [template], true);
    await logActivity(
      {
        actorId: actor.id,
        type: "template.starred",
        summary: `${actor.name} made "${template.name}" the master template`,
        data: { templateId: id },
      },
      tx,
    );
    return { ok: true as const, template: { id, name: template.name }, changed: true };
  });
}

async function writeSteps(tx: Tx, id: number, steps: SequenceStep[]): Promise<void> {
  await tx.templateStep.deleteMany({ where: { templateId: id, step: { notIn: steps.map((s) => s.step) } } });
  for (const s of steps) {
    const data = { enabled: s.enabled, subject: s.step === 0 ? (s.subject ?? "") : null, body: s.body, delayDays: s.delayDays };
    await tx.templateStep.upsert({
      where: { templateId_step: { templateId: id, step: s.step } },
      create: { templateId: id, step: s.step, ...data },
      update: data,
    });
  }
}

export type SaveCheck = {
  /**
   * The template's updatedAt when the editor opened it (or last saved it). When someone has saved
   * the template since, the save is refused instead of silently replacing their changes. Leave it
   * out to skip the check ("Save back to template" from a campaign draft does).
   */
  expectedUpdatedAt?: Date | string | null;
};

/** "Ali changed this template after you opened it. …" — the refusal when a save would overwrite newer changes. */
export function changedSinceMessage(by: { id: number; name: string } | null, actor: { id: number }): string {
  const next = "copy your text first if you need it.";
  if (by && by.id === actor.id) {
    return `You saved this template in another tab or from a campaign after you opened it here. Reload to see that version; ${next}`;
  }
  const who = by?.name.trim() || "Someone";
  return `${who} changed this template after you opened it. Reload to see their changes; ${next}`;
}

function sameInstant(a: Date, b: Date | string): boolean {
  const t = b instanceof Date ? b.getTime() : Date.parse(b);
  return Number.isFinite(t) && a.getTime() === t;
}

/**
 * The first-subject rule of saving (M4-DESIGN §2.13): a first subject starting with "Re:" or "Fwd:" (any case, spaces
 * before the colon allowed) is refused with the rule's own sentence, under "step0.subject". The Outlook warning
 * ("Art: …") never blocks a save; the editor shows it.
 */
export function firstSubjectFieldError(steps: readonly SequenceStep[]): string | null {
  const first = steps.find((s) => s.step === 0);
  const problem = first ? firstSubjectProblem(first.subject ?? "") : null;
  return problem?.level === "error" ? problem.text : null;
}

/**
 * Replaces a template's steps: the first email (subject and body required) plus follow-ups 1..3
 * in order (body required, on/off, delayDays ≥ 1). Follow-up subjects are never stored.
 * Field errors use the keys "step0.subject", "step2.body", "step1.delayDays".
 */
export async function saveSteps(
  actor: Actor,
  id: number,
  steps: readonly SequenceStep[],
  check: SaveCheck = {},
): Promise<TemplateResult<{ template: TemplateDetail }>> {
  return saveTemplate(actor, id, { steps, expectedUpdatedAt: check.expectedUpdatedAt });
}

/**
 * The editor's Save: optionally a new name, and the steps (see saveSteps). One change in the log.
 * With `expectedUpdatedAt`, refuses when a teammate (or another tab) saved the template since.
 * A first subject that starts with "Re:" or "Fwd:" is refused (M4-DESIGN §2.13, firstSubjectFieldError).
 */
export async function saveTemplate(
  actor: Actor,
  id: number,
  input: { name?: string; steps: readonly SequenceStep[] } & SaveCheck,
): Promise<TemplateResult<{ template: TemplateDetail }>> {
  const fieldErrors: StepFieldErrors = {};
  const nameProblem = input.name !== undefined ? templateNameProblem(input.name) : null;
  if (nameProblem) fieldErrors.name = [nameProblem];
  const checked = validateSequence(input.steps);
  if (!checked.ok) Object.assign(fieldErrors, checked.fieldErrors);
  const subjectProblem = fieldErrors["step0.subject"] ? null : firstSubjectFieldError(input.steps);
  if (subjectProblem) fieldErrors["step0.subject"] = [subjectProblem];
  if (!checked.ok || nameProblem || subjectProblem) {
    const onlySubject = checked.ok && !nameProblem;
    const error = onlySubject && subjectProblem ? subjectProblem : !checked.ok ? checked.error : "Some details need fixing. Check the highlighted fields.";
    return { ok: false, error, fieldErrors };
  }
  const name = input.name !== undefined ? cleanTemplateName(input.name) : undefined;

  const res = await dbTx(async (tx) => {
    const current = await tx.template.findUnique({
      where: { id },
      select: { id: true, name: true, updatedAt: true, updatedById: true, createdById: true },
    });
    if (!current) return { ok: false as const, error: TEMPLATE_GONE };
    const expected = input.expectedUpdatedAt;
    if (expected !== undefined && expected !== null && !sameInstant(current.updatedAt, expected)) {
      const byId = current.updatedById ?? current.createdById;
      const by = byId ? await tx.user.findUnique({ where: { id: byId }, select: { id: true, name: true } }) : null;
      return { ok: false as const, error: changedSinceMessage(by, actor) };
    }
    if (name !== undefined && name !== current.name) {
      const taken = await findTemplateByName(tx, name, id);
      if (taken) return { ok: false as const, error: takenMessage(taken.name), fieldErrors: { name: [takenMessage(taken.name)] } };
    }
    await writeSteps(tx, id, checked.steps);
    await tx.template.update({ where: { id }, data: { ...(name !== undefined ? { name } : {}), updatedById: actor.id } });
    const renamed = name !== undefined && name !== current.name;
    const followUps = checked.steps.length - 1;
    await logActivity(
      {
        actorId: actor.id,
        type: "template.updated",
        summary: renamed
          ? `${actor.name} saved the template "${current.name}" and renamed it to "${name}"`
          : `${actor.name} saved the template "${current.name}"`,
        data: { templateId: id, followUps, ...(renamed ? { from: current.name, to: name } : {}) },
      },
      tx,
    );
    return { ok: true as const };
  });
  if (!res.ok) return res;
  const template = await getTemplate(id);
  if (!template) return { ok: false, error: TEMPLATE_GONE };
  return { ok: true, template };
}
