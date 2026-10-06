import { describe, expect, it } from "vitest";
import {
  evaluateReplyTest,
  mergeReplyTestAnswers,
  providerOf,
  REPLY_TEST_TEXTS,
  replyTestAnswersKey,
  replyTestPassedFor,
  type MailboxFacts,
} from "@/core/reply-test";
import { OWN_REPLY_TEST_TEXTS } from "@/core/sending/own-mailbox";
import { DEFAULT_UNSUBSCRIBE_TEST, type ReplyTestMailbox, type ReplyTestOriginal, type UnsubscribeTestSetting } from "@/core/setting-types";

/**
 * The reply test by hand in own-mailbox mode (MAIN-DOMAIN-DESIGN O13, §3.5, §8 P4): the app can't see replies, so each
 * mailbox answers placement, "did your reply arrive in contact@…" and DMARC; one pasted original proves the return
 * address, DMARC and the List-Unsubscribe header; when it shows a `mailto:`, the Owner says whether an email to it
 * reached a mailbox someone reads. A pass belongs to its mode. Per-person and shared-From verdicts are unchanged.
 */

const D = "example.com";
const FROM = "contact@example.com";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const OTHER = "t@company.de";
const MAILTO = "u+x@example.com";
const OWN = { teamFrom: FROM, sendingDomain: D, ownMailbox: true } as const;

/** Sent and delivered; the app never sees the reply in this mode (replyStored stays false). */
const done: MailboxFacts = { testSendId: 1, sentAt: new Date("2026-09-27T10:00:00Z"), delivered: true, replyStored: false };

function answer(address: string, a: Partial<ReplyTestMailbox> = {}): ReplyTestMailbox {
  return { address, provider: providerOf(address), inboxOk: true, authOk: null, authFromHeaders: false, placementOk: true, dmarcOk: "pass", ...a };
}

function original(o: Partial<ReplyTestOriginal> = {}): ReplyTestOriginal {
  return {
    domain: D,
    from: FROM,
    address: GMAIL,
    testSendId: 1,
    returnPathDomain: D,
    returnPathOk: true,
    dmarc: "pass",
    dkimSigner: D,
    mailtoDomain: D,
    mailtoOk: true,
    readAt: "2026-09-27T10:05:00Z",
    unsubscribeScheme: "http",
    mailtoAddress: MAILTO,
    ...o,
  };
}

function setting(mailboxes: ReplyTestMailbox[], over: Partial<UnsubscribeTestSetting> = {}): UnsubscribeTestSetting {
  return { ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes, headersOk: true, original: original(), mailtoArrived: true, ...over };
}

function facts(entries: Array<[string, Partial<MailboxFacts>]>): Map<string, MailboxFacts> {
  return new Map(entries.map(([a, f]) => [a, { ...done, ...f }]));
}

const both = facts([[OUTLOOK, {}], [GMAIL, {}]]);
const allGood = () => setting([answer(OUTLOOK), answer(GMAIL)]);

