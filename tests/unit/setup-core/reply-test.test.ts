import { describe, expect, it } from "vitest";
import {
  authResultsText,
  evaluateReplyTest,
  parseAuthResults,
  providerOf,
  REPLY_TEST_SUBJECT,
  REPLY_TEST_TEXTS,
  replyTestEmail,
  validateTestList,
  type MailboxFacts,
} from "@/core/reply-test";
import { DEFAULT_UNSUBSCRIBE_TEST, type ReplyTestMailbox, type UnsubscribeTestSetting } from "@/core/setting-types";

// ───────────────────────── providers ─────────────────────────

describe("providerOf", () => {
  it("knows Gmail, Microsoft and Yahoo in any country, and nothing else", () => {
    expect(providerOf("a@gmail.com")).toBe("gmail");
    expect(providerOf("a@googlemail.com")).toBe("gmail");
    for (const a of ["a@outlook.com", "a@outlook.de", "a@hotmail.co.uk", "a@live.com", "a@live.nl", "a@msn.com"]) {
      expect(providerOf(a)).toBe("microsoft");
    }
    for (const a of ["a@yahoo.com", "a@yahoo.co.uk", "a@ymail.com"]) expect(providerOf(a)).toBe("yahoo");
    for (const a of ["a@live.somecompany.com", "a@gmail.company.com", "a@company.de", "not an address"]) {
      expect(providerOf(a)).toBe("other");
    }
  });
});

// ───────────────────────── the verdict ─────────────────────────

const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const YAHOO = "t.yahoo@yahoo.com";
const OTHER = "t@company.de";

const done: MailboxFacts = { testSendId: 1, sentAt: new Date("2026-09-23T10:00:00Z"), delivered: true, replyStored: true };

function answer(address: string, a: Partial<ReplyTestMailbox> = {}): ReplyTestMailbox {
  return { address, provider: providerOf(address), inboxOk: true, authOk: "pass", authFromHeaders: false, ...a };
}

function setting(mailboxes: ReplyTestMailbox[], headersOk: boolean | null = true): UnsubscribeTestSetting {
  return { ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes, headersOk };
}

function facts(entries: Array<[string, Partial<MailboxFacts>]>): Map<string, MailboxFacts> {
  return new Map(entries.map(([a, f]) => [a, { ...done, ...f }]));
}

