// Owned by the Templates work package (Milestone 2). The sending engine (worker) and the campaign
// screens call these; keep the names and signatures stable.
import type { Prisma } from "@/generated/prisma/client";
import { buildTemplateValues, type TemplateCompany, type TemplatePerson, type TemplateSender } from "@/core/templates/context";
import { renderEmail } from "@/core/templates/email";
import type { FooterSettings } from "@/core/templates/html";
import { stepLabel } from "@/core/templates/steps";
import type { RenderedEmail, RenderPurpose } from "@/core/templates/types";
import { db, type DbOrTx } from "@/server/db";
import { SETTING_DEFAULTS } from "@/server/settings";

/**
 * Turns template text into the exact email a person gets (PLAN.md B6.3/B6.4):
 *  - variables come from the CURRENT company/person data and the sender's profile, so an edited
 *    personal line shows up in the next render;
 *  - variations are stable per person and step, so the template preview, Review and the sent
 *    email agree;
 *  - follow-ups get "Re: <the first subject exactly as that person received it>".
 * Only reads the database (pass `tx` to read inside a transaction); never writes.
 */

/** A problem the person can fix (the message is plain language and safe to show). */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

type Client = DbOrTx;

export type RenderSettings = { footer: FooterSettings; portfolioUrl: string };

const RENDER_SETTING_KEYS = ["footer.companyName", "footer.address", "footer.unsubscribeText", "portfolioUrl"] as const;

