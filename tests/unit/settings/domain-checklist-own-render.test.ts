import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { checklistTitle } from "@/core/dns/checklist";
import { REPLY_TEST_TEAM_TEXTS, REPLY_TEST_TEXTS } from "@/core/reply-test";
import { NEVER_MAILGUN_MX_TEXT, OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS } from "@/core/sending/own-mailbox";
import type { ChecklistRow } from "@/core/system-state";
import type { ReplyTestView } from "@/components/settings/types";
import { phoneWidthProblems } from "../shell/truncate-chain";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("server-only", () => ({}));
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
  setLeaveOutMailtoAction: vi.fn(),
  saveDomainAgeAction: vi.fn(),
}));

const { Checklist } = await import("@/components/settings/domain/checklist");
const { ReplyTestSection } = await import("@/components/settings/domain/reply-test-section");
const { APPLY_HINT, applyHintFor, checklistRowsShown } = await import("@/app/(app)/settings/domain/load");

/**
 * Static markup of the Domain checklist page in own-mailbox mode (MAIN-DOMAIN-DESIGN §3.3, §3.5, §8 P4): a red
 * own-mailbox from-mx row with its fix and no record box (the fake-mode lookup can't show one); the from-mx row shown
 * with no From saved (the page's from-* filter is app mode's only) and still hidden in per-person mode; the own-mailbox
 * Apply hint; the page without the reply-routes placeholder; and the by-hand reply test section (question order, no
 * dkim/arc question, the unsubscribe-by-email question with the address, no Setup switch, the logs note, "The reply test
 * passed" never "Setup A passed").
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

const D = "example.com";
const FROM = "contact@example.com";
const MAILTO = "u+x@example.com";

function row(r: Partial<ChecklistRow> & Pick<ChecklistRow, "key" | "status" | "title">): ChecklistRow {
  return { group: "dns", text: "", fix: null, records: [], detail: null, ...r };
}

const ZOHO = [
  { priority: 10, host: "mx.zoho.com" },
  { priority: 20, host: "mx2.zoho.com" },
  { priority: 50, host: "mx3.zoho.com" },
];

function redFromMx(): ChecklistRow {
  return row({
    key: "from-mx",
    status: "bad",
    title: checklistTitle("from-mx", D),
    text: `${D}'s mail servers (MX) point to Mailgun. Your everyday email and every reply to your campaigns would go to Mailgun, where nobody reads them. Live campaign emails wait until this is fixed.`,
    fix: `In the DNS panel for ${D} (GoDaddy), delete the MX records of ${D} (Name @) that point to Mailgun, and ${OWN_MAILBOX_TEXTS.putBackMx(ZOHO)}. ${NEVER_MAILGUN_MX_TEXT(D)} Then click Check again.`,
    detail: "1.1.1.1: 10 mxa.mailgun.org · 8.8.8.8: 10 mxa.mailgun.org",
    // A stored oddity: the page never draws an MX record box in own-mailbox mode, whatever a row carries.
    records: [{ type: "MX", name: "@", fqdn: D, value: "mxa.mailgun.org", priority: "10", found: [] }],
  });
}

function ownRows(): ChecklistRow[] {
  return [
    row({ key: "mailgun-domain", group: "mailgun", status: "ok", title: "Mailgun knows your domain" }),
    row({ key: "spf", status: "ok", title: checklistTitle("spf", D) }),
    row({ key: "dmarc", status: "ok", title: "Mail servers know your policy (DMARC)" }),
    redFromMx(),
    row({ key: "webhooks", group: "settings", status: "info", title: "Mailgun tells the app what happened" }),
    row({ key: "reply-test", group: "connection", status: "warn", title: "Reply test" }),
  ];
}

describe("the Domain checklist's rows in own-mailbox mode", () => {
  it("a red from-mx row: its title with the domain, its text and fix naming the last good MX, and no record box", () => {
    expect(checklistTitle("from-mx", D)).toBe("Mail for example.com stays with your mail provider (MX)");
    const out = html(createElement(Checklist, { rows: ownRows(), senders: [], domain: D, domainRegisteredOn: null, ownMailbox: true }));
    const t = text(out);
    expect(out).toContain('data-row="from-mx"');
    expect(t).toContain("Mail for example.com stays with your mail provider (MX)");
    expect(t).toContain("Not done");
    expect(t).toContain("example.com's mail servers (MX) point to Mailgun.");
    expect(t).toContain(
      "put back your mail provider's MX records: mx.zoho.com (priority 10), mx2.zoho.com (priority 20), mx3.zoho.com (priority 50).",
    );
    expect(t).toContain("Never add Mailgun's MX records (mxa.mailgun.org, mxb.mailgun.org) to example.com. Then click Check again.");
    // No record box: nothing copyable asks for an MX record.
    expect(out).not.toContain("MX record value");
    expect(out).not.toContain("MX record name");
    expect(out.indexOf('data-row="dmarc"')).toBeLessThan(out.indexOf('data-row="from-mx"'));
  });

  it("no reply routes: no 'Replies reach each sender' placeholder and no routes list", () => {
    const t = text(html(createElement(Checklist, { rows: ownRows(), senders: [], domain: D, domainRegisteredOn: null, ownMailbox: true })));
    expect(t).not.toContain("Replies reach each sender");
    expect(t).not.toContain("Nobody has a");
    // A reply-routes row somehow stored for this mode isn't drawn either.
    const withRoutes = [...ownRows(), row({ key: "reply-routes", group: "settings", status: "bad", title: "Replies reach each sender" })];
    const t2 = text(html(createElement(Checklist, { rows: withRoutes, senders: [], domain: D, domainRegisteredOn: null, ownMailbox: true })));
    expect(t2).not.toContain("Replies reach each sender");
    // App mode keeps today's placeholder and its record boxes.
    const app = html(createElement(Checklist, { rows: [redFromMx()], senders: [], domain: "send.example.com", domainRegisteredOn: null }));
    expect(text(app)).toContain("Replies reach each sender");
    expect(app).toContain("MX record value");
  });

  it("the domain-age form asks about the sending domain itself", () => {
    const t = text(html(createElement(Checklist, { rows: ownRows(), senders: [], domain: D, domainRegisteredOn: null, ownMailbox: true })));
    expect(t).toContain("When did you buy example.com?");
  });

  it("the page's from-* filter is app mode's only: own-mailbox shows from-mx with no From saved; per-person hides it", () => {
    const rows = ownRows();
    expect(checklistRowsShown(rows, { ownMailbox: true, fromSaved: false }).some((r) => r.key === "from-mx")).toBe(true);
    expect(checklistRowsShown(rows, { ownMailbox: false, fromSaved: false }).some((r) => r.key === "from-mx")).toBe(false);
    expect(checklistRowsShown(rows, { ownMailbox: false, fromSaved: true })).toBe(rows);
    const shown = html(
      createElement(Checklist, { rows: checklistRowsShown(rows, { ownMailbox: true, fromSaved: false }), senders: [], domain: D, domainRegisteredOn: null, ownMailbox: true }),
    );
    expect(shown).toContain('data-row="from-mx"');
  });

  it("the Apply hint: own-mailbox mode's never mentions reply routes; app mode's is today's", () => {
    expect(applyHintFor(true)).toBe(OWN_MAILBOX_TEXTS.applyHint);
    expect(applyHintFor(true)).toBe(
      "Switches off open and click tracking, switches on Mailgun's unsubscribe handling with blank footers and asks Mailgun for secure unsubscribe links. With remote access it also sets the webhooks. It changes nothing about receiving mail: mail for polygonparadise.com stays with your mail provider.",
    );
    expect(applyHintFor(true)).not.toContain("reply routes");
    expect(applyHintFor(false)).toBe(APPLY_HINT);
    expect(APPLY_HINT).toBe(
      "Switches off open and click tracking, switches on Mailgun's unsubscribe handling with blank footers, marks spam instead of deleting it, keeps stored replies for your plan's time, sets up secure unsubscribe links, the webhooks and the reply routes.",
    );
  });
});

const ownView: ReplyTestView = {
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
      replyStored: false,
      inboxOk: true,
      authOk: null,
      authFromHeaders: false,
      placementOk: false,
      dmarcOk: "unsure",
      dmarcFromHeaders: false,
    },
    {
      address: "t.gmail@gmail.com",
      providerLabel: "Gmail",
      testEmail: "Sent, waiting for delivery",
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
  headersOk: true,
  unsubscribeSeen: false,
  verdict: { status: "incomplete", missing: [OWN_REPLY_TEST_TEXTS.mailtoUnanswered] },
  ownerAddress: null,
  runningJobId: null,
  ownFrom: FROM,
  roundSince: "2026-09-28T08:00:00.000Z",
  original: {
    domain: D,
    from: FROM,
    address: "t.outlook@outlook.com",
    testSendId: 7,
    returnPathDomain: D,
    returnPathOk: true,
    dmarc: "pass",
    dkimSigner: D,
    mailtoDomain: D,
    mailtoOk: true,
    readAt: "2026-09-28T09:00:00Z",
    unsubscribeScheme: "http",
    mailtoAddress: MAILTO,
  },
  warnings: ["t.outlook@outlook.com: the test email landed in spam."],
  mailtoAddress: MAILTO,
  mailtoArrived: null,
};

describe("the Reply test section in own-mailbox mode (by hand)", () => {
  it("the intro, the logs note, the three questions in order per mailbox; no dkim question, no 'Reply reached the app'", () => {
    const out = html(createElement(ReplyTestSection, { view: ownView }));
    const t = text(out);
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.intro(FROM));
    expect(t).toContain(
      "Send the test emails: one to each mailbox on your test list, from contact@example.com. Replies come straight to contact@example.com, not to the app.",
    );
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.logsNote);
    expect(t).toContain("Not tested yet with the From address contact@example.com. Live campaigns start once this passes.");
    const box = t.slice(t.indexOf("t.outlook@outlook.com"), t.indexOf("t.gmail@gmail.com Provider"));
    const order = [REPLY_TEST_TEAM_TEXTS.placementQuestion, OWN_REPLY_TEST_TEXTS.replyQuestion(FROM), REPLY_TEST_TEAM_TEXTS.dmarcQuestion].map((q) =>
      box.indexOf(q),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(OWN_REPLY_TEST_TEXTS.replyQuestion(FROM)).toBe(
      "Reply to the test email from this mailbox. Did your reply arrive in contact@example.com? Look in its Spam folder too.",
    );
    // DMARC "Not sure" opens its paste box.
    expect(box).toContain(REPLY_TEST_TEAM_TEXTS.dmarcPasteLabel);
    expect(t).not.toContain("dkim=pass or arc=pass");
    expect(t).not.toContain("Reply reached the app");
    expect(t).not.toContain("Did the reply arrive in your reply inbox");
    expect(t).not.toContain(REPLY_TEST_TEAM_TEXTS.zohoHelp);
    expect(t).not.toMatch(/reply address|sending address/i);
  });

  it("the pasted original's own lines, the mailto note and the unsubscribe-by-email question with a copy button", () => {
    const out = html(createElement(ReplyTestSection, { view: ownView }));
    const t = text(out);
    expect(t).toContain("From: contact@example.com ✓");
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.returnPathOwn(D));
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.linkHttp);
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.mailtoOwn(MAILTO));
    expect(t).not.toContain("(bounces and automatic replies reach the app)");
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.mailtoNote);
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.mailtoQuestion(MAILTO, FROM));
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.mailtoAfter);
    expect(out).toContain('data-part="mailto"');
    expect(out).toContain('aria-label="Copy unsubscribe-by-email address"');
    expect(out).toContain(`>${MAILTO}</textarea>`);
    // Below the List-Unsubscribe question, and after the original's part.
    expect(t.indexOf(OWN_REPLY_TEST_TEXTS.headersQuestion)).toBeGreaterThan(-1);
    expect(t.indexOf(OWN_REPLY_TEST_TEXTS.mailtoQuestion(MAILTO, FROM))).toBeGreaterThan(t.indexOf(OWN_REPLY_TEST_TEXTS.headersQuestion));
    expect(out.indexOf('data-part="mailto"')).toBeGreaterThan(out.indexOf('data-part="original"'));
    expect(t).toContain("t.outlook@outlook.com: the test email landed in spam.");
    expect(out.match(/data-variant="default"/g)).toBeNull();
    expect(phoneWidthProblems(out)).toEqual([]);
  });

  it("no mailto: in the original → no unsubscribe-by-email question", () => {
    const t = text(
      html(createElement(ReplyTestSection, { view: { ...ownView, mailtoAddress: null, original: { ...ownView.original!, mailtoAddress: null, mailtoDomain: null } } })),
    );
    expect(t).not.toContain("From one of your test mailboxes, send an email to");
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.mailtoNone);
    expect(t).not.toContain(OWN_REPLY_TEST_TEXTS.leaveOutButton);
  });

  it("review SECURITY-03: a mailto: whose address can't be read shows a failed line, never 'not offered', and offers the last resort", () => {
    const out = html(
      createElement(ReplyTestSection, {
        view: {
          ...ownView,
          mailtoAddress: null,
          original: { ...ownView.original!, mailtoAddress: null, mailtoUnreadable: true },
          verdict: { status: "failed", missing: [OWN_REPLY_TEST_TEXTS.mailtoUnreadable] },
        },
      }),
    );
    const t = text(out);
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.mailtoUnreadableLine);
    expect(t).not.toContain(OWN_REPLY_TEST_TEXTS.mailtoNone);
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.mailtoUnreadable);
    expect(out).toContain('data-part="leave-out"');
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.leaveOutButton);
  });

  it("review SCREENS-04: the List-Unsubscribe question asks for a link (http on Free) and says Post needs Foundation; app mode keeps its question", () => {
    const t = text(html(createElement(ReplyTestSection, { view: ownView })));
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.headersQuestion);
    expect(OWN_REPLY_TEST_TEXTS.headersQuestion).toBe(
      "In one test mailbox, open the test email's original. Do you see a List-Unsubscribe: line with a link (http:// or https://)?",
    );
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.headersNote);
    expect(OWN_REPLY_TEST_TEXTS.headersNote).toContain("need Mailgun's Foundation plan");
    expect(t).not.toContain("Do you see List-Unsubscribe: <https://…> and List-Unsubscribe-Post?");
    const app: ReplyTestView = { ...ownView, ownFrom: undefined, mailtoAddress: undefined, mailtoArrived: undefined, original: undefined, warnings: undefined, roundSince: undefined };
    const a = text(html(createElement(ReplyTestSection, { view: app })));
    expect(a).toContain("Do you see List-Unsubscribe: <https://…> and List-Unsubscribe-Post?");
    expect(a).not.toContain(OWN_REPLY_TEST_TEXTS.headersNote);
  });

  it("review REPLIES-01: an address on the From's domain is proved only by a mailbox you read, never by Settings › Deliverability", () => {
    expect(OWN_REPLY_TEST_TEXTS.mailtoQuestion(MAILTO, FROM)).toBe(
      "From one of your test mailboxes, send an email to u+x@example.com (any subject and text). Within the hour, did it arrive in contact@example.com or another mailbox you read? Look in Spam too.",
    );
    expect(OWN_REPLY_TEST_TEXTS.mailtoQuestion(MAILTO, FROM)).not.toContain("Deliverability");
    const t = text(html(createElement(ReplyTestSection, { view: ownView })));
    const box = t.slice(t.indexOf(OWN_REPLY_TEST_TEXTS.mailtoQuestion(MAILTO, FROM)));
    expect(box).toContain(OWN_REPLY_TEST_TEXTS.mailtoAfter);
    expect(box).not.toContain(OWN_REPLY_TEST_TEXTS.mailtoAfterElsewhere);
    // Another domain (for example Mailgun's tracking host) keeps the list as a proof, from the mailbox whose link wasn't clicked.
    const elsewhere = "u+x@email.example.com";
    expect(OWN_REPLY_TEST_TEXTS.mailtoQuestion(elsewhere, FROM)).toContain("whose unsubscribe link you didn't click");
    const e = text(
      html(createElement(ReplyTestSection, { view: { ...ownView, mailtoAddress: elsewhere, original: { ...ownView.original!, mailtoAddress: elsewhere } } })),
    );
    expect(e).toContain(OWN_REPLY_TEST_TEXTS.mailtoQuestion(elsewhere, FROM));
    expect(e).toContain(OWN_REPLY_TEST_TEXTS.mailtoAfterElsewhere);
  });

  it("review REPLIES-03: after a No, the last resort is offered; while it's on, the note and 'Offer unsubscribe by email again' show", () => {
    const before = html(createElement(ReplyTestSection, { view: ownView }));
    expect(before).not.toContain('data-part="leave-out"');
    const no = html(
      createElement(ReplyTestSection, {
        view: { ...ownView, mailtoArrived: false, verdict: { status: "failed", missing: [OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM)] } },
      }),
    );
    const tNo = text(no);
    expect(no).toContain('data-part="leave-out"');
    expect(tNo).toContain(OWN_REPLY_TEST_TEXTS.leaveOutOffer);
    expect(tNo).toContain(OWN_REPLY_TEST_TEXTS.leaveOutButton);
    expect(no.indexOf('data-part="leave-out"')).toBeGreaterThan(no.indexOf('data-part="mailto"'));
    // Below the failure line that says "click Leave out unsubscribe by email below".
    expect(OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM)).toContain(`click ${OWN_REPLY_TEST_TEXTS.leaveOutButton} below`);
    expect(tNo.indexOf(OWN_REPLY_TEST_TEXTS.leaveOutOffer)).toBeGreaterThan(tNo.indexOf(OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM)));
    // Only outline buttons: the dialogs hold the one primary action.
    expect(no.match(/data-variant="default"/g)).toBeNull();

    const on = html(
      createElement(ReplyTestSection, {
        view: {
          ...ownView,
          original: null,
          mailtoAddress: null,
          mailtoArrived: null,
          headersOk: null,
          warnings: ["t.outlook@outlook.com: the test email landed in spam.", OWN_REPLY_TEST_TEXTS.leftOutNote],
          verdict: { status: "incomplete", missing: [OWN_REPLY_TEST_TEXTS.leftOutSendAgain] },
        },
      }),
    );
    const tOn = text(on);
    expect(on).toContain('data-part="left-out"');
    expect(on).not.toContain('data-part="leave-out"');
    expect(tOn).toContain(OWN_REPLY_TEST_TEXTS.offerAgainButton);
    expect(tOn).toContain(OWN_REPLY_TEST_TEXTS.leftOutSendAgain);
    // The note isn't a spam placement, and the mailto note isn't shown while unsubscribe by email is left out.
    const spam = on.slice(on.indexOf('aria-label="Spam placements"'));
    expect(spam).not.toContain(OWN_REPLY_TEST_TEXTS.leftOutNote);
    expect(tOn).not.toContain(OWN_REPLY_TEST_TEXTS.mailtoNote);
    expect(tOn.split(OWN_REPLY_TEST_TEXTS.leftOutNote)).toHaveLength(2);
    expect(phoneWidthProblems(on)).toEqual([]);

    // The loader's explicit `mailtoLeftOut` (the saved choice) decides, whatever the verdict's warnings say: on with a
    // stale original that still shows a mailto: (no question, the box to offer it again), off with a stray note.
    const saved = text(
      html(
        createElement(ReplyTestSection, {
          view: { ...ownView, mailtoLeftOut: true, warnings: [], verdict: { status: "failed", missing: [OWN_REPLY_TEST_TEXTS.leftOutMailtoStill] } },
        }),
      ),
    );
    expect(saved).toContain(OWN_REPLY_TEST_TEXTS.offerAgainButton);
    expect(saved).not.toContain(OWN_REPLY_TEST_TEXTS.mailtoQuestion(MAILTO, FROM));
    const off = html(createElement(ReplyTestSection, { view: { ...ownView, mailtoLeftOut: false, warnings: [OWN_REPLY_TEST_TEXTS.leftOutNote] } }));
    expect(off).not.toContain('data-part="left-out"');
    expect(text(off)).toContain(OWN_REPLY_TEST_TEXTS.mailtoQuestion(MAILTO, FROM));
  });

  it("no Setup switch and no Setup words; Back to normal only while a restored setup isn't A", () => {
    const t = text(html(createElement(ReplyTestSection, { view: ownView })));
    expect(t).not.toContain("Try Setup B");
    expect(t).not.toContain("Back to Setup A");
    expect(t).not.toContain("Setup A:");
    expect(t).not.toContain(OWN_MAILBOX_TEXTS.backToNormal);
    const restored = text(html(createElement(ReplyTestSection, { view: { ...ownView, setup: "B" } })));
    expect(restored).toContain("Back to normal");
    expect(restored).not.toContain("Try Setup B");
    expect(restored).not.toContain("Setup B (check only)");
  });

  it("a passed decision reads 'The reply test passed…', never 'Setup A passed'; a failure names the own From", () => {
    const passed = OWN_REPLY_TEST_TEXTS.passedRow(" on 28 Sep", FROM);
    expect(passed).toBe(
      "The reply test passed on 28 Sep with the From address contact@example.com: test emails arrived, your replies reached contact@example.com, unsubscribing works, and the test email passed DMARC.",
    );
    const t = text(html(createElement(ReplyTestSection, { view: { ...ownView, decided: { status: "passed", text: passed }, verdict: { status: "passed", missing: [] } } })));
    expect(t).toContain(passed);
    expect(t).not.toContain("Setup A passed");
    const failed = text(
      html(
        createElement(ReplyTestSection, {
          view: { ...ownView, verdict: { status: "failed", missing: [OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM)] } },
        }),
      ),
    );
    expect(failed).toContain(OWN_REPLY_TEST_TEXTS.sectionFailed(FROM));
    expect(failed).toContain(OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM));
    expect(failed).not.toContain("separate reply address");
    expect(failed).not.toContain("try Setup B");
  });

  it("with no own From yet: the 'type your From address first' line", () => {
    const t = text(html(createElement(ReplyTestSection, { view: { ...ownView, ownFrom: null, original: null, mailtoAddress: null } })));
    expect(t).toContain(OWN_REPLY_TEST_TEXTS.noFromRow);
  });

  it("app mode (no ownFrom) keeps today's section", () => {
    const app: ReplyTestView = { ...ownView, ownFrom: undefined, mailtoAddress: undefined, mailtoArrived: undefined, original: undefined, warnings: undefined, roundSince: undefined };
    const t = text(html(createElement(ReplyTestSection, { view: app })));
    expect(t).toContain("dkim=pass or arc=pass");
    expect(t).toContain("Reply reached the app");
    expect(t).toContain("Try Setup B (check only)");
    expect(t).not.toContain(OWN_REPLY_TEST_TEXTS.logsNote);
    expect(t).not.toContain("From one of your test mailboxes");
    expect(REPLY_TEST_TEXTS.headersUnanswered).toBe("Answer the question about the List-Unsubscribe headers.");
  });
});
