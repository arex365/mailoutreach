import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WaitingReplyView } from "@/server/services/replies/waiting";

// The Server Actions modules can't load outside Next (server-only); nothing here calls them.
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
vi.mock("@/app/(app)/notifications/actions", () => ({ markAllNotificationsReadAction: vi.fn(), markNotificationsReadAction: vi.fn() }));
vi.mock("@/app/(app)/contacts/actions", () => ({ searchCompaniesAction: vi.fn() }));
vi.mock("@/app/(app)/campaigns/outbox/actions", () => ({ simulateEmailAction: vi.fn(), simulateReplyAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/notifications",
}));

const { ReplyCard } = await import("@/components/replies/reply-card");
const { OnHoldCard, onHoldTexts } = await import("@/components/replies/on-hold-card");
const { OtherMessages } = await import("@/components/replies/other-messages");
const { RepliesSection } = await import("@/components/replies/replies-section");
const { LinkReplyDialog } = await import("@/components/replies/link-reply-dialog");
const { SimulateButtons, SIMULATE_BUTTONS } = await import("@/components/campaigns/simulate-buttons");

const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

function view(overrides: Partial<WaitingReplyView> = {}): WaitingReplyView {
  return {
    id: 7,
    kind: "REPLY",
    label: "",
    receivedIso: "2026-09-24T08:00:00.000Z",
    receivedAgo: "2 hours ago",
    receivedExact: "24 Sept 2026, 10:00",
    quietLine: null,
    fromEmail: "anna@firma.de",
    fromName: "Anna Berg",
    fromIsContact: true,
    company: { id: 1042, name: "Firma GmbH" },
    person: { id: 3, name: "Anna Berg" },
    campaign: { id: 5, name: "Germany Q4", step: 1 },
    senderName: "Ali",
    assigneeName: "Ali",
    subject: "Re: 3D models for your shop",
    firstLines: "Hi Ali, sounds interesting.",
    whyLines: [],
    hints: [],
    hintCompanyId: null,
    canAddPerson: false,
    ...overrides,
  };
}

describe("ReplyCard", () => {
  it("a reply: who, company link, badge, meta, first lines, Answered and No answer needed", () => {
    const out = html(createElement(ReplyCard, { reply: view(), showAssignee: true }));
    expect(out).toContain("Anna Berg");
    expect(out).toContain('href="/contacts?company=1042"');
    expect(out).toContain(">Reply<");
    expect(out).toContain("Replied 2 hours ago to “Re: 3D models for your shop” · Germany Q4 · follow-up 1 · sent by Ali · waiting for Ali");
    expect(out).toContain('title="24 Sept 2026, 10:00"');
    expect(out).toContain("Hi Ali, sounds interesting.");
    expect(out).toContain(">Answered<");
    expect(out).toContain(">No answer needed<");
    expect(out).not.toContain("Real reply");
    expect(out).not.toContain("Link to a company");
    expect(out).not.toContain(" to Firma GmbH<"); // no Add button for a contact
  });

  it("an unknown colleague: 'not in your contacts' and the Add button", () => {
    const out = html(createElement(ReplyCard, { reply: view({ fromEmail: "jonas@firma.de", fromName: null, fromIsContact: false, canAddPerson: true }), showAssignee: false }));
    expect(out).toContain("jonas@firma.de (not in your contacts)");
    expect(out).toContain(">Add jonas@firma.de to Firma GmbH<");
    expect(out).not.toContain("waiting for Ali");
  });

  it("a possible reply: why the app isn't sure, Real reply and It was an auto-reply", () => {
    const out = html(
      createElement(ReplyCard, {
        reply: view({ kind: "POSSIBLE_REPLY", whyLines: ["It says they're away, but it may also contain a real answer."] }),
        showAssignee: false,
      }),
    );
    expect(out).toContain(">Real reply?<");
    expect(out).toContain("The app isn't sure this is a real reply:");
    expect(out).toContain("<li>It says they're away, but it may also contain a real answer.</li>");
    expect(out).toContain(">Real reply<");
    expect(out).toContain(">It was an auto-reply<");
    expect(out).not.toContain(">Answered<");
  });

  it("an unlinked reply: hints, Link to a company, Answered, No answer needed; the Dry run badge; quiet line", () => {
    const out = html(
      createElement(ReplyCard, {
        reply: view({
          kind: "UNLINKED",
          label: "Dry run",
          company: null,
          campaign: null,
          fromName: null,
          fromIsContact: false,
          fromEmail: "jonas@firma.de",
          hints: ["Same domain as Firma GmbH (C-1042).", "Follow-ups to Firma GmbH wait until you link this reply or mark it."],
          quietLine: "Arrived on 12 Sept while the PC was off.",
        }),
        showAssignee: false,
      }),
    );
    expect(out).toContain(">Reply we couldn't link to a company<");
    expect(out).toContain(">Dry run<");
    expect(out).toContain("Same domain as Firma GmbH (C-1042).");
    expect(out).toContain("Arrived on 12 Sept while the PC was off.");
    expect(out).toContain("Received 2 hours ago: “Re: 3D models for your shop”");
    expect(out).toContain(">Link to a company<");
    expect(out).toContain(">Answered<");
  });

  it("shows the reply's text as plain text only", () => {
    const out = renderToStaticMarkup(createElement(ReplyCard, { reply: view({ firstLines: '<script>alert("x")</script> <a href="https://evil.example">click</a>' }), showAssignee: false }));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain('href="https://evil.example"');
    expect(out).toContain("&lt;script&gt;");
  });

  it("the pinned card is highlighted", () => {
    expect(html(createElement(ReplyCard, { reply: view(), showAssignee: false, highlighted: true }))).toContain("ring-brand");
  });
});

