import { describe, expect, it } from "vitest";
import { parseTestOriginal, testOriginalTexts } from "@/core/reply-test";
import { testOriginal, type TestOriginalOptions } from "./originals";

/**
 * The pasted original of a reply-test email (SHARED-FROM-DESIGN §3.4, F25): `parseTestOriginal` reads the From, the
 * return address (Return-Path, else SPF's smtp.mailfrom), DMARC, the passing DKIM signer of the From domain and the
 * List-Unsubscribe `mailto:` host from Gmail- and Outlook.com-shaped originals, and never keeps the text;
 * `testOriginalTexts` words one line per check.
 */

const D = "send.example.com";
const ORG = "example.com";
const FROM_LINE = "Arslan from Polygon Paradise <contact@example.com>";
const ID = "pp.t.71.1a2b3c4d5e6f@send.example.com";
const opts = { sendingDomain: D, fromDomain: ORG };

const read = (o: Partial<TestOriginalOptions> = {}) =>
  parseTestOriginal(testOriginal({ from: FROM_LINE, messageId: ID, replyTo: "arslan@send.example.com", ...o }), opts);

describe("parseTestOriginal", () => {
  // MAIN-DOMAIN-DESIGN §3.5: every read also carries the unsubscribe link's scheme and the whole mailto: address.
  const MAILTO = "u+na6tmy3ege4tgnldmyytqojqmvqtoylf@send.example.com";

  it("reads a Gmail original: Message-ID, From, return address, DMARC, signer and mailto host", () => {
    expect(read()).toEqual({
      messageId: ID,
      from: "contact@example.com",
      returnPathDomain: D,
      returnPathOk: true,
      dmarc: "pass",
      dkimSigner: ORG,
      mailtoDomain: D,
      mailtoOk: true,
      unsubscribeScheme: "https",
      mailtoAddress: MAILTO,
    });
  });

  it("reads an Outlook.com original the same way (1-space folds, header.d, Return-Path far below)", () => {
    expect(read({ provider: "outlook" })).toEqual({
      messageId: ID,
      from: "contact@example.com",
      returnPathDomain: D,
      returnPathOk: true,
      dmarc: "pass",
      dkimSigner: ORG,
      mailtoDomain: D,
      mailtoOk: true,
      unsubscribeScheme: "https",
      mailtoAddress: MAILTO,
    });
  });

  it("the return address: on the sending domain or under it is fine; the From domain or anything else isn't", () => {
    expect(read({ returnPath: "bounce+x@send.example.com" })).toMatchObject({ returnPathDomain: D, returnPathOk: true });
    expect(read({ returnPath: "bounce+x@email.send.example.com" })).toMatchObject({ returnPathDomain: "email.send.example.com", returnPathOk: true });
    expect(read({ returnPath: "bounce+x@example.com" })).toMatchObject({ returnPathDomain: ORG, returnPathOk: false });
    expect(read({ returnPath: "bounce+x@other.example" })).toMatchObject({ returnPathDomain: "other.example", returnPathOk: false });
    expect(read({ returnPath: "bounce+x@example.com", provider: "outlook" })).toMatchObject({ returnPathOk: false });
  });

  it("without a Return-Path header it reads SPF's smtp.mailfrom; with neither it is unknown", () => {
    expect(read({ returnPath: "bounce+x@send.example.com", returnPathHeader: false })).toMatchObject({ returnPathDomain: D, returnPathOk: true });
    expect(read({ returnPath: "bounce+x@example.com", returnPathHeader: false, provider: "outlook" })).toMatchObject({
      returnPathDomain: ORG,
      returnPathOk: false,
    });
    expect(read({ returnPath: null })).toMatchObject({ returnPathDomain: null, returnPathOk: null });
  });

  it("the List-Unsubscribe mailto: host", () => {
    expect(read({ listUnsubscribe: "<mailto:u+x@send.example.com?subject=unsubscribe>, <https://email.send.example.com/u/x>" })).toMatchObject({
      mailtoDomain: D,
      mailtoOk: true,
    });
    expect(read({ listUnsubscribe: "<mailto:u+x@example.com>, <https://email.send.example.com/u/x>" })).toMatchObject({
      mailtoDomain: ORG,
      mailtoOk: false,
    });
    expect(read({ listUnsubscribe: "<https://email.send.example.com/u/x>" })).toMatchObject({ mailtoDomain: null, mailtoOk: true });
    expect(read({ listUnsubscribe: null })).toMatchObject({ mailtoDomain: null, mailtoOk: null });
  });

  it("the signer: a passing signature of the From domain or a subdomain; a failed one or another domain's isn't", () => {
    expect(read({ dkimD: "send.example.com" })).toMatchObject({ dkimSigner: D });
    expect(read({ dkimD: ORG, dkim: "fail" })).toMatchObject({ dkimSigner: null });
    expect(read({ dkimD: "mailgun.example" })).toMatchObject({ dkimSigner: null });
    expect(read({ dkimD: null })).toMatchObject({ dkimSigner: null });
  });

  it("ignores a Mailgun ARC set above the mailbox's own results", () => {
    const text = read({
      dmarc: "fail",
      extraHeaders: [["ARC-Authentication-Results", "i=2; mxa.mailgun.org; dkim=pass header.d=example.com; dmarc=pass header.from=example.com"]],
    });
    expect(text).toMatchObject({ dmarc: "fail", dkimSigner: ORG });
    const mailgunOnTop = read({
      dmarc: "fail",
      extraHeaders: [["Authentication-Results", "mxa.mailgun.org; dmarc=pass header.from=example.com; spf=pass smtp.mailfrom=b@example.com"]],
    });
    expect(mailgunOnTop).toMatchObject({ dmarc: "fail", returnPathDomain: D });
  });

  it("folded headers and CRLF pastes read the same", () => {
    expect(read({ newline: "\r\n" })).toEqual(read());
    expect(read({ provider: "outlook", newline: "\r\n" })).toEqual(read({ provider: "outlook" }));
  });

  it("only the message's own headers count: nothing from the body", () => {
    const text = `${testOriginal({ from: FROM_LINE, messageId: ID, returnPath: null })}\nReturn-Path: <x@send.example.com>\nFrom: someone@else.example\n`;
    expect(parseTestOriginal(text, opts)).toMatchObject({ from: "contact@example.com", returnPathDomain: null, returnPathOk: null });
  });

  it("another From address is read as it is (the service refuses it)", () => {
    expect(read({ from: "Arslan <arslan@send.example.com>" })).toMatchObject({ from: "arslan@send.example.com" });
    expect(parseTestOriginal("no headers here", opts)).toEqual({
      messageId: null,
      from: null,
      returnPathDomain: null,
      returnPathOk: null,
      dmarc: null,
      dkimSigner: null,
      mailtoDomain: null,
      mailtoOk: null,
      unsubscribeScheme: null,
      mailtoAddress: null,
    });
  });

  it("the result never carries the pasted text", () => {
    const text = testOriginal({ from: FROM_LINE, messageId: ID, extraHeaders: [["X-Unique-Marker", "paste-7f3a9c"]] });
    const json = JSON.stringify(parseTestOriginal(text, opts));
    expect(json).not.toContain("paste-7f3a9c");
    expect(json).not.toContain("Delivered-To");
    expect(json).not.toContain("Reply test from Polygon Paradise Outreach");
  });
});