describe("evaluateReplyTest", () => {
  it("passes with a Microsoft and a Gmail mailbox complete, the headers seen and an unsubscribe", () => {
    const v = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL)]), facts([[OUTLOOK, {}], [GMAIL, {}]]), true);
    expect(v).toEqual({ status: "passed", missing: [] });
  });

  it("accepts Yahoo instead of Gmail, and ignores an unfinished third mailbox", () => {
    const v = evaluateReplyTest(
      setting([answer(OUTLOOK), answer(YAHOO), answer(OTHER, { inboxOk: null, authOk: null })]),
      facts([[OUTLOOK, {}], [YAHOO, {}], [OTHER, { delivered: false, replyStored: false }]]),
      true,
    );
    expect(v.status).toBe("passed");
  });

  it("needs both kinds of mailbox", () => {
    const noMicrosoft = evaluateReplyTest(setting([answer(GMAIL), answer(OTHER)]), facts([[GMAIL, {}], [OTHER, {}]]), true);
    expect(noMicrosoft).toEqual({ status: "incomplete", missing: [REPLY_TEST_TEXTS.needMicrosoft] });
    const noGmail = evaluateReplyTest(setting([answer(OUTLOOK)]), facts([[OUTLOOK, {}]]), true);
    expect(noGmail).toEqual({ status: "incomplete", missing: [REPLY_TEST_TEXTS.needGmailOrYahoo] });
  });

  it("needs the headers answer and the unsubscribe", () => {
    const f = facts([[OUTLOOK, {}], [GMAIL, {}]]);
    const both = [answer(OUTLOOK), answer(GMAIL)];
    expect(evaluateReplyTest(setting(both, null), f, true)).toEqual({ status: "incomplete", missing: [REPLY_TEST_TEXTS.headersUnanswered] });
    expect(evaluateReplyTest(setting(both, false), f, true)).toEqual({ status: "incomplete", missing: [REPLY_TEST_TEXTS.headersMissing] });
    expect(evaluateReplyTest(setting(both, true), f, false)).toEqual({ status: "incomplete", missing: [REPLY_TEST_TEXTS.unsubscribe] });
  });

  it("fails as soon as any mailbox says No, even a third one", () => {
    const f = facts([[OUTLOOK, {}], [GMAIL, {}], [OTHER, {}]]);
    const inboxNo = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL), answer(OTHER, { inboxOk: false })]), f, true);
    expect(inboxNo).toEqual({ status: "failed", missing: [`${OTHER}: the reply didn't arrive in your reply inbox.`] });
    const authNo = evaluateReplyTest(setting([answer(OUTLOOK, { authOk: "fail" }), answer(GMAIL)]), f, true);
    expect(authNo).toEqual({ status: "failed", missing: [`${OUTLOOK}: the reply didn't pass dkim or arc.`] });
  });

  it("says what each group still needs, from the mailbox that got furthest", () => {
    const f = facts([
      [OUTLOOK, { delivered: false, replyStored: false }],
      [GMAIL, { replyStored: false }],
    ]);
    const v = evaluateReplyTest(setting([answer(OUTLOOK, { inboxOk: null, authOk: null }), answer(GMAIL, { authOk: "unsure" })], null), f, false);
    expect(v.status).toBe("incomplete");
    expect(v.missing).toEqual([
      `${OUTLOOK}: the test email hasn't been delivered yet.`,
      `${GMAIL}: no reply has reached the app yet. Reply to the test email from this mailbox.`,
      REPLY_TEST_TEXTS.headersUnanswered,
      REPLY_TEST_TEXTS.unsubscribe,
    ]);
    const unsure = evaluateReplyTest(setting([answer(OUTLOOK), answer(GMAIL, { authOk: "unsure" })]), facts([[OUTLOOK, {}], [GMAIL, {}]]), true);
    expect(unsure.missing).toEqual([`${GMAIL}: answer whether the reply's original says dkim=pass or arc=pass.`]);
  });

  it("asks to send first when nothing was sent, and to add mailboxes when there are none", () => {
    const f = facts([[OUTLOOK, { testSendId: null, delivered: false, replyStored: false }], [GMAIL, { testSendId: null, delivered: false, replyStored: false }]]);
    const v = evaluateReplyTest(setting([], null), f, false);
    expect(v.missing[0]).toBe(REPLY_TEST_TEXTS.sendFirst);
    expect(v.missing.filter((m) => m.includes("send the test email first"))).toEqual([]);
    expect(evaluateReplyTest(setting([]), new Map(), true)).toEqual({ status: "incomplete", missing: [REPLY_TEST_TEXTS.noMailboxes] });
  });

  it("ignores answers for mailboxes that are no longer on the test list", () => {
    const v = evaluateReplyTest(
      setting([answer(OUTLOOK), answer(GMAIL), answer("gone@gmail.com", { inboxOk: false })]),
      facts([[OUTLOOK, {}], [GMAIL, {}]]),
      true,
    );
    expect(v.status).toBe("passed");
  });
});

// ───────────────────────── pasted headers ─────────────────────────

const GMAIL_ORIGINAL_PASS = `Delivered-To: arslan.owner@gmail.com
Received: by 2002:a05:7300:5d8a:b0:12a:bc3 with SMTP id q10csp123456;
        Wed, 23 Sep 2026 03:12:01 -0700 (PDT)
ARC-Seal: i=2; a=rsa-sha256; t=1790158321; cv=pass;
        d=google.com; s=arc-20240605;
        b=Zk3PqXbT0cRS4n2GbWmR4g==
ARC-Authentication-Results: i=2; mx.google.com;
       dkim=pass header.i=@outlook.com header.s=selector1 header.b=Qm4a1f2E;
       arc=pass (i=1 spf=pass spfdomain=outlook.com dkim=pass dkdomain=outlook.com dmarc=pass fromdomain=outlook.com);
       spf=pass (google.com: domain of bounce+abc@send.example.com designates 159.135.228.10 as permitted sender) smtp.mailfrom="bounce+abc@send.example.com"
Return-Path: <bounce+abc@send.example.com>
Received: from m228-10.mailgun.net (m228-10.mailgun.net. [159.135.228.10])
        by mx.google.com with UTF8SMTPS id 5b1f17b1804b1-45;
        Wed, 23 Sep 2026 03:12:01 -0700 (PDT)
Authentication-Results: mx.google.com;
       dkim=pass header.i=@outlook.com header.s=selector1 header.b=Qm4a1f2E;
       arc=pass (i=1 spf=pass spfdomain=outlook.com dkim=pass dkdomain=outlook.com dmarc=pass fromdomain=outlook.com);
       spf=pass (google.com: domain of bounce+abc@send.example.com designates 159.135.228.10 as permitted sender) smtp.mailfrom="bounce+abc@send.example.com"
From: Test Outlook <t.outlook@outlook.com>
To: "Arslan from Polygon Paradise" <arslan@send.example.com>
Subject: Re: Reply test from Polygon Paradise Outreach
`;