describe("evaluateReplyTest in own-mailbox mode (by hand)", () => {
  it("passes with every answer, a good original, the mailto answer and the unsubscribe; no reply is ever needed", () => {
    expect(evaluateReplyTest(allGood(), both, true, OWN)).toEqual({ status: "passed", missing: [], warnings: [] });
    // Neither the reply reaching the app nor dkim/arc is asked in this mode.
    expect(evaluateReplyTest(setting([answer(OUTLOOK, { authOk: "fail" }), answer(GMAIL, { authOk: null })]), both, true, OWN).status).toBe("passed");
  });

  it("is incomplete until each group has delivered + your reply arrived + DMARC pass, every mailbox answered, and an original is stored", () => {
    const nothing = evaluateReplyTest(setting([], { original: null, headersOk: null, mailtoArrived: null }), facts([[OUTLOOK, { testSendId: null, delivered: false }], [GMAIL, { testSendId: null, delivered: false }]]), false, OWN);
    expect(nothing.status).toBe("incomplete");
    expect(nothing.missing).toEqual([
      REPLY_TEST_TEXTS.sendFirst,
      REPLY_TEST_TEXTS.originalMissing,
      REPLY_TEST_TEXTS.headersUnanswered,
      REPLY_TEST_TEXTS.unsubscribe,
    ]);

    const undelivered = evaluateReplyTest(allGood(), facts([[OUTLOOK, { delivered: false }], [GMAIL, {}]]), true, OWN);
    expect(undelivered).toMatchObject({ status: "incomplete", missing: [`${OUTLOOK}: the test email hasn't been delivered yet.`] });

    const replyOpen = evaluateReplyTest(setting([answer(OUTLOOK, { inboxOk: null }), answer(GMAIL)]), both, true, OWN);
    expect(replyOpen.missing).toEqual([OWN_REPLY_TEST_TEXTS.replyUnanswered(OUTLOOK, FROM)]);
    expect(OWN_REPLY_TEST_TEXTS.replyUnanswered(OUTLOOK, FROM)).toBe("t.outlook@outlook.com: answer whether your reply arrived in contact@example.com.");

    const answersOpen = evaluateReplyTest(
      setting([answer(OUTLOOK, { placementOk: null, dmarcOk: "unsure" }), answer(GMAIL)], { original: null }),
      both,
      true,
      OWN,
    );
    expect(answersOpen.missing).toEqual([
      REPLY_TEST_TEXTS.placementUnanswered(OUTLOOK),
      REPLY_TEST_TEXTS.dmarcUnanswered(OUTLOOK),
      REPLY_TEST_TEXTS.originalMissing,
    ]);

    // A stored original without a return address says what to paste again.
    const noReturn = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ returnPathDomain: null, returnPathOk: null }) }), both, true, OWN);
    expect(noReturn).toMatchObject({ status: "incomplete", missing: [REPLY_TEST_TEXTS.returnPathUnknown] });
  });

  it("lists what is missing in §3.5's order, with the provider groups last", () => {
    const onlyOther = facts([[OTHER, { testSendId: 2, delivered: false }]]);
    const v = evaluateReplyTest(
      setting([answer(OTHER, { placementOk: null, inboxOk: null, dmarcOk: null })], { original: null, headersOk: null, mailtoArrived: null }),
      onlyOther,
      false,
      OWN,
    );
    expect(v.missing).toEqual([
      REPLY_TEST_TEXTS.placementUnanswered(OTHER),
      REPLY_TEST_TEXTS.dmarcUnanswered(OTHER),
      REPLY_TEST_TEXTS.originalMissing,
      REPLY_TEST_TEXTS.headersUnanswered,
      REPLY_TEST_TEXTS.unsubscribe,
      REPLY_TEST_TEXTS.needMicrosoft,
      REPLY_TEST_TEXTS.needGmailOrYahoo,
    ]);
    const all = evaluateReplyTest(
      setting([answer(OUTLOOK, { placementOk: null, inboxOk: null, dmarcOk: null }), answer(GMAIL, { inboxOk: null })], { mailtoArrived: null, headersOk: null }),
      facts([[OUTLOOK, {}], [GMAIL, { delivered: false }]]),
      false,
      OWN,
    );
    expect(all.missing).toEqual([
      `${GMAIL}: the test email hasn't been delivered yet.`,
      REPLY_TEST_TEXTS.placementUnanswered(OUTLOOK),
      OWN_REPLY_TEST_TEXTS.replyUnanswered(OUTLOOK, FROM),
      REPLY_TEST_TEXTS.dmarcUnanswered(OUTLOOK),
      REPLY_TEST_TEXTS.headersUnanswered,
      OWN_REPLY_TEST_TEXTS.mailtoUnanswered,
      REPLY_TEST_TEXTS.unsubscribe,
    ]);
  });

  it("needs every mailbox: an unsent third one keeps it open", () => {
    const three = facts([[OUTLOOK, {}], [GMAIL, {}], [OTHER, { testSendId: null, delivered: false }]]);
    expect(evaluateReplyTest(allGood(), three, true, OWN)).toMatchObject({ status: "incomplete", missing: [`${OTHER}: send the test email first.`] });
  });

  it("your reply didn't arrive in the own From → failed with the reply sentence", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK, { inboxOk: false }), answer(GMAIL)]), both, true, OWN);
    expect(v).toEqual({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.replyFailed(OUTLOOK, FROM)], warnings: [] });
    expect(v.missing[0]).toBe(
      "t.outlook@outlook.com: your reply didn't arrive in contact@example.com. Check the Spam folder and the filters of contact@example.com, then change the answer.",
    );
  });

  it("DMARC No, or an original saying DMARC fail → failed", () => {
    expect(evaluateReplyTest(setting([answer(OUTLOOK, { dmarcOk: "fail" }), answer(GMAIL)]), both, true, OWN)).toMatchObject({
      status: "failed",
      missing: [REPLY_TEST_TEXTS.dmarcFailed(OUTLOOK)],
    });
    expect(evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ dmarc: "fail" }) }), both, true, OWN)).toMatchObject({
      status: "failed",
      missing: [REPLY_TEST_TEXTS.dmarcFailed(GMAIL)],
    });
  });

  it("an original with a Return-Path on another domain → failed with the own-mailbox sentence", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ returnPathDomain: "other.example", returnPathOk: false }) }), both, true, OWN);
    expect(v).toMatchObject({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.returnPathFailed("other.example", D)] });
    expect(v.missing[0]).toBe("The test email's return address is on other.example, not on example.com. Tell the person who set up the app.");
  });

  it("the List-Unsubscribe answer No → failed with the own headers sentence", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { headersOk: false }), both, true, OWN);
    expect(v).toMatchObject({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.headersFailed] });
  });

  it("an original with a mailto: address: unanswered → incomplete, No → failed with the catch-all fix, Yes → passes", () => {
    const unanswered = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { mailtoArrived: null }), both, true, OWN);
    expect(unanswered).toEqual({ status: "incomplete", missing: [OWN_REPLY_TEST_TEXTS.mailtoUnanswered], warnings: [] });
    expect(OWN_REPLY_TEST_TEXTS.mailtoUnanswered).toBe("Answer whether the email to the unsubscribe address arrived.");
    const missingField = setting([answer(OUTLOOK), answer(GMAIL)]);
    delete missingField.mailtoArrived;
    expect(evaluateReplyTest(missingField, both, true, OWN).missing).toEqual([OWN_REPLY_TEST_TEXTS.mailtoUnanswered]);

    const no = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { mailtoArrived: false }), both, true, OWN);
    expect(no).toMatchObject({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM)] });
    expect(no.missing[0]).toContain("Zoho Mail: Admin Console › Domains › example.com › Catch-all Address, under Advanced Settings");
    expect(no.missing[0]).toContain("Emails to u+x@example.com don't reach anyone");

    expect(evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { mailtoArrived: true }), both, true, OWN).status).toBe("passed");
  });

  it("an original without a mailto: never asks, and its mailtoOk never fails this mode", () => {
    const noMailto = setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ mailtoAddress: null, mailtoDomain: null }), mailtoArrived: null });
    expect(evaluateReplyTest(noMailto, both, true, OWN)).toEqual({ status: "passed", missing: [], warnings: [] });
    const offDomain = setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ mailtoOk: false, mailtoDomain: "mailgun.example" }) });
    expect(evaluateReplyTest(offDomain, both, true, OWN).status).toBe("passed");
    // A stale "No" left over from an earlier original never fails once the new original shows no mailto.
    expect(evaluateReplyTest({ ...noMailto, mailtoArrived: false }, both, true, OWN).status).toBe("passed");
  });

  it("an original of another From or domain doesn't count (currentOriginal)", () => {
    expect(evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ from: "info@example.com" }) }), both, true, OWN).missing).toEqual([
      REPLY_TEST_TEXTS.originalMissing,
    ]);
    expect(evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ domain: "send.example.com" }) }), both, true, OWN).missing).toEqual([
      REPLY_TEST_TEXTS.originalMissing,
    ]);
  });

  it("placement No → passed with a warning (never a failure)", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK, { placementOk: false }), answer(GMAIL)]), both, true, OWN);
    expect(v).toEqual({ status: "passed", missing: [], warnings: [REPLY_TEST_TEXTS.spamWarning(OUTLOOK)] });
  });

  it("an unsubscribe that didn't reach the app yet keeps it open", () => {
    expect(evaluateReplyTest(allGood(), both, false, OWN)).toMatchObject({ status: "incomplete", missing: [REPLY_TEST_TEXTS.unsubscribe] });
  });
});