describe("the On hold card", () => {
  it("the sender's version, with the dialog text", () => {
    const t = onHoldTexts({ held: 8, firstEmailsWaiting: 2, from: "3 Oct", to: "9 Oct" });
    expect(t.title).toBe("Your follow-ups are on hold");
    // SPEC-03: the dates are the replies that may have been missed, not the PC's off-time.
    expect(t.text).toBe(
      "The PC was off too long, so the app may have missed replies that arrived from 3 Oct to 9 Oct. Look through your inbox for replies to your campaigns from those days. Follow-ups of 8 people wait until you confirm. First emails to 2 other people at those companies wait too.",
    );
    expect(onHoldTexts({ held: 1, firstEmailsWaiting: 0, from: null, to: null }).text).toMatch(
      /^The PC was off too long, so the app may have missed replies that arrived then\. /,
    );
    expect(t.confirm).toBe(
      "Did you check your inbox for replies from 3 Oct to 9 Oct? Follow-ups to 8 people will continue. If someone replied, set their company to Replied first, so their follow-ups stop.",
    );
    const out = html(createElement(OnHoldCard, { held: 8, firstEmailsWaiting: 0, from: "3 Oct", to: "9 Oct" }));
    expect(out).toContain('id="on-hold"');
    expect(out).toContain("Follow-ups of 8 people wait until you confirm.");
    expect(out).not.toContain("other people");
    expect(out).toContain("I've checked my inbox");
  });

  it("only first emails waiting for others: nothing to do", () => {
    const t = onHoldTexts({ held: 0, firstEmailsWaiting: 2, from: "3 Oct", to: "9 Oct" });
    expect(t).toEqual({
      title: "Some of your first emails are on hold",
      text: "First emails to 2 people wait until the senders who already emailed their companies have checked their inbox for replies from 3 Oct to 9 Oct. There's nothing for you to do.",
      confirm: null,
    });
    expect(html(createElement(OnHoldCard, { held: 0, firstEmailsWaiting: 2, from: "3 Oct", to: "9 Oct" }))).not.toContain("I've checked my inbox");
  });
});

