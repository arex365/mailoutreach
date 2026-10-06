/**
 * Test data for the mail-event, webhook and catch-up tests. Call createTestDb() first: every helper imports the
 * database lazily. Emails get Message-IDs on the sending domain (like real TEST/LIVE sends).
 */
import type { RecipientState, SendMode, SendStatus } from "@/generated/prisma/client";
import {
  complainedEvent,
  deliveredEvent,
  permanentFailEvent,
  tempFailEvent,
  toEventData,
  unsubscribedEvent,
  type MessageFacts,
} from "../../fake-mailgun/events";

async function write() {
  return (await import("@/server/db")).dbWrite;
}

let seq = 0;
function next(): number {
  seq += 1;
  return seq;
}

export async function makeOwner(name = "Arslan", email = "arslan@polygonparadise.test") {
  const dbWrite = await write();
  return dbWrite((c) => c.user.create({ data: { name, email, role: "OWNER", replyInbox: email } }));
}

export async function makeMember(name: string, email: string, opts: { replyInbox?: string | null; active?: boolean } = {}) {
  const dbWrite = await write();
  return dbWrite((c) =>
    c.user.create({ data: { name, email, role: "MEMBER", replyInbox: opts.replyInbox ?? email, active: opts.active ?? true } }),
  );
}

/** A company with one person (or the existing person with that address). */
export async function personFor(email: string, companyName?: string) {
  const { db } = await import("@/server/db");
  const dbWrite = await write();
  const norm = email.toLowerCase();
  const existing = await db.person.findUnique({ where: { emailNorm: norm } });
  if (existing) return { personId: existing.id, companyId: existing.companyId };
  const n = next();
  const company = await dbWrite((c) =>
    c.company.create({ data: { name: companyName ?? `Studio ${n}`, nameNorm: (companyName ?? `studio ${n}`).toLowerCase() } }),
  );
  const person = await dbWrite((c) =>
    c.person.create({ data: { companyId: company.id, name: `Person ${n}`, email, emailNorm: norm } }),
  );
  return { personId: person.id, companyId: company.id };
}

export type SeededEmail = {
  campaignId: number;
  recipientId: number;
  emailId: number;
  companyId: number;
  personId: number;
  messageId: string;
  sendId: string;
  toNorm: string;
  followUpId: number | null;
};

/**
 * One campaign email. Defaults: LIVE, SENT, recipient WAITING with a QUEUED follow-up (step 1), so stops and SKIPPED
 * rows can be seen. `campaignId` adds the email to an existing campaign.
 *
 * A new campaign records its launch flag as a launch would (M6-DESIGN §2.2): `launchedGoLive` when given, else Setting
 * "sending.goLive" at the moment it is seeded. So set go-live before seeding when its live sends should count as
 * "emailed".
 */