describe("review SECURITY-03: a mailto: the app couldn't read never skips the question (fail closed)", () => {
  it("an original that offers a mailto: without a readable address fails, whatever the mailto answer says", () => {
    for (const o of [
      original({ mailtoAddress: null, mailtoUnreadable: true }),
      // A stored original that lost its address (malformed, or never kept) but still names the mailto: host.
      original({ mailtoAddress: null }),
      original({ mailtoAddress: null, mailtoDomain: null, mailtoOk: false }),
    ]) {
      for (const mailtoArrived of [true, false, null]) {
        const v = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: o, mailtoArrived }), both, true, OWN);
        expect(v).toMatchObject({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.mailtoUnreadable] });
      }
    }
    expect(OWN_REPLY_TEST_TEXTS.mailtoUnreadable).toContain("Leave out unsubscribe by email");
  });

  it("a long u+… address (over 254 characters) is asked about like any other", () => {
    const long = `u+${"a".repeat(260)}@example.com`;
    const s = setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ mailtoAddress: long }), mailtoArrived: null });
    expect(evaluateReplyTest(s, both, true, OWN).missing).toEqual([OWN_REPLY_TEST_TEXTS.mailtoUnanswered]);
    expect(evaluateReplyTest({ ...s, mailtoArrived: false }, both, true, OWN).missing).toEqual([OWN_REPLY_TEST_TEXTS.mailtoFailed(long, D, FROM)]);
  });
});

