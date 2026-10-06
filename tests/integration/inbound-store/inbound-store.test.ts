import { afterAll, describe, expect, it } from "vitest";
import type { ParsedInbound } from "@/core/mailgun/inbound";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("inbound-store");
const { db, dbTx } = await import("@/server/db");
const { storeInbound, STRIPPED_TEXT_MAX, BODY_TEXT_MAX } = await import("@/server/services/mail-events/inbound-store");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

let n = 0;

/** A ParsedInbound as Milestone 3 built it (none of the M4 fields). */
function m3Parsed(over: Partial<ParsedInbound> = {}): ParsedInbound {
  n += 1;
  return {
    recipient: "ali@send.example.com",
    fromEmail: "Anna@Firma.DE",
    fromName: "Anna Berg",
    subject: "Re: Hello",
    snippet: "Thanks, sounds good!",
    messageIdHeader: `reply${n}@firma.de`,
    inReplyTo: "pp.abc@send.example.com",
    references: ["pp.abc@send.example.com"],
    headers: [
      ["From", "Anna Berg <anna@firma.de>"],
      ["Subject", "Re: Hello"],
    ],
    storageKey: `KEY${n}`,
    messageUrl: `http://127.0.0.1:9/v3/domains/send.example.com/messages/KEY${n}`,
    receivedAt: new Date("2026-09-23T10:00:00Z"),
    ...over,
  };
}

async function row(id: number) {
  return db.inboundMessage.findUniqueOrThrow({ where: { id } });
}

describe("storeInbound: the M4 fields (M4-DESIGN §3.2)", () => {
  it("writes the envelope sender (\"\" = the null sender), the texts with their newlines and the body flag", async () => {
    const res = await dbTx((tx) =>
      storeInbound(
        tx,
        m3Parsed({
          envelopeSender: "",
          strippedText: "Hi Ali,\r\n\r\nyes please.",
          bodyText: "Hi Ali,\r\n\r\nyes please.\r\n\r\n> old text",
          bodyAvailable: true,
        }),
        "NOTIFY",
      ),
    );
    expect(res.status).toBe("created");
    expect(await row(res.id)).toMatchObject({
      envelopeSender: "",
      strippedText: "Hi Ali,\n\nyes please.",
      bodyText: "Hi Ali,\n\nyes please.\n\n> old text",
      bodyAvailable: true,
      fromEmail: "anna@firma.de",
      processedAt: null,
      kind: null,
    });
  });

  it("caps stripped-text at 8,000 and body-plain at 16,000 characters; blank text and a missing envelope are null", async () => {
    const res = await dbTx((tx) =>
      storeInbound(tx, m3Parsed({ envelopeSender: "<Bounce@Mailer.Example>", strippedText: "x".repeat(9_000), bodyText: "y".repeat(20_000) }), "NOTIFY"),
    );
    const stored = await row(res.id);
    expect(stored.strippedText).toHaveLength(STRIPPED_TEXT_MAX);
    expect(stored.bodyText).toHaveLength(BODY_TEXT_MAX);
    expect(stored.envelopeSender).toBe("bounce@mailer.example");
    const blank = await dbTx((tx) => storeInbound(tx, m3Parsed({ strippedText: "  \n ", bodyText: null, envelopeSender: null }), "NOTIFY"));
    expect(await row(blank.id)).toMatchObject({ strippedText: null, bodyText: null, envelopeSender: null, bodyAvailable: true });
    // An empty body-plain is still a body (only a missing one is null).
    const empty = await dbTx((tx) => storeInbound(tx, m3Parsed({ bodyText: "" }), "NOTIFY"));
    expect((await row(empty.id)).bodyText).toBe("");
  });

  it("still stores a Milestone 3 shaped reply (no new fields): envelope unknown, no texts, body available", async () => {
    const res = await dbTx((tx) => storeInbound(tx, m3Parsed(), "CATCHUP"));
    expect(await row(res.id)).toMatchObject({
      source: "CATCHUP",
      envelopeSender: null,
      strippedText: null,
      bodyText: null,
      bodyAvailable: true,
      snippet: "Thanks, sounds good!",
      references: "pp.abc@send.example.com",
    });
  });

  it("a log-only recovery gets the text, headers and snippet of a later full copy (same storage key)", async () => {
    const logOnly = m3Parsed({ snippet: "", headers: [["Subject", "Re: Hello"]], envelopeSender: "anna@firma.de", bodyAvailable: false });
    const first = await dbTx((tx) => storeInbound(tx, logOnly, "CATCHUP"));
    expect(await row(first.id)).toMatchObject({ bodyAvailable: false, strippedText: null, snippet: "" });
    // Another log-only copy changes nothing.
    expect(await dbTx((tx) => storeInbound(tx, logOnly, "CATCHUP"))).toEqual({ status: "duplicate", id: first.id });
    expect((await row(first.id)).bodyAvailable).toBe(false);

    const full = m3Parsed({
      storageKey: logOnly.storageKey,
      messageIdHeader: logOnly.messageIdHeader,
      snippet: "Yes please, send prices.",
      headers: [["Auto-Submitted", "no"], ["Subject", "Re: Hello"]],
      envelopeSender: "anna@firma.de",
      strippedText: "Yes please,\nsend prices.",
      bodyText: "Yes please,\nsend prices.\n> quoted",
    });
    expect(await dbTx((tx) => storeInbound(tx, full, "NOTIFY"))).toEqual({ status: "duplicate", id: first.id });
    expect(await row(first.id)).toMatchObject({
      bodyAvailable: true,
      snippet: "Yes please, send prices.",
      strippedText: "Yes please,\nsend prices.",
      bodyText: "Yes please,\nsend prices.\n> quoted",
      envelopeSender: "anna@firma.de",
      headers: [["Auto-Submitted", "no"], ["Subject", "Re: Hello"]],
      source: "CATCHUP",
    });
  });

  it("the upgrade also works through the Message-ID duplicate path, and never touches a row that already has its text", async () => {
    const logOnly = m3Parsed({ storageKey: null, messageUrl: null, snippet: "", bodyAvailable: false });
    const first = await dbTx((tx) => storeInbound(tx, logOnly, "CATCHUP"));
    const full = m3Parsed({ messageIdHeader: logOnly.messageIdHeader, snippet: "Now with text", strippedText: "Now with text" });
    expect(await dbTx((tx) => storeInbound(tx, full, "NOTIFY"))).toEqual({ status: "duplicate", id: first.id });
    expect(await row(first.id)).toMatchObject({ bodyAvailable: true, snippet: "Now with text", storageKey: full.storageKey });

    const again = m3Parsed({ storageKey: full.storageKey, snippet: "Different text", strippedText: "Different text" });
    expect(await dbTx((tx) => storeInbound(tx, again, "NOTIFY"))).toEqual({ status: "duplicate", id: first.id });
    expect(await row(first.id)).toMatchObject({ snippet: "Now with text", strippedText: "Now with text" });
  });
});