/** Footer and portfolio settings, read through `client` (works inside a transaction). */
export async function loadRenderSettings(client: Client = db): Promise<RenderSettings> {
  const rows = await client.setting.findMany({ where: { key: { in: [...RENDER_SETTING_KEYS] } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const text = (key: (typeof RENDER_SETTING_KEYS)[number]): string => {
    const value = map.has(key) ? map.get(key) : SETTING_DEFAULTS[key];
    return typeof value === "string" ? value : "";
  };
  return {
    footer: {
      companyName: text("footer.companyName"),
      address: text("footer.address"),
      unsubscribeText: text("footer.unsubscribeText"),
    },
    portfolioUrl: text("portfolioUrl"),
  };
}

async function loadCustomFieldKeys(client: Client): Promise<string[]> {
  const rows = await client.customField.findMany({ select: { key: true } });
  return rows.map((r) => r.key);
}

const PERSON_SELECT = {
  id: true,
  name: true,
  firstName: true,
  isGeneric: true,
  personalLineOverride: true,
  customFields: true,
  deletedAt: true,
  company: {
    select: {
      id: true,
      name: true,
      website: true,
      domain: true,
      profileKey: true,
      country: true,
      niche: true,
      personalLine: true,
      customFields: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.PersonSelect;

type PersonRow = Prisma.PersonGetPayload<{ select: typeof PERSON_SELECT }>;

function toTemplatePerson(p: PersonRow): TemplatePerson {
  return {
    id: p.id,
    name: p.name,
    firstName: p.firstName,
    isGeneric: p.isGeneric,
    personalLineOverride: p.personalLineOverride,
    customFields: p.customFields,
  };
}

function toTemplateCompany(p: PersonRow): TemplateCompany {
  return {
    name: p.company.name,
    website: p.company.website,
    domain: p.company.domain,
    profileKey: p.company.profileKey,
    country: p.company.country,
    niche: p.company.niche,
    personalLine: p.company.personalLine,
    customFields: p.company.customFields,
  };
}

async function loadSender(client: Client, userId: number | null | undefined): Promise<TemplateSender> {
  const user = userId ? await client.user.findUnique({ where: { id: userId }, select: { name: true, signature: true } }) : null;
  if (!user) throw new RenderError("The sender doesn't exist any more. Pick another teammate to send as.");
  return { name: user.name, signature: user.signature };
}

async function loadPreviewPerson(client: Client, personId: number): Promise<PersonRow> {
  const person = await client.person.findUnique({ where: { id: personId }, select: PERSON_SELECT });
  if (!person || person.deletedAt || person.company.deletedAt) {
    throw new RenderError("This contact was deleted. Pick another contact to preview.");
  }
  return person;
}

/**
 * Every variable's value for one person sent by one teammate (standard variables + every custom
 * field key). For screens that render many emails with the pure engine (@/core/templates).
 */
export async function templateValuesFor(args: {
  personId: number;
  senderId: number;
  tx?: DbOrTx;
}): Promise<{ values: Record<string, string>; settings: RenderSettings }> {
  const client = args.tx ?? db;
  // One query at a time: a transaction client must not run queries in parallel.
  const person = await loadPreviewPerson(client, args.personId);
  const sender = await loadSender(client, args.senderId);
  const settings = await loadRenderSettings(client);
  const customFieldKeys = await loadCustomFieldKeys(client);
  const values = buildTemplateValues({
    person: toTemplatePerson(person),
    company: toTemplateCompany(person),
    sender,
    portfolioUrl: settings.portfolioUrl,
    customFieldKeys,
  });
  return { values, settings };
}

// ───────────────────────── previews (template editor, campaign wizard) ─────────────────────────

/**
 * Renders raw, unsaved text for a real person as sent by a teammate (purpose "preview").
 * For follow-ups (step > 0) pass the FIRST email's subject template as `subject`: the result's
 * subject is "Re: " + that subject rendered for this person.
 */
export async function renderDraftPreview(args: {
  subject: string | null;
  body: string;
  step: number;
  personId: number;
  senderId: number;
}): Promise<RenderedEmail> {
  const { values, settings } = await templateValuesFor({ personId: args.personId, senderId: args.senderId });
  return renderEmail({
    step: args.step,
    subject: args.subject,
    body: args.body,
    personId: args.personId,
    values,
    footer: settings.footer,
    purpose: "preview",
  });
}

/** Template editor preview: one template step for one real person, as sent by one teammate. */
export async function renderTemplatePreview(args: {
  templateId: number;
  step: number;
  personId: number;
  senderId: number;
  /**
   * Unsaved editor text to preview instead of the stored step. `firstSubject` (optional) is the
   * unsaved first-email subject, used for a follow-up's "Re: …" subject.
   */
  draft?: { subject: string | null; body: string; firstSubject?: string | null };
}): Promise<RenderedEmail> {
  const template = await db.template.findUnique({
    where: { id: args.templateId },
    select: { id: true, steps: { select: { step: true, subject: true, body: true } } },
  });
  if (!template) throw new RenderError("This template doesn't exist any more. It may have been deleted.");
  const stored = template.steps.find((s) => s.step === args.step) ?? null;
  const first = template.steps.find((s) => s.step === 0) ?? null;
  const text = args.draft ?? stored;
  if (!text) throw new RenderError(`This template has no ${stepLabel(args.step).toLowerCase()}.`);

  let subject: string | null;
  if (args.step === 0) subject = text.subject;
  else if (args.draft && args.draft.firstSubject !== undefined) subject = args.draft.firstSubject;
  else subject = first?.subject ?? null;

  return renderDraftPreview({ subject, body: text.body, step: args.step, personId: args.personId, senderId: args.senderId });
}

// ───────────────────────── campaigns ─────────────────────────

type CampaignBase = {
  campaignId: number;
  steps: Map<number, { subject: string | null; body: string }>;
  sender: TemplateSender;
  settings: RenderSettings;
  customFieldKeys: string[];
};

async function loadCampaignBase(client: Client, campaignId: number): Promise<CampaignBase> {
  const campaign = await client.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, senderId: true, createdById: true, steps: { select: { step: true, subject: true, body: true } } },
  });
  if (!campaign) throw new RenderError("This campaign doesn't exist any more.");
  // The sender snapshot's user is Campaign.senderId (fixed at launch); a draft uses the chosen sender.
  const sender = await loadSender(client, campaign.senderId ?? campaign.createdById);
  const settings = await loadRenderSettings(client);
  const customFieldKeys = await loadCustomFieldKeys(client);
  return {
    campaignId: campaign.id,
    steps: new Map(campaign.steps.map((s) => [s.step, { subject: s.subject, body: s.body }])),
    sender,
    settings,
    customFieldKeys,
  };
}

type RecipientData = {
  id: number;
  person: PersonRow;
  edits: Map<number, { subject: string | null; body: string }>;
  /**
   * The step-0 subject as it was stored when that email was sent (null while there's none: launch
   * creates the row with an empty subject and the sender fills it in at send time).
   */
  sentFirstSubject: string | null;
};

function renderRecipientStep(base: CampaignBase, r: RecipientData, step: number, purpose: RenderPurpose): RenderedEmail {
  const campaignStep = base.steps.get(step);
  const edit = r.edits.get(step);
  if (!campaignStep && !edit) throw new RenderError(`This campaign has no ${stepLabel(step).toLowerCase()}.`);
  const body = edit?.body ?? campaignStep!.body;

  const values = buildTemplateValues({
    person: toTemplatePerson(r.person),
    company: toTemplateCompany(r.person),
    sender: base.sender,
    portfolioUrl: base.settings.portfolioUrl,
    customFieldKeys: base.customFieldKeys,
  });

  // The first email's subject template for this person: their own edit, else the campaign's.
  // Follow-ups use the subject step 0 was actually stored with, when it exists.
  const firstEdit = r.edits.get(0);
  const firstSubjectTemplate = firstEdit?.subject ?? base.steps.get(0)?.subject ?? null;
  return renderEmail({
    step,
    subject: firstSubjectTemplate,
    body,
    firstSubject: step > 0 ? r.sentFirstSubject : null,
    personId: r.person.id,
    values,
    footer: base.settings.footer,
    purpose,
  });
}

const RECIPIENT_SELECT = {
  id: true,
  campaignId: true,
  person: { select: PERSON_SELECT },
  edits: { select: { step: true, subject: true, body: true } },
} satisfies Prisma.CampaignRecipientSelect;

type RecipientRow = Prisma.CampaignRecipientGetPayload<{ select: typeof RECIPIENT_SELECT }>;

function toRecipientData(row: RecipientRow, sentFirstSubject: string | null): RecipientData {
  return {
    id: row.id,
    person: row.person,
    edits: new Map(row.edits.map((e) => [e.step, { subject: e.subject, body: e.body }])),
    sentFirstSubject,
  };
}

/**
 * Renders the exact email one campaign recipient gets for one step (0 = first email,
 * 1..3 = follow-ups), from the campaign's step text or that person's RecipientEdit, the
 * current company/person data, the campaign's sender (Campaign.senderId: the snapshot's user
 * once launched, the chosen sender while it's a draft), the footer settings and the portfolio URL.
 * Follow-ups get the subject "Re: <first subject exactly as that person received it>" (the stored
 * step-0 OutboundEmail subject when there is one, else step 0 rendered for them).
 * Deterministic: calling it twice gives the same text (stable variations).
 * Throws RenderError (plain message) when the recipient, campaign, step or sender is gone.
 */
export async function renderCampaignEmail(args: {
  recipientId: number;
  step: number;
  purpose: RenderPurpose;
  tx?: DbOrTx;
}): Promise<RenderedEmail> {
  const client = args.tx ?? db;
  const row = await client.campaignRecipient.findUnique({ where: { id: args.recipientId }, select: RECIPIENT_SELECT });
  if (!row) throw new RenderError("This person isn't in the campaign any more.");
  const base = await loadCampaignBase(client, row.campaignId);
  let sentFirstSubject: string | null = null;
  if (args.step > 0) {
    const first = await client.outboundEmail.findFirst({
      where: { recipientId: row.id, step: 0, subject: { not: "" } },
      orderBy: { id: "asc" },
      select: { subject: true },
    });
    sentFirstSubject = first?.subject ?? null;
  }
  return renderRecipientStep(base, toRecipientData(row, sentFirstSubject), args.step, args.purpose);
}

export type RenderedRecipientStep = { recipientId: number; personId: number; step: number; email: RenderedEmail };

/**
 * Renders many recipients of one campaign at once (Review, warning counts, the dry-run sender),
 * with the shared data loaded once. Same output as renderCampaignEmail for each pair.
 * `recipientIds` defaults to every recipient of the campaign; `steps` defaults to every step the
 * campaign has (enabled or not). Recipients without a step's text are skipped for that step.
 */
export async function renderCampaignEmails(args: {
  campaignId: number;
  recipientIds?: readonly number[];
  steps?: readonly number[];
  purpose: RenderPurpose;
  tx?: DbOrTx;
}): Promise<RenderedRecipientStep[]> {
  const client = args.tx ?? db;
  const base = await loadCampaignBase(client, args.campaignId);
  const steps = [...new Set(args.steps ?? [...base.steps.keys()])].sort((a, b) => a - b);
  const out: RenderedRecipientStep[] = [];
  const CHUNK = 500;

  let ids: number[] | null = args.recipientIds ? [...new Set(args.recipientIds)] : null;
  if (!ids) {
    ids = (
      await client.campaignRecipient.findMany({ where: { campaignId: args.campaignId }, select: { id: true }, orderBy: { id: "asc" } })
    ).map((r) => r.id);
  }

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await client.campaignRecipient.findMany({
      where: { id: { in: chunk }, campaignId: args.campaignId },
      select: RECIPIENT_SELECT,
      orderBy: { id: "asc" },
    });
    const sent = steps.some((s) => s > 0)
      ? await client.outboundEmail.findMany({
          where: { recipientId: { in: rows.map((r) => r.id) }, step: 0, subject: { not: "" } },
          orderBy: { id: "asc" },
          select: { recipientId: true, subject: true },
        })
      : [];
    const firstSubjects = new Map<number, string>();
    for (const s of sent) if (!firstSubjects.has(s.recipientId)) firstSubjects.set(s.recipientId, s.subject);

    for (const row of rows) {
      const data = toRecipientData(row, firstSubjects.get(row.id) ?? null);
      for (const step of steps) {
        if (!base.steps.has(step) && !data.edits.has(step)) continue;
        out.push({ recipientId: row.id, personId: row.person.id, step, email: renderRecipientStep(base, data, step, args.purpose) });
      }
    }
  }
  return out;
}