describe("review REPLIES-01 and REPLIES-03: the unsubscribe-by-email texts", () => {
  it("on the From's own domain only a mailbox you read proves it; Settings › Deliverability never does", () => {
    const q = OWN_REPLY_TEST_TEXTS.mailtoQuestion(MAILTO, FROM);
    expect(q).toBe(
      "From one of your test mailboxes, send an email to u+x@example.com (any subject and text). Within the hour, did it arrive in contact@example.com or another mailbox you read? Look in Spam too.",
    );
    expect(q).not.toContain("Deliverability");
    expect(OWN_REPLY_TEST_TEXTS.mailtoAfter).toContain("answer No");
    expect(OWN_REPLY_TEST_TEXTS.mailtoAfter).toContain("Settings › Deliverability can't answer this");
    expect(OWN_REPLY_TEST_TEXTS.mailtoAfter).not.toContain("Remove");
    // Case and trailing dots don't matter; a subdomain (Mailgun's tracking host) isn't the own domain.
    expect(OWN_REPLY_TEST_TEXTS.mailtoQuestion("U+X@Example.COM", FROM)).not.toContain("Deliverability");
    const elsewhere = OWN_REPLY_TEST_TEXTS.mailtoQuestion("u+x@email.example.com", FROM);
    expect(elsewhere).toContain("From the test mailbox whose unsubscribe link you didn't click");
    expect(elsewhere).toContain("or does Settings › Deliverability now list that mailbox?");
  });

  it("the No sentence offers, in order: a catch-all, email aliases, then leaving out unsubscribe by email", () => {
    const t = OWN_REPLY_TEST_TEXTS.mailtoFailed(MAILTO, D, FROM);
    expect(t.startsWith(`Emails to ${MAILTO} don't reach anyone`)).toBe(true);
    const at = (s: string) => t.indexOf(s);
    const steps = [
      `Zoho Mail: Admin Console › Domains › ${D} › Catch-all Address, under Advanced Settings`,
      `add u@${D} and bounce@${D} as email aliases of ${FROM}`,
      `Admin Console › Users › the user of ${FROM} › Mailbox Settings › Email Alias › Add`,
      `Zoho may then deliver ${MAILTO} to u@${D}: try it, the test shows whether it works.`,
      "click Leave out unsubscribe by email below",
    ];
    for (const s of steps) expect(t, s).toContain(s);
    expect(steps.map(at)).toEqual([...steps.map(at)].sort((a, b) => a - b));
    expect(t).not.toContain("tell the person who set up the app");
    // An address without "+…" is itself the alias; bounce@ alone isn't named twice.
    expect(OWN_REPLY_TEST_TEXTS.mailtoFailed(`unsub@${D}`, D, FROM)).toContain(`add unsub@${D} and bounce@${D} as email aliases`);
    expect(OWN_REPLY_TEST_TEXTS.mailtoFailed(`unsub@${D}`, D, FROM)).not.toContain("Zoho may then deliver");
    expect(OWN_REPLY_TEST_TEXTS.mailtoFailed(`bounce@${D}`, D, FROM)).toContain(`add bounce@${D} as email aliases`);
  });
});

