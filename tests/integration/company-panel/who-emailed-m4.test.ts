import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createTestDb } from "../helpers/test-db";

/**
 * "Who has been emailed" in the company panel after Milestone 4 (M4-DESIGN §2.12, §6 rows 2–5): the banner's replied
 * part, the people's Replied flag with its date, the held and reply-stop sequence texts (with the hold reason read
 * from getCompanyDetail) and the " (test list)" suffix for live emails before go-live.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/contacts",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth/dal", () => ({
  requireUserAction: async () => {
    throw new Error("not used");
  },
}));

const t = await createTestDb("company-panel-m4");
const { db, dbWrite } = await import("@/server/db");
const detail = await import("@/server/services/companies/detail");
const { CompanyPanel } = await import("@/components/company-panel/company-panel");
const { emailedSummary, pickSequence, personFlags } = await import("@/components/company-panel/emailed-text");
const { formatShortDate } = await import("@/core/time/format");

const DAY = 86_400_000;
const TZ = "Europe/Berlin";
const now = new Date();

let ownerId = 0;
let firmaId = 0;
let annaId = 0;
let benId = 0;

async function setSetting(key: string, value: unknown) {
  await dbWrite((c) => c.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } }));
}

/** A launched campaign; it records Setting "sending.goLive" as its launch flag, as a launch does (M6-DESIGN §2.2). */
async function campaign(name: string, mode: "LIVE" | "DRY_RUN" | "TEST", status: "RUNNING" | "FINISHED" = "RUNNING") {
  const goLive = await db.setting.findUnique({ where: { key: "sending.goLive" } });
  return dbWrite((c) =>
    c.campaign.create({
      data: {
        name,
        mode,
        status,
        createdById: ownerId,
        senderId: ownerId,
        launchedAt: new Date(now.getTime() - 5 * DAY),
        launchedGoLive: goLive?.value === true,
      },
    }),
  );
}

async function recipient(campaignId: number, personId: number, email: string, data: Record<string, unknown>) {
  return dbWrite((c) =>
    c.campaignRecipient.create({ data: { campaignId, companyId: firmaId, personId, emailNorm: email, ...data } }),
  );
}

/** An email the sending loop sent (markSent's result, without its "emailed" bookkeeping: a send before go-live). */
async function sentEmail(r: { id: number; campaignId: number; personId: number; emailNorm: string }, mode: "LIVE" | "TEST", step: number, sentAt: Date) {
  const id = `${r.campaignId}-${step}-${r.personId}`;
  return dbWrite((c) =>
    c.outboundEmail.create({
      data: {
        campaignId: r.campaignId,
        recipientId: r.id,
        personId: r.personId,
        companyId: firmaId,
        senderId: ownerId,
        step,
        mode,
        toEmail: r.emailNorm,
        toNorm: r.emailNorm,
        companyDomain: "firma.de",
        companyName: "Firma GmbH",
        fromAddress: "arslan@send.pp.test",
        subject: "3D models for Firma",
        text: "Hi",
        html: "<p>Hi</p>",
        messageId: `m-${id}@send.pp.test`,
        sendId: `s-${id}`,
        dueAt: sentAt,
        status: "SENT",
        sentAt,
      },
    }),
  );
}

type Detail = NonNullable<Awaited<ReturnType<typeof detail.getCompanyDetail>>>;

function banner(d: Detail): string {
  return emailedSummary(
    {
      lastEmailedAt: d.lastEmailedAt,
      lastEmailedByName: d.lastEmailedBy?.name ?? null,
      lastEmailedCampaignName: d.lastEmailedCampaignName,
      lastEmailedStep: d.lastEmailedStep,
      importedLastContactAt: d.importedLastContactAt,
      sequence: pickSequence(d.sequences),
      repliedAt: d.repliedAt,
      testSend: d.lastTestSend,
    },
    TZ,
    now,
  ).text;
}

function personText(p: Detail["people"][number]): string {
  return emailedSummary(
    {
      lastEmailedAt: p.lastEmailedAt,
      lastEmailedByName: p.lastEmailedBy?.name ?? null,
      lastEmailedCampaignName: p.lastEmailedCampaignName,
      lastEmailedStep: p.lastEmailedStep,
      sequence: pickSequence(p.sequences),
      testSend: p.lastTestSend,
    },
    TZ,
    now,
  ).text;
}

