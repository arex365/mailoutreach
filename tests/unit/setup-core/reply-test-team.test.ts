import { describe, expect, it } from "vitest";
import {
  currentOriginal,
  dmarcResultsText,
  evaluateReplyTest,
  parseDmarcResult,
  providerOf,
  REPLY_TEST_TEXTS,
  replyTestPassedFor,
  validateTestList,
  type MailboxFacts,
} from "@/core/reply-test";
import { TEAM_FROM_TEXTS } from "@/core/sending/from-address";
import { DEFAULT_UNSUBSCRIBE_TEST, type ReplyTestMailbox, type ReplyTestOriginal, type UnsubscribeTestSetting } from "@/core/setting-types";
import { testOriginal } from "./originals";

/**
 * The reply test in shared-From mode (SHARED-FROM-DESIGN §3.4, F12, F25, F26): the verdict's extra answers and the
 * pasted original, the spam warnings, DMARC read from a pasted original, the test list refusing the shared From
 * address and a stored pass counting only for its domain and From address. Per-person mode is pinned by
 * reply-test.test.ts, and checked here once more with the new options absent.
 */

const D = "send.example.com";
const FROM = "contact@example.com";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const OTHER = "t@company.de";
const TEAM = { teamFrom: FROM, sendingDomain: D };

const done: MailboxFacts = { testSendId: 1, sentAt: new Date("2026-09-27T10:00:00Z"), delivered: true, replyStored: true };

function answer(address: string, a: Partial<ReplyTestMailbox> = {}): ReplyTestMailbox {
  return { address, provider: providerOf(address), inboxOk: true, authOk: "pass", authFromHeaders: false, placementOk: true, dmarcOk: "pass", ...a };
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
    dkimSigner: "example.com",
    mailtoDomain: D,
    mailtoOk: true,
    readAt: "2026-09-27T10:05:00Z",
    ...o,
  };
}

function setting(mailboxes: ReplyTestMailbox[], over: Partial<UnsubscribeTestSetting> = {}): UnsubscribeTestSetting {
  return { ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes, headersOk: true, original: original(), ...over };
}

function facts(entries: Array<[string, Partial<MailboxFacts>]>): Map<string, MailboxFacts> {
  return new Map(entries.map(([a, f]) => [a, { ...done, ...f }]));
}

const both = facts([[OUTLOOK, {}], [GMAIL, {}]]);