describe("review REPLIES-03: unsubscribe by email left out (the last resort, self-checking)", () => {
  const leftOut = (o: Partial<ReplyTestOriginal> | null, over: Partial<UnsubscribeTestSetting> = {}) =>
    setting([answer(OUTLOOK), answer(GMAIL)], {
      leaveOutMailto: true,
      mailtoArrived: null,
      original: o === null ? null : original({ mailtoAddress: null, mailtoDomain: null, mailtoOk: true, ...o }),
      ...over,
    });

  it("passes with a new original showing the link and no mailto:, without the mailto question; the note is a warning", () => {
    const v = evaluateReplyTest(leftOut({ unsubscribeScheme: "http" }), both, true, OWN);
    expect(v).toEqual({ status: "passed", missing: [], warnings: [OWN_REPLY_TEST_TEXTS.leftOutNote] });
    // A stale No left from before the switch doesn't matter.
    expect(evaluateReplyTest(leftOut({ unsubscribeScheme: "https" }, { mailtoArrived: false }), both, true, OWN).status).toBe("passed");
  });

  it("an original still showing a mailto: fails (Mailgun's own header came back, or the email is from before the switch)", () => {
    for (const o of [{ mailtoAddress: MAILTO, mailtoDomain: D }, { mailtoUnreadable: true }, { mailtoOk: false, mailtoDomain: "mailgun.example" }]) {
      const v = evaluateReplyTest(leftOut({ unsubscribeScheme: "http", ...o }, { mailtoArrived: true }), both, true, OWN);
      expect(v).toMatchObject({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.leftOutMailtoStill] });
    }
  });

  it("an original without a web link fails: Mailgun didn't fill in its link, so this way out doesn't work", () => {
    const v = evaluateReplyTest(leftOut({ unsubscribeScheme: null }), both, true, OWN);
    expect(v).toEqual({ status: "failed", missing: [OWN_REPLY_TEST_TEXTS.leftOutNoLink], warnings: [OWN_REPLY_TEST_TEXTS.leftOutNote] });
  });

  it("no original yet (or one read before the scheme was kept): send again and paste a new one", () => {
    expect(evaluateReplyTest(leftOut(null), both, true, OWN).missing).toEqual([OWN_REPLY_TEST_TEXTS.leftOutSendAgain]);
    const old = leftOut({});
    delete old.original!.unsubscribeScheme;
    expect(evaluateReplyTest(old, both, true, OWN)).toMatchObject({ status: "incomplete", missing: [OWN_REPLY_TEST_TEXTS.leftOutSendAgain] });
  });

  it("the choice changes nothing in app mode", () => {
    const pp: UnsubscribeTestSetting = {
      ...DEFAULT_UNSUBSCRIBE_TEST,
      leaveOutMailto: true,
      headersOk: true,
      mailboxes: [
        { address: OUTLOOK, provider: "microsoft", inboxOk: true, authOk: "pass", authFromHeaders: false },
        { address: GMAIL, provider: "gmail", inboxOk: true, authOk: "pass", authFromHeaders: false },
      ],
    };
    const replied = facts([[OUTLOOK, { replyStored: true }], [GMAIL, { replyStored: true }]]);
    expect(evaluateReplyTest(pp, replied, true)).toEqual({ status: "passed", missing: [] });
  });
});

