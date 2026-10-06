import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { WEB_ONLY_LIST_UNSUBSCRIBE } from "@/core/sending/own-mailbox";
import { MailgunClient } from "@/server/mailgun/client";
import { MailgunError } from "@/server/mailgun/errors";
import type { SendMessageInput } from "@/server/mailgun/types";

/**
 * Own-mailbox mode's last resort (review REPLIES-03): with unsubscribe by email left out, `MailgunClient.sendMessage`
 * adds the app's own `h:List-Unsubscribe` with only Mailgun's web link (`<%unsubscribe_url%>`, no mailto:), so Mailgun
 * adds none of its own (it adds one only when the message has none: docs/dev/research/mailgun-sending.md). Every send
 * passes here (campaign emails, "Send me a test", the reply test), so the reply test's pasted original proves what all
 * emails carry. App mode never asks and never sends the header; a choice that can't be read sends nothing.
 */

const D = "example.com";
const OWN = "contact@example.com";

function recordingClient(opts: { ownMailboxFrom?: string | null; leaveOutMailto?: () => Promise<boolean> } = {}) {
  const forms: FormData[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    forms.push(init?.body as FormData);
    return new Response(JSON.stringify({ id: `<pp.x@${D}>`, message: "Queued. Thank you." }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new MailgunClient({ apiKey: "key-fake-api", region: "US", baseUrl: "http://127.0.0.1:9", retryDelayMs: () => 0, fetchImpl, ...opts });
  return { client, forms };
}

function msg(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    from: `Arslan from Polygon Paradise <${OWN}>`,
    to: "tester@gmail.com",
    subject: "Hello",
    text: "Hi",
    html: "<p>Hi</p>",
    messageId: `pp.${crypto.randomBytes(12).toString("hex")}@${D}`,
    replyTo: null,
    tags: ["outreach", "step-0"],
    variables: {},
    purpose: "campaign",
    guard: { goLive: false, testList: new Set(["tester@gmail.com"]) },
    ...over,
  };
}

describe("the app's own List-Unsubscribe (unsubscribe by email left out)", () => {
  it("own-mailbox mode with the choice on: exactly one h:List-Unsubscribe with only the web link", async () => {
    let asked = 0;
    const { client, forms } = recordingClient({
      ownMailboxFrom: OWN,
      leaveOutMailto: async () => {
        asked++;
        return true;
      },
    });
    await client.sendMessage(D, msg());
    await client.sendMessage(D, msg({ purpose: "reply-test" }));
    // The client of the other region keeps the choice.
    await client.forRegion("EU").sendMessage(D, msg());
    expect(asked).toBe(3);
    expect(forms).toHaveLength(3);
    for (const form of forms) {
      expect(form.getAll("h:List-Unsubscribe")).toEqual([WEB_ONLY_LIST_UNSUBSCRIBE]);
      expect(String(form.get("h:List-Unsubscribe"))).not.toContain("mailto:");
    }
    expect(WEB_ONLY_LIST_UNSUBSCRIBE).toBe("<%unsubscribe_url%>");
  });

  it("own-mailbox mode with the choice off: no h:List-Unsubscribe (Mailgun adds its own, as before)", async () => {
    const { client, forms } = recordingClient({ ownMailboxFrom: OWN, leaveOutMailto: async () => false });
    await client.sendMessage(D, msg());
    expect(forms[0]!.getAll("h:List-Unsubscribe")).toEqual([]);
  });

  it("app mode never asks and never sends the header, whatever the choice says", async () => {
    let asked = 0;
    const leaveOutMailto = async () => {
      asked++;
      return true;
    };
    const { client, forms } = recordingClient({ ownMailboxFrom: null, leaveOutMailto });
    await client.sendMessage("send.example.com", msg({ from: "Ali <ali@send.example.com>", messageId: `pp.abc@send.example.com` }));
    const noOption = recordingClient({ leaveOutMailto });
    await noOption.client.sendMessage("send.example.com", msg({ from: "Ali <ali@send.example.com>", messageId: `pp.abd@send.example.com` }));
    expect(asked).toBe(0);
    for (const form of [...forms, ...noOption.forms]) expect(form.getAll("h:List-Unsubscribe")).toEqual([]);
  });

  it("a choice that can't be read sends nothing (a plain refusal before any request, never 'ambiguous')", async () => {
    const { client, forms } = recordingClient({
      ownMailboxFrom: OWN,
      leaveOutMailto: async () => {
        throw new Error("database is locked");
      },
    });
    const err = await client.sendMessage(D, msg()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MailgunError);
    expect(err).toMatchObject({ kind: "unexpected", requestStarted: false, ambiguous: false });
    expect(forms).toHaveLength(0);
  });

  it("the sender check still speaks first: a wrong From is refused before the choice is read", async () => {
    let asked = 0;
    const { client, forms } = recordingClient({
      ownMailboxFrom: OWN,
      leaveOutMailto: async () => {
        asked++;
        return true;
      },
    });
    const err = await client.sendMessage(D, msg({ from: `Ali <ali@${D}>` })).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "sender" });
    expect(asked).toBe(0);
    expect(forms).toHaveLength(0);
  });
});
