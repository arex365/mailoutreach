import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { checklistTitle } from "@/core/dns/checklist";
import { REPLY_TEST_TEAM_TEXTS, REPLY_TEST_TEXTS } from "@/core/reply-test";
import { GO_LIVE_COPY } from "@/core/sending/go-live-copy";
import type { ChecklistRow } from "@/core/system-state";
import type { ReplyTestView } from "@/components/settings/types";
import type { GoLiveView } from "@/server/services/go-live";
import { phoneWidthProblems } from "../shell/truncate-chain";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
  usePathname: () => "/settings/domain",
}));
vi.mock("@/app/(app)/settings/domain/actions", () => ({
  applyRecommendedSettingsAction: vi.fn(),
  checkDomainAgainAction: vi.fn(),
  sendReplyTestAction: vi.fn(),
  saveReplyTestAnswersAction: vi.fn(),
  saveReplyTestOriginalAction: vi.fn(),
  decideReplyTestAction: vi.fn(),
  switchUnsubscribeSetupAction: vi.fn(),
  saveDomainAgeAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/sending/actions", () => ({ goLiveAction: vi.fn() }));

const { Checklist, noReplyRoutesText } = await import("@/components/settings/domain/checklist");
const { ReplyTestSection } = await import("@/components/settings/domain/reply-test-section");
const { GoLiveCard } = await import("@/components/settings/sending/go-live-card");
const { DialogTick } = await import("@/components/settings/sending/go-live-dialog");
const { goLiveCardView } = await import("@/components/settings/sending/go-live-view");

/**
 * Static markup of the Domain checklist page's shared-From parts (SHARED-FROM-DESIGN §3.2–§3.4, §9.1): a red from-mx
 * row with its fix (the fake-mode lookup can't show one), the reply-routes and domain-age words, the reply test section
 * with its four questions per mailbox in order, the pasted original's part and lines, the mailto note, the warnings and
 * the shared-From failure sentence; and the go-live card with the from-mx blocker and the spam-placement tick.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) =>
  markup
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

const D = "send.example.com";
const FROM = "contact@example.com";

function row(r: Partial<ChecklistRow> & Pick<ChecklistRow, "key" | "status" | "title">): ChecklistRow {
  return { group: "dns", text: "", fix: null, records: [], detail: null, ...r };
}

describe("the Domain checklist's shared-From rows", () => {
  it("a red from-mx row shows its title with the From domain, its text and its fix, with no record box", () => {
    const title = checklistTitle("from-mx", "example.com");
    expect(title).toBe("Mail for example.com stays with your mail provider (MX)");
    const rows = [
      row({ key: "dmarc", status: "ok", title: "Mail servers know your policy (DMARC)" }),
      row({
        key: "from-mx",
        status: "bad",
        title,
        text: "example.com's mail servers (MX) point to Mailgun. Email to contact@example.com would go to Mailgun instead of your inbox, and replies the app forwards there would be lost. Live campaign emails wait until this is fixed.",
        fix: "In the DNS panel for example.com, delete the MX records of example.com (Name @) that point to Mailgun, and keep only mx.zoho.example. Never add Mailgun's MX records to example.com. Then click Check again.",
        detail: "1.1.1.1: 10 mxa.mailgun.org · 8.8.8.8: 10 mxa.mailgun.org",
      }),
      row({ key: "from-spf", status: "info", title: checklistTitle("from-spf", "example.com"), text: "example.com's SPF record is almost full (9 of 10 DNS lookups)." }),
    ];
    const out = html(createElement(Checklist, { rows, senders: [], domain: D, domainRegisteredOn: null, ageDomain: "example.com", teamFrom: true }));
    const t = text(out);
    expect(out).toContain('data-row="from-mx"');
    expect(t).toContain("Mail for example.com stays with your mail provider (MX)");
    expect(t).toContain("Not done");
    expect(t).toContain("point to Mailgun. Email to contact@example.com would go to Mailgun instead of your inbox");
    expect(t).toContain("delete the MX records of example.com (Name @) that point to Mailgun, and keep only mx.zoho.example.");
    expect(t).toContain("example.com's SPF record (your everyday email)");
    expect(t).toContain("For your information");
    expect(t).not.toContain("Mail for send.example.com");
    // No record box: nothing copyable asks for an MX record.
    expect(out).not.toContain("MX record value");
    // The from-* rows come right after DMARC, in the DNS records card.
    expect(out.indexOf('data-row="dmarc"')).toBeLessThan(out.indexOf('data-row="from-mx"'));
    expect(out.indexOf('data-row="from-mx"')).toBeLessThan(out.indexOf('data-row="from-spf"'));
    // Domain age asks about the From domain; the empty routes sentence says "reply address".
    expect(t).toContain("When did you buy example.com?");
    expect(t).toContain("Nobody has a reply address yet. Everyone adds theirs in Settings › My profile › Reply address.");
  });

  it("per-person words are unchanged", () => {
    expect(noReplyRoutesText(false)).toBe("Nobody has a sending address yet. Everyone adds theirs in Settings › My profile › Sending address.");
    const t = text(html(createElement(Checklist, { rows: [], senders: [], domain: D, domainRegisteredOn: null })));
    expect(t).toContain("When did you buy send.example.com?");
    expect(t).toContain(noReplyRoutesText(false));
  });
});

const teamView: ReplyTestView = {
  domain: D,
  setup: "A",
  decided: null,
  blockers: [],
  testList: ["t.outlook@outlook.com", "t.gmail@gmail.com"],
  mailboxes: [
    {
      address: "t.outlook@outlook.com",
      providerLabel: "Outlook.com",
      testEmail: "Delivered",
      delivered: true,
      replyStored: true,
      inboxOk: true,
      authOk: "pass",
      authFromHeaders: false,
      placementOk: false,
      dmarcOk: "unsure",
      dmarcFromHeaders: false,
    },
    {
      address: "t.gmail@gmail.com",
      providerLabel: "Gmail",
      testEmail: REPLY_TEST_TEXTS.notSentWithThisFrom,
      delivered: false,
      replyStored: false,
      inboxOk: null,
      authOk: null,
      authFromHeaders: false,
      placementOk: null,
      dmarcOk: null,
      dmarcFromHeaders: false,
    },
  ],
  headersOk: null,
  unsubscribeSeen: false,
  verdict: { status: "incomplete", missing: [REPLY_TEST_TEXTS.originalMissing] },
  ownerAddress: "arslan@send.example.com",
  runningJobId: null,
  teamFrom: FROM,
  original: {
    domain: D,
    from: FROM,
    address: "t.outlook@outlook.com",
    testSendId: 7,
    returnPathDomain: "example.com",
    returnPathOk: false,
    dmarc: "pass",
    dkimSigner: "example.com",
    mailtoDomain: D,
    mailtoOk: true,
    readAt: "2026-09-27T10:00:00Z",
  },
  warnings: ["t.outlook@outlook.com: the test email landed in spam."],
};

describe("the Reply test section in shared-From mode", () => {
  it("the intro, the four questions in order, the Zoho help and the DMARC paste box", () => {
    const out = html(createElement(ReplyTestSection, { view: teamView }));
    const t = text(out);
    expect(t).toContain(
      "Send the test emails: one to each mailbox on your test list, from contact@example.com (replies go to arslan@send.example.com).",
    );
    expect(t).toContain("Not tested yet with the From address contact@example.com. Live campaigns start once this passes.");
    const box = t.slice(t.indexOf("t.outlook@outlook.com"), t.indexOf("t.gmail@gmail.com Provider"));
    const order = [
      REPLY_TEST_TEAM_TEXTS.placementQuestion,
      "Did the reply arrive in your reply inbox, not in spam?",
      "Does it say dkim=pass or arc=pass?",
      REPLY_TEST_TEAM_TEXTS.dmarcQuestion,
    ].map((q) => box.indexOf(q));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(REPLY_TEST_TEAM_TEXTS.placementQuestion).toBe(
      "Did the test email arrive in this mailbox's inbox, not in spam or junk? (Gmail's Promotions or Updates tab counts as the inbox.)",
    );
    expect(box).toContain(REPLY_TEST_TEAM_TEXTS.zohoHelp);
    expect(box).toContain("Paste the test email's original here, and the app reads it for you.");
    expect(box).toContain("Read the headers");
    expect(t).toContain("Not sent yet with this From address");
  });

  it("the pasted original's part, below the mailboxes, with one line per check", () => {
    const out = html(createElement(ReplyTestSection, { view: teamView }));
    const t = text(out);
    expect(t).toContain("The test email's original");
    expect(t).toContain(REPLY_TEST_TEAM_TEXTS.originalText);
    expect(t).toContain("Read the original");
    expect(out.indexOf('data-part="original"')).toBeGreaterThan(out.lastIndexOf("data-mailbox="));
    expect(t).toContain("From: contact@example.com ✓");
    expect(t).toContain(
      "Return address: …@example.com, not on send.example.com: bounces and automatic replies would go to your everyday inbox instead of the app.",
    );
    expect(t).toContain("The original says DMARC: PASS.");
    expect(t).toContain("Signed by example.com ✓");
    expect(t).toContain("Unsubscribe by email: …@send.example.com ✓");
    // The mailto note under the List-Unsubscribe question, and the spam warning in the result.
    expect(t).toContain(
      "If it also shows a mailto: address, the part after the @ must end in send.example.com (for example u+…@send.example.com or …@email.send.example.com). If it is …@example.com, answer No.",
    );
    expect(t).toContain("t.outlook@outlook.com: the test email landed in spam.");
    expect(out.match(/data-variant="default"/g)).toBeNull();
    expect(phoneWidthProblems(out)).toEqual([]);
  });

  it("a failure names the shared-From way back, never a separate reply address", () => {
    const failed = text(
      html(
        createElement(ReplyTestSection, {
          view: { ...teamView, verdict: { status: "failed", missing: [REPLY_TEST_TEXTS.returnPathFailed("example.com", D)] } },
        }),
      ),
    );
    expect(failed).toContain(
      "The reply test didn't pass with the From address contact@example.com. The lines above say which check failed. If it was the return address or DMARC, clear the From address in Settings › Sending & Mailgun (emails then come from each person's own address on send.example.com) and ask the person who set up the app.",
    );
    expect(failed).not.toContain("reply.");
    expect(failed).not.toContain("separate reply address");
  });

  it("per-person mode shows none of it", () => {
    const perPerson: ReplyTestView = {
      ...teamView,
      teamFrom: undefined,
      original: undefined,
      warnings: undefined,
      mailboxes: teamView.mailboxes.map((m) => ({
        address: m.address,
        providerLabel: m.providerLabel,
        testEmail: m.testEmail,
        delivered: m.delivered,
        replyStored: m.replyStored,
        inboxOk: m.inboxOk,
        authOk: m.authOk,
        authFromHeaders: m.authFromHeaders,
      })),
      verdict: { status: "failed", missing: [] },
    };
    const t = text(html(createElement(ReplyTestSection, { view: perPerson })));
    expect(t).not.toContain(REPLY_TEST_TEAM_TEXTS.placementQuestion);
    expect(t).not.toContain("DMARC");
    expect(t).not.toContain("The test email's original");
    expect(t).not.toContain("Zoho");
    expect(t).toContain("Send the test emails: one to each mailbox on your test list, from arslan@send.example.com.");
    expect(t).toContain("For each mailbox, answer the two questions below.");
    expect(t).toContain("Setup A didn't pass. The usual fix is a separate reply address such as ali@reply.send.example.com.");
  });
});

function goLiveView(over: Partial<GoLiveView> = {}): GoLiveView {
  return {
    practiceCopy: false,
    live: false,
    at: null,
    byName: null,
    domain: D,
    endedOnDomain: null,
    blockers: [],
    recommendations: [],
    drafts: { items: [], more: 0 },
    capOverrideToday: null,
    warmupLine: null,
    from: FROM,
    ownFromExample: "Arslan from Polygon Paradise <arslan@send.example.com>",
    spamPlacements: [],
    endedOnFrom: null,
    ...over,
  };
}

describe("the go-live card in shared-From mode", () => {
  const ctx = { timeZone: "Asia/Karachi", warmup: { startCap: 50, maxCap: 1000, steps: 20 } };

  it("the from-mx blocker in the '…: not done yet' form", () => {
    const sentence = `${checklistTitle("from-mx", "example.com")}: not done yet (Domain checklist).`;
    const card = goLiveCardView(goLiveView({ blockers: [sentence] }), ctx);
    const t = text(html(createElement(GoLiveCard, { view: card })));
    expect(t).toContain(`Before going live: ${sentence}`);
    expect(t).toContain("Mail for example.com stays with your mail provider (MX): not done yet (Domain checklist).");
  });

  it("the spam-placement tick: the card view carries it, and the dialog's tick box draws it", () => {
    const card = goLiveCardView(goLiveView({ spamPlacements: ["Outlook.com (tess@outlook.com)"] }), ctx);
    expect(card.spamPlacementTick).toBe(GO_LIVE_COPY.spamPlacementTick("Outlook.com (tess@outlook.com)"));
    const out = html(createElement(DialogTick, { id: "spam", label: card.spamPlacementTick!, checked: false, onChange: () => undefined }));
    expect(out).toContain('role="checkbox"');
    expect(out).toContain('aria-checked="false"');
    expect(text(out)).toContain(
      "I know the reply test's email landed in spam at Outlook.com (tess@outlook.com). Go live anyway: fewer people there may see our emails at first.",
    );
    expect(GO_LIVE_COPY.spamPlacementRequired).toBe("Tick the box about the spam folder first.");
  });
});