const GMAIL_ORIGINAL_FAIL = `Delivered-To: arslan.owner@gmail.com
Authentication-Results: mx.google.com;
       dkim=fail header.i=@yahoo.com header.s=s2048 header.b=Xy12;
       arc=fail (signature failed);
       spf=pass (google.com: domain of bounce@send.example.com designates 159.135.228.10 as permitted sender) smtp.mailfrom=bounce@send.example.com;
       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=yahoo.com
From: T <t.yahoo@yahoo.com>
`;

const OUTLOOK_SOURCE_PASS = `Received: from AM9P191MB1234.EURP191.PROD.OUTLOOK.COM (2603:10a6:20b:3a1::7)
 by DB9P191MB5678.EURP191.PROD.OUTLOOK.COM with HTTPS; Wed, 23 Sep 2026
 10:12:03 +0000
Authentication-Results: spf=pass (sender IP is 159.135.228.10)
 smtp.mailfrom=send.example.com; dkim=pass (signature was verified)
 header.d=gmail.com;dmarc=pass action=none header.from=gmail.com;compauth=pass
 reason=100
Received-SPF: Pass (protection.outlook.com: domain of send.example.com designates
 159.135.228.10 as permitted sender) receiver=protection.outlook.com;
From: T Gmail <t.gmail@gmail.com>
`;

/**
 * A reply from Outlook.com, forwarded by a Mailgun route to a Gmail inbox, as Gmail's "Show original" shows it (the
 * summary table first, then the headers, newest hop on top). Gmail found the signature broken and didn't trust the
 * chain; Mailgun's own ARC hop (i=1, further down) still records the dkim=pass it saw before forwarding.
 */
