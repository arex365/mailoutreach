import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { phoneWidthProblems } from "../shell/truncate-chain";

/**
 * "Today's inbox check" (MAIN-DOMAIN-DESIGN O33, §3.9, §8 P6), static markup: the card's texts, the button with the own
 * mailbox, the companies and "and {n} more", "Nobody has read it today." and the last-read line, the primary button
 * until today's check and outline afterwards, phone width; and the replies list's own-mailbox empty text.
 */

// The Server Action modules can't load outside Next (server-only); nothing here calls them.
vi.mock("@/components/replies/inbox-check-actions", () => ({ markInboxCheckedAction: vi.fn() }));
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/notifications",
}));

const { InboxCheckCard, inboxCheckLastLine } = await import("@/components/replies/inbox-check-card");
const { RepliesSection } = await import("@/components/replies/replies-section");
const { INBOX_CHECK_TEXTS, OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const NOW = "2026-09-28T10:30:00.000Z"; // 12:30 in Berlin
const TZ = "Europe/Berlin";

type Props = Parameters<typeof InboxCheckCard>[0];

function card(overrides: Partial<Props> = {}): string {
  return html(
    createElement(InboxCheckCard, {
      from: "contact@example.com",
      checkedToday: false,
      lastAtIso: null,
      byName: null,
      timeZone: TZ,
      nowIso: NOW,
      waiting: [
        { companyId: 3, companyName: "Acme Studio", count: 2 },
        { companyId: 9, companyName: "Beta Prints", count: 1 },
      ],
      more: 0,
      ...overrides,
    }),
  );
}

describe("the inbox check card", () => {
  it("shows the title, what to do, the companies with their follow-ups and the button with the own mailbox", () => {
    const out = card();
    expect(out).toContain('id="inbox-check"');
    expect(out).toContain("scroll-mt-4");
    expect(out).toContain("Today's inbox check");
    expect(out).toContain(
      // Review REPLIES-05: removal requests, unsubscribe emails and bounce notices need Mark unsubscribed, not They replied.
      `Replies to your campaigns come only to contact@example.com. Before live follow-ups go, read its inbox and its Spam folder. For every answer, open the company and click They replied (search Contacts for the address it came from). A removal request, an email to the unsubscribe address or a "couldn't be delivered" notice isn't an answer: open the company and click ⋯ › Mark unsubscribed on that person instead. Then click the button below: live follow-ups wait for it each day.`,
    );
    expect(out).toContain("Follow-ups due in the next 24 hours:");
    expect(out).toContain('href="/contacts?company=3"');
    expect(out).toContain(">Acme Studio</a>");
    expect(out).toContain("2 follow-ups");
    expect(out).toContain('href="/contacts?company=9"');
    expect(out).toContain("1 follow-up");
    expect(out).not.toContain("more</li>");
    expect(out).toContain("I've read contact@example.com");
    expect(INBOX_CHECK_TEXTS.button("contact@example.com")).toBe("I've read contact@example.com");
  });

  it("before today's check: \"Nobody has read it today.\" and the primary button", () => {
    const out = card();
    expect(out).toContain("Nobody has read it today.");
    expect(out).toMatch(/data-variant="default"[^>]*>I've read contact@example.com/);
  });

  it("with an older check: says nobody read it today and when it was last read", () => {
    const out = card({ lastAtIso: "2026-09-26T14:40:00.000Z", byName: "Arslan" });
    expect(out).toContain("Nobody has read it today. Last read on 26 Sept at 16:40 by Arslan.");
  });

  it("after today's check: the last-read line and an outline button", () => {
    const out = card({ checkedToday: true, lastAtIso: "2026-09-28T07:12:00.000Z", byName: "Arslan" });
    expect(out).toContain("Last read today at 09:12 by Arslan.");
    expect(out).not.toContain("Nobody has read it today.");
    expect(out).toMatch(/data-variant="outline"[^>]*>I've read contact@example.com/);
  });

  it("lists at most what it is given and says how many more companies wait", () => {
    const out = card({ more: 2 });
    expect(out).toContain("and 2 more");
  });

  it("without follow-ups due, the list is left out", () => {
    const out = card({ waiting: [] });
    expect(out).not.toContain("Follow-ups due in the next 24 hours:");
    expect(out).toContain("I've read contact@example.com");
  });

  it("fits a phone: long names and addresses wrap instead of pushing the page wider", () => {
    const out = card({
      from: "a-very-long-mailbox-name-for-the-team@a-rather-long-domain-name.example",
      waiting: [{ companyId: 1, companyName: "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa GmbH", count: 1 }],
    });
    expect(phoneWidthProblems(out)).toEqual([]);
    expect(out).toContain("grid-cols-1");
    expect(out).toContain("[overflow-wrap:anywhere]");
  });
});

describe("the last-read line", () => {
  const now = new Date(NOW);

  it("nobody has checked yet", () => {
    expect(inboxCheckLastLine({ checkedToday: false, lastAt: null, byName: null }, TZ, now)).toBe("Nobody has read it today.");
  });

  it("today's check, in the viewer's zone", () => {
    expect(inboxCheckLastLine({ checkedToday: true, lastAt: new Date("2026-09-28T07:12:00.000Z"), byName: "Ali" }, TZ, now)).toBe(
      "Last read today at 09:12 by Ali.",
    );
    expect(
      inboxCheckLastLine({ checkedToday: true, lastAt: new Date("2026-09-28T07:12:00.000Z"), byName: "Ali" }, "Asia/Karachi", now),
    ).toBe("Last read today at 12:12 by Ali.");
  });

  it("an older check", () => {
    expect(inboxCheckLastLine({ checkedToday: false, lastAt: new Date("2026-09-26T14:40:00.000Z"), byName: "Arslan" }, TZ, now)).toBe(
      "Nobody has read it today. Last read on 26 Sept at 16:40 by Arslan.",
    );
  });
});

describe("the replies list's empty state", () => {
  const base = { rows: [], total: 0, mine: 0, everyone: 0, page: 1, pageCount: 1, hrefFor: () => "/notifications" };

  it("own-mailbox mode says where replies go", () => {
    const out = html(createElement(RepliesSection, { ...base, scope: "everyone", ownFrom: "contact@example.com" }));
    expect(out).toContain(OWN_MAILBOX_TEXTS.repliesEmpty("contact@example.com"));
    expect(out).toContain("Replies go straight to contact@example.com, not to the app. When someone answers, click They replied on their company.");
    expect(out).not.toContain("Nobody's replies are waiting for an answer.");
  });

  it("app mode is unchanged", () => {
    expect(html(createElement(RepliesSection, { ...base, scope: "everyone" }))).toContain("Nobody's replies are waiting for an answer.");
    expect(html(createElement(RepliesSection, { ...base, scope: "mine" }))).toContain("No replies are waiting for an answer.");
    expect(html(createElement(RepliesSection, { ...base, scope: "mine", ownFrom: null }))).not.toContain("Replies go straight to");
  });
});