describe("review REPLIES-08: a report lost over a gap says to send again", () => {
  it("a test email whose delivery report is gone: send the test emails again (not 'hasn't been delivered yet')", () => {
    const v = evaluateReplyTest(allGood(), facts([[OUTLOOK, { delivered: false, reportGone: true }], [GMAIL, {}]]), true, OWN);
    expect(v).toMatchObject({ status: "incomplete", missing: [OWN_REPLY_TEST_TEXTS.reportGone(OUTLOOK)] });
    expect(OWN_REPLY_TEST_TEXTS.reportGone(OUTLOOK)).toBe(
      "t.outlook@outlook.com: Mailgun's report for this test email is no longer available, so the app can't see that it arrived. Send the test emails again.",
    );
  });

  it("an unsubscribe click whose report is gone: Remove the test mailbox and click the link again", () => {
    expect(evaluateReplyTest(allGood(), both, false, { ...OWN, unsubscribeGone: true }).missing).toEqual([OWN_REPLY_TEST_TEXTS.unsubscribeGone]);
    expect(OWN_REPLY_TEST_TEXTS.unsubscribeGone).toContain("click Remove next to that test mailbox, then click the unsubscribe link");
    // Seen after all: nothing to say.
    expect(evaluateReplyTest(allGood(), both, true, { ...OWN, unsubscribeGone: true }).status).toBe("passed");
  });

  it("reportsGoneBefore: the days of logs plus an hour", async () => {
    const { reportsGoneBefore } = await import("@/core/reply-test");
    const now = new Date("2026-09-28T12:00:00Z");
    expect(reportsGoneBefore(now, 1).toISOString()).toBe("2026-09-27T11:00:00.000Z");
    expect(reportsGoneBefore(now, 5).toISOString()).toBe("2026-09-23T11:00:00.000Z");
    expect(reportsGoneBefore(now, Number.NaN).toISOString()).toBe("2026-09-27T11:00:00.000Z");
  });
});

