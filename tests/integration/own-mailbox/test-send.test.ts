import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CheckStatus, ChecklistGroup, ChecklistRowKey } from "@/core/system-state";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { makeCompany, makeDraft } from "../campaigns/seed";
import { fastMailgun, makeUser, setSettingValue } from "../mailgun-setup/helpers";

/**
 * Test sends in own-mailbox mode (MAIN-DOMAIN-DESIGN §3.6, O23, O24, O25, §8 P4) against the fake Mailgun on example.com
 * (US, Free, `receivesMail: false`): "Send me a test" comes From the sender's display name with contact@, no Reply-To,
 * needs no sending address and records the own From; to a test inbox that is contact@ itself it adds the "look in
 * spam" sentence; it refuses without an own From; the rolling guard refuses at 100 emails in 24 hours (Mailgun's own
 * `accepted` events count), also in the dialog and for the reply test; the fake's limit refusal pauses with the plan
 * reason and never looks like a rejected email; an authorized-recipients refusal says the test sentence.
 */

const D = "example.com";
const FROM = "contact@example.com";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";

const t = await createTestDb("own-mailbox-test-send");
const previousPub = process.env.APP_PUBLIC_URL;
delete process.env.APP_PUBLIC_URL;
const mg: FakeConnection = await connectFakeMailgun({
  domain: D,
  region: "US",
  replies: "own-mailbox",
  fromAddress: FROM,
  plan: "free",
  fake: { domain: D, region: "US", plan: "free", receivesMail: false },
});
const { db, dbWrite } = await import("@/server/db");
const { setState } = await import("@/server/state");
const ts = await import("@/server/services/test-send");
const { getPauseState, resumeSending } = await import("@/server/services/sending/pause");
const { TEAM_FROM_TEXTS } = await import("@/core/sending/from-address");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");
const { PLAN_TEXTS } = await import("@/core/mailgun/plan");

const deps = { mailgun: fastMailgun };
const last = () => mg.fake.messages[mg.fake.messages.length - 1]!;
const field = (m: { fields: Record<string, string[]> }, k: string) => m.fields[k]?.[0];
let owner: { id: number; name: string };
let ali: { id: number; name: string };
let campaignId = 0;
let recipientId = 0;
let n = 0;

async function rejection(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

const OWN_ROWS: ReadonlyArray<[ChecklistRowKey, ChecklistGroup]> = [
  ["mailgun-domain", "mailgun"],
  ["spf", "dns"],
  ["dkim", "dns"],
  ["tracking-cname", "dns"],
  ["https-links", "dns"],
  ["dmarc", "dns"],
  ["from-mx", "dns"],
  ["tracking-off", "settings"],
  ["unsubscribe", "settings"],
  ["signing-key", "settings"],
  ["webhooks", "settings"],
  ["sending-allowed", "settings"],
  ["remote-access", "connection"],
];

async function writeOwnCheck(): Promise<void> {
  const info: Partial<Record<ChecklistRowKey, CheckStatus>> = { "https-links": "info", webhooks: "info", "remote-access": "info" };
  const rows = OWN_ROWS.map(([key, group]) => ({ key, group, status: info[key] ?? "ok", title: `Row ${key}`, text: "", fix: null, records: [], detail: null }));
  await setState("domain.check", { domain: D, region: "US", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows, error: null, replies: "own-mailbox" });
}

/** `count` distinct `accepted` events Mailgun reported in the last 24 hours (other senders on the account). */
async function acceptedEvents(count: number): Promise<void> {
  const at = new Date(Date.now() - 60 * 60_000);
  await dbWrite((c) =>
    c.mailEvent.createMany({
      data: Array.from({ length: count }, () => {
        n += 1;
        return { dedupeKey: `accepted-${n}`, type: "accepted", occurredAt: at, messageId: `other.${n}@${D}`, recipient: `r${n}@company.example`, source: "LOGS", raw: {} };
      }),
    }),
  );
}

beforeAll(async () => {
  // The Owner's test inbox is contact@ itself (allowed in this mode: no loop rule on the own mailbox).
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: FROM });
  ali = await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" });
  const { company, people } = await makeCompany({ name: "Studio Berg", people: [{ name: "Anna Berg", email: "anna@studio-berg.de" }] });
  const draft = await makeDraft({ name: "Germany Q4", createdById: owner.id, senderId: ali.id, recipients: [{ companyId: company.id, personId: people[0]!.id }] });
  campaignId = draft.id;
  recipientId = (await db.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).id;
  await setSettingValue("sending.testList", [OUTLOOK, GMAIL]);
  await writeOwnCheck();
});

