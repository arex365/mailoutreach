import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("templates-render");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const render = await import("@/server/services/render");
const templates = await import("@/server/services/templates");
const { variationIndex } = await import("@/core/templates/hash");

const SUBJECT = "{Print-ready 3D models|3D models} for {{company}}";
const BODY0 = "{Hi|Hello} {{first_name|there}},\n\n{{personal_line|}}\n\nI'm {{sender_name}}. Revenue: {{est_revenue|unknown}}.\n\n{{sender_signature}}";
const BODY1 = "Hi {{first_name|there}},\n\nHere: {{portfolio_url}}\n\n{{sender_signature}}";

let ali: { id: number; name: string };
let sara: { id: number; name: string };
let companyId: number;
let anna: number; // named person
let inbox: number; // General inbox
let olaf: number; // has a personal line override
let campaignId: number;
const recipient: Record<string, number> = {};

async function makeUser(name: string, signature: string) {
  return dbWrite((c) =>
    c.user.create({
      data: { name, email: `${name.toLowerCase()}.${Date.now()}@example.com`, signature, senderDisplayName: `${name} from Polygon Paradise` },
      select: { id: true, name: true },
    }),
  );
}

async function makePerson(data: { name: string; email: string; isGeneric?: boolean; personalLineOverride?: string | null; firstName?: string | null }) {
  return dbWrite((c) =>
    c.person.create({
      data: {
        companyId,
        name: data.name,
        firstName: data.firstName ?? null,
        email: data.email,
        emailNorm: data.email,
        isGeneric: data.isGeneric ?? false,
        personalLineOverride: data.personalLineOverride ?? null,
      },
      select: { id: true },
    }),
  ).then((p) => p.id);
}

function pick(personId: number, step: number, options: string[], occurrence = 0): string {
  return options[variationIndex({ personId, step, options: options.join("|"), occurrence }, options.length)]!;
}