const GMAIL_ORIGINAL_BROKEN_BY_FORWARD = `Original Message
Message ID	<AM9P191MB1234ABCD@AM9P191MB1234.EURP191.PROD.OUTLOOK.COM>
Created at:	Wed, Sep 23, 2026 at 12:12 PM (Delivered after 1 second)
From:	Test Outlook <t.outlook@outlook.com>
To:	"Arslan from Polygon Paradise" <arslan@send.example.com>
Subject:	Re: Reply test from Polygon Paradise Outreach
SPF:	PASS with IP 159.135.228.10 Learn more
DKIM:	'FAIL' with domain outlook.com Learn more
DMARC:	'FAIL' Learn more

Download Original	Copy to clipboard

Delivered-To: arslan.owner@gmail.com
Received: by 2002:a05:7300:5d8a:b0:12a:bc3 with SMTP id q10csp123456;
        Wed, 23 Sep 2026 03:12:01 -0700 (PDT)
X-Google-Smtp-Source: AGHT+IE3kq9Zb1c
ARC-Seal: i=2; a=rsa-sha256; t=1790158321; cv=fail;
        d=google.com; s=arc-20240605;
        b=Zk3PqXbT0cRS4n2GbWmR4g==
ARC-Message-Signature: i=2; a=rsa-sha256; c=relaxed/relaxed; d=google.com; s=arc-20240605;
        h=to:subject:message-id:date:from:mime-version:dkim-signature;
        bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=; b=Qm9vb2s=
ARC-Authentication-Results: i=2; mx.google.com;
       dkim=fail header.i=@outlook.com header.s=selector1 header.b=Qm4a1f2E;
       arc=fail (signature failed);
       spf=pass (google.com: domain of bounce+abc@send.example.com designates 159.135.228.10 as permitted sender) smtp.mailfrom="bounce+abc@send.example.com";
       dmarc=fail (p=NONE sp=QUARANTINE dis=NONE) header.from=outlook.com
Return-Path: <bounce+abc@send.example.com>
Received: from m228-10.mailgun.net (m228-10.mailgun.net. [159.135.228.10])
        by mx.google.com with UTF8SMTPS id 5b1f17b1804b1-45;
        Wed, 23 Sep 2026 03:12:01 -0700 (PDT)
Received-SPF: pass (google.com: domain of bounce+abc@send.example.com designates 159.135.228.10 as permitted sender) client-ip=159.135.228.10;
Authentication-Results: mx.google.com;
       dkim=fail header.i=@outlook.com header.s=selector1 header.b=Qm4a1f2E;
       arc=fail (signature failed);
       spf=pass (google.com: domain of bounce+abc@send.example.com designates 159.135.228.10 as permitted sender) smtp.mailfrom="bounce+abc@send.example.com";
       dmarc=fail (p=NONE sp=QUARANTINE dis=NONE) header.from=outlook.com
ARC-Seal: i=1; a=rsa-sha256; cv=none; d=mailgun.org; s=arc; t=1790158320;
        b=TWFpbGd1bg==
ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=mailgun.org; s=arc;
        h=From:To:Subject:Date:Message-ID; bh=Zm9v; b=YmFy
ARC-Authentication-Results: i=1; mxa.eu.mailgun.org;
       dkim=pass header.d=outlook.com header.s=selector1 header.b=Qm4a1f2E;
       spf=pass (mxa.eu.mailgun.org: domain of t.outlook@outlook.com designates 2a01:111:f403:2e0c::800 as permitted sender) smtp.mailfrom=t.outlook@outlook.com;
       dmarc=pass header.from=outlook.com
Received: from EUR05-VI1-obe.outbound.protection.outlook.com (mail-vi1eur05olkn2080.outbound.protection.outlook.com [40.92.90.80])
        by mxa.eu.mailgun.org with ESMTP id 66f1c2e0; Wed, 23 Sep 2026 10:12:00 GMT
DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=outlook.com; s=selector1;
        h=From:Date:Subject:Message-ID:Content-Type:MIME-Version; bh=Zm9vYmFy; b=Qm4a1f2E
From: Test Outlook <t.outlook@outlook.com>
To: "Arslan from Polygon Paradise" <arslan@send.example.com>
Subject: Re: Reply test from Polygon Paradise Outreach
`;

/** The same kind of reply from Gmail, forwarded to an Outlook.com inbox: Outlook.com's "View message source". */
const OUTLOOK_SOURCE_BROKEN_BY_FORWARD = `Received: from AM9P191MB1234.EURP191.PROD.OUTLOOK.COM (2603:10a6:20b:3a1::7)
 by DB9P191MB5678.EURP191.PROD.OUTLOOK.COM with HTTPS; Wed, 23 Sep 2026
 10:12:03 +0000
ARC-Seal: i=2; a=rsa-sha256; s=arcselector10001; d=microsoft.com; cv=fail;
 b=TWljcm9zb2Z0
ARC-Authentication-Results: i=2; mx.microsoft.com 1; spf=pass (sender ip is
 159.135.228.10) smtp.rcpttodomain=outlook.com smtp.mailfrom=send.example.com;
 dmarc=fail (p=none sp=none pct=100) action=none header.from=gmail.com;
 dkim=fail (body hash did not verify) header.d=gmail.com; arc=fail (47)
Authentication-Results: spf=pass (sender IP is 159.135.228.10)
 smtp.mailfrom=send.example.com; dkim=fail (body hash did not verify)
 header.d=gmail.com;dmarc=fail action=none header.from=gmail.com;compauth=fail
 reason=001
Received-SPF: Pass (protection.outlook.com: domain of send.example.com designates
 159.135.228.10 as permitted sender) receiver=protection.outlook.com;
ARC-Seal: i=1; a=rsa-sha256; cv=none; d=mailgun.org; s=arc; t=1790158320;
 b=TWFpbGd1bg==
ARC-Authentication-Results: i=1; mxa.eu.mailgun.org; dkim=pass header.d=gmail.com
 header.s=20230601 header.b=abc; spf=pass smtp.mailfrom=t.gmail@gmail.com;
 dmarc=pass header.from=gmail.com
DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=gmail.com; s=20230601;
 h=to:subject:message-id:date:from:mime-version; bh=Zm9v; b=abc
From: T Gmail <t.gmail@gmail.com>
`;