describe("own-mailbox mode: the unsubscribe link's scheme and the mailto: address (MAIN-DOMAIN-DESIGN §3.5, O13)", () => {
  const OWN_ID = "pp.t.72.1a2b3c4d5e6f@example.com";
  const ownOpts = { sendingDomain: ORG, fromDomain: ORG };
  const readOwn = (o: Partial<TestOriginalOptions> = {}) =>
    parseTestOriginal(testOriginal({ from: "Arslan from Polygon Paradise <contact@example.com>", messageId: OWN_ID, ...o }), ownOpts);

  it("unsubscribeScheme: https, http, or null without a web link (or without the header)", () => {
    expect(readOwn({ listUnsubscribe: "<mailto:u+x@example.com>, <https://email.example.com/u/x>" }).unsubscribeScheme).toBe("https");
    expect(readOwn({ listUnsubscribe: "<mailto:u+x@example.com>, <http://email.example.com/u/x>" }).unsubscribeScheme).toBe("http");
    expect(readOwn({ listUnsubscribe: "<HTTP://email.example.com/u/x>" }).unsubscribeScheme).toBe("http");
    // The first web link counts.
    expect(readOwn({ listUnsubscribe: "<http://email.example.com/u/x>, <https://email.example.com/u/y>" }).unsubscribeScheme).toBe("http");
    expect(readOwn({ listUnsubscribe: "<mailto:u+x@example.com>" }).unsubscribeScheme).toBeNull();
    expect(readOwn({ listUnsubscribe: null }).unsubscribeScheme).toBeNull();
  });

  it("mailtoAddress: the whole first mailto: address without ?…, lowercase; null without one", () => {
    expect(readOwn({ listUnsubscribe: "<mailto:u+x@example.com?subject=unsubscribe>, <http://email.example.com/u/x>" })).toMatchObject({
      mailtoAddress: "u+x@example.com",
      mailtoDomain: ORG,
      mailtoOk: true,
      unsubscribeScheme: "http",
    });
    expect(readOwn({ listUnsubscribe: "<mailto:U+AbC@Example.COM>" }).mailtoAddress).toBe("u+abc@example.com");
    expect(readOwn({ listUnsubscribe: "<http://email.example.com/u/x>" }).mailtoAddress).toBeNull();
    expect(readOwn({ listUnsubscribe: null }).mailtoAddress).toBeNull();
    // Not one address: none, and flagged as offered but unreadable (review SECURITY-03).
    for (const bad of ["<mailto:no-at-sign>", "<mailto:a@b@example.com>", "<mailto:>", "<mailto:@example.com>", `<mailto:${"u".repeat(1000)}@example.com>`]) {
      expect(readOwn({ listUnsubscribe: bad }), bad).toMatchObject({ mailtoAddress: null, mailtoUnreadable: true });
    }
    // Without a mailto: nothing is flagged.
    expect(readOwn({ listUnsubscribe: "<http://email.example.com/u/x>" })).not.toHaveProperty("mailtoUnreadable");
  });

  it("review SECURITY-03: long u+… tokens, percent-encoding, a quoted local part and a second header are read", () => {
    // Longer than RFC 5321's 254 characters (Mailgun's token format is unverified): kept up to a header line's 998.
    const long = `u+${"a".repeat(260)}@example.com`;
    expect(readOwn({ listUnsubscribe: `<mailto:${long}?subject=unsubscribe>, <http://email.example.com/u/x>` })).toMatchObject({
      mailtoAddress: long,
      mailtoDomain: ORG,
    });
    // RFC 6068: the address may be percent-encoded.
    expect(readOwn({ listUnsubscribe: "<mailto:u%2Bx%40example.com?subject=unsubscribe>" }).mailtoAddress).toBe("u+x@example.com");
    expect(readOwn({ listUnsubscribe: "<mailto:%22a%40b%22@example.com>" }).mailtoAddress).toBe('"a@b"@example.com');
    expect(readOwn({ listUnsubscribe: "<mailto:u%ZZx@example.com>" })).toMatchObject({ mailtoAddress: null, mailtoUnreadable: true });
    // A second List-Unsubscribe header with a mailto: counts too (the shared-From fields still read the first).
    // (extraHeaders come first, so the header without a mailto: is the top-most one here.)
    const two = readOwn({
      listUnsubscribe: "<mailto:u+y@example.com>, <http://email.example.com/u/y>",
      extraHeaders: [["List-Unsubscribe", "<http://email.example.com/u/x>"]],
    });
    expect(two).toMatchObject({ mailtoAddress: "u+y@example.com", unsubscribeScheme: "http", mailtoDomain: null, mailtoOk: true });
  });

  it("testOriginalTexts: a mailto: whose address can't be read is a failed line, never 'not offered'", () => {
    const own = { from: "contact@example.com", d: ORG, org: ORG, ownMailbox: true };
    const lines = testOriginalTexts(readOwn({ listUnsubscribe: "<mailto:a@b@example.com>, <http://email.example.com/u/x>" }), own);
    expect(lines[lines.length - 1]).toEqual({ ok: false, text: "Unsubscribe by email is offered, but the app can't read its address." });
    // A stored original that lost its address but still names the mailto: host reads the same way.
    const stored = { ...readOwn({ listUnsubscribe: "<mailto:u+x@example.com>" }), mailtoAddress: null };
    expect(testOriginalTexts(stored, own).at(-1)).toEqual({ ok: false, text: "Unsubscribe by email is offered, but the app can't read its address." });
  });

  it("a folded List-Unsubscribe header reads the same", () => {
    const folded = readOwn({ listUnsubscribe: "<mailto:u+x@example.com?subject=unsubscribe>,\n <http://email.example.com/u/x>" });
    expect(folded).toMatchObject({ mailtoAddress: "u+x@example.com", unsubscribeScheme: "http" });
    expect(readOwn({ listUnsubscribe: "<mailto:u+x@example.com>,\n <http://email.example.com/u/x>", newline: "\r\n" })).toMatchObject({
      mailtoAddress: "u+x@example.com",
      unsubscribeScheme: "http",
    });
  });

  it("a garbled 200,000-character List-Unsubscribe still reads in linear time", () => {
    const head = `Message-ID: <${OWN_ID}>\nList-Unsubscribe: `;
    for (const junk of ["mailto:".repeat(40_000), "http:/".repeat(40_000), `<mailto:${"a".repeat(200_000)}`, "<h".repeat(100_000)]) {
      const text = (head + junk).slice(0, 200_000);
      const start = performance.now();
      const parsed = parseTestOriginal(text, ownOpts);
      expect(performance.now() - start).toBeLessThan(750);
      expect(parsed.messageId).toBe(OWN_ID);
    }
  });

  it("testOriginalTexts in own-mailbox mode: From, return address, DMARC, signature, the link's scheme, the mailto address", () => {
    const own = { from: "contact@example.com", d: ORG, org: ORG, ownMailbox: true };
    const good = readOwn({ returnPath: "bounce+x@example.com", listUnsubscribe: "<mailto:u+x@example.com>, <http://email.example.com/u/x>" });
    expect(testOriginalTexts(good, own)).toEqual([
      { ok: true, text: "From: contact@example.com ✓" },
      {
        ok: true,
        text: "Return address: …@example.com. Bounces that come later and automatic replies go to your own mailbox (or nowhere), not the app.",
      },
      { ok: true, text: "The original says DMARC: PASS." },
      { ok: true, text: "Signed by example.com ✓" },
      {
        ok: true,
        text: "Unsubscribe link: http. It works when clicked, but Gmail's and Yahoo's one-click unsubscribe button needs https (Mailgun's Foundation plan).",
      },
      { ok: true, text: "Unsubscribe by email goes to u+x@example.com. The question below checks that it reaches a mailbox you read." },
    ]);
    const https = testOriginalTexts(readOwn({ listUnsubscribe: "<https://email.example.com/u/x>" }), own);
    expect(https.slice(4)).toEqual([
      { ok: true, text: "Unsubscribe link: https ✓" },
      { ok: true, text: "Unsubscribe by email: not offered." },
    ]);
    const none = testOriginalTexts(readOwn({ listUnsubscribe: null, returnPath: "bounce+x@other.example", dmarc: "fail" }), own);
    expect(none.map((l) => l.text)).toEqual([
      "From: contact@example.com ✓",
      "Return address: …@other.example, not on example.com. Tell the person who set up the app.",
      "The original says DMARC: FAIL.",
      "Signed by example.com ✓",
      "The original shows no unsubscribe link in its headers.",
      "Unsubscribe by email: not offered.",
    ]);
    expect(none.filter((l) => !l.ok).map((l) => l.text)).toEqual([
      "Return address: …@other.example, not on example.com. Tell the person who set up the app.",
      "The original says DMARC: FAIL.",
      "The original shows no unsubscribe link in its headers.",
    ]);
    expect(testOriginalTexts(readOwn({ returnPath: null }), own)[1]).toEqual({
      ok: false,
      text: "The original doesn't show a return address. Paste the whole original, starting at the first line.",
    });
    // None of the own lines promises that replies or late bounces reach the app.
    for (const l of testOriginalTexts(good, own)) expect(l.text).not.toMatch(/reach the app\)|instead of the app/);
  });

  it("without ownMailbox the lines are exactly as before, whatever the new fields say", () => {
    const ctx = { from: "contact@example.com", d: D, org: ORG };
    const withNew = { ...read(), unsubscribeScheme: "http" as const, mailtoAddress: "u+x@send.example.com" };
    expect(testOriginalTexts(withNew, ctx)).toEqual(testOriginalTexts({ ...read() }, ctx));
  });
});

