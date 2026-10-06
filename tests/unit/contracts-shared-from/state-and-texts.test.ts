import { describe, expect, it } from "vitest";
import { parseAuthResults, replyTestPassedFor, validateTestList } from "@/core/reply-test";
import { DEFAULT_UNSUBSCRIBE_TEST, type ReplyTestOriginal } from "@/core/setting-types";
import { parseDomainCheckState, parsePacerState, parseUnsubscribeTest } from "@/core/system-state-parse";
import { waitingText } from "@/components/campaigns/format";
import { MODE_GATE_TEXTS } from "@/core/sending/mode-gates";
import { MailgunError, SENDER_TEXT, plainMailgunError } from "@/server/mailgun/errors";
import { testOriginal } from "../setup-core/originals";

/**
 * The shared From address's state, settings and text contracts (docs/dev/SHARED-FROM-DESIGN.md §7.1–§7.2, §7.5, §7.8):
 * the parsers keep the new optional fields only when they are well-typed and add nothing to shapes of before; a stored
 * reply-test pass counts per (domain, From); the test list refuses the shared From; the new wait reason and error kind
 * have their sentences; the pasted-original fixture reads like the real thing.
 */

const ORIGINAL: ReplyTestOriginal = {
  domain: "send.example.com",
  from: "contact@example.com",
  address: "tess@gmail.com",
  testSendId: 7,
  returnPathDomain: "send.example.com",
  returnPathOk: true,
  dmarc: "pass",
  dkimSigner: "example.com",
  mailtoDomain: "send.example.com",
  mailtoOk: true,
  readAt: "2026-09-27T17:05:00.000Z",
};

describe("replyTestPassedFor (F12)", () => {
  const passed = { status: "passed" as const, domain: "send.example.com" };

  it("a pass without `from` counts only in per-person mode, on its own domain", () => {
    expect(replyTestPassedFor(passed, "send.example.com", null)).toBe(true);
    expect(replyTestPassedFor(passed, "Send.Example.com", null)).toBe(true);
    expect(replyTestPassedFor({ ...passed, from: null }, "send.example.com", "")).toBe(true);
    expect(replyTestPassedFor(passed, "send.example.com", "contact@example.com")).toBe(false);
    expect(replyTestPassedFor(passed, "send2.example.com", null)).toBe(false);
    expect(replyTestPassedFor(passed, null, null)).toBe(false);
    expect(replyTestPassedFor({ ...passed, domain: null }, "send.example.com", null)).toBe(false);
    expect(replyTestPassedFor({ ...passed, status: "failed" }, "send.example.com", null)).toBe(false);
    expect(replyTestPassedFor({ ...passed, status: "untested" }, "send.example.com", null)).toBe(false);
  });

  it("a pass with `from` counts only for that same From address", () => {
    const team = { ...passed, from: "contact@example.com" };
    expect(replyTestPassedFor(team, "send.example.com", "contact@example.com")).toBe(true);
    expect(replyTestPassedFor(team, "send.example.com", " Contact@Example.com ")).toBe(true);
    expect(replyTestPassedFor(team, "send.example.com", "info@example.com")).toBe(false);
    expect(replyTestPassedFor(team, "send.example.com", null)).toBe(false);
  });
});

describe("validateTestList with teamFrom (F15)", () => {
  const ctx = { sendingDomains: ["send.example.com"], teammateInboxes: [] };

  it("refuses the shared From address as a test mailbox; absent or null keeps today's rules", () => {
    expect(validateTestList(["tess@gmail.com", "contact@example.com"], ctx)).toEqual({
      ok: true,
      value: ["tess@gmail.com", "contact@example.com"],
      warnings: [],
    });
    expect(validateTestList(["contact@example.com"], { ...ctx, teamFrom: null })).toMatchObject({ ok: true });
    // Its own sentence (review SCREENS-04): the From card's "is on your test list" doesn't fit an address being added.
    expect(validateTestList(["tess@gmail.com", "Contact@Example.com"], { ...ctx, teamFrom: "contact@example.com" })).toEqual({
      ok: false,
      error: "contact@example.com is your From address, so it can't be a test mailbox. Use a normal mailbox, such as Gmail or Outlook.com.",
    });
    expect(validateTestList(["tess@gmail.com", "info@example.com"], { ...ctx, teamFrom: "contact@example.com" })).toEqual({
      ok: true,
      value: ["tess@gmail.com", "info@example.com"],
      warnings: [],
    });
    // The sending-domain rule still comes first.
    expect(validateTestList(["ali@send.example.com"], { ...ctx, teamFrom: "contact@example.com" })).toMatchObject({ ok: false, error: expect.stringContaining("is on your sending domain") });
  });
});