/** When Anna's live first email went to her test-list mailbox. */
const annaSentAt = new Date(now.getTime() - 3 * DAY);
const annaSentOn = () => formatShortDate(annaSentAt, TZ, now);

beforeAll(async () => {
  const owner = await dbWrite((c) => c.user.create({ data: { name: "Arslan", email: "arslan@pp.test", role: "OWNER" } }));
  ownerId = owner.id;
  const firma = await dbWrite((c) =>
    c.company.create({
      data: { name: "Firma GmbH", nameNorm: "firma", domain: "firma.de", status: "REPLIED", repliedAt: new Date(now.getTime() - 2 * DAY) },
    }),
  );
  firmaId = firma.id;
  const anna = await dbWrite((c) =>
    c.person.create({
      data: { companyId: firmaId, name: "Anna Berg", email: "anna@firma.de", emailNorm: "anna@firma.de", repliedAt: new Date(now.getTime() - 2 * DAY) },
    }),
  );
  const ben = await dbWrite((c) =>
    c.person.create({ data: { companyId: firmaId, name: "Ben Braun", email: "ben@firma.de", emailNorm: "ben@firma.de" } }),
  );
  annaId = anna.id;
  benId = ben.id;
  await setSetting("sending.goLive", false);
  await setSetting("practice.copy", false);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("getCompanyDetail for Milestone 4", () => {
  it("returns each sequence's hold reason and whether its sends count as emailed", async () => {
    const live = await campaign("Test mailboxes", "LIVE");
    await recipient(live.id, annaId, "anna@firma.de", { state: "HELD", holdReason: "possible-reply", heldAt: now, currentStep: 1 });
    await recipient(live.id, benId, "ben@firma.de", { state: "STOPPED", stopReason: "company_replied", stoppedByInboundId: 7 });

    const d = (await detail.getCompanyDetail(firmaId))!;
    const anna = d.sequences.find((s) => s.personId === annaId)!;
    expect(anna).toMatchObject({ state: "HELD", holdReason: "possible-reply", countsAsEmailed: false, campaignMode: "LIVE" });
    expect(anna).not.toHaveProperty("countsAsReal");
    expect(d.sequences.find((s) => s.personId === benId)).toMatchObject({ state: "STOPPED", stopReason: "company_replied", holdReason: null });
    expect(d.repliedAt).not.toBeNull();

    // Nothing was sent yet: live before go-live could only reach the test list, " (test list)"; the replied part ends
    // the banner.
    expect(d.lastTestSend).toBeNull();
    expect(banner(d)).toBe("Never emailed · on hold: a possible reply needs checking (test list) · replied 2 days ago");
  });

  it("says a test email went out to a test-list mailbox that replied, not 'Never emailed' (NOTIFY-01)", async () => {
    const live = (await db.campaign.findFirst({ where: { name: "Test mailboxes" } }))!;
    const annaRow = (await db.campaignRecipient.findFirst({ where: { campaignId: live.id, personId: annaId } }))!;
    await sentEmail(annaRow, "LIVE", 0, annaSentAt);

    const d = (await detail.getCompanyDetail(firmaId))!;
    expect(d.lastTestSend).toMatchObject({ mode: "LIVE", step: 0, campaignId: live.id, campaignName: "Test mailboxes", sentAt: annaSentAt });
    expect(d.people.find((p) => p.id === annaId)!.lastTestSend).toMatchObject({ mode: "LIVE", step: 0 });
    expect(d.people.find((p) => p.id === benId)!.lastTestSend).toBeNull();
    // Still not "emailed" for filters and the 30-day rule.
    expect(d.lastEmailedAt).toBeNull();

    const lead = `Test email sent ${annaSentOn()} (test list, doesn't count as emailed) · Test mailboxes · first email`;
    expect(banner(d)).toBe(`${lead} · on hold: a possible reply needs checking · replied 2 days ago`);
    expect(personText(d.people.find((p) => p.id === annaId)!)).toBe(`${lead} · on hold: a possible reply needs checking`);
    // Ben got nothing: his row still says so.
    expect(personText(d.people.find((p) => p.id === benId)!)).toBe(
      "Never emailed · stopped because someone at the company replied (test list)",
    );

    // After go-live the send still counts only as a test (it went out before), and the campaign, launched before
    // go-live, keeps its " (test list)" suffix: "emailed" is judged by its launch flag (M6-DESIGN §2.2).
    await setSetting("sending.goLive", true);
    const after = (await detail.getCompanyDetail(firmaId))!;
    expect(after.sequences.every((s) => !s.countsAsEmailed)).toBe(true);
    expect(banner(after)).toBe(`${lead} · on hold: a possible reply needs checking · replied 2 days ago`);
    expect(personText(after.people.find((p) => p.id === benId)!)).toBe(
      "Never emailed · stopped because someone at the company replied (test list)",
    );
  });

  it("renders the panel: banner, the Replied flag with its date, and each person's sequence", async () => {
    const panel = await CompanyPanel({
      companyId: firmaId,
      user: { id: ownerId, email: "arslan@pp.test", name: "Arslan", role: "OWNER", timeZone: TZ, sessionId: 1 },
    });
    // The app shell provides the tooltip context.
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, panel));
    const lead = `Test email sent ${annaSentOn()} (test list, doesn&#x27;t count as emailed) · Test mailboxes · first email`;
    // The banner and Anna's row say what happened; the banner isn't drawn as "nothing sent" (dashed).
    const bannerText = `${lead} · on hold: a possible reply needs checking · replied 2 days ago`;
    expect(html).toContain(bannerText);
    expect(html).toContain(`${lead} · on hold: a possible reply needs checking</p>`);
    expect(html).not.toContain("Never emailed · on hold: a possible reply needs checking");
    const at = html.indexOf(bannerText);
    const bannerBox = html.slice(html.lastIndexOf("<div", at), at);
    expect(bannerBox).toContain("bg-card");
    expect(bannerBox).not.toContain("border-dashed");
    const annaFlag = personFlags(
      { unsubscribedAt: null, bouncedAt: null, complainedAt: null, repliedAt: new Date(now.getTime() - 2 * DAY), suppressed: false },
      TZ,
      now,
    )[0]!;
    expect(html).toContain(`title="${annaFlag.title}"`);
    expect(annaFlag.title).toMatch(/^Replied on \d{1,2} [A-Z][a-z]{2,3}( \d{4})?$/);
    expect(html).toContain(`(${annaFlag.title})`); // also read out, not only a tooltip
    expect(html).toContain("stopped because someone at the company replied");
  });

  it("words an outage hold and a reply stop in the person rows", async () => {
    const other = await campaign("Norway prints", "LIVE");
    await recipient(other.id, benId, "ben@firma.de", { state: "HELD", holdReason: "outage", heldAt: now, currentStep: 1 });
    const d = (await detail.getCompanyDetail(firmaId))!;
    const ben = d.people.find((p) => p.id === benId)!;
    expect(personText(ben)).toBe("Never emailed · on hold: replies may have been missed while the PC was off");
  });

  it("looks test emails up only for people with no counted email, and prefers a delivered one to test mode", async () => {
    const mode = await campaign("Mode check", "TEST", "FINISHED");
    const benRow = await recipient(mode.id, benId, "ben@firma.de", { state: "FINISHED", currentStep: 1 });
    await sentEmail(benRow, "TEST", 0, new Date(now.getTime() - DAY));
    let d = (await detail.getCompanyDetail(firmaId))!;
    const ben = d.people.find((p) => p.id === benId)!;
    expect(ben.lastTestSend).toMatchObject({ mode: "TEST", campaignName: "Mode check" });
    expect(personText(ben)).toMatch(/^Sent in test mode .+ \(not delivered\) · Mode check · first email · /);
    // Anna's test-list email is older, but it was delivered: the company banner names it.
    expect(d.lastTestSend).toMatchObject({ mode: "LIVE", campaignName: "Test mailboxes" });

    // Once Anna has a counted email, only Ben (still without one) keeps his test email.
    const counted = new Date(now.getTime() - DAY / 2);
    await dbWrite((c) => c.company.update({ where: { id: firmaId }, data: { lastEmailedAt: counted, lastEmailedById: ownerId } }));
    await dbWrite((c) => c.person.update({ where: { id: annaId }, data: { lastEmailedAt: counted, lastEmailedById: ownerId } }));
    d = (await detail.getCompanyDetail(firmaId))!;
    expect(d.lastTestSend).toBeNull();
    expect(d.people.find((p) => p.id === annaId)!.lastTestSend).toBeNull();
    expect(d.people.find((p) => p.id === benId)!.lastTestSend).toMatchObject({ mode: "TEST" });
    expect(banner(d)).toMatch(/^Emailed by Arslan 12 hours ago · /);
  });
});