describe("the Owner's other messages", () => {
  it("lists from, subject, what it was and when; or says there were none", () => {
    const out = html(
      createElement(OtherMessages, {
        rows: [{ id: 1, fromEmail: "offers@bulk-mailer.example", subject: "Grow your sales", what: "marked as spam by Mailgun", receivedExact: "24 Sept 2026, 09:00" }],
      }),
    );
    expect(out).toContain("<details");
    expect(out).toContain("Messages we couldn't link (last 30 days)");
    expect(out).toContain("offers@bulk-mailer.example");
    expect(out).toContain("marked as spam by Mailgun · 24 Sept 2026, 09:00");
    expect(html(createElement(OtherMessages, { rows: [] }))).toContain("None in the last 30 days.");
  });
});

describe("the replies section", () => {
  const hrefFor = (q: { scope: "mine" | "everyone"; rpage: number }) => `/notifications?scope=${q.scope}&rpage=${q.rpage}#replies`;
  it("heading, count, toggle, help line and the empty texts per view", () => {
    const empty = { rows: [], total: 0, mine: 0, everyone: 0, page: 1, pageCount: 1, hrefFor };
    const everyone = html(createElement(RepliesSection, { ...empty, scope: "everyone" }));
    expect(everyone).toContain('id="replies"');
    expect(everyone).toContain("Replies waiting for an answer");
    expect(everyone).toContain("Everyone's (0)");
    expect(everyone).toContain("Yours (0)");
    expect(everyone).toContain("The app can't see your inbox. Answer in your own email program, then mark the reply here.");
    expect(everyone).toContain("Nobody's replies are waiting for an answer.");
    expect(html(createElement(RepliesSection, { ...empty, scope: "mine" }))).toContain("No replies are waiting for an answer.");
  });

  it("lists the cards, skips the pinned one, and pages with Previous / Next", () => {
    const out = html(
      createElement(RepliesSection, {
        rows: [view({ id: 1, fromEmail: "a@x.de", fromName: null }), view({ id: 2, fromEmail: "b@x.de", fromName: null })],
        total: 60,
        mine: 3,
        everyone: 60,
        page: 1,
        pageCount: 2,
        scope: "everyone",
        hrefFor,
        skipId: 2,
      }),
    );
    expect(out).toContain("a@x.de");
    expect(out).not.toContain("b@x.de");
    expect(out).toContain("Page 1 of 2 · 60 replies");
    expect(out).toContain('href="/notifications?scope=everyone&amp;rpage=2#replies"');
    expect(out).toMatch(/aria-current="page"[^>]*>Everyone's \(60\)</);
  });
});

describe("the Link dialog", () => {
  it("renders nothing while closed", () => {
    const reply = view({ kind: "UNLINKED" });
    expect(renderToStaticMarkup(createElement(LinkReplyDialog, { reply, open: false, onOpenChange: () => undefined }))).toBe("");
  });
});

describe("the outbox's Simulate row", () => {
  it("has the four Mailgun reports and the three answers, each once, with the help line", () => {
    expect(SIMULATE_BUTTONS.map((b) => b.label)).toEqual(["Delivered", "Bounce", "Complaint", "Unsubscribe", "Reply", "Out-of-office", "Unclear reply"]);
    const out = html(
      createElement(SimulateButtons, { emailId: 9, done: ["delivered"], repliesDone: ["reply"], resultLine: "Delivered · Replied (simulated)", practiceCopy: false }),
    );
    expect(out).toContain("Test what happens when Mailgun reports back, or when the person answers. In a dry run this only changes this campaign.");
    for (const label of ["Delivered", "Bounce", "Complaint", "Unsubscribe", "Reply", "Out-of-office", "Unclear reply"]) expect(out).toContain(`>${label}</button>`);
    expect(out.match(/aria-pressed="true"/g)?.length).toBe(2);
    expect(out).toContain("Delivered · Replied (simulated)");
    expect(
      html(createElement(SimulateButtons, { emailId: 9, done: [], resultLine: "No results yet.", practiceCopy: true })),
    ).toContain("In the practice copy this changes the person too, like a real event.");
  });
});