describe("parseUnsubscribeTest keeps the shared-From fields only when well-typed (§7.2)", () => {
  it("adds nothing to a shape of before", () => {
    const s = parseUnsubscribeTest({
      setup: "B",
      status: "passed",
      domain: "send.example.com",
      mailboxes: [{ address: "tess@gmail.com", provider: "gmail", inboxOk: true, authOk: "pass", authFromHeaders: true }],
      headersOk: true,
    });
    expect("from" in s).toBe(false);
    expect("original" in s).toBe(false);
    expect(Object.keys(s.mailboxes[0]!).sort()).toEqual(["address", "authFromHeaders", "authOk", "inboxOk", "provider"]);
    expect(parseUnsubscribeTest(undefined)).toEqual(DEFAULT_UNSUBSCRIBE_TEST);
    expect("from" in parseUnsubscribeTest(undefined)).toBe(false);
  });

  it("keeps from, the original and the new mailbox answers when their types are right", () => {
    const s = parseUnsubscribeTest({
      status: "passed",
      domain: "send.example.com",
      from: "contact@example.com",
      original: ORIGINAL,
      mailboxes: [
        { address: "tess@gmail.com", provider: "gmail", inboxOk: true, authOk: "pass", placementOk: true, dmarcOk: "pass", dmarcFromHeaders: true },
        { address: "tess@outlook.com", provider: "microsoft", placementOk: false, dmarcOk: "unsure" },
        { address: "x@yahoo.com", provider: "yahoo", placementOk: null, dmarcOk: null },
      ],
    });
    expect(s.from).toBe("contact@example.com");
    expect(s.original).toEqual(ORIGINAL);
    expect(s.original).not.toBe(ORIGINAL);
    expect(s.mailboxes.map((m) => [m.placementOk, m.dmarcOk, m.dmarcFromHeaders])).toEqual([
      [true, "pass", true],
      [false, "unsure", undefined],
      [null, null, undefined],
    ]);
    expect(parseUnsubscribeTest({ from: null, original: null })).toMatchObject({ from: null, original: null });
    const nullable = { ...ORIGINAL, returnPathDomain: null, returnPathOk: null, dmarc: null, dkimSigner: null, mailtoDomain: null, mailtoOk: null };
    expect(parseUnsubscribeTest({ original: nullable }).original).toEqual(nullable);
  });

  it("drops what is of the wrong type, and a half-read original entirely (fail closed)", () => {
    const s = parseUnsubscribeTest({
      from: 42,
      mailboxes: [{ address: "tess@gmail.com", placementOk: "yes", dmarcOk: "maybe", dmarcFromHeaders: 1 }],
    });
    expect("from" in s).toBe(false);
    expect(Object.keys(s.mailboxes[0]!)).not.toEqual(expect.arrayContaining(["placementOk"]));
    expect("dmarcOk" in s.mailboxes[0]!).toBe(false);
    expect("dmarcFromHeaders" in s.mailboxes[0]!).toBe(false);
    const broken: Array<Record<string, unknown>> = [
      { ...ORIGINAL, domain: "" },
      { ...ORIGINAL, testSendId: "7" },
      { ...ORIGINAL, readAt: "yesterday" },
      { ...ORIGINAL, returnPathOk: "true" },
      { ...ORIGINAL, dmarc: "bestguesspass" },
      { ...ORIGINAL, mailtoOk: undefined },
    ];
    for (const original of broken) expect("original" in parseUnsubscribeTest({ original })).toBe(false);
    const { mailtoOk: _dropped, ...missing } = ORIGINAL;
    void _dropped;
    expect("original" in parseUnsubscribeTest({ original: missing })).toBe(false);
    expect("original" in parseUnsubscribeTest({ original: "text" })).toBe(false);
  });
});