describe("parseAuthResults", () => {
  it("reads a pass from a Gmail original, folded lines included", () => {
    expect(parseAuthResults(GMAIL_ORIGINAL_PASS)).toBe("pass");
    expect(parseAuthResults(GMAIL_ORIGINAL_PASS.replace(/\n/g, "\r\n"))).toBe("pass");
  });

  it("reads a pass from an Outlook.com message source (one-space folds, no space after ;)", () => {
    expect(parseAuthResults(OUTLOOK_SOURCE_PASS)).toBe("pass");
  });

  it("reads a fail when nothing passed; dmarc=pass is not a pass", () => {
    expect(parseAuthResults(GMAIL_ORIGINAL_FAIL)).toBe("fail");
    expect(parseAuthResults("Authentication-Results: mx.google.com; dkim=fail header.i=@x.com; dmarc=pass header.from=x.com")).toBe("fail");
  });

  it("judges the inbox's own verdict, not Mailgun's forwarding hop that says pass (Gmail inbox)", () => {
    expect(parseAuthResults(GMAIL_ORIGINAL_BROKEN_BY_FORWARD)).toBe("fail");
    expect(parseAuthResults(GMAIL_ORIGINAL_BROKEN_BY_FORWARD, { from: "t.outlook@outlook.com" })).toBe("fail");
    expect(parseAuthResults(GMAIL_ORIGINAL_BROKEN_BY_FORWARD.replace(/\n/g, "\r\n"))).toBe("fail");
  });

  it("judges the inbox's own verdict, not Mailgun's forwarding hop that says pass (Outlook.com inbox, no authserv-id)", () => {
    expect(parseAuthResults(OUTLOOK_SOURCE_BROKEN_BY_FORWARD)).toBe("fail");
    // "dkim=fail (body hash did not verify)" and Gmail's "dkim=neutral (body hash did not verify)" both mean the
    // signature broke.
    expect(parseAuthResults("Authentication-Results: mx.google.com; dkim=neutral (body hash did not verify) header.i=@outlook.com")).toBe("fail");
  });

  it("with no Authentication-Results, uses the newest ARC set that isn't Mailgun's", () => {
    const mailgunOnly = "ARC-Authentication-Results: i=1; mxa.eu.mailgun.org; dkim=pass header.d=outlook.com";
    expect(parseAuthResults(mailgunOnly)).toBeNull();
    const withInbox = `ARC-Authentication-Results: i=2; mx.google.com; dkim=fail header.i=@outlook.com; arc=fail\n${mailgunOnly}`;
    expect(parseAuthResults(withInbox)).toBe("fail");
    const newest = "ARC-Authentication-Results: i=1; mx.example.net; dkim=fail header.d=x.com\nARC-Authentication-Results: i=3; mx.google.com; arc=pass";
    expect(parseAuthResults(newest)).toBe("pass");
  });

  it("an arc=pass from the inbox counts (it trusted Mailgun's seal); results inside (comments) never do", () => {
    const trusted =
      "Authentication-Results: mx.google.com;\n       dkim=fail header.i=@outlook.com;\n       arc=pass (i=1 spf=pass dkim=pass dkdomain=outlook.com)";
    expect(parseAuthResults(trusted)).toBe("pass");
    const commentOnly = "Authentication-Results: mx.google.com; dkim=fail header.i=@outlook.com; arc=fail (i=1 dkim=pass arc=pass)";
    expect(parseAuthResults(commentOnly)).toBe("fail");
  });

  it("another signer's pass can't hide a broken signature of the reply's own domain", () => {
    const resigned = "Authentication-Results: mx.google.com; dkim=pass header.i=@send.example.com header.s=pdk1; dkim=fail header.i=@outlook.com";
    expect(parseAuthResults(resigned, { from: "t.outlook@outlook.com" })).toBe("fail");
    expect(parseAuthResults(`${resigned}\nFrom: Test <t.outlook@outlook.com>`)).toBe("fail");
    // googlemail.com mailboxes are signed as gmail.com.
    expect(parseAuthResults("Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com", { from: "t@googlemail.com" })).toBe("pass");
    // When the inbox lists no signature of the reply's own domain, any dkim=pass it reports still counts.
    expect(parseAuthResults("Authentication-Results: mx.google.com; dkim=pass header.i=@send.example.com", { from: "t.gmail@gmail.com" })).toBe("pass");
  });

  it("finds nothing without the headers, or without a dkim/arc verdict", () => {
    expect(parseAuthResults("")).toBeNull();
    expect(parseAuthResults("Subject: hello\nFrom: a@b.com\n\ndkim=pass in the body doesn't count")).toBeNull();
    expect(parseAuthResults("Authentication-Results: mx.google.com; dkim=none; spf=pass smtp.mailfrom=x.com")).toBeNull();
    expect(parseAuthResults("X-Mailgun-Dkim-Check-Result: Pass")).toBeNull();
    expect(parseAuthResults("Authentication-Results: mxa.eu.mailgun.org; dkim=pass header.d=outlook.com")).toBeNull();
  });

  it("words the result", () => {
    expect(authResultsText("pass")).toBe("The headers say dkim=pass.");
    expect(authResultsText(null)).toBe("The headers don't show a DKIM or ARC result. Paste the whole original, starting at the first line.");
  });
});