describe("evaluateReplyTest in shared-From mode", () => {
  it("passes with every answer, a good original and the unsubscribe; warnings is there, empty", () => {
    expect(evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)]), both, true, TEAM)).toEqual({ status: "passed", missing: [], warnings: [] });
  });

  it("is incomplete until every mailbox answered placement and DMARC, and an original is pasted", () => {
    const v = evaluateReplyTest(
      setting([answer(OUTLOOK, { placementOk: null }), answer(GMAIL, { dmarcOk: "unsure" })], { original: null }),
      both,
      true,
      TEAM,
    );
    expect(v.status).toBe("incomplete");
    expect(v.missing).toEqual([
      REPLY_TEST_TEXTS.placementUnanswered(OUTLOOK),
      REPLY_TEST_TEXTS.dmarcUnanswered(GMAIL),
      REPLY_TEST_TEXTS.originalMissing,
    ]);
    expect(REPLY_TEST_TEXTS.placementUnanswered(OUTLOOK)).toBe("t.outlook@outlook.com: answer whether the test email arrived in the inbox.");
    expect(REPLY_TEST_TEXTS.dmarcUnanswered(GMAIL)).toBe("t.gmail@gmail.com: answer whether the test email's original says DMARC: PASS.");
    expect(REPLY_TEST_TEXTS.originalMissing).toBe("Paste one test email's original (below the mailboxes).");
  });

  it("needs every mailbox, not one per provider: an unsent third mailbox keeps it open", () => {
    const three = facts([[OUTLOOK, {}], [GMAIL, {}], [OTHER, { testSendId: null, delivered: false, replyStored: false }]]);
    const v = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)]), three, true, TEAM);
    expect(v).toMatchObject({ status: "incomplete", missing: [`${OTHER}: send the test email first.`] });
    // Per-person mode ignores the unfinished third mailbox, as before.
    const perPerson = evaluateReplyTest({ ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes: [answer(OUTLOOK), answer(GMAIL)], headersOk: true }, three, true);
    expect(perPerson).toEqual({ status: "passed", missing: [] });
  });

  it("a DMARC No fails, with the DMARC sentence", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK, { dmarcOk: "fail" }), answer(GMAIL)]), both, true, TEAM);
    expect(v.status).toBe("failed");
    expect(v.missing).toEqual([
      't.outlook@outlook.com: the test email didn\'t pass DMARC, so inbox providers may treat it as fake. Check the "Mail servers know your policy (DMARC)" row on the Domain checklist.',
    ]);
  });

  it("an original with the return address off the sending domain fails with the return-address sentence", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ returnPathDomain: "example.com", returnPathOk: false }) }), both, true, TEAM);
    expect(v).toEqual({
      status: "failed",
      missing: [
        "The test email's return address is on example.com, not on send.example.com, so bounces and automatic replies would go to your everyday inbox instead of the app. Clear the From address in Settings › Sending & Mailgun and ask the person who set up the app.",
      ],
      warnings: [],
    });
  });

  it("an original whose mailto: isn't on the sending domain, or the headers answer No, fails with the headers sentence", () => {
    const headers = REPLY_TEST_TEXTS.headersFailedTeam(D);
    expect(headers).toBe(
      "The test email's List-Unsubscribe header is missing, or its mailto: address isn't on send.example.com. Click Apply recommended settings and send the test emails again; if it stays that way, ask the person who set up the app.",
    );
    const mailto = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ mailtoDomain: "example.com", mailtoOk: false }) }), both, true, TEAM);
    expect(mailto).toMatchObject({ status: "failed", missing: [headers] });
    const no = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { headersOk: false }), both, true, TEAM);
    expect(no).toMatchObject({ status: "failed", missing: [headers] });
  });

  it("the original's own DMARC fail fails too", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ dmarc: "fail" }) }), both, true, TEAM);
    expect(v).toMatchObject({ status: "failed", missing: [REPLY_TEST_TEXTS.dmarcFailed(GMAIL)] });
  });

  it("an original without a return address keeps it open (paste the whole original)", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: original({ returnPathDomain: null, returnPathOk: null }) }), both, true, TEAM);
    expect(v).toMatchObject({ status: "incomplete", missing: [REPLY_TEST_TEXTS.returnPathUnknown] });
  });

  it("a placement No passes with a warning, never a failure", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK, { placementOk: false }), answer(GMAIL)]), both, true, TEAM);
    expect(v).toEqual({ status: "passed", missing: [], warnings: ["t.outlook@outlook.com: the test email landed in spam."] });
  });

  it("an original for another From address or another domain doesn't count", () => {
    for (const other of [original({ from: "info@example.com" }), original({ domain: "mail.example.com" })]) {
      const v = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)], { original: other }), both, true, TEAM);
      expect(v).toMatchObject({ status: "incomplete", missing: [REPLY_TEST_TEXTS.originalMissing] });
    }
    expect(currentOriginal({ original: original() }, "Send.Example.com", "Contact@Example.com")).not.toBeNull();
    expect(currentOriginal({ original: original() }, D, null)).toBeNull();
  });

  it("per-person mode: the new answers and the original are ignored, and there is no warnings key", () => {
    const s = setting([answer(OUTLOOK, { placementOk: false, dmarcOk: "fail" }), answer(GMAIL)], { original: original({ returnPathOk: false }) });
    expect(evaluateReplyTest(s, both, true)).toEqual({ status: "passed", missing: [] });
    expect(evaluateReplyTest(s, both, true, { teamFrom: null, sendingDomain: D })).toEqual({ status: "passed", missing: [] });
    expect(evaluateReplyTest({ ...s, headersOk: false }, both, true)).toEqual({ status: "incomplete", missing: [REPLY_TEST_TEXTS.headersMissing] });
  });
});