export async function seedEmail(opts: {
  createdById: number;
  email?: string;
  mode?: SendMode;
  status?: SendStatus;
  campaignId?: number;
  campaignStatus?: "RUNNING" | "PAUSED" | "FINISHED";
  recipientState?: RecipientState;
  followUp?: boolean;
  domain?: string;
  sentAt?: Date | null;
  providerId?: string | null;
  claimedAt?: Date | null;
  /** The new campaign's `launchedGoLive`; default: Setting "sending.goLive" now. */
  launchedGoLive?: boolean;
}): Promise<SeededEmail> {
  const dbWrite = await write();
  const n = next();
  const email = (opts.email ?? `anna${n}@studio${n}.de`).toLowerCase();
  const mode = opts.mode ?? "LIVE";
  const status = opts.status ?? "SENT";
  const domain = opts.domain ?? "send.example.com";
  const { personId, companyId } = await personFor(email);
  const { getSetting } = await import("@/server/settings");
  const launchedGoLive = opts.campaignId === undefined ? (opts.launchedGoLive ?? (await getSetting("sending.goLive")) === true) : undefined;
  const campaignId =
    opts.campaignId ??
    (
      await dbWrite((c) =>
        c.campaign.create({
          data: {
            name: `Campaign ${n}`,
            createdById: opts.createdById,
            senderId: opts.createdById,
            status: opts.campaignStatus ?? "RUNNING",
            mode,
            fromAddress: `arslan@${domain}`,
            launchedAt: new Date(Date.now() - 86_400_000),
            launchedGoLive,
            steps: { create: [{ step: 0, subject: "Hello", body: "Hi" }, { step: 1, subject: null, body: "Again", delayDays: 3 }] },
          },
        }),
      )
    ).id;
  const followUp = opts.followUp ?? status === "SENT";
  const recipient = await dbWrite((c) =>
    c.campaignRecipient.create({
      data: {
        campaignId,
        companyId,
        personId,
        emailNorm: email,
        state: opts.recipientState ?? (followUp ? "WAITING" : "SCHEDULED"),
        currentStep: followUp ? 1 : 0,
      },
    }),
  );
  const messageId = `pp.seed${n}.${Date.now().toString(36)}@${domain}`;
  const sendId = `send-${n}-${Date.now().toString(36)}`;
  const sentAt = opts.sentAt === undefined ? (status === "SENT" ? new Date(Date.now() - 3_600_000) : null) : opts.sentAt;
  const base = {
    campaignId,
    recipientId: recipient.id,
    personId,
    companyId,
    senderId: opts.createdById,
    mode,
    toEmail: email,
    toNorm: email,
    companyName: "Snapshot",
    fromAddress: `Arslan <arslan@${domain}>`,
    subject: "Hello",
    text: "Hi",
    html: "<p>Hi</p>",
  };
  const row = await dbWrite((c) =>
    c.outboundEmail.create({
      data: {
        ...base,
        step: 0,
        messageId,
        sendId,
        dueAt: new Date(Date.now() - 7_200_000),
        status,
        sentAt,
        providerId: opts.providerId ?? (status === "SENT" ? messageId : null),
        claimedAt: opts.claimedAt ?? (status === "QUEUED" ? null : new Date(Date.now() - 3_600_000)),
      },
    }),
  );
  let followUpId: number | null = null;
  if (followUp) {
    const f = await dbWrite((c) =>
      c.outboundEmail.create({
        data: {
          ...base,
          step: 1,
          messageId: `pp.seed${n}f.${Date.now().toString(36)}@${domain}`,
          sendId: `send-${n}f-${Date.now().toString(36)}`,
          inReplyTo: messageId,
          references: messageId,
          dueAt: new Date(Date.now() + 3 * 86_400_000),
          status: "QUEUED",
        },
      }),
    );
    followUpId = f.id;
  }
  return { campaignId, recipientId: recipient.id, emailId: row.id, companyId, personId, messageId, sendId, toNorm: email, followUpId };
}

/** What an email contributes to its Mailgun events (the fake's builders). */
export function factsFor(e: Pick<SeededEmail, "messageId" | "toNorm" | "sendId" | "campaignId">, opts: { testMode?: boolean; domain?: string } = {}): MessageFacts {
  return {
    messageId: e.messageId,
    domain: opts.domain ?? "send.example.com",
    recipient: e.toNorm,
    from: "Arslan <arslan@send.example.com>",
    to: e.toNorm,
    subject: "Hello",
    tags: ["outreach", "step-0"],
    userVariables: { send_id: e.sendId, campaign_id: String(e.campaignId), step: "0" },
    testMode: opts.testMode ?? false,
  };
}

type Kind = "delivered" | "tempfail" | "bounce" | "complain" | "unsubscribe";

/** Webhook `event-data` for one email (research §13.1 shape, built by the fake's own builders). */
export function eventData(
  e: Pick<SeededEmail, "messageId" | "toNorm" | "sendId" | "campaignId">,
  kind: Kind,
  opts: { at?: Date; reason?: string; testMode?: boolean; domain?: string } = {},
): Record<string, unknown> {
  const facts = factsFor(e, opts);
  const at = opts.at ?? new Date();
  const ev =
    kind === "delivered"
      ? deliveredEvent(facts, at)
      : kind === "tempfail"
        ? tempFailEvent(facts, at)
        : kind === "bounce"
          ? permanentFailEvent(facts, at, { reason: opts.reason ?? "bounce" })
          : kind === "complain"
            ? complainedEvent(facts, at)
            : unsubscribedEvent(facts, at);
  return toEventData(ev);
}

export async function setSetting(key: string, value: unknown) {
  const dbWrite = await write();
  await dbWrite((c) => c.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } }));
}

export async function setState(key: string, value: unknown) {
  const dbWrite = await write();
  await dbWrite((c) =>
    c.systemState.upsert({ where: { key }, create: { key, value: value as never, version: 1 }, update: { value: value as never, version: { increment: 1 } } }),
  );
}