describe("review REPLIES-05: the daily inbox check names Mark unsubscribed", () => {
  it("the card, the dashboard item and the notification say what to do with removal requests and bounce notices", async () => {
    const { INBOX_CHECK_TEXTS } = await import("@/core/sending/own-mailbox");
    for (const t of [INBOX_CHECK_TEXTS.intro(FROM), INBOX_CHECK_TEXTS.item(2, FROM), INBOX_CHECK_TEXTS.notificationBody(FROM)]) {
      expect(t).toContain("⋯ › Mark unsubscribed");
      expect(t).toContain(`"couldn't be delivered"`);
      expect(t).toContain("They replied");
    }
    expect(INBOX_CHECK_TEXTS.item(1, FROM)).toMatch(/^1 follow-up waits for today's check of contact@example\.com\./);
  });
});

describe("a pass belongs to its mode (replyTestPassedFor)", () => {
  const passed = { status: "passed" as const, domain: D, from: FROM };

  it("an own-mailbox pass counts only in own-mailbox mode, for its domain and own From", () => {
    const own = { ...passed, replies: "own-mailbox" as const };
    expect(replyTestPassedFor(own, D, FROM, { ownMailbox: true })).toBe(true);
    expect(replyTestPassedFor(own, D, FROM)).toBe(false);
    expect(replyTestPassedFor(own, D, "info@example.com", { ownMailbox: true })).toBe(false);
    expect(replyTestPassedFor(own, "send.example.com", FROM, { ownMailbox: true })).toBe(false);
  });

  it("an app-mode pass never counts in own-mailbox mode, and still counts in app mode", () => {
    expect(replyTestPassedFor(passed, D, FROM, { ownMailbox: true })).toBe(false);
    expect(replyTestPassedFor(passed, D, FROM)).toBe(true);
    const perPerson = { status: "passed" as const, domain: "send.example.com", from: null };
    expect(replyTestPassedFor(perPerson, "send.example.com", null)).toBe(true);
    expect(replyTestPassedFor(perPerson, "send.example.com", null, { ownMailbox: true })).toBe(false);
  });
});

describe("per-person and shared-From verdicts are unchanged", () => {
  const pp = (over: Partial<UnsubscribeTestSetting> = {}): UnsubscribeTestSetting => ({
    ...DEFAULT_UNSUBSCRIBE_TEST,
    mailboxes: [
      { address: OUTLOOK, provider: "microsoft", inboxOk: true, authOk: "pass", authFromHeaders: false },
      { address: GMAIL, provider: "gmail", inboxOk: true, authOk: "pass", authFromHeaders: false },
    ],
    headersOk: true,
    ...over,
  });
  const replied = facts([[OUTLOOK, { replyStored: true }], [GMAIL, { replyStored: true }]]);

  it("per-person: the reply must reach the app; the own-mailbox fields change nothing", () => {
    expect(evaluateReplyTest(pp(), replied, true)).toEqual({ status: "passed", missing: [] });
    expect(evaluateReplyTest(pp({ mailtoArrived: false, original: original() }), replied, true)).toEqual({ status: "passed", missing: [] });
    expect(evaluateReplyTest(pp(), both, true).status).toBe("incomplete");
    expect(evaluateReplyTest(pp(), both, true).missing[0]).toBe(`${OUTLOOK}: no reply has reached the app yet. Reply to the test email from this mailbox.`);
  });

  it("shared-From: without ownMailbox the verdict is today's (no mailto question, the reply must reach the app)", () => {
    const team = { teamFrom: FROM, sendingDomain: "send.example.com" };
    const teamOriginal = original({ domain: "send.example.com", returnPathDomain: "send.example.com", mailtoDomain: "send.example.com" });
    const s: UnsubscribeTestSetting = {
      ...pp(),
      mailboxes: [answer(OUTLOOK, { authOk: "pass" }), answer(GMAIL, { authOk: "pass" })],
      original: teamOriginal,
      mailtoArrived: false,
    };
    expect(evaluateReplyTest(s, replied, true, team)).toEqual({ status: "passed", missing: [], warnings: [] });
    expect(evaluateReplyTest(s, both, true, team).status).toBe("incomplete");
  });
});

describe("the unsubscribe-by-email answer in a save and in the section's key", () => {
  const LIST = [OUTLOOK, GMAIL];
  const reads = { auth: new Map(), dmarc: new Map() };

  it("mergeReplyTestAnswers keeps mailtoArrived only when given", () => {
    const s = setting([answer(OUTLOOK), answer(GMAIL)], { mailtoArrived: null });
    const yes = mergeReplyTestAnswers(s, LIST, { mailboxes: [], mailtoArrived: true }, reads);
    expect(yes.ok && yes.setting.mailtoArrived).toBe(true);
    const untouched = mergeReplyTestAnswers({ ...s, mailtoArrived: false }, LIST, { mailboxes: [], headersOk: true }, reads);
    expect(untouched.ok && untouched.setting.mailtoArrived).toBe(false);
    // App-mode shapes stay as they were: no mailtoArrived key appears.
    const app = mergeReplyTestAnswers({ ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes: [] }, LIST, { mailboxes: [], headersOk: true }, reads);
    expect(app.ok && Object.hasOwn(app.setting, "mailtoArrived")).toBe(false);
  });

  it("replyTestAnswersKey changes with the mailto answer or address; app-mode keys are unchanged", () => {
    const view = { domain: D, teamFrom: FROM, setup: "A" as const, headersOk: true, mailboxes: [] };
    const base = replyTestAnswersKey({ ...view, mailtoAddress: MAILTO, mailtoArrived: null });
    expect(replyTestAnswersKey({ ...view, mailtoAddress: MAILTO, mailtoArrived: true })).not.toBe(base);
    expect(replyTestAnswersKey({ ...view, mailtoAddress: "u+y@example.com", mailtoArrived: null })).not.toBe(base);
    expect(replyTestAnswersKey(view)).toBe(JSON.stringify([{ domain: D, from: FROM, setup: "A" }, true, []]));
  });
});
