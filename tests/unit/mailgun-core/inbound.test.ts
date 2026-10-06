import { describe, expect, it } from "vitest";
import { normalizeLogItem } from "@/core/mailgun/events";
import {
  extractMessageIds,
  headerValues,
  lowerKeys,
  parseAddressHeader,
  parseInboundForm,
  parseMessageHeaders,
  parseStoredLogOnly,
  parseStoredMessage,
} from "@/core/mailgun/inbound";

const NOW = new Date("2026-02-12T18:30:00Z");
const MESSAGE_URL =
  "https://storage-europe-west1.api.mailgun.net/v3/domains/send.example.com/messages/BAABAAdzYub9ZBnyVMlI_YnQHR1rCYY1Yg";

/** A notify POST as `request.formData()` gives it (mailgun-api-reference §13.2). */
function notifyForm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    domain: "send.example.com",
    recipient: "Ali@Send.Example.com",
    sender: "bounce+123@firma.de",
    from: "Anna Berg <anna@firma.de>",
    subject: "Re: Your 3D models",
    "body-plain": "Thanks, sounds good.\n\nOn Tue, Ali wrote:\n> Hi Anna",
    "stripped-text": "Thanks,\n  sounds   good.",
    "message-headers": JSON.stringify([
      ["Received", "from mail.firma.de by mxa.eu.mailgun.org"],
      ["Message-Id", "<Reply.1@firma.de>"],
      ["In-Reply-To", "<pp.abc@send.example.com>"],
      ["References", "<pp.first@send.example.com>\r\n <pp.abc@send.example.com>"],
      ["Subject", "Re: Your 3D models"],
      ["subject", "Re: Your 3D models"],
    ]),
    "message-url": MESSAGE_URL,
    attachments: "[]",
    timestamp: "1770918000",
    token: "e0b5477167110d68991efc6b9f89f0a11066af27834600e123",
    signature: "6ae8ba140d2536fd21c45a0db161e962a424ed6ca953c96a63182621e118ee13",
    ...overrides,
  };
}

describe("lowerKeys", () => {
  it("lowercases field names; the first non-empty value wins", () => {
    expect(lowerKeys({ "Content-id-map": "{}", Recipient: "a@x.com", recipient: "b@x.com" })).toEqual({
      "content-id-map": "{}",
      recipient: "a@x.com",
    });
    expect(lowerKeys({ Subject: "", subject: "Hello" })).toEqual({ subject: "Hello" });
  });

  it("keeps a field called __proto__ as a plain field", () => {
    const out = lowerKeys({ ["__proto__"]: "x", a: "1" });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
  });
});

describe("parseMessageHeaders and headerValues", () => {
  it("reads the notify POST's JSON string and the stored message's array", () => {
    const pairs: Array<[string, string]> = [
      ["Subject", "Hello"],
      ["subject", "Hello again"],
      ["Message-Id", "<a@x.com>"],
    ];
    expect(parseMessageHeaders(JSON.stringify(pairs))).toEqual(pairs);
    expect(parseMessageHeaders(pairs)).toEqual(pairs);
  });

  it("keeps duplicate and case-variant headers, found case-insensitively", () => {
    const headers = parseMessageHeaders(JSON.stringify([["Subject", "A"], ["subject", "B"], ["X-Other", "C"]]));
    expect(headerValues(headers, "SUBJECT")).toEqual(["A", "B"]);
    expect(headerValues(headers, "missing")).toEqual([]);
  });

  it("gives [] for anything unreadable and skips bad entries", () => {
    expect(parseMessageHeaders("{not json")).toEqual([]);
    expect(parseMessageHeaders('{"a":1}')).toEqual([]);
    expect(parseMessageHeaders(null)).toEqual([]);
    expect(parseMessageHeaders(undefined)).toEqual([]);
    expect(parseMessageHeaders([["Only-name"], [1, "x"], ["X-Num", 5], ["X-Null", null]])).toEqual([
      ["X-Num", "5"],
      ["X-Null", ""],
    ]);
  });

  it("caps the list at 200 pairs and 32 KB", () => {
    const many = Array.from({ length: 250 }, (_, i) => [`X-H${i}`, "v"]);
    expect(parseMessageHeaders(many)).toHaveLength(200);
    const big = Array.from({ length: 40 }, (_, i) => [`Received`, `${i}`.padEnd(1000, "x")]);
    big.push(["Message-Id", "<late@x.com>"]);
    const capped = parseMessageHeaders(big);
    const size = capped.reduce((n, [a, b]) => n + a.length + b.length, 0);
    expect(size).toBeLessThanOrEqual(32 * 1024);
    expect(capped.length).toBeLessThan(41);
    expect(headerValues(capped, "Message-Id")).toEqual(["<late@x.com>"]);
  });
});