describe("testOriginalTexts", () => {
  const ctx = { from: "contact@example.com", d: D, org: ORG };

  it("all good: one line per check, each ticked", () => {
    expect(testOriginalTexts(read(), ctx)).toEqual([
      { ok: true, text: "From: contact@example.com ✓" },
      { ok: true, text: "Return address: …@send.example.com ✓ (bounces and automatic replies reach the app)" },
      { ok: true, text: "The original says DMARC: PASS." },
      { ok: true, text: "Signed by example.com ✓" },
      { ok: true, text: "Unsubscribe by email: …@send.example.com ✓" },
    ]);
  });

  it("what went wrong, in words", () => {
    const bad = testOriginalTexts(
      { ...read({ returnPath: "bounce+x@example.com", dmarc: "fail", dkimD: null, listUnsubscribe: "<mailto:u@example.com>" }), from: "arslan@send.example.com" },
      ctx,
    );
    expect(bad.map((l) => l.text)).toEqual([
      "From: arslan@send.example.com, not contact@example.com: paste the original of a test email sent after the From address was set.",
      "Return address: …@example.com, not on send.example.com: bounces and automatic replies would go to your everyday inbox instead of the app.",
      "The original says DMARC: FAIL.",
      "No valid signature found.",
      "Unsubscribe by email goes to …@example.com, not to send.example.com.",
    ]);
    expect(bad.every((l) => !l.ok)).toBe(true);
    const unknown = testOriginalTexts(read({ returnPath: null, listUnsubscribe: "<https://email.send.example.com/u/x>" }), ctx);
    expect(unknown[1]).toEqual({ ok: false, text: "The original doesn't show a return address. Paste the whole original, starting at the first line." });
    expect(unknown[4]).toEqual({ ok: true, text: "Unsubscribe by email: not offered (the link works) ✓" });
  });
});