describe("parseDmarcResult", () => {
  const gmail = (dmarc: Parameters<typeof testOriginal>[0]["dmarc"]) =>
    testOriginal({ from: `Arslan <${FROM}>`, messageId: "pp.t.1.abc@send.example.com", provider: "gmail", dmarc });

  it("reads Gmail's and Outlook.com's DMARC verdict", () => {
    expect(parseDmarcResult(gmail("pass"), { fromDomain: "example.com" })).toBe("pass");
    expect(parseDmarcResult(gmail("fail"), { fromDomain: "example.com" })).toBe("fail");
    const outlook = testOriginal({ from: FROM, messageId: "pp.t.1.abc@send.example.com", provider: "outlook", dmarc: "pass" });
    expect(parseDmarcResult(outlook, { fromDomain: "example.com" })).toBe("pass");
    expect(parseDmarcResult(testOriginal({ from: FROM, messageId: "pp.t.1@send.example.com", provider: "outlook", dmarc: "fail" }))).toBe("fail");
  });

  it("anything else is null: none, bestguesspass, temperror, permerror, missing", () => {
    for (const d of ["none", "bestguesspass", "temperror", "permerror", null] as const) {
      expect(parseDmarcResult(gmail(d), { fromDomain: "example.com" }), String(d)).toBeNull();
    }
    expect(parseDmarcResult("")).toBeNull();
  });

  it("reads Zoho-style headers (its own authserv-id, folded)", () => {
    const zoho = [
      "Delivered-To: arslan@zoho.example",
      "ARC-Authentication-Results: i=1; mx.zohomail.com;",
      "\tdkim=pass header.i=example.com;",
      "\tspf=pass (zohomail.com: domain of send.example.com designates 159.135.228.4 as permitted sender)  smtp.mailfrom=bounce@send.example.com;",
      "\tdmarc=pass(p=none dis=none)  header.from=example.com",
      "Authentication-Results: mx.zohomail.com;",
      "\tdkim=pass header.i=example.com;",
      "\tdmarc=pass(p=none dis=none)  header.from=example.com",
      "From: Arslan <contact@example.com>",
    ].join("\n");
    expect(parseDmarcResult(zoho, { fromDomain: "example.com" })).toBe("pass");
  });

  it("ignores Mailgun's own sets and a result for another From domain", () => {
    const mailgunOnly = "Authentication-Results: mxa.mailgun.org; dmarc=pass header.from=example.com\nFrom: a@example.com";
    expect(parseDmarcResult(mailgunOnly, { fromDomain: "example.com" })).toBeNull();
    const withMailgunOnTop = [
      "Authentication-Results: mxa.mailgun.org; dmarc=pass header.from=example.com",
      "Authentication-Results: mx.google.com; dmarc=fail (p=NONE) header.from=example.com",
    ].join("\n");
    expect(parseDmarcResult(withMailgunOnTop, { fromDomain: "example.com" })).toBe("fail");
    const otherDomain = "Authentication-Results: mx.google.com; dmarc=fail header.from=gmail.com";
    expect(parseDmarcResult(otherDomain, { fromDomain: "example.com" })).toBeNull();
    // Without a From domain, any result counts.
    expect(parseDmarcResult(otherDomain)).toBe("fail");
  });

  it("says what it read", () => {
    expect(dmarcResultsText("pass")).toBe("The original says DMARC: PASS.");
    expect(dmarcResultsText("fail")).toBe("The original says DMARC: FAIL.");
    expect(dmarcResultsText(null)).toBe("The original doesn't show a DMARC result. Paste the whole original, starting at the first line.");
  });
});

describe("validateTestList with a shared From address (F15)", () => {
  const ctx = { sendingDomains: [D], teammateInboxes: [] };

  it("refuses the shared From address as a test mailbox, in any case, with its own sentence (SCREENS-04)", () => {
    expect(validateTestList([OUTLOOK, " Contact@Example.com "], { ...ctx, teamFrom: FROM })).toEqual({
      ok: false,
      error: REPLY_TEST_TEXTS.fromOnTestList(FROM),
    });
    expect(REPLY_TEST_TEXTS.fromOnTestList(FROM)).toBe(
      "contact@example.com is your From address, so it can't be a test mailbox. Use a normal mailbox, such as Gmail or Outlook.com.",
    );
    // The From card's sentence (an address already on the test list) is a different one and stays as it was.
    expect(REPLY_TEST_TEXTS.fromOnTestList(FROM)).not.toBe(TEAM_FROM_TEXTS.onTestList(FROM));
    expect(TEAM_FROM_TEXTS.onTestList(FROM)).toBe("contact@example.com is on your test list. Remove it from the test list first: it can't be a test mailbox.");
  });

  it("other addresses of the main domain are fine, and without teamFrom nothing changes", () => {
    expect(validateTestList([OUTLOOK, "info@example.com"], { ...ctx, teamFrom: FROM })).toMatchObject({ ok: true, value: [OUTLOOK, "info@example.com"] });
    expect(validateTestList([OUTLOOK, FROM], ctx)).toMatchObject({ ok: true, value: [OUTLOOK, FROM] });
    expect(validateTestList([OUTLOOK, FROM], { ...ctx, teamFrom: null })).toMatchObject({ ok: true });
  });
});

describe("replyTestPassedFor (F12)", () => {
  const passed = { status: "passed" as const, domain: D };

  it("needs the same domain and the same From address", () => {
    expect(replyTestPassedFor({ ...passed, from: FROM }, D, FROM)).toBe(true);
    expect(replyTestPassedFor({ ...passed, from: "Contact@Example.com" }, "SEND.example.com", FROM)).toBe(true);
    expect(replyTestPassedFor({ ...passed, from: FROM }, D, "info@example.com")).toBe(false);
    expect(replyTestPassedFor({ ...passed, from: FROM }, "mail.example.com", FROM)).toBe(false);
    expect(replyTestPassedFor({ ...passed, from: FROM }, null, FROM)).toBe(false);
    expect(replyTestPassedFor({ status: "failed", domain: D, from: FROM }, D, FROM)).toBe(false);
  });

  it("a stored pass without `from` counts only in per-person mode", () => {
    expect(replyTestPassedFor(passed, D, null)).toBe(true);
    expect(replyTestPassedFor({ ...passed, from: null }, D, null)).toBe(true);
    expect(replyTestPassedFor(passed, D, FROM)).toBe(false);
    expect(replyTestPassedFor({ ...passed, from: FROM }, D, null)).toBe(false);
  });
});
