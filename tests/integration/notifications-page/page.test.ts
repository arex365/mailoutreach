import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The Notifications page (M4-DESIGN §4.3, §5.5, §9.1) rendered with a test database: its sections, the filter chips,
 * the empty states, the pinned `?reply=` card (also from page 2 of the list), the On hold card and the Owner's
 * "Messages we couldn't link"; and the reply Server Actions behind the cards.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/notifications",
  redirect: (href: string) => {
    throw new Error(`redirect ${href}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction,
    requireUser: async () => {
      if (!auth.user) throw new Error("redirect /login");
      return auth.user;
    },
  };
});

const t = await createTestDb("notifications-page");
const { db, dbWrite } = await import("@/server/db");
const { default: NotificationsPage } = await import("@/app/(app)/notifications/page");
const actions = await import("@/app/(app)/notifications/reply-actions");

let owner: TestUser;
let ali: TestUser;
let sara: TestUser;
let lonely: TestUser;
let seq = 0;

async function user(name: string, role: "OWNER" | "MEMBER"): Promise<TestUser> {
  const u = await dbWrite((c) => c.user.create({ data: { name, email: `${name.toLowerCase()}@polygonparadise.test`, role, timeZone: "Europe/Berlin" } }));
  return { id: u.id, email: u.email, name: u.name, role, timeZone: "Europe/Berlin", sessionId: 1 };
}

/** A processed reply waiting for an answer, as reply processing leaves it. */
async function waiting(opts: { assigneeId: number; from?: string; kind?: "REPLY" | "POSSIBLE_REPLY" | "UNLINKED"; receivedAt?: Date; answered?: boolean }) {
  seq += 1;
  return dbWrite((c) =>
    c.inboundMessage.create({
      data: {
        messageIdHeader: `w${seq}@example.org`,
        receivedAt: opts.receivedAt ?? new Date(Date.now() - (100 - seq) * 60_000),
        toAddress: "ali@send.example.com",
        fromEmail: opts.from ?? `person${seq}@shop${seq}.de`,
        subject: `Question ${seq}`,
        snippet: `First lines ${seq}`,
        kind: opts.kind ?? "UNLINKED",
        replyScope: "none",
        assigneeId: opts.assigneeId,
        source: "NOTIFY",
        processedAt: new Date(),
        ...(opts.answered ? { answeredAt: new Date(), answeredById: opts.assigneeId, answerOutcome: "answered" } : {}),
      },
    }),
  );
}

async function render(search: Record<string, string> = {}): Promise<string> {
  const el = await NotificationsPage({ params: Promise.resolve({}), searchParams: Promise.resolve(search) } as never);
  return renderToStaticMarkup(el)
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

beforeAll(async () => {
  owner = await user("Arslan", "OWNER");
  ali = await user("Ali", "MEMBER");
  sara = await user("Sara", "MEMBER");
  lonely = await user("Lonely", "MEMBER");
});

beforeEach(() => {
  auth.user = owner;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("empty states", () => {
  it("nothing at all: You're all caught up, with the next step", async () => {
    auth.user = lonely;
    const html = await render();
    expect(html).toContain("You're all caught up.");
    expect(html).toContain("Replies to your campaigns, finished campaigns and anything that needs your attention will show up here.");
    expect(html).toContain('href="/contacts"');
    expect(html).not.toContain("Replies waiting for an answer");
  });
});

describe("with replies and notifications", () => {
  it("shows the waiting list (Everyone's for the Owner, Yours for Members), the help line and the notification list", async () => {
    await waiting({ assigneeId: ali.id, from: "jonas@firma.de", kind: "UNLINKED" });
    await waiting({ assigneeId: sara.id, from: "ben@shop.de", kind: "UNLINKED" });
    await dbWrite((c) =>
      c.notification.create({ data: { userId: owner.id, type: "campaign.finished", title: "Germany Q4 finished", body: "3 emails were sent.", link: "/campaigns/1" } }),
    );

    const html = await render();
    expect(html).toContain("Replies waiting for an answer");
    expect(html).toContain("Everyone's (2)");
    expect(html).toContain("Yours (0)");
    expect(html).toContain("The app can't see your inbox. Answer in your own email program, then mark the reply here.");
    expect(html).toContain("jonas@firma.de");
    expect(html).toContain("Reply we couldn't link to a company");
    expect(html).toContain("waiting for Ali");
    expect(html).toContain("Link to a company");
    expect(html).toContain("All notifications");
    for (const chip of ["All", "Unread", "Replies", "Campaigns", "Sending and system"]) expect(html).toContain(`>${chip}</a>`);
    expect(html).toContain("Germany Q4 finished");
    expect(html).toContain("1 unread notification.");
    expect(html).toContain("Messages we couldn't link (last 30 days)");
    expect(html).toContain("None in the last 30 days.");

    auth.user = ali;
    const member = await render();
    expect(member).toContain("Yours (1)");
    expect(member).toContain("Everyone's (2)");
    expect(member).toContain("jonas@firma.de");
    expect(member).not.toContain("ben@shop.de");
    expect(member).not.toContain("waiting for Ali"); // Yours: no assignee line
    expect(member).not.toContain("Messages we couldn't link");
    const everyone = await render({ scope: "everyone" });
    expect(everyone).toContain("ben@shop.de");

    auth.user = lonely;
    expect(await render()).toContain("No replies are waiting for an answer.");
  });

  it("a filter with nothing in it says so and offers Show all", async () => {
    const html = await render({ filter: "replies" });
    expect(html).toContain("No notifications match this filter.");
    expect(html).toContain("Show all");
    expect(html).toMatch(/aria-current="page"[^>]*>Replies<\/a>/);
  });
});

describe("the pinned reply (?reply=)", () => {
  it("pins a reply that is on page 2 of the list, and says when one isn't waiting any more", async () => {
    let last = 0;
    for (let i = 0; i < 52; i++) last = (await waiting({ assigneeId: ali.id, receivedAt: new Date(Date.now() - (60 - i) * 60_000), from: `bulk${i}@bulk${i}.de` })).id;
    const html = await render({ reply: String(last) });
    expect(html).toContain("The reply you opened");
    expect(html).toContain("bulk51@bulk51.de");
    expect(html).toContain("Page 1 of 2");
    expect(html.indexOf("The reply you opened")).toBeLessThan(html.indexOf("Replies waiting for an answer"));
    // The notification's link ends in #replies: the one anchor is the pinned reply, so the browser lands on it.
    expect(html.match(/id="replies"/g)?.length).toBe(1);
    expect(html.indexOf('id="replies"')).toBeLessThan(html.indexOf("The reply you opened"));
    expect((await render()).match(/id="replies"/g)?.length).toBe(1);

    const done = await waiting({ assigneeId: ali.id, answered: true });
    const gone = await render({ reply: String(done.id) });
    expect(gone).toContain("This reply isn't on the list any more.");
  });
});

describe("the On hold card", () => {
  async function outage(heldFor: string, heldTo: string) {
    await dbWrite(async (c) => {
      await c.systemState.deleteMany({ where: { key: "catchup.outage" } });
      await c.systemState.create({
        data: {
          key: "catchup.outage",
          version: 1,
          value: {
            detectedAt: heldTo,
            from: heldFor,
            to: heldTo,
            beyondLogRetention: true,
            beyondMessageRetention: false,
            handledAt: heldTo,
            heldFor,
            heldTo,
            heldCount: 2,
          },
        },
      });
    });
  }

  async function heldRecipient(senderId: number, currentStep: number) {
    seq += 1;
    const company = await dbWrite((c) => c.company.create({ data: { name: `Held ${seq}`, nameNorm: `held ${seq}` } }));
    const person = await dbWrite((c) => c.person.create({ data: { companyId: company.id, name: `P ${seq}`, email: `p${seq}@held.de`, emailNorm: `p${seq}@held.de` } }));
    const camp = await dbWrite((c) =>
      c.campaign.create({ data: { name: `Held campaign ${seq}`, createdById: senderId, senderId, status: "RUNNING", mode: "LIVE", steps: { create: [{ step: 0, subject: "Hi", body: "Hi" }] } } }),
    );
    return dbWrite((c) =>
      c.campaignRecipient.create({
        data: { campaignId: camp.id, companyId: company.id, personId: person.id, emailNorm: person.emailNorm!, state: "HELD", holdReason: "outage", heldAt: new Date(), currentStep },
      }),
    );
  }

  it("shows the sender's held follow-ups with the window, and continues them with I've checked my inbox", async () => {
    await outage("2026-10-03T08:00:00.000Z", "2026-10-09T08:00:00.000Z");
    await heldRecipient(sara.id, 1);
    await heldRecipient(sara.id, 0);
    auth.user = sara;
    const html = await render();
    expect(html).toContain('id="on-hold"');
    expect(html).toContain("Your follow-ups are on hold");
    expect(html).toContain(
      // SPEC-03: the dates are the replies that may have been missed, not the PC's off-time.
      "The PC was off too long, so the app may have missed replies that arrived from 3 Oct to 9 Oct. Look through your inbox for replies to your campaigns from those days. Follow-ups of 1 person wait until you confirm. First emails to 1 other person at those companies wait too.",
    );
    expect(html).toContain("I've checked my inbox");

    const res = await actions.continueMyFollowUpsAction();
    expect(res).toMatchObject({ ok: true, data: { message: "Thanks. Follow-ups of 1 person continue.", released: 1 } });
    expect(await actions.continueMyFollowUpsAction()).toEqual({ ok: false, error: "Nothing of yours is on hold." });
    expect(await render()).not.toContain('id="on-hold"');
  });

  it("only first emails waiting for other senders: nothing to do, no button", async () => {
    await outage("2026-10-03T08:00:00.000Z", "2026-10-09T08:00:00.000Z");
    await heldRecipient(ali.id, 0);
    // Another sender emailed the same kind of company and is still held (keeps the colleague waiting).
    await heldRecipient(owner.id, 1);
    auth.user = ali;
    const html = await render();
    expect(html).toContain("Some of your first emails are on hold");
    expect(html).toContain(
      "First emails to 1 person wait until the senders who already emailed their companies have checked their inbox for replies from 3 Oct to 9 Oct. There's nothing for you to do.",
    );
    expect(html).not.toContain("I've checked my inbox");
  });
});

describe("the reply Server Actions", () => {
  it("anyone signed in may act on any waiting reply; the answers are plain sentences", async () => {
    const row = await waiting({ assigneeId: ali.id, kind: "UNLINKED", from: "someone@action.de" });
    auth.user = sara;
    expect(await actions.markReplyAnsweredAction({ id: row.id })).toEqual({ ok: true, data: { message: "Marked as answered." }, message: undefined });
    expect(await actions.markReplyAnsweredAction({ id: row.id })).toEqual({
      ok: false,
      error: "This reply was already handled by Sara. Refresh the page to see it.",
    });
    expect(await actions.reopenReplyAction({ id: row.id })).toMatchObject({ ok: true, data: { message: "The reply is back on the waiting list." } });
    expect(await actions.markReplyNotNeededAction({ id: row.id })).toMatchObject({ ok: true, data: { message: "Marked as needing no answer." } });
    expect(await actions.linkReplyAction({ id: row.id, companyId: 0 })).toMatchObject({ ok: false });
    expect(await actions.confirmReplyAction({ id: 999_999, real: true })).toEqual({ ok: false, error: "This reply isn't on the list any more. Refresh the page." });
    expect(await actions.replyLinkCompanyAction({ companyId: 999_999 })).toEqual({ ok: false, error: "This company was deleted. Pick another one." });

    auth.user = null;
    expect((await actions.markReplyAnsweredAction({ id: row.id })).ok).toBe(false);
    expect((await actions.addReplySenderAction({ id: row.id })).ok).toBe(false);
    expect((await actions.continueMyFollowUpsAction()).ok).toBe(false);
  });

  it("the Link dialog's company lookup lists the live people", async () => {
    const company = await dbWrite((c) => c.company.create({ data: { name: "Lookup GmbH", nameNorm: "lookup gmbh" } }));
    await dbWrite((c) => c.person.create({ data: { companyId: company.id, name: "Anna Berg", email: "anna@lookup.de", emailNorm: "anna@lookup.de" } }));
    await dbWrite((c) =>
      c.person.create({ data: { companyId: company.id, name: "Gone Person", email: "gone@lookup.de", emailNorm: "gone@lookup.de", deletedAt: new Date() } }),
    );
    auth.user = ali;
    const res = await actions.replyLinkCompanyAction({ companyId: company.id });
    expect(res).toMatchObject({ ok: true, data: { id: company.id, name: "Lookup GmbH", deleted: false, people: [{ label: "Anna Berg (anna@lookup.de)" }] } });
  });
});