beforeAll(async () => {
  ali = await makeUser("Ali Khan", "Ali Khan\nPolygon Paradise");
  sara = await makeUser("Sara", "Sara\nPolygon Paradise");
  companyId = (
    await dbWrite((c) =>
      c.company.create({
        data: {
          name: "Acme 3D",
          nameNorm: "acme 3d",
          website: "https://www.acme.de",
          domain: "acme.de",
          country: "DE",
          niche: "Figurines",
          personalLine: "Your dragon busts caught my eye.",
          customFields: { est_revenue: "2M" },
        },
        select: { id: true },
      }),
    )
  ).id;
  await dbWrite((c) => c.customField.create({ data: { key: "est_revenue", label: "Est. revenue", entity: "COMPANY" } }));
  anna = await makePerson({ name: "Anna Berg", email: "anna@acme.de" });
  inbox = await makePerson({ name: "General inbox", email: "info@acme.de", isGeneric: true });
  olaf = await makePerson({ name: "Olaf Nord", email: "olaf@acme.de", personalLineOverride: "Olaf's owl print is wonderful." });

  campaignId = (
    await dbWrite((c) =>
      c.campaign.create({
        data: {
          name: "Germany Q4",
          createdById: ali.id,
          senderId: sara.id,
          steps: {
            create: [
              { step: 0, subject: SUBJECT, body: BODY0 },
              { step: 1, subject: null, body: BODY1, delayDays: 3 },
            ],
          },
        },
        select: { id: true },
      }),
    )
  ).id;
  for (const [key, personId] of Object.entries({ anna, inbox, olaf })) {
    const email = (await db.person.findUniqueOrThrow({ where: { id: personId } })).emailNorm!;
    recipient[key] = (
      await dbWrite((c) => c.campaignRecipient.create({ data: { campaignId, companyId, personId, emailNorm: email }, select: { id: true } }))
    ).id;
  }
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("renderCampaignEmail", () => {
  it("renders the first email with current data, the campaign's sender and the footer", async () => {
    const e = await render.renderCampaignEmail({ recipientId: recipient.anna!, step: 0, purpose: "send" });
    expect(e.subject).toBe(`${pick(anna, 0, ["Print-ready 3D models", "3D models"])} for Acme 3D`);
    expect(e.text).toBe(
      [
        `${pick(anna, 0, ["Hi", "Hello"])} Anna,`,
        "",
        "Your dragon busts caught my eye.",
        "",
        "I'm Sara. Revenue: 2M.",
        "",
        "Sara",
        "Polygon Paradise",
        "",
        "--",
        "Polygon Paradise · 55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan",
        "If you'd rather not hear from us, unsubscribe here: %unsubscribe_url%",
      ].join("\n"),
    );
    expect(e.html).toContain('<a href="%unsubscribe_url%">%unsubscribe_url%</a>');
    expect(e.warnings).toEqual([]);
  });

  it("is deterministic, and preview differs from send only in the unsubscribe link", async () => {
    const a = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "send" });
    const b = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "send" });
    expect(a).toEqual(b);
    const p = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "preview" });
    expect(p.subject).toBe(a.subject);
    expect(p.text).toBe(a.text.replace("%unsubscribe_url%", "[unsubscribe link]"));
    expect(p.html).not.toContain("%unsubscribe_url%");
  });

  it("uses the person's personal line override", async () => {
    const e = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "preview" });
    expect(e.text).toContain("\n\nOlaf's owl print is wonderful.\n\n");
    expect(e.text).not.toContain("dragon busts");
  });

  it("removes the empty personal line for a General inbox and uses the fallback name", async () => {
    await dbWrite((c) => c.company.update({ where: { id: companyId }, data: { personalLine: null } }));
    const e = await render.renderCampaignEmail({ recipientId: recipient.inbox!, step: 0, purpose: "preview" });
    expect(e.text.startsWith(`${pick(inbox, 0, ["Hi", "Hello"])} there,\n\nI'm Sara.`)).toBe(true);
    expect(e.warnings).toEqual([]);
    await dbWrite((c) => c.company.update({ where: { id: companyId }, data: { personalLine: "Your dragon busts caught my eye." } }));
  });

  it("picks up changed company data and settings on the next render", async () => {
    await dbWrite((c) => c.company.update({ where: { id: companyId }, data: { personalLine: "New approved line." } }));
    await setSetting("footer.companyName", "PP Studio", ali.id);
    const e = await render.renderCampaignEmail({ recipientId: recipient.anna!, step: 0, purpose: "preview" });
    expect(e.text).toContain("\n\nNew approved line.\n\n");
    expect(e.text).toContain("\n--\nPP Studio · 55th Avenue");
    await setSetting("footer.companyName", "Polygon Paradise", ali.id);
    await dbWrite((c) => c.company.update({ where: { id: companyId }, data: { personalLine: "Your dragon busts caught my eye." } }));
  });

  it("uses that person's RecipientEdit for the step", async () => {
    await dbWrite((c) =>
      c.recipientEdit.create({
        data: { recipientId: recipient.anna!, step: 0, subject: "A note for {{company}}", body: "Dear {{first_name}}, just for you.", editedById: ali.id },
      }),
    );
    const e = await render.renderCampaignEmail({ recipientId: recipient.anna!, step: 0, purpose: "preview" });
    expect(e.subject).toBe("A note for Acme 3D");
    expect(e.text.startsWith("Dear Anna, just for you.\n\n--\n")).toBe(true);
    // Someone else in the same campaign still gets the campaign's text.
    const other = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "preview" });
    expect(other.subject).toMatch(/for Acme 3D$/);
    expect(other.subject).not.toBe("A note for Acme 3D");
  });

  it("gives follow-ups 'Re: ' + the first subject that person gets (their edit included)", async () => {
    const annaFollow = await render.renderCampaignEmail({ recipientId: recipient.anna!, step: 1, purpose: "preview" });
    expect(annaFollow.subject).toBe("Re: A note for Acme 3D");
    expect(annaFollow.text.startsWith("Hi Anna,\n\nHere: https://www.polygonparadise.com\n\nSara\nPolygon Paradise\n\n--\n")).toBe(true);
    const olafFirst = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "preview" });
    const olafFollow = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 1, purpose: "preview" });
    expect(olafFollow.subject).toBe(`Re: ${olafFirst.subject}`);
  });

  it("uses the stored subject of the email that was actually sent (not a queued row's empty one)", async () => {
    const row = await dbWrite((c) =>
      c.outboundEmail.create({
        data: {
          campaignId,
          recipientId: recipient.olaf!,
          personId: olaf,
          companyId,
          senderId: sara.id,
          step: 0,
          mode: "DRY_RUN",
          toEmail: "olaf@acme.de",
          toNorm: "olaf@acme.de",
          companyName: "Acme 3D",
          fromAddress: "Sara <sara@your-sending-domain>",
          // Launch creates the row like this; the sender fills the text in when it sends.
          subject: "",
          text: "",
          html: "",
          messageId: `pp.test1@dry-run.invalid`,
          sendId: "send-test-1",
          dueAt: new Date(),
          status: "QUEUED",
        },
        select: { id: true },
      }),
    );
    const before = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 1, purpose: "send" });
    expect(before.subject).toMatch(/^Re: (Print-ready 3D models|3D models) for Acme 3D$/);
    const batchBefore = await render.renderCampaignEmails({ campaignId, recipientIds: [recipient.olaf!], steps: [1], purpose: "send" });
    expect(batchBefore[0]?.email.subject).toBe(before.subject);

    await dbWrite((c) =>
      c.outboundEmail.update({
        where: { id: row.id },
        data: { subject: "The subject Olaf really got", text: "x", html: "<p>x</p>", status: "SENT", sentAt: new Date() },
      }),
    );
    const e = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 1, purpose: "send" });
    expect(e.subject).toBe("Re: The subject Olaf really got");
    const batch = await render.renderCampaignEmails({ campaignId, recipientIds: [recipient.olaf!], steps: [1], purpose: "send" });
    expect(batch[0]?.email.subject).toBe("Re: The subject Olaf really got");
  });

  it("uses the campaign's sender (not the creator) and the user's name, not the display name", async () => {
    await dbWrite((c) => c.campaign.update({ where: { id: campaignId }, data: { status: "RUNNING", launchedAt: new Date(), fromName: "Sara from Polygon Paradise" } }));
    const e = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "send" });
    expect(e.text).toContain("I'm Sara. Revenue");
    await dbWrite((c) => c.campaign.update({ where: { id: campaignId }, data: { status: "DRAFT", launchedAt: null, fromName: null } }));
  });

  it("works inside a transaction", async () => {
    const e = await dbTx((tx) => render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "send", tx }));
    expect(e).toEqual(await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "send" }));
  });

  it("explains what's gone in plain words", async () => {
    await expect(render.renderCampaignEmail({ recipientId: 999_999, step: 0, purpose: "send" })).rejects.toThrow(render.RenderError);
    await expect(render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 3, purpose: "send" })).rejects.toThrow(
      "This campaign has no follow-up 3.",
    );
  });
});

