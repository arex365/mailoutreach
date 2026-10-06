import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The dashboard in own-mailbox mode (MAIN-DOMAIN-DESIGN §3.9, O15, O26, O36, P5): the `inbox-check` item for everyone
 * while nobody has read the own mailbox today and live follow-ups (a paused campaign's included) are due within 24
 * hours; the replies tile's own empty state; go-live's evidence From; stored checklist rows of the other mode ignored;
 * the outage sentences' days. App mode, in the same database, shows none of it. No Mailgun is involved: the dashboard
 * only reads settings and rows.
 */

vi.mock("server-only", () => ({}));
// The reply cards' Server Actions can't load outside Next; the empty tile never renders a card.
vi.mock("@/app/(app)/notifications/reply-actions", () => ({
  addReplySenderAction: vi.fn(),
  confirmReplyAction: vi.fn(),
  continueMyFollowUpsAction: vi.fn(),
  linkReplyAction: vi.fn(),
  markReplyAnsweredAction: vi.fn(),
  markReplyNotNeededAction: vi.fn(),
  reopenReplyAction: vi.fn(),
  replyLinkCompanyAction: vi.fn(),
}));
vi.mock("@/app/(app)/contacts/actions", () => ({ searchCompaniesAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

const t = await createTestDb("own-mailbox-dashboard");
const { db, dbWrite } = await import("@/server/db");
const { loadDashboard } = await import("@/app/(app)/dashboard/load");
const { RepliesList } = await import("@/components/dashboard/replies-list");
const { INBOX_CHECK_TEXTS, OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");
const { makeUser, makeCompany, makePerson, makeCampaign, enroll } = await import("../stops-holds/world");
const { setSetting, setState } = await import("../mail-events/seed");

const FROM = "contact@example.com";
const H = 3_600_000;
const D = 24 * H;

type Viewer = Parameters<typeof loadDashboard>[0];
let owner: Viewer;
let ali: Viewer;
let seq = 0;

/** A campaign (`mode`, `status`) with one person whose next email (`step`) is QUEUED and due `dueIn` from `now`. */
async function queued(now: Date, opts: { mode?: "LIVE" | "TEST" | "DRY_RUN"; status?: "RUNNING" | "PAUSED" | "FINISHED"; step?: number; dueIn: number }) {
  seq += 1;
  const campaign = await makeCampaign({ createdById: owner.id, senderId: owner.id, mode: opts.mode ?? "LIVE", status: opts.status ?? "RUNNING" });
  const company = await makeCompany(`Studio ${seq}`);
  const step = opts.step ?? 1;
  const r = await enroll(campaign, await makePerson(company.id, `p${seq}@studio${seq}.example`), step === 0 ? { first: true } : {});
  await dbWrite((c) => c.outboundEmail.update({ where: { id: r.queuedId! }, data: { dueAt: new Date(now.getTime() + opts.dueIn) } }));
  return r;
}

const inboxItem = (view: Awaited<ReturnType<typeof loadDashboard>>) => view.attention.find((i) => i.key === "inbox-check");
const text = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

async function inAppMode<T>(fn: () => Promise<T>): Promise<T> {
  await setSetting("mailgun.replies", "app");
  try {
    return await fn();
  } finally {
    await setSetting("mailgun.replies", "own-mailbox");
  }
}

beforeAll(async () => {
  const o = await makeUser("Arslan", { role: "OWNER", timeZone: "Asia/Karachi" });
  const a = await makeUser("Ali", { timeZone: "Asia/Karachi" });
  owner = { id: o.id, email: o.email, name: o.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 };
  ali = { id: a.id, email: a.email, name: a.name, role: "MEMBER", timeZone: "Asia/Karachi", sessionId: 2 };
  for (const [key, value] of [
    ["practice.copy", false],
    ["sending.capDayTimeZone", "Asia/Karachi"],
    ["mailgun.domain", "example.com"],
    ["mailgun.region", "US"],
    ["mailgun.replies", "own-mailbox"],
    ["mailgun.fromAddress", FROM],
  ] as const) {
    await setSetting(key, value);
  }
});

beforeEach(async () => {
  await setSetting("mailgun.replies", "own-mailbox");
  await setSetting("sending.goLive", false);
  await setSetting("sending.goLiveAt", null);
  await setSetting("sending.goLiveDomain", null);
  await setSetting("sending.goLiveFrom", null);
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: { in: ["sending.inboxCheck", "catchup.outage", "domain.check"] } } });
    await c.outboundEmail.deleteMany({});
    await c.companyReservation.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaignStep.deleteMany({});
    await c.campaign.deleteMany({});
  });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("the inbox-check item", () => {
  it("shows for the Owner and a Member while live follow-ups are due within 24 hours, a paused campaign's included", async () => {
    const now = new Date();
    await queued(now, { dueIn: 2 * H });
    await queued(now, { status: "PAUSED", dueIn: -3 * H });
    // Not counted: a follow-up due later, a first email, a test-mode or dry-run follow-up, a finished campaign's.
    await queued(now, { dueIn: 3 * D });
    await queued(now, { step: 0, dueIn: H });
    await queued(now, { mode: "TEST", dueIn: H });
    await queued(now, { mode: "DRY_RUN", dueIn: H });
    await queued(now, { status: "FINISHED", dueIn: H });

    const expected = {
      key: "inbox-check",
      tone: "warning",
      text: INBOX_CHECK_TEXTS.item(2, FROM),
      detail: null,
      link: { href: "/notifications#inbox-check", label: "Open the inbox check" },
      note: null,
    };
    expect(inboxItem(await loadDashboard(owner, now))).toEqual(expected);
    expect(inboxItem(await loadDashboard(ali, now))).toEqual(expected);
    expect(expected.text).toBe(
      `2 follow-ups wait for today's check of contact@example.com. Whoever reads it: read its inbox and Spam folder, click They replied on every company that answered and ⋯ › Mark unsubscribed on the person for every removal request or "couldn't be delivered" notice, then click I've read contact@example.com.`,
    );
  });

  it("is gone once someone read the mailbox today; yesterday's check doesn't count", async () => {
    const now = new Date();
    await queued(now, { dueIn: H });
    await setState("sending.inboxCheck", { at: new Date(now.getTime() - D).toISOString(), byUserId: ali.id });
    expect(inboxItem(await loadDashboard(owner, now))).toBeDefined();
    await setState("sending.inboxCheck", { at: now.toISOString(), byUserId: ali.id });
    expect(inboxItem(await loadDashboard(owner, now))).toBeUndefined();
    expect(inboxItem(await loadDashboard(ali, now))).toBeUndefined();
  });

  it("a check stamped ahead of the clock isn't today's check: the item stays (review SECURITY-02, the gate's rule)", async () => {
    const now = new Date();
    await queued(now, { dueIn: H });
    await setState("sending.inboxCheck", { at: new Date(now.getTime() + 30 * D).toISOString(), byUserId: ali.id });
    expect(inboxItem(await loadDashboard(owner, now))).toBeDefined();
    await setState("sending.inboxCheck", { at: new Date(now.getTime() + 2 * 60_000).toISOString(), byUserId: ali.id });
    expect(inboxItem(await loadDashboard(owner, now))).toBeDefined();
    // Within the minute's allowance it counts, as at the gate.
    await setState("sending.inboxCheck", { at: new Date(now.getTime() + 30_000).toISOString(), byUserId: ali.id });
    expect(inboxItem(await loadDashboard(owner, now))).toBeUndefined();
  });

  it("never shows in app mode", async () => {
    const now = new Date();
    await queued(now, { dueIn: H });
    const view = await inAppMode(() => loadDashboard(owner, now));
    expect(inboxItem(view)).toBeUndefined();
    expect(view.ownFrom).toBeUndefined();
  });
});

describe("the replies tile", () => {
  it("says replies go straight to the own From when none wait (app mode: today's sentence)", async () => {
    const view = await loadDashboard(owner, new Date());
    expect(view.ownFrom).toBe(FROM);
    expect(view.replies).toEqual({ rows: [], total: 0 });
    const own = text(createElement(RepliesList, { replies: view.replies, ownFrom: view.ownFrom }));
    expect(own).toContain(OWN_MAILBOX_TEXTS.repliesEmpty(FROM));
    expect(own).toContain("Replies go straight to contact@example.com, not to the app. When someone answers, click They replied on their company.");
    expect(own).not.toContain("No replies are waiting for you.");
    expect(text(createElement(RepliesList, { replies: { rows: [], total: 0 } }))).toContain("No replies are waiting for you.");
  });
});

describe("go-live, the checklist and the outage in own-mailbox mode", () => {
  async function goLive(now: Date) {
    await setSetting("sending.goLive", true);
    await setSetting("sending.goLiveAt", new Date(now.getTime() - 5 * D).toISOString());
    await setSetting("sending.goLiveDomain", "example.com");
    await setSetting("sending.goLiveFrom", FROM);
  }
  const fromMx = { key: "from-mx", group: "dns", status: "bad", title: "Mail for example.com stays with your mail provider (MX)", text: "", fix: null, records: [], detail: null };

  it("go-live's From is the own From (evidence From): no 'go live again' item", async () => {
    const now = new Date();
    await goLive(now);
    const view = await loadDashboard(owner, now);
    expect(view.attention.map((i) => i.key)).not.toContain("go-live-again");
  });

  it("uses stored checklist rows only of own-mailbox mode, with that mode's go-live rows", async () => {
    const now = new Date();
    await goLive(now);
    const check = { domain: "example.com", checkedAt: now.toISOString(), lastVerifyAt: null, rows: [fromMx], error: null };
    // Rows checked in app mode (no `replies`): ignored.
    await setState("domain.check", check);
    expect((await loadDashboard(owner, now)).attention.map((i) => i.key)).not.toContain("checklist");
    // Rows of this mode: the from-mx row is a go-live row.
    await setState("domain.check", { ...check, replies: "own-mailbox" });
    expect((await loadDashboard(owner, now)).attention.find((i) => i.key === "checklist")?.text).toBe(
      "Something on the Domain checklist needs fixing: Mail for example.com stays with your mail provider (MX).",
    );
    // App mode ignores this mode's rows in turn.
    expect((await inAppMode(() => loadDashboard(owner, now))).attention.map((i) => i.key)).not.toContain("checklist");
  });

  it("the outage sentence says more than 1 day (the Free plan's logs) and names Mailgun's reports, not replies; app mode: more than 5 days", async () => {
    const now = new Date();
    await setState("catchup.outage", {
      detectedAt: now.toISOString(),
      from: new Date(now.getTime() - 30 * H).toISOString(),
      to: new Date(now.getTime() - 23 * H).toISOString(),
      beyondLogRetention: true,
      beyondMessageRetention: false,
      handledAt: null,
      heldFor: null,
      heldTo: null,
      heldCount: 0,
    });
    // Review REPLIES-09: in own-mailbox mode no reply passes through the app, so none can be missed.
    expect((await loadDashboard(owner, now)).attention.find((i) => i.key === "outage-hold")?.text).toBe(
      "Some emails wait a moment: the PC was off for more than 1 day, so Mailgun's reports of that time couldn't be read. Replies aren't affected: they go straight to your own mailbox.",
    );
    expect((await inAppMode(() => loadDashboard(owner, now))).attention.find((i) => i.key === "outage-hold")?.text).toBe(
      "Some emails wait: the PC was off for more than 5 days, so replies may have been missed.",
    );
  });
});
