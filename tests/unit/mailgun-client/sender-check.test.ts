import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { MailgunClient } from "@/server/mailgun/client";
import { MailgunError, plainMailgunError } from "@/server/mailgun/errors";
import type { SendMessageInput } from "@/server/mailgun/types";

/**
 * The sender check inside MailgunClient.sendMessage (SHARED-FROM-DESIGN §2.4, fail closed): next to the test-list guard
 * and before any request, the From must be on the domain the email goes through (any Reply-To, as before), or on its
 * main domain with one bare Reply-To on that domain. Anything else is MailgunError kind "sender", requestStarted false,
 * and no request is ever made (the fetch below records every call).
 */

const D = "send.example.com";

function recordingClient() {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ id: `<pp.x@${D}>`, message: "Queued. Thank you." }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new MailgunClient({ apiKey: "key-fake-api", region: "EU", baseUrl: "http://127.0.0.1:9", retryDelayMs: () => 0, fetchImpl });
  return { client, calls };
}

function msg(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    from: "Ali from Polygon Paradise <ali@send.example.com>",
    to: "tester@gmail.com",
    subject: "Hello",
    text: "Hi",
    html: "<p>Hi</p>",
    messageId: `pp.${crypto.randomBytes(12).toString("hex")}@${D}`,
    tags: ["outreach", "step-0"],
    variables: {},
    purpose: "campaign",
    guard: { goLive: false, testList: new Set(["tester@gmail.com"]) },
    ...over,
  };
}

async function refusal(p: Promise<unknown>): Promise<MailgunError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailgunError);
  return err as MailgunError;
}

describe("the client's sender check", () => {
  it("refuses every From or Reply-To that doesn't fit the domain, before any request", async () => {
    const { client, calls } = recordingClient();
    for (const bad of [
      // A shared From without a Reply-To (replies would go to the main domain's mailbox, never the app).
      { from: "Ali <contact@example.com>", replyTo: null },
      // A Reply-To off the sending domain, under it, or not one bare address.
      { from: "Ali <contact@example.com>", replyTo: "contact@example.com" },
      { from: "Ali <contact@example.com>", replyTo: "ali@x.send.example.com" },
      { from: "Ali <contact@example.com>", replyTo: "Ali <ali@send.example.com>" },
      // A From neither on the domain nor on its main domain.
      { from: "Anna <anna@firma.de>", replyTo: "ali@send.example.com" },
      { from: "Anna <anna@firma.de>", replyTo: null },
      // No From at all.
      { from: "", replyTo: null },
    ]) {
      const err = await refusal(client.sendMessage(D, msg(bad)));
      expect(err.kind, bad.from).toBe("sender");
      expect(err.requestStarted).toBe(false);
      expect(err.ambiguous).toBe(false);
      expect(err.message).toMatch(/^Stopped by the sender check: /);
      expect(plainMailgunError(err)).toBe(
        "An email's From address or reply address doesn't fit your sending domain. Check the From address in Settings › Sending & Mailgun, then try again.",
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("the test-list guard still speaks first", async () => {
    const { client, calls } = recordingClient();
    const err = await refusal(client.sendMessage(D, msg({ from: "Anna <anna@firma.de>", to: "stranger@studio.de" })));
    expect(err.kind).toBe("guard");
    expect(calls).toHaveLength(0);
  });

  it("lets per-person emails (any Reply-To, as before) and shared-From emails with a Reply-To on the domain through", async () => {
    const { client, calls } = recordingClient();
    await client.sendMessage(D, msg());
    await client.sendMessage(D, msg({ replyTo: "ali@reply.example.com" }));
    await client.sendMessage(D, msg({ from: "Ali from Polygon Paradise <contact@example.com>", replyTo: "ali@send.example.com" }));
    expect(calls).toEqual([`http://127.0.0.1:9/v3/${D}/messages`, `http://127.0.0.1:9/v3/${D}/messages`, `http://127.0.0.1:9/v3/${D}/messages`]);
  });
});
