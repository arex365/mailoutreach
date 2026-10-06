import { describe, expect, it } from "vitest";
import { normalizeLogItem } from "@/core/mailgun/events";
import {
  BODY_TEXT_MAX,
  STRIPPED_TEXT_MAX,
  headerValues,
  isPriorityHeader,
  parseEnvelopeSender,
  parseInboundForm,
  parseMessageHeaders,
  parseStoredLogOnly,
  parseStoredMessage,
} from "@/core/mailgun/inbound";

/** M4 fields of the inbound parsers (M4-DESIGN §3.2). */

const NOW = new Date("2026-09-23T10:00:00Z");

function form(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    recipient: "ali@send.example.com",
    sender: "Anna@Firma.DE",
    from: "Anna Berg <anna@firma.de>",
    subject: "Re: 3D models",
    "body-plain": "Yes please.\r\n\r\nOn Mon, Ali wrote:\r\n> Hi",
    "stripped-text": "Yes please.\r\nBest, Anna",
    "message-headers": JSON.stringify([
      ["Message-Id", "<r1@firma.de>"],
      ["In-Reply-To", "<pp.abc@send.example.com>"],
    ]),
    timestamp: String(Math.floor(NOW.getTime() / 1000) - 60),
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

describe("parseEnvelopeSender", () => {
  it("the null sender, unknown, and bare lowercase addresses", () => {
    expect(parseEnvelopeSender("")).toBe("");
    expect(parseEnvelopeSender("<>")).toBe("");
    expect(parseEnvelopeSender(" < > ")).toBe("");
    expect(parseEnvelopeSender(null)).toBeNull();
    expect(parseEnvelopeSender(undefined)).toBeNull();
    expect(parseEnvelopeSender("<Bounce+123@Firma.DE>")).toBe("bounce+123@firma.de");
    expect(parseEnvelopeSender("Anna@Firma.de")).toBe("anna@firma.de");
    expect(parseEnvelopeSender("MAILER-DAEMON")).toBe("mailer-daemon");
  });
});

describe("parseInboundForm: envelope sender", () => {
  it("reads `sender`: an address, \"\" and \"<>\" (the null sender)", () => {
    expect(parseInboundForm(form(), NOW)?.envelopeSender).toBe("anna@firma.de");
    expect(parseInboundForm(form({ sender: "" }), NOW)?.envelopeSender).toBe("");
    expect(parseInboundForm(form({ sender: "<>" }), NOW)?.envelopeSender).toBe("");
  });

  it("falls back to X-Envelope-From, else null", () => {
    const headers = (value: string) => JSON.stringify([["X-Envelope-From", value], ["Message-Id", "<r1@firma.de>"]]);
    expect(parseInboundForm(form({ sender: undefined, "message-headers": headers("<>") }), NOW)?.envelopeSender).toBe("");
    expect(parseInboundForm(form({ sender: undefined, "message-headers": headers("<Anna@Firma.de>") }), NOW)?.envelopeSender).toBe(
      "anna@firma.de",
    );
    expect(parseInboundForm(form({ sender: undefined }), NOW)?.envelopeSender).toBeNull();
  });
});

describe("parseInboundForm: texts", () => {
  it("keeps the newlines of stripped-text and body-plain", () => {
    const p = parseInboundForm(form(), NOW)!;
    expect(p.strippedText).toBe("Yes please.\nBest, Anna");
    expect(p.bodyText).toBe("Yes please.\n\nOn Mon, Ali wrote:\n> Hi");
    expect(p.bodyAvailable).toBe(true);
    expect(p.snippet).toBe("Yes please. Best, Anna");
  });

  it("stripped-text: missing or blank → null (Mailgun's parse failed); at most 8,000 characters", () => {
    expect(parseInboundForm(form({ "stripped-text": undefined }), NOW)?.strippedText).toBeNull();
    expect(parseInboundForm(form({ "stripped-text": "  \n " }), NOW)?.strippedText).toBeNull();
    const long = parseInboundForm(form({ "stripped-text": "line\n".repeat(3_000) }), NOW)!.strippedText!;
    expect(STRIPPED_TEXT_MAX).toBe(8_000);
    expect(long).toHaveLength(8_000);
    expect(long.startsWith("line\nline\n")).toBe(true);
  });

  it("body-plain: missing → null; at most 16,000 characters", () => {
    expect(parseInboundForm(form({ "body-plain": undefined }), NOW)?.bodyText).toBeNull();
    expect(BODY_TEXT_MAX).toBe(16_000);
    expect(parseInboundForm(form({ "body-plain": "x".repeat(20_000) }), NOW)!.bodyText).toHaveLength(16_000);
  });

  it("never ends a capped text in half of a surrogate pair", () => {
    const text = `${"a".repeat(7_999)}😀tail`;
    const out = parseInboundForm(form({ "stripped-text": text }), NOW)!.strippedText!;
    expect(out).toHaveLength(7_999);
  });
});

describe("parseStoredMessage: M4 fields", () => {
  const at = new Date("2026-09-23T09:00:00Z");
  const stored = {
    From: "Anna Berg <anna@firma.de>",
    sender: "",
    recipients: "ali@send.example.com",
    "body-plain": "Hi Ali,\nyes.\n",
    "stripped-text": "Hi Ali,\nyes.",
    "message-headers": [
      ["Message-Id", "<r2@firma.de>"],
      ["Auto-Submitted", "auto-replied"],
    ],
  };

  it("reads the envelope sender and the texts", () => {
    const p = parseStoredMessage(stored, { at })!;
    expect(p).toMatchObject({ envelopeSender: "", strippedText: "Hi Ali,\nyes.", bodyText: "Hi Ali,\nyes.\n", bodyAvailable: true });
  });

  it("falls back to X-Envelope-From when `sender` is missing", () => {
    const { sender: _sender, ...rest } = stored;
    const withHeader = { ...rest, "message-headers": [...stored["message-headers"], ["X-Envelope-From", "<anna@firma.de>"]] };
    expect(parseStoredMessage(withHeader, { at })?.envelopeSender).toBe("anna@firma.de");
    expect(parseStoredMessage(rest, { at })?.envelopeSender).toBeNull();
  });
});

describe("parseStoredLogOnly: M4 fields", () => {
  const item = {
    id: "st-2",
    event: "stored",
    "@timestamp": "2026-09-20T17:50:00.000Z",
    recipient: "ali@send.example.com",
    envelope: { sender: "Anna@Firma.de" },
    message: { headers: { from: "Anna <anna@firma.de>", to: "ali@send.example.com", subject: "Re: Hi", "message-id": "<r9@firma.de>" } },
    storage: { key: "KEY9", url: ["https://storage.example/v3/domains/send.example.com/messages/KEY9"] },
  };

  it("has no text and bodyAvailable false, with the envelope sender from envelope.sender", () => {
    const p = parseStoredLogOnly(item)!;
    expect(p).toMatchObject({ bodyAvailable: false, strippedText: null, bodyText: null, snippet: "", envelopeSender: "anna@firma.de" });
    expect(parseStoredLogOnly(normalizeLogItem(item)!)).toEqual(p);
  });

  it("reads the null sender, and the header when the log has no envelope sender", () => {
    expect(parseStoredLogOnly({ ...item, envelope: { sender: "" } })?.envelopeSender).toBe("");
    const noEnvelope = { ...item, envelope: {}, message: { headers: { ...item.message.headers, "x-envelope-from": "<>" } } };
    expect(parseStoredLogOnly(noEnvelope)?.envelopeSender).toBe("");
    expect(parseStoredLogOnly({ ...item, envelope: undefined })?.envelopeSender).toBeNull();
  });
});

describe("the header cap keeps the allow-list first", () => {
  it("keeps Auto-Submitted and X-Mailgun-Sflag when 200 Received headers come first", () => {
    const pairs: Array<[string, string]> = Array.from({ length: 200 }, (_, i) => ["Received", `from relay${i}.example by mx`]);
    pairs.push(["Auto-Submitted", "auto-replied"], ["X-Mailgun-Sflag", "Yes"], ["X-Other", "dropped"]);
    const capped = parseMessageHeaders(JSON.stringify(pairs));
    expect(capped).toHaveLength(200);
    expect(headerValues(capped, "Auto-Submitted")).toEqual(["auto-replied"]);
    expect(headerValues(capped, "X-Mailgun-Sflag")).toEqual(["Yes"]);
    expect(headerValues(capped, "X-Other")).toEqual([]);
    expect(headerValues(capped, "Received")).toHaveLength(198);
    // The kept headers stay in the message's order.
    expect(capped.slice(-2)).toEqual([
      ["Auto-Submitted", "auto-replied"],
      ["X-Mailgun-Sflag", "Yes"],
    ]);
  });

  it("gives the allow-list the 32 KB first too", () => {
    const pairs: Array<[string, string]> = Array.from({ length: 40 }, (_, i) => ["ARC-Seal", `${i}`.padEnd(1_000, "x")]);
    pairs.push(["Content-Type", "multipart/report; report-type=delivery-status"], ["List-Unsubscribe", "<https://x>"]);
    const capped = parseMessageHeaders(pairs);
    expect(headerValues(capped, "Content-Type")).toHaveLength(1);
    expect(headerValues(capped, "List-Unsubscribe")).toHaveLength(1);
    expect(capped.reduce((n, [a, b]) => n + a.length + b.length, 0)).toBeLessThanOrEqual(32 * 1024);
  });

  it("parseInboundForm stores the same capped list", () => {
    const pairs: Array<[string, string]> = Array.from({ length: 210 }, (_, i) => ["Received", `r${i}`]);
    pairs.push(["X-Autoreply", "yes"]);
    const p = parseInboundForm(form({ "message-headers": JSON.stringify(pairs) }), NOW)!;
    expect(p.headers).toHaveLength(200);
    expect(headerValues(p.headers, "X-Autoreply")).toEqual(["yes"]);
  });

  it("isPriorityHeader covers the design's list", () => {
    for (const name of [
      "Content-Type",
      "auto-submitted",
      "X-Autoreply",
      "X-Auto-Response-Suppress",
      "Precedence",
      "X-Precedence",
      "List-Id",
      "List-Unsubscribe",
      "X-Envelope-From",
      "X-Mailer",
      "X-Zendesk-Email-Id",
      "X-Failed-Recipients",
      "X-Loop",
      "X-MS-Exchange-Inbox-Rules-Loop",
      "Feedback-ID",
      "Delivered-To",
      "X-Mailgun-Sflag",
      "X-Mailgun-Sscore",
      "X-Mailgun-Spf",
      "X-Mailgun-Dkim-Check-Result",
      "Message-Id",
      "In-Reply-To",
      "References",
      "From",
      "To",
      "Subject",
    ]) {
      expect({ name, priority: isPriorityHeader(name) }).toEqual({ name, priority: true });
    }
    for (const name of ["Received", "DKIM-Signature", "ARC-Seal", "X-Google-Smtp-Source", "Thread-Index"]) {
      expect(isPriorityHeader(name)).toBe(false);
    }
  });
});
