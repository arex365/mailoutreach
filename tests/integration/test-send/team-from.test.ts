import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeDraft } from "../campaigns/seed";
import { addSenderAddress, fastMailgun, makeUser, setSettingValue, writeDomainCheck } from "../mailgun-setup/helpers";

/**
 * Test sends with a shared From address (SHARED-FROM-DESIGN §3.4, §3.5, F8, F26): "Send me a test" comes From the shared
 * address with the sender's display name and Reply-To the sender's own address, records `TestSend.teamFrom`, adds the
 * "look in spam" sentence when the reply inbox is the From address itself, and says "reply address"; a saved From
 * address that no longer fits refuses the self test, its dialog and the reply test. Against the fake Mailgun.
 */

const FROM = "contact@example.com";
const t = await createTestDb("test-send-team");
const mg: FakeConnection = await connectFakeMailgun({ fromAddress: FROM });
const { db } = await import("@/server/db");
const ts = await import("@/server/services/test-send");
const rt = await import("@/server/services/reply-test");
const { TEAM_FROM_TEXTS } = await import("@/core/sending/from-address");
const { setSecret, deleteSecret } = await import("@/server/secrets");
const { getPauseState, resumeSending } = await import("@/server/services/sending/pause");
const { AUTH_TEXT, MailgunError } = await import("@/server/mailgun/errors");
const { AUTH_PAUSE_FIX, SENDING_KEY_TEAM_FROM_FIX, mailgunFailure } = await import("@/server/services/sending/mailgun-transport");

const D = mg.domain;
const PUB = "http://127.0.0.1:3999";
const previousPub = process.env.APP_PUBLIC_URL;
let owner: { id: number; name: string };
let ali: { id: number; name: string };
let campaignId = 0;
let recipientId = 0;
let saraCampaignId = 0;
let saraRecipientId = 0;

const deps = { mailgun: fastMailgun };
const last = () => mg.fake.messages[mg.fake.messages.length - 1]!;
const field = (m: { fields: Record<string, string[]> }, k: string) => m.fields[k]?.[0];

async function rejection(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = PUB;
  // The Owner reads replies in the shared mailbox itself (allowed: F9).
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: FROM });
  ali = await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" });
  const sara = await makeUser("Sara", { replyInbox: "sara.b@outlook.com" });
  await addSenderAddress(owner.id, mg.domainId, "arslan", "ok");
  await addSenderAddress(ali.id, mg.domainId, "ali", "ok");
  const { company, people } = await makeCompany({ name: "Studio Berg", people: [{ name: "Anna Berg", email: "anna@studio-berg.de" }] });
  const draft = await makeDraft({ name: "Germany Q4", createdById: owner.id, senderId: ali.id, recipients: [{ companyId: company.id, personId: people[0]!.id }] });
  campaignId = draft.id;
  recipientId = (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).id;
  const saraDraft = await makeDraft({ name: "From Sara", createdById: owner.id, senderId: sara.id, recipients: [{ companyId: company.id, personId: people[0]!.id }] });
  saraCampaignId = saraDraft.id;
  saraRecipientId = (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: saraCampaignId } })).id;
  await setSettingValue("sending.testList", ["t.outlook@outlook.com", "t.gmail@gmail.com"]);
  await writeDomainCheck(D, { "from-mx": "ok", "from-spf": "ok" });
});