describe("extractMessageIds", () => {
  it("reads References chains in order, without brackets or duplicates", () => {
    expect(extractMessageIds("<PP.First@send.example.com>\r\n <pp.abc@send.example.com> <pp.first@send.example.com>")).toEqual([
      "pp.first@send.example.com",
      "pp.abc@send.example.com",
    ]);
    expect(extractMessageIds("<a@x.com>,<b@y.com>")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("reads ids written without brackets", () => {
    expect(extractMessageIds("a@x.com b@y.com")).toEqual(["a@x.com", "b@y.com"]);
    expect(extractMessageIds("not-an-id")).toEqual([]);
    expect(extractMessageIds("")).toEqual([]);
    expect(extractMessageIds(null)).toEqual([]);
  });
});

describe("parseAddressHeader", () => {
  it("reads the usual forms", () => {
    expect(parseAddressHeader("Anna Berg <anna@firma.de>")).toEqual({ email: "anna@firma.de", name: "Anna Berg" });
    expect(parseAddressHeader('"Berg, Anna" <anna@firma.de>')).toEqual({ email: "anna@firma.de", name: "Berg, Anna" });
    expect(parseAddressHeader("<anna@firma.de>")).toEqual({ email: "anna@firma.de", name: null });
    expect(parseAddressHeader("anna@firma.de")).toEqual({ email: "anna@firma.de", name: null });
    expect(parseAddressHeader("anna@firma.de (Anna Berg)")).toEqual({ email: "anna@firma.de", name: "Anna Berg" });
    expect(parseAddressHeader("anna@firma.de <anna@firma.de>")).toEqual({ email: "anna@firma.de", name: null });
  });

  it("takes the first address of a list", () => {
    expect(parseAddressHeader('"Berg, Anna" <anna@firma.de>, Bo <bo@firma.de>')).toEqual({ email: "anna@firma.de", name: "Berg, Anna" });
    expect(parseAddressHeader("a@x.com, b@y.com")).toEqual({ email: "a@x.com", name: null });
  });

  it("decodes encoded names", () => {
    expect(parseAddressHeader("=?UTF-8?B?QW5uYSBCw6ly?= <anna@firma.de>")).toEqual({ email: "anna@firma.de", name: "Anna Bér" });
    expect(parseAddressHeader("=?iso-8859-1?Q?J=F8rgen_Hansen?= <j@firma.no>")).toEqual({ email: "j@firma.no", name: "Jørgen Hansen" });
  });

  it("returns null without a usable address", () => {
    expect(parseAddressHeader("Anna Berg")).toBeNull();
    expect(parseAddressHeader("")).toBeNull();
    expect(parseAddressHeader("Anna <not an address>")).toBeNull();
  });
});

describe("parseInboundForm", () => {
  it("reads a notify POST", () => {
    const p = parseInboundForm(notifyForm(), NOW)!;
    expect(p).toMatchObject({
      recipient: "ali@send.example.com",
      fromEmail: "anna@firma.de",
      fromName: "Anna Berg",
      subject: "Re: Your 3D models",
      snippet: "Thanks, sounds good.",
      messageIdHeader: "reply.1@firma.de",
      inReplyTo: "pp.abc@send.example.com",
      references: ["pp.first@send.example.com", "pp.abc@send.example.com"],
      storageKey: "BAABAAdzYub9ZBnyVMlI_YnQHR1rCYY1Yg",
      messageUrl: MESSAGE_URL,
    });
    expect(p.headers).toHaveLength(6);
    expect(p.receivedAt.toISOString()).toBe(new Date(1770918000 * 1000).toISOString());
  });

  it("reads field names in any case", () => {
    const upper = Object.fromEntries(Object.entries(notifyForm()).map(([k, v]) => [k.toUpperCase(), v]));
    expect(parseInboundForm(upper, NOW)?.recipient).toBe("ali@send.example.com");
    expect(parseInboundForm(upper, NOW)?.messageIdHeader).toBe("reply.1@firma.de");
  });

  it("falls back to body-plain, the sender and the headers", () => {
    const p = parseInboundForm(notifyForm({ "stripped-text": "", from: "" }), NOW)!;
    expect(p.snippet).toBe("Thanks, sounds good. On Tue, Ali wrote: > Hi Anna");
    expect(p.fromEmail).toBe("bounce+123@firma.de");
    const noSubject = parseInboundForm(notifyForm({ subject: "" }), NOW)!;
    expect(noSubject.subject).toBe("Re: Your 3D models");
  });

  it("caps the snippet at 300 characters", () => {
    const p = parseInboundForm(notifyForm({ "stripped-text": "word\n\n ".repeat(200) }), NOW)!;
    expect(p.snippet.length).toBeLessThanOrEqual(300);
    expect(p.snippet).not.toMatch(/\s{2}/);
    expect(p.snippet.endsWith("…")).toBe(true);
  });

  it("uses the time of the call when the signed timestamp is missing or in the future", () => {
    expect(parseInboundForm(notifyForm({ timestamp: "" }), NOW)?.receivedAt.toISOString()).toBe(NOW.toISOString());
    expect(parseInboundForm(notifyForm({ timestamp: "1870918000" }), NOW)?.receivedAt.toISOString()).toBe(NOW.toISOString());
  });

  it("returns null without a recipient or a sender", () => {
    expect(parseInboundForm(notifyForm({ recipient: "" }), NOW)).toBeNull();
    expect(parseInboundForm(notifyForm({ from: "", sender: "" }), NOW)).toBeNull();
  });
});

describe("parseStoredMessage", () => {
  /** The stored-message JSON from the research (§7): raw headers as top-level keys, message-headers as an array. */
  const stored = {
    "Content-Type": "multipart/form-data; boundary=----SomeFormBoundaryABC123",
    From: "foo.bar@my-domain.com",
    "Message-Id": "<xxxxxxxxxxxxx.111111111111111@my-domain.com>",
    "Mime-Version": "1.0",
    Subject: '"Mailgun is awesome"',
    To: "Cool Bar <cool.barr@cool.com>, bar.baz@gmail.com",
    sender: "foo.bar@my-domain.com",
    recipients: "cool.barr@cool.com, bar.baz@gmail.com",
    "body-html": "<html>This is some html</html>",
    "body-plain": "This is some html",
    "stripped-text": "This is some html",
    "message-headers": [
      ["Mime-Version", "1.0"],
      ["Subject", '"Mailgun is awesome"'],
      ["From", "foo.bar@my-domain.com"],
      ["Message-Id", "<xxxxxxxxxxxxx.111111111111111@my-domain.com>"],
      ["Content-Type", "text/html; charset=ascii"],
    ],
  };
  const at = new Date("2026-02-12T18:00:00Z");

  it("reads the research example with what the Logs event knew", () => {
    const p = parseStoredMessage(stored, { recipient: "ali@send.example.com", storageKey: "KEY1", at })!;
    expect(p).toMatchObject({
      recipient: "ali@send.example.com",
      fromEmail: "foo.bar@my-domain.com",
      fromName: null,
      subject: '"Mailgun is awesome"',
      snippet: "This is some html",
      messageIdHeader: "xxxxxxxxxxxxx.111111111111111@my-domain.com",
      inReplyTo: null,
      references: [],
      storageKey: "KEY1",
    });
    expect(p.headers).toHaveLength(5);
    expect(p.receivedAt).toBe(at);
  });

  it("finds the recipient and keys in any case without a fallback", () => {
    const lower = Object.fromEntries(Object.entries(stored).map(([k, v]) => [k.toLowerCase(), v]));
    const p = parseStoredMessage(lower, { at })!;
    expect(p.recipient).toBe("cool.barr@cool.com");
    expect(p.messageIdHeader).toBe("xxxxxxxxxxxxx.111111111111111@my-domain.com");
    expect(p.storageKey).toBeNull();
  });

  it("returns null for anything that isn't a message", () => {
    expect(parseStoredMessage("text", { at })).toBeNull();
    expect(parseStoredMessage({ recipients: "a@x.com" }, { at })).toBeNull();
  });
});

describe("parseStoredLogOnly", () => {
  const item = {
    id: "st-1",
    event: "stored",
    "@timestamp": "2026-02-12T17:50:00.000Z",
    recipient: "ali@send.example.com",
    domain: { name: "send.example.com" },
    message: {
      headers: {
        from: "Anna <anna@firma.de>",
        to: "ali@send.example.com",
        subject: "Re: Hi",
        "message-id": "<Reply9@firma.de>",
      },
    },
    storage: { key: "KEY9", url: ["https://storage-europe-west1.api.mailgun.net/v3/domains/send.example.com/messages/KEY9"] },
    flags: { "is-routed": true },
  };

  it("builds the reply from the Logs item's headers, with no text", () => {
    const p = parseStoredLogOnly(item)!;
    expect(p).toMatchObject({
      recipient: "ali@send.example.com",
      fromEmail: "anna@firma.de",
      fromName: "Anna",
      subject: "Re: Hi",
      snippet: "",
      messageIdHeader: "reply9@firma.de",
      storageKey: "KEY9",
      messageUrl: "https://storage-europe-west1.api.mailgun.net/v3/domains/send.example.com/messages/KEY9",
    });
    expect(p.receivedAt.toISOString()).toBe("2026-02-12T17:50:00.000Z");
  });

  it("accepts the NormalizedEvent made from the same item", () => {
    const n = normalizeLogItem(item)!;
    expect(parseStoredLogOnly(n)).toEqual(parseStoredLogOnly(item));
  });

  it("returns null when the item says nothing usable", () => {
    expect(parseStoredLogOnly(null)).toBeNull();
    expect(parseStoredLogOnly({ id: "x", event: "stored" })).toBeNull();
  });
});