beforeEach(async () => {
  mg.fake.reset();
  await setSettingValue("sending.mode", "TEST");
  await dbWrite((c) => c.mailEvent.deleteMany({ where: { type: "accepted" } }));
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Send me a test in own-mailbox mode", () => {
  it("comes From the sender's name with contact@, no Reply-To, needs no sending address, and records the own From", async () => {
    expect(await db.senderAddress.count()).toBe(0);
    const res = await ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps);
    expect(res).toEqual({ status: "sent", message: "Test sent to ali.khan@gmail.com. It should arrive within a minute." });
    const m = last();
    expect(field(m, "to")).toBe("ali.khan@gmail.com");
    expect(field(m, "from")).toBe("Ali from Polygon Paradise <contact@example.com>");
    expect(field(m, "h:Reply-To")).toBeUndefined();
    expect(field(m, "h:Message-Id")).toMatch(/^<pp\.t\.[0-9a-f]{24}@example\.com>$/);
    expect(mg.fake.requests.map((r) => r.path)).toContain(`/v3/${D}/messages`);
    const row = await db.testSend.findFirstOrThrow({ orderBy: { id: "desc" } });
    expect(row).toMatchObject({ userId: ali.id, purpose: "SELF", status: "SENT", teamFrom: FROM });
  });

  it("to a test inbox that is contact@ itself (allowed), the message says to look in spam", async () => {
    const res = await ts.sendMeATest(owner, { campaignId, recipientId, step: 0 }, deps);
    expect(res.message).toBe(`Test sent to ${FROM}. It should arrive within a minute.${TEAM_FROM_TEXTS.selfTestNote(FROM)}`);
    expect(field(last(), "to")).toBe(FROM);
    expect(field(last(), "from")).toBe("Ali from Polygon Paradise <contact@example.com>");
    // Review SCREENS-11: the dialog says "your inbox for test emails" in this mode.
    expect(await ts.testSendInfo(owner)).toMatchObject({ blocker: null, ownMailbox: true });
  });

  it("without an own From: refused with its sentence, in the dialog too, and nothing is sent", async () => {
    await setSettingValue("mailgun.fromAddress", "");
    const missing = OWN_MAILBOX_TEXTS.fromMissing(D);
    const before = await db.testSend.count();
    expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(missing);
    expect((await ts.testSendInfo(ali)).blocker).toBe(missing);
    expect(mg.fake.messages).toHaveLength(0);
    expect(await db.testSend.count()).toBe(before);
    await setSettingValue("mailgun.fromAddress", FROM);
  });

  it("the rolling guard: 100 emails in the last 24 hours (Mailgun's accepted events count) refuse the test, the dialog and the reply test", async () => {
    await acceptedEvents(100);
    const full = PLAN_TEXTS.testsFull(100);
    expect(full).toBe("Your Mailgun plan sends at most 100 emails in 24 hours, and that many have gone out. Try again later.");
    const before = await db.testSend.count();
    expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(full);
    expect(await db.testSend.count()).toBe(before);
    expect((await ts.testSendInfo(ali)).blocker).toBe(full);
    const err = await ts.sendReplyTestEmails(owner.id, { jobId: 801, mailgun: fastMailgun }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ts.ReplyTestRefusedError);
    expect((err as InstanceType<typeof ts.ReplyTestRefusedError>).reasons).toEqual([full]);
    expect(mg.fake.messages).toHaveLength(0);
  });

  it("with room for one test but not for the reply test's two emails: the test goes, the reply test is refused", async () => {
    // The app's own count is 2 (the earlier cases' test emails); Mailgun reports 99: the larger count wins, 1 left.
    await acceptedEvents(99);
    expect((await ts.testSendInfo(ali)).blocker).toBeNull();
    const err = await ts.sendReplyTestEmails(owner.id, { jobId: 802, mailgun: fastMailgun }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ts.ReplyTestRefusedError>).reasons).toEqual([PLAN_TEXTS.testsFull(100)]);
    await ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps);
    expect(mg.fake.messages).toHaveLength(1);
  });

  it("the fake's limit refusal pauses with the plan reason; the test email is never 'rejected'", async () => {
    mg.fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 400,
      body: { message: `Domain ${D} has reached its daily sending limit of 100 messages.` },
    });
    expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(PLAN_TEXTS.limitRefused);
    const row = await db.testSend.findFirstOrThrow({ orderBy: { id: "desc" } });
    expect(row).toMatchObject({ status: "FAILED", error: PLAN_TEXTS.limitRefused });
    expect(await getPauseState()).toMatchObject({
      paused: true,
      kind: "mailgun-not-allowed",
      reason: PLAN_TEXTS.limitReason,
      fixText: PLAN_TEXTS.limitRefused,
    });
    await resumeSending({ actorId: owner.id, actorName: owner.name });
  });

  it("an authorized-recipients refusal says the test sentence (a test mailbox may be authorized)", async () => {
    mg.fake.failNext("POST /v3/:d/messages", {
      kind: "status",
      status: 403,
      body: { message: `Domain ${D} is not allowed to send: Free accounts are for test purposes only. Please upgrade or add the address to authorized recipients in Account Settings.` },
    });
    expect(await rejection(ts.sendMeATest(ali, { campaignId, recipientId, step: 0 }, deps))).toBe(PLAN_TEXTS.authorizedOnlyTest);
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-not-allowed", reason: PLAN_TEXTS.authorizedReason });
    await resumeSending({ actorId: owner.id, actorName: owner.name });
  });
});