describe("the new rows and wait reason survive the SystemState parsers (§7.2)", () => {
  it("keeps from-mx and from-spf rows and the main-domain-mx wait reason", () => {
    const state = parseDomainCheckState({
      domain: "send.example.com",
      rows: [
        { key: "dmarc", group: "dns", status: "ok", title: "Mail servers know your policy (DMARC)", text: "", fix: null, records: [], detail: null },
        { key: "from-mx", group: "dns", status: "bad", title: "Mail for example.com stays with your mail provider (MX)", text: "t", fix: "f", records: [], detail: null },
        { key: "from-spf", group: "dns", status: "info", title: "example.com's SPF record (your everyday email)", text: "t", fix: null, records: [], detail: null },
        { key: "from-nothing", group: "dns", status: "ok", title: "x", text: "", fix: null, records: [], detail: null },
      ],
    });
    expect(state.rows.map((r) => [r.key, r.status])).toEqual([
      ["dmarc", "ok"],
      ["from-mx", "bad"],
      ["from-spf", "info"],
    ]);
    const pacer = parsePacerState({ waiting: { reason: "main-domain-mx", until: null, at: "2026-09-27T12:00:00.000Z" } });
    expect(pacer.waiting).toEqual({ reason: "main-domain-mx", until: null, at: "2026-09-27T12:00:00.000Z" });
  });

  it("the campaign page words the new wait (§3.7): a Mailgun MX or none at all, like the notice and the gate (review SCREENS-07)", () => {
    const line = waitingText({ reason: "main-domain-mx", until: null }, { timeZone: "Europe/Berlin", senderName: "Ali" });
    expect(line).toBe(
      "Waiting: mail for your main domain points to Mailgun or is missing, so replies forwarded to your inbox would be lost. The Owner can see how to fix it in Settings › Domain checklist.",
    );
    expect(line).toContain("points to Mailgun or is missing");
    expect(MODE_GATE_TEXTS.fromMx).toContain("points to Mailgun or is missing");
  });

  it("the client's sender check has its own plain sentence (kind \"sender\", no request made)", () => {
    const err = new MailgunError({ kind: "sender", message: "Stopped by the sender check: x", requestStarted: false });
    expect(err.ambiguous).toBe(false);
    expect(plainMailgunError(err)).toBe(SENDER_TEXT);
    expect(SENDER_TEXT).toBe(
      "An email's From address or reply address doesn't fit your sending domain. Check the From address in Settings › Sending & Mailgun, then try again.",
    );
  });
});

describe("the pasted-original fixture (tests/unit/setup-core/originals.ts)", () => {
  const from = "Arslan from Polygon Paradise <contact@example.com>";
  const messageId = "pp.0123456789abcdef01234567@send.example.com";

  it("builds a Gmail-style original the app's header reader understands", () => {
    const text = testOriginal({ from, messageId, replyTo: "arslan@send.example.com" });
    expect(text).toContain("Return-Path: <bounce+1a2b3c.4d5e6f-tess=gmail.com@send.example.com>");
    expect(text).toContain('smtp.mailfrom="bounce+1a2b3c.4d5e6f-tess=gmail.com@send.example.com"');
    expect(text).toContain("dkim=pass header.i=@example.com header.s=pdk1");
    expect(text).toContain("dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com");
    expect(text).toContain("List-Unsubscribe: <mailto:u+");
    expect(text).toContain(`From: ${from}`);
    expect(text).toContain("Reply-To: arslan@send.example.com");
    expect(text).toContain(`Message-Id: <${messageId}>`);
    expect(text).toMatch(/\nAuthentication-Results: mx\.google\.com;\n {7}dkim=pass/);
    expect(parseAuthResults(text, { from: "contact@example.com" })).toBe("pass");
    expect(parseAuthResults(testOriginal({ from, messageId, dkim: "fail" }), { from: "contact@example.com" })).toBe("fail");
  });

  it("builds an Outlook.com-style original: folded results, header.d, the domain-only smtp.mailfrom, a low Return-Path", () => {
    const text = testOriginal({ from, messageId, provider: "outlook", dmarc: "bestguesspass" });
    expect(text).toContain("smtp.mailfrom=send.example.com;");
    expect(text).toContain("header.d=example.com;dmarc=bestguesspass action=none\n header.from=example.com;");
    expect(text.indexOf("Return-Path: bounce+")).toBeGreaterThan(text.indexOf("Message-Id:"));
    expect(text).toContain("To: tess@outlook.com");
    expect(parseAuthResults(text, { from: "contact@example.com" })).toBe("pass");
  });

  it("leaves out what it is told to", () => {
    const none = testOriginal({ from, messageId, returnPath: null, dkimD: null, dmarc: null, listUnsubscribe: null });
    expect(none).not.toContain("Return-Path");
    expect(none).not.toContain("smtp.mailfrom");
    expect(none).not.toContain("DKIM-Signature");
    expect(none).not.toContain("dmarc=");
    expect(none).not.toContain("List-Unsubscribe");
    const noHeader = testOriginal({ from, messageId, returnPathHeader: false, provider: "outlook" });
    expect(noHeader).not.toContain("Return-Path");
    expect(noHeader).toContain("smtp.mailfrom=send.example.com");
    const crlf = testOriginal({ from, messageId, newline: "\r\n", extraHeaders: [["X-Test", "1"]] });
    expect(crlf.startsWith("X-Test: 1\r\n")).toBe(true);
    expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
    expect(testOriginal({ from, messageId, returnPath: "bounce+x@example.com", listUnsubscribe: "<mailto:u+x@example.com>" })).toContain(
      "Return-Path: <bounce+x@example.com>",
    );
  });
});