describe("renderCampaignEmails (many at once)", () => {
  it("gives the same emails as rendering one by one", async () => {
    const all = await render.renderCampaignEmails({ campaignId, purpose: "preview" });
    expect(all).toHaveLength(6);
    for (const item of all) {
      expect(item.email).toEqual(await render.renderCampaignEmail({ recipientId: item.recipientId, step: item.step, purpose: "preview" }));
    }
    const some = await render.renderCampaignEmails({ campaignId, recipientIds: [recipient.inbox!], steps: [1], purpose: "send" });
    expect(some.map((s) => [s.recipientId, s.personId, s.step])).toEqual([[recipient.inbox, inbox, 1]]);
  });
});

describe("previews", () => {
  let templateId: number;

  beforeAll(async () => {
    await templates.ensureDefaultTemplates();
    templateId = (await templates.getMasterTemplate()).id;
  });

  it("renders a stored template step for a real person and sender", async () => {
    const e = await render.renderTemplatePreview({ templateId, step: 0, personId: anna, senderId: ali.id });
    expect(e.subject).toBe(`${pick(anna, 0, ["Print-ready 3D models", "3D models"])} for Acme 3D`);
    expect(e.text).toContain("I'm Ali Khan from Polygon Paradise.");
    expect(e.text).toContain("[unsubscribe link]");
    expect(e.text).not.toContain("%unsubscribe_url%");
  });

  it("matches what the campaign would send for the same text (stable variations)", async () => {
    const preview = await render.renderDraftPreview({ subject: SUBJECT, body: BODY0, step: 0, personId: olaf, senderId: sara.id });
    const sent = await render.renderCampaignEmail({ recipientId: recipient.olaf!, step: 0, purpose: "preview" });
    expect(preview).toEqual(sent);
  });

  it("previews unsaved text, including a follow-up's Re: subject", async () => {
    const e = await render.renderTemplatePreview({
      templateId,
      step: 1,
      personId: inbox,
      senderId: sara.id,
      draft: { subject: null, body: "Hi {{first_name|there}}, {{nope}}", firstSubject: "Quick question for {{company}}" },
    });
    expect(e.subject).toBe("Re: Quick question for Acme 3D");
    expect(e.text.startsWith("Hi there, {{nope}}\n\n--\n")).toBe(true);
    expect(e.warnings.map((w) => w.kind)).toEqual(["unknown"]);
    const stored = await render.renderTemplatePreview({ templateId, step: 1, personId: inbox, senderId: sara.id });
    expect(stored.subject).toMatch(/^Re: (Print-ready 3D models|3D models) for Acme 3D$/);
  });

  it("reports missing details for the chosen person", async () => {
    const e = await render.renderDraftPreview({ subject: "Hi", body: "Dear {{first_name}}", step: 0, personId: inbox, senderId: ali.id });
    expect(e.warnings).toEqual([expect.objectContaining({ kind: "missing", variable: "first_name" })]);
  });

  it("explains deleted contacts, templates and steps", async () => {
    const gone = await makePerson({ name: "Gone", email: "gone@acme.de" });
    await dbWrite((c) => c.person.update({ where: { id: gone }, data: { deletedAt: new Date() } }));
    await expect(render.renderDraftPreview({ subject: "x", body: "y", step: 0, personId: gone, senderId: ali.id })).rejects.toThrow(
      "This contact was deleted. Pick another contact to preview.",
    );
    await expect(render.renderTemplatePreview({ templateId: 999_999, step: 0, personId: anna, senderId: ali.id })).rejects.toThrow(
      render.RenderError,
    );
    const created = await templates.createTemplate(ali, "Only first");
    if (!created.ok) throw new Error("setup failed");
    await expect(render.renderTemplatePreview({ templateId: created.template.id, step: 2, personId: anna, senderId: ali.id })).rejects.toThrow(
      "This template has no follow-up 2.",
    );
    await expect(render.renderDraftPreview({ subject: "x", body: "y", step: 0, personId: anna, senderId: 999_999 })).rejects.toThrow(
      render.RenderError,
    );
  });

  it("returns every variable's value for a person and sender", async () => {
    const { values, settings } = await render.templateValuesFor({ personId: olaf, senderId: ali.id });
    expect(values).toMatchObject({ first_name: "Olaf", personal_line: "Olaf's owl print is wonderful.", est_revenue: "2M", sender_name: "Ali Khan", website: "acme.de", country: "Germany" });
    expect(settings.portfolioUrl).toBe("https://www.polygonparadise.com");
  });
});
