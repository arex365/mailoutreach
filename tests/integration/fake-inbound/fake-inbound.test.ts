import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { findSentMessage, INBOUND_PRESETS, presetInbound } from "../../fake-mailgun/inbound-presets";
import { hmacSignature } from "../../fake-mailgun/webhooks";

const D = "send.example.com";
const AUTH = "Basic " + Buffer.from("api:key-fake-api").toString("base64");
const OUR_ID = "pp.4f1c9a0b7e2d4c6a8b0e1f23@send.example.com";
const SUBJECT = "3D models for your shop";

const fake = await startFakeMailgun({ domain: D });

beforeEach(() => {
  fake.reset();
});

afterAll(async () => {
  await fake.close();
});

type Json = Record<string, unknown>;

async function admin(f: FakeMailgun, path: string, json?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${f.origin}/__fake/${path}`, {
    method: json === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

/** Ali's email to Anna, sent through the fake (its id is ours unless the fake rewrites ids). */
async function sendToAnna(f: FakeMailgun, extra: Record<string, string> = {}): Promise<string> {
  const body = new URLSearchParams({
    from: "Ali Khan <ali@send.example.com>",
    to: "Anna Berg <anna@firma.de>",
    subject: SUBJECT,
    text: "Hi Anna",
    "h:Message-Id": `<${OUR_ID}>`,
    ...extra,
  });
  const res = await fetch(`${f.origin}/v3/${D}/messages`, { method: "POST", headers: { authorization: AUTH }, body });
  const json = (await res.json()) as { id: string };
  return json.id.replace(/^<|>$/g, "");
}

function headersOf(fields: Record<string, string>): Array<[string, string]> {
  return JSON.parse(fields["message-headers"]!) as Array<[string, string]>;
}

function header(list: Array<[string, string]> | unknown[], name: string): string[] {
  return (list as Array<[string, string]>).filter(([n]) => n.toLowerCase() === name.toLowerCase()).map(([, v]) => v);
}

async function stored(f: FakeMailgun, key: string): Promise<Json> {
  const res = await fetch(`${f.origin}/v3/domains/${D}/messages/${key}`, { headers: { authorization: AUTH } });
  return (await res.json()) as Json;
}

async function storedLogItem(f: FakeMailgun, key: string): Promise<Json> {
  const res = await fetch(`${f.origin}/v1/analytics/logs`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify({ start: new Date(Date.now() - 86_400_000).toUTCString(), end: new Date(Date.now() + 60_000).toUTCString(), events: ["stored"] }),
  });
  const items = ((await res.json()) as { items: Json[] }).items;
  return items.find((i) => (i.storage as { key?: string } | undefined)?.key === key)!;
}

describe("receive(): the M4 inputs (M4-DESIGN §7.3)", () => {
  it("null sender, failed parse, content type, fixed Message-Id and display name; the notify form, the stored JSON and the Logs agree", async () => {
    const r = fake.receive({
      from: "anna@firma.de",
      fromName: "Berg, Anna",
      to: "Ali <ali@send.example.com>",
      subject: `Automatic reply: ${SUBJECT}`,
      text: "I am out of the office.",
      bodyPlain: "I am out of the office.\n\n> Hi Anna",
      strippedText: null,
      envelopeSender: "",
      contentType: 'multipart/report; report-type=delivery-status; boundary="b"',
      messageId: "<Fixed.123@Firma.de>",
      headers: [["Auto-Submitted", "auto-replied"]],
    });
    const f = r.fields;
    expect(f.sender).toBe("");
    expect(f.from).toBe('"Berg, Anna" <anna@firma.de>');
    expect("stripped-text" in f).toBe(false);
    expect(f["body-plain"]).toBe("I am out of the office.\n\n> Hi Anna");
    const hs = headersOf(f);
    expect(header(hs, "X-Envelope-From")).toEqual(["<>"]);
    expect(header(hs, "Content-Type")).toEqual(['multipart/report; report-type=delivery-status; boundary="b"']);
    expect(header(hs, "Message-Id")).toEqual(["<Fixed.123@Firma.de>"]);
    expect(header(hs, "From")).toEqual(['"Berg, Anna" <anna@firma.de>']);
    expect(header(hs, "Auto-Submitted")).toEqual(["auto-replied"]);

    const json = await stored(fake, r.storageKey);
    expect(json).toMatchObject({ sender: "", from: f.from, subject: f.subject, "body-plain": f["body-plain"], recipients: "ali@send.example.com" });
    expect("stripped-text" in json).toBe(false);
    expect(json["message-headers"]).toEqual(hs);

    const item = await storedLogItem(fake, r.storageKey);
    expect((item.envelope as Json).sender).toBe("");
    expect((item.message as { headers: Json }).headers["message-id"]).toBe("Fixed.123@Firma.de");
  });

  it("keeps Milestone 3's defaults: sender = From, stripped-text = body-plain = text, text/plain, no X-Envelope-From", async () => {
    const r = fake.receive({ from: "Anna <anna@firma.de>", to: `ali@${D}`, subject: "Re: hi", text: "Yes" });
    expect(r.fields).toMatchObject({ sender: "anna@firma.de", from: "Anna <anna@firma.de>", "stripped-text": "Yes", "body-plain": "Yes" });
    const hs = headersOf(r.fields);
    expect(header(hs, "X-Envelope-From")).toEqual([]);
    expect(header(hs, "Content-Type")).toEqual(["text/plain; charset=utf-8"]);
    expect(header(hs, "Message-Id")[0]).toMatch(/^<[0-9a-f]{16}@firma\.de>$/);
    expect(((await storedLogItem(fake, r.storageKey)).envelope as Json).sender).toBe("anna@firma.de");
  });

  it("normalises the envelope sender: \"<>\" is the null sender, an address is bare and lowercase", () => {
    expect(fake.receive({ from: "a@b.test", to: `ali@${D}`, subject: "s", text: "t", envelopeSender: "<>" }).fields.sender).toBe("");
    const r = fake.receive({ from: "a@b.test", to: `ali@${D}`, subject: "s", text: "t", envelopeSender: "<Bounce@Mailer.Example>" });
    expect(r.fields.sender).toBe("bounce@mailer.example");
    expect(header(headersOf(r.fields), "X-Envelope-From")).toEqual(["<bounce@mailer.example>"]);
  });
});

describe("admin POST /__fake/inbound presets", () => {
  it("answers one of the fake's sent messages with each preset", async () => {
    await sendToAnna(fake);
    const one = async (preset: string) => {
      const res = await admin(fake, "inbound", { preset, inReplyTo: OUR_ID });
      expect(res.status, preset).toBe(200);
      const fields = res.json.fields as Record<string, string>;
      return { fields, hs: headersOf(fields) };
    };

    const reply = await one("reply");
    expect(reply.fields).toMatchObject({ recipient: "ali@send.example.com", from: '"Anna Berg" <anna@firma.de>', sender: "anna@firma.de", subject: `Re: ${SUBJECT}` });
    expect(reply.fields["stripped-text"]).toBe("Hi Ali,\n\nThanks, this sounds interesting. Could you send a few examples and your prices?\n\nBest,\nAnna");
    expect(header(reply.hs, "In-Reply-To")).toEqual([`<${OUR_ID}>`]);
    expect(header(reply.hs, "References")).toEqual([`<${OUR_ID}>`]);

    const ooo = await one("out-of-office");
    expect(ooo.fields).toMatchObject({ subject: `Automatic reply: ${SUBJECT}`, sender: "", "stripped-text": "I am out of the office until next Monday with limited access to email." });
    expect(header(ooo.hs, "Auto-Submitted")).toEqual(["auto-replied"]);
    expect(header(ooo.hs, "X-Autoreply")).toEqual(["yes"]);
    expect(header(ooo.hs, "X-Envelope-From")).toEqual(["<>"]);
    expect(header(ooo.hs, "In-Reply-To")).toEqual([`<${OUR_ID}>`]);

    const unclear = await one("unclear");
    expect(unclear.fields).toMatchObject({ subject: `Re: ${SUBJECT}`, "stripped-text": "I'm out of the office this week, but yes, we're interested. Please send details." });

    const bounce = await one("bounce-notice");
    expect(bounce.fields).toMatchObject({ from: "mailer-daemon@firma.de", sender: "", subject: `Undeliverable: ${SUBJECT}`, recipient: "ali@send.example.com" });
    expect(bounce.fields["body-plain"]).toBe(
      `Delivery has failed to these recipients or groups:\n\nanna@firma.de\nThe email address couldn't be found.\n\nOriginal message headers:\n\nMessage-ID: <${OUR_ID}>`,
    );
    expect(header(bounce.hs, "Content-Type")).toEqual(['multipart/report; report-type=delivery-status; boundary="b"']);

    const newEmail = await one("new-email");
    expect(newEmail.fields).toMatchObject({ from: '"Anna Berg" <anna@firma.de>', subject: "Question" });
    expect(header(newEmail.hs, "In-Reply-To")).toEqual([]);
    expect(header(newEmail.hs, "References")).toEqual([]);

    const spam = await one("spam");
    expect(spam.fields).toMatchObject({ from: "offers@bulk-mailer.example", recipient: "ali@send.example.com", subject: "Grow your sales 300% this month" });
    expect(header(spam.hs, "X-Mailgun-Sflag")).toEqual(["Yes"]);
    expect(header(spam.hs, "X-Mailgun-Sscore")).toEqual(["12.5"]);
    expect(header(spam.hs, "In-Reply-To")).toEqual([]);
    expect(INBOUND_PRESETS).toHaveLength(6);
  });

  it("explicit fields override the preset; bad input gets a plain error", async () => {
    await sendToAnna(fake);
    const at = "2026-09-20T08:00:00.000Z";
    const res = await admin(fake, "inbound", {
      preset: "out-of-office",
      inReplyTo: `<${OUR_ID.toUpperCase()}>`,
      subject: "Abwesend",
      text: "Bin weg.",
      headers: [["X-Custom", "1"]],
      envelopeSender: "anna@firma.de",
      strippedText: null,
      messageId: "twin@firma.de",
      at,
    });
    expect(res.status).toBe(200);
    const fields = res.json.fields as Record<string, string>;
    const hs = headersOf(fields);
    expect(fields).toMatchObject({ subject: "Abwesend", "body-plain": "Bin weg.", sender: "anna@firma.de" });
    expect("stripped-text" in fields).toBe(false);
    expect(header(hs, "Auto-Submitted")).toEqual([]);
    expect(header(hs, "X-Custom")).toEqual(["1"]);
    expect(header(hs, "Message-Id")).toEqual(["<twin@firma.de>"]);
    expect(header(hs, "Date")).toEqual([new Date(at).toUTCString()]);

    expect(await admin(fake, "inbound", { preset: "hello", inReplyTo: OUR_ID })).toMatchObject({
      status: 400,
      json: { error: "preset must be one of reply, out-of-office, unclear, bounce-notice, new-email, spam." },
    });
    expect((await admin(fake, "inbound", { preset: "reply" })).json.error).toMatch(/^inReplyTo is required with a preset/);
    expect((await admin(fake, "inbound", { preset: "reply", inReplyTo: "nope@x" })).json.error).toBe(
      "The fake has no sent message nope@x. Use an id from GET /__fake/messages.",
    );
    expect((await admin(fake, "inbound", { preset: "reply", inReplyTo: OUR_ID, headers: "X: 1" })).json.error).toBe(
      'headers must look like [["Auto-Submitted", "auto-replied"]].',
    );
    expect((await admin(fake, "inbound", { preset: "reply", inReplyTo: OUR_ID, at: "yesterday" })).json.error).toBe("at must be an ISO date.");
    expect((await admin(fake, "inbound", { from: "a@b.test", to: `ali@${D}`, subject: "s" })).json.error).toBe("text is required.");
    // Without a preset, the M3 shape still works, now with the new fields.
    const plain = await admin(fake, "inbound", { from: "a@b.test", to: `ali@${D}`, subject: "s", text: "t", envelopeSender: "", inReplyTo: "x@y" });
    expect((plain.json.fields as Record<string, string>).sender).toBe("");
    expect(header(headersOf(plain.json.fields as Record<string, string>), "In-Reply-To")).toEqual(["<x@y>"]);
  });

  it("threads to Mailgun's own id when the fake rewrote ours (found by either id), with the email's References", async () => {
    fake.setSwitches({ rewriteMessageId: true });
    const mailgunId = await sendToAnna(fake, { "h:References": "<pp.first@send.example.com>", "h:In-Reply-To": "<pp.first@send.example.com>" });
    expect(mailgunId).not.toBe(OUR_ID);
    const message = findSentMessage(fake.messages, OUR_ID);
    expect(message?.id).toBe(mailgunId);
    expect(findSentMessage(fake.messages, `<${mailgunId}>`)?.id).toBe(mailgunId);
    expect(findSentMessage(fake.messages, "")).toBeNull();
    const input = presetInbound("reply", message!);
    expect(input).toMatchObject({ inReplyTo: mailgunId, references: ["pp.first@send.example.com", mailgunId], from: "anna@firma.de", fromName: "Anna Berg" });
  });

  it("uses the address when there is no display name (\"anna.berg@…\" → Anna)", () => {
    const input = presetInbound("reply", {
      id: "x@send.example.com",
      fields: { from: ["ali@send.example.com"], to: ["anna.berg@firma.de"], subject: ["Hello"] },
      receivedAt: new Date(),
    });
    expect(input.text).toBe("Hi Ali,\n\nThanks, this sounds interesting. Could you send a few examples and your prices?\n\nBest,\nAnna");
    expect(input.fromName).toBeUndefined();
  });

  it("notify: true posts a correctly signed notification to a loopback app", async () => {
    const received: Array<{ path: string; body: string }> = [];
    const app = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        received.push({ path: req.url ?? "", body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
    const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const withApp = await startFakeMailgun({ domain: D, appUrl });
    try {
      await sendToAnna(withApp);
      const res = await admin(withApp, "inbound", { preset: "out-of-office", inReplyTo: OUR_ID, notify: true });
      expect(res.json.notify).toEqual({ status: 200, body: '{"ok":true}' });
      expect(received.map((r) => r.path)).toEqual(["/api/webhooks/mailgun/inbound"]);
      const form = new URLSearchParams(received[0]!.body);
      expect(form.get("signature")).toBe(hmacSignature("key-fake-signing", form.get("timestamp")!, form.get("token")!));
      expect(form.get("sender")).toBe("");
      expect(form.get("subject")).toBe(`Automatic reply: ${SUBJECT}`);
    } finally {
      await withApp.close();
      await new Promise<void>((r) => app.close(() => r()));
    }
  });
});

describe("otherDomains", () => {
  it("answers for older sending domains too, and still refuses unknown ones", async () => {
    const multi = await startFakeMailgun({ domain: D, otherDomains: ["Old.Example.com"] });
    try {
      const get = (domain: string) => fetch(`${multi.origin}/v3/${domain}/bounces`, { headers: { authorization: AUTH } }).then((r) => r.status);
      expect(await get(D)).toBe(200);
      expect(await get("old.example.com")).toBe(200);
      expect(await get("other.example.com")).toBe(404);
    } finally {
      await multi.close();
    }
  });
});