// ───────────────────────── the email and the test list ─────────────────────────

describe("replyTestEmail", () => {
  const footer = { companyName: "Polygon Paradise", address: "Lahore", unsubscribeText: "Unsubscribe here:" };
  it("has the fixed text, the signature and the real footer with Mailgun's placeholder", () => {
    const e = replyTestEmail({ signature: "Arslan\r\nPolygon Paradise\n", footer });
    expect(e.subject).toBe(REPLY_TEST_SUBJECT);
    expect(e.text).toContain('Please reply to this email with a short message such as "Got it".');
    expect(e.text).toContain("If it landed in spam, move it to your inbox first, then reply.");
    expect(e.text).toContain("Arslan\nPolygon Paradise\n\n--\nPolygon Paradise · Lahore\nUnsubscribe here: %unsubscribe_url%");
    expect(e.html).toContain('<a href="%unsubscribe_url%">%unsubscribe_url%</a>');
    expect(e.html).toContain("<p>Hi,</p>");
  });
  it("works without a signature", () => {
    const e = replyTestEmail({ signature: "  ", footer });
    expect(e.text).toMatch(/then reply\.\n\n--\n/);
  });
});

describe("validateTestList", () => {
  const ctx = { sendingDomains: ["send.example.com"], teammateInboxes: [{ name: "Ali", inbox: "ali.khan@gmail.com" }] };
  it("stores bare lowercase addresses once, and warns about a teammate's reply inbox", () => {
    const res = validateTestList(["T.Gmail@Gmail.com", "t.gmail@gmail.com", "Ana <ana@outlook.com>", "", "ali.khan@gmail.com"], ctx);
    expect(res).toEqual({
      ok: true,
      value: ["t.gmail@gmail.com", "ana@outlook.com", "ali.khan@gmail.com"],
      warnings: [
        "ali.khan@gmail.com is Ali's reply inbox. Gmail hides emails sent to and from the same address, so use a different mailbox.",
      ],
    });
  });
  it("refuses invalid addresses, the sending domain and more than 10", () => {
    expect(validateTestList(["nope"], ctx)).toEqual({ ok: false, error: "nope isn't a valid email address. Check it and try again." });
    expect(validateTestList(["x@send.example.com"], ctx)).toEqual({
      ok: false,
      error: "x@send.example.com is on your sending domain. Use a normal mailbox, such as Gmail or Outlook.com.",
    });
    expect(validateTestList(["x@reply.send.example.com"], ctx).ok).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => `t${i}@gmail.com`);
    expect(validateTestList(eleven, ctx)).toEqual({ ok: false, error: "Your test list can hold 10 addresses at most. Remove one first." });
  });
});