beforeEach(async () => {
  mg.fake.reset();
  await setSettingValue("sending.mode", "TEST");
  await setSettingValue("mailgun.fromAddress", FROM);
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Send me a test with a shared From address", () => {
  it("comes From the shared address with the sender's name, Reply-To the sender's own address, and records teamFrom", async () => {
    const res = await ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps);
    expect(res).toEqual({ status: "sent", message: "Test sent to ali.khan@gmail.com. It should arrive within a minute." });
    const m = last();
    expect(field(m, "to")).toBe("ali.khan@gmail.com");
    expect(field(m, "from")).toBe("Ali from Polygon Paradise <contact@example.com>");
    expect(field(m, "h:Reply-To")).toBe(`ali@${D}`);
    expect(field(m, "h:Message-Id")).toMatch(/^<pp\.t\.[0-9a-f]{24}@send\.example\.com>$/);
    expect(mg.fake.requests.map((r) => r.path)).toContain(`/v3/${D}/messages`);
    const row = await db.testSend.findFirstOrThrow({ orderBy: { id: "desc" } });
    expect(row).toMatchObject({ userId: ali.id, purpose: "SELF", status: "SENT", teamFrom: FROM });
  });

  it("to a reply inbox that is the From address itself, the message says to look in spam", async () => {
    const res = await ts.sendMeATest(owner, { campaignId, recipientId, step: 0 }, deps);
    expect(res.message).toBe(
      "Test sent to contact@example.com. It should arrive within a minute. It comes from contact@example.com, your own address: if it isn't in your inbox within a few minutes, look in spam.",
    );
    expect(field(last(), "to")).toBe(FROM);
    expect(field(last(), "from")).toBe("Ali from Polygon Paradise <contact@example.com>");
  });

  it("a sender without an address is told about the reply address", async () => {
    expect(await rejection(ts.sendMeATest(ali, { campaignId: saraCampaignId, recipientId: saraRecipientId, step: 0 }, deps))).toBe(
      "Sara has no reply address yet. Sara can add one in Settings › My profile.",
    );
    expect(ts.noSenderAddressText("Sara")).toBe("Sara has no sending address yet. Sara can add one in Settings › My profile.");
  });

  it("a saved From address that no longer fits refuses the self test, its dialog and the reply test (fail closed)", async () => {
    await setSettingValue("mailgun.fromAddress", "contact@other.example");
    const misfit = TEAM_FROM_TEXTS.misfit("contact@other.example", D);
    expect(misfit).toBe(
      "The From address contact@other.example doesn't fit your sending domain send.example.com. Change or clear it in Settings › Sending & Mailgun.",
    );
    const before = await db.testSend.count();
    expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(misfit);
    expect((await ts.testSendInfo(ali)).blocker).toBe(misfit);
    const err = await ts.sendReplyTestEmails(owner.id, { jobId: 90, mailgun: fastMailgun }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ts.ReplyTestRefusedError);
    expect((err as InstanceType<typeof ts.ReplyTestRefusedError>).reasons[0]).toBe(misfit);
    const gate = await rt.loadGateInputs();
    expect(rt.replyTestBlockersFor(gate)[0]).toBe(misfit);
    expect(rt.modeBlockersFor("TEST", gate)).toEqual([misfit]);
    expect(rt.goLiveBlockersFor(gate)[0]).toBe(misfit);
    expect(mg.fake.messages).toHaveLength(0);
    expect(await db.testSend.count()).toBe(before);
  });

  describe("a domain sending key Mailgun refuses (SEND-2)", () => {
    // The fake accepts only its own keys: this sending key is refused with 401, as Mailgun might for a From on another
    // domain (§11 Q7). getMailgunContext sends with it while it is saved.
    const REFUSED_KEY = "key-fake-sending-unknown";
    /** The pause the sending loop takes for the same refusal of a shared-From campaign email. */
    const loopPause = () => {
      const refused = new MailgunError({ kind: "auth", status: 401, message: "POST /v3/messages: 401", mailgunMessage: "Forbidden", requestStarted: true });
      const f = mailgunFailure(refused, { domain: D, now: new Date(), teamFromWithSendingKey: true });
      return f.kind === "pause" ? { reason: f.reason, fixText: f.fixText } : null;
    };

    async function withRefusedKey(fn: () => Promise<void>) {
      await setSecret("mailgun.sendingKey", REFUSED_KEY, null);
      try {
        await fn();
      } finally {
        await deleteSecret("mailgun.sendingKey");
        if ((await getPauseState()).paused) await resumeSending({ actorId: owner.id, actorName: owner.name });
      }
    }

    it("Send me a test: the sending-key sentence, not 'paste the API key', and the loop's own pause", async () => {
      await withRefusedKey(async () => {
        const message = await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps));
        expect(message).toBe(ts.sendingKeyRefusedText());
        expect(message).toBe(`Mailgun didn't accept the domain sending key.${SENDING_KEY_TEAM_FROM_FIX}`);
        expect(message).toContain("remove the domain sending key");
        expect(message).not.toContain("paste it here");
        expect(await db.testSend.findFirstOrThrow({ orderBy: { id: "desc" } })).toMatchObject({ status: "FAILED", error: message, teamFrom: FROM });
        const pause = await getPauseState();
        expect(pause).toMatchObject({ paused: true, kind: "mailgun-auth", fixText: AUTH_PAUSE_FIX + SENDING_KEY_TEAM_FROM_FIX });
        expect(pause).toMatchObject({ ...loopPause() });
      });
    });

    it("the reply test: the email's line says the same, and sending pauses the same way", async () => {
      await withRefusedKey(async () => {
        const res = await ts.sendReplyTestEmails(owner.id, { jobId: 91, mailgun: fastMailgun });
        // The whole account was refused: the run stops after the first mailbox.
        expect(res).toMatchObject({ sent: 0, failed: 1 });
        const row = await db.testSend.findUniqueOrThrow({ where: { messageId: ts.replyTestMessageId(91, "t.outlook@outlook.com", D) } });
        expect(row).toMatchObject({ status: "FAILED", error: ts.sendingKeyRefusedText(), teamFrom: FROM });
        expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-auth", ...loopPause() });
      });
    });

    it("per-person mode with the same key: exactly as before (the API-key sentence)", async () => {
      await setSettingValue("mailgun.fromAddress", null);
      await withRefusedKey(async () => {
        expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(AUTH_TEXT);
        expect(await getPauseState()).toMatchObject({
          paused: true,
          kind: "mailgun-auth",
          reason: "Mailgun didn't accept the API key",
          fixText: `${AUTH_TEXT} Then click Resume.`,
        });
      });
    });

    it("shared-From mode without a sending key: the API key was refused, so the API-key sentence stays", async () => {
      mg.fake.failNext("POST /v3/:d/messages", { kind: "status", status: 401, body: "Forbidden" });
      try {
        expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(AUTH_TEXT);
        expect((await getPauseState()).fixText).toBe(`${AUTH_TEXT} Then click Resume.`);
      } finally {
        await resumeSending({ actorId: owner.id, actorName: owner.name });
      }
    });
  });

  it("the reply test without the Owner's address asks for the reply address", async () => {
    const address = await db.senderAddress.findFirstOrThrow({ where: { userId: owner.id } });
    const { dbWrite } = await import("@/server/db");
    await dbWrite((c) => c.senderAddress.update({ where: { id: address.id }, data: { retiredAt: new Date() } }));
    try {
      expect(rt.replyTestBlockersFor(await rt.loadGateInputs())).toEqual(["Add your reply address first in Settings › My profile."]);
      expect(rt.OWNER_ADDRESS_MISSING_TEXT).toBe("Add your sending address first in Settings › My profile.");
    } finally {
      await dbWrite((c) => c.senderAddress.update({ where: { id: address.id }, data: { retiredAt: null } }));
    }
  });
});
