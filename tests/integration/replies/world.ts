/**
 * Test data for the reply-processing tests (M4-DESIGN §3, §10 P4). Call createTestDb() and connectFakeMailgun() first:
 * every helper imports the app's modules lazily. Emails get real-looking Message-IDs (`pp.<24 hex>@send.example.com`,
 * dry runs `@dry-run.invalid`), so bounce notices that quote them are found by `bodyMessageIds`.
 *
 *   const ali = await makeSender("Ali");                       // a Member with ali@send.example.com
 *   const firma = await makeCompany("Firma GmbH", { domain: "firma.de" });
 *   const anna = await makePerson(firma.id, "anna@firma.de", "Anna Berg");
 *   const camp = await makeCampaign({ createdById: ali.id });
 *   const sent = await sendEmail(camp, anna);                  // step 0 SENT, step 1 QUEUED, recipient WAITING
 *   await replyTo(mg.fake, sent.emailId);                      // through the signed inbound webhook
 *   await processAll();                                         // the event lane's reply work
 */
import crypto from "node:crypto";
import type { CampaignStatus, CompanyStatus, Role, SendMode, SendStatus } from "@/generated/prisma/client";

async function write() {
  return (await import("@/server/db")).dbWrite;
}
async function reader() {
  return (await import("@/server/db")).db;
}

let seq = 0;
function next(): number {
  seq += 1;
  return seq;
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const DOMAIN = "send.example.com";

/** A new Message-ID of ours, as the app stores it (lowercase, no brackets). */
export function ourId(domain = DOMAIN): string {
  return `pp.${crypto.randomBytes(12).toString("hex")}@${domain}`;
}

/** The fake's sending domain row (connectFakeMailgun created it). */
async function domainId(): Promise<number> {
  const db = await reader();
  const d = await db.sendingDomain.findUniqueOrThrow({ where: { name: DOMAIN }, select: { id: true } });
  return d.id;
}

export type TestUser = { id: number; name: string; email: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number; address: string | null };

/**
 * A user with a sending address `<local>@send.example.com` (default: the lowercase name) and a private login email.
 * `address: null` gives no SenderAddress.
 */
export async function makeSender(
  name: string,
  opts: { role?: Role; local?: string | null; active?: boolean; timeZone?: string } = {},
): Promise<TestUser> {
  const dbWrite = await write();
  const n = next();
  const email = `${name.toLowerCase()}${n}@polygonparadise.test`;
  const user = await dbWrite((c) =>
    c.user.create({
      data: {
        name,
        email,
        role: opts.role ?? "MEMBER",
        active: opts.active ?? true,
        timeZone: opts.timeZone ?? "Europe/Berlin",
        replyInbox: email,
      },
    }),
  );
  let address: string | null = null;
  if (opts.local !== null) {
    const local = opts.local ?? name.toLowerCase();
    address = `${local}@${DOMAIN}`;
    const dId = await domainId();
    await dbWrite((c) => c.senderAddress.create({ data: { userId: user.id, domainId: dId, localPart: local, address: address! } }));
  }
  return { id: user.id, name, email, role: user.role, timeZone: user.timeZone, sessionId: 1, address };
}

export async function makeCompany(name: string, opts: { domain?: string | null; status?: CompanyStatus } = {}) {
  const dbWrite = await write();
  return dbWrite((c) =>
    c.company.create({
      data: { name, nameNorm: name.toLowerCase(), domain: opts.domain ?? null, status: opts.status ?? "CONTACTED" },
    }),
  );
}

export async function makePerson(companyId: number, email: string, name: string, opts: { deleted?: boolean } = {}) {
  const dbWrite = await write();
  const norm = email.toLowerCase();
  return dbWrite((c) =>
    c.person.create({
      data: {
        companyId,
        name,
        firstName: name.split(" ")[0] ?? null,
        email,
        emailNorm: norm,
        deletedAt: opts.deleted ? new Date() : null,
      },
    }),
  );
}

export type TestCampaign = { id: number; mode: SendMode; senderId: number | null; name: string; fromAddress: string };

/**
 * A launched campaign. It records its launch flag as a launch would (M6-DESIGN §2.2): `launchedGoLive` when given, else
 * Setting "sending.goLive" now, so set go-live first when its live sends should count as "emailed".
 */
export async function makeCampaign(opts: {
  createdById: number;
  senderId?: number | null;
  mode?: SendMode;
  status?: CampaignStatus;
  name?: string;
  fromAddress?: string;
  /** `Campaign.launchedGoLive`; default: Setting "sending.goLive" now. */
  launchedGoLive?: boolean;
}): Promise<TestCampaign> {
  const dbWrite = await write();
  const n = next();
  const mode = opts.mode ?? "LIVE";
  const fromAddress = opts.fromAddress ?? `Ali <ali@${DOMAIN}>`;
  const { getSetting } = await import("@/server/settings");
  const launchedGoLive = opts.launchedGoLive ?? (await getSetting("sending.goLive")) === true;
  const c = await dbWrite((c) =>
    c.campaign.create({
      data: {
        name: opts.name ?? `Campaign ${n}`,
        createdById: opts.createdById,
        senderId: opts.senderId === undefined ? opts.createdById : opts.senderId,
        status: opts.status ?? "RUNNING",
        mode,
        fromAddress,
        launchedAt: new Date(Date.now() - 30 * DAY),
        launchedGoLive,
        steps: {
          create: [
            { step: 0, subject: "3D models for your shop", body: "Hi" },
            { step: 1, subject: null, body: "Again", delayDays: 3 },
            { step: 2, subject: null, body: "Last", delayDays: 4 },
          ],
        },
      },
    }),
  );
  return { id: c.id, mode, senderId: c.senderId, name: c.name, fromAddress };
}

export type SentEmail = { recipientId: number; emailId: number; messageId: string; queuedId: number | null };

/**
 * One of our emails to a person: step `step` (default 0) SENT at `sentAt` (default an hour ago) with `status`, and the
 * next step QUEUED (unless `next: false`, then the recipient is FINISHED). The recipient is created on the first call
 * for the campaign and person, and moves to WAITING.
 */
export async function sendEmail(
  campaign: TestCampaign,
  person: { id: number; companyId: number; email: string | null },
  opts: { step?: number; sentAt?: Date; status?: SendStatus; next?: boolean; subject?: string; providerId?: string | null; claimedAt?: Date | null } = {},
): Promise<SentEmail> {
  const dbWrite = await write();
  const db = await reader();
  const email = person.email!.toLowerCase();
  const step = opts.step ?? 0;
  const sentAt = opts.sentAt ?? new Date(Date.now() - HOUR);
  const status = opts.status ?? "SENT";
  const hasNext = opts.next !== false;
  const existing = await db.campaignRecipient.findFirst({ where: { campaignId: campaign.id, personId: person.id }, select: { id: true } });
  const recipientId =
    existing?.id ??
    (
      await dbWrite((c) =>
        c.campaignRecipient.create({
          data: { campaignId: campaign.id, companyId: person.companyId, personId: person.id, emailNorm: email, state: "WAITING", currentStep: step + 1 },
        }),
      )
    ).id;
  await dbWrite((c) =>
    c.campaignRecipient.update({
      where: { id: recipientId },
      data: hasNext ? { state: "WAITING", currentStep: step + 1 } : { state: "FINISHED", currentStep: step },
    }),
  );
  const domain = campaign.mode === "DRY_RUN" ? "dry-run.invalid" : DOMAIN;
  const messageId = ourId(domain);
  const prev = step > 0 ? await db.outboundEmail.findFirst({ where: { recipientId, step: step - 1 }, select: { messageId: true } }) : null;
  const base = {
    campaignId: campaign.id,
    recipientId,
    personId: person.id,
    companyId: person.companyId,
    senderId: campaign.senderId,
    mode: campaign.mode,
    toEmail: person.email!,
    toNorm: email,
    companyName: "Snapshot",
    fromAddress: campaign.fromAddress,
    text: "Hi",
    html: "<p>Hi</p>",
  };
  const row = await dbWrite((c) =>
    c.outboundEmail.upsert({
      where: { campaignId_step_toNorm: { campaignId: campaign.id, step, toNorm: email } },
      create: {
        ...base,
        step,
        subject: opts.subject ?? (step === 0 ? "3D models for your shop" : "Re: 3D models for your shop"),
        messageId,
        sendId: `send-${crypto.randomBytes(6).toString("hex")}`,
        inReplyTo: prev?.messageId ?? null,
        references: prev?.messageId ?? null,
        dueAt: sentAt,
        status,
        sentAt: status === "SENT" ? sentAt : null,
        claimedAt: opts.claimedAt === undefined ? sentAt : opts.claimedAt,
        providerId: opts.providerId !== undefined ? opts.providerId : campaign.mode === "DRY_RUN" ? `dry-run:${messageId}` : status === "SENT" ? messageId : null,
      },
      update: {
        subject: opts.subject ?? (step === 0 ? "3D models for your shop" : "Re: 3D models for your shop"),
        status,
        sentAt: status === "SENT" ? sentAt : null,
        claimedAt: opts.claimedAt === undefined ? sentAt : opts.claimedAt,
        providerId: opts.providerId !== undefined ? opts.providerId : campaign.mode === "DRY_RUN" ? `dry-run:${messageId}` : status === "SENT" ? messageId : null,
      },
      select: { id: true, messageId: true },
    }),
  );
  let queuedId: number | null = null;
  if (hasNext) {
    const q = await dbWrite((c) =>
      c.outboundEmail.upsert({
        where: { campaignId_step_toNorm: { campaignId: campaign.id, step: step + 1, toNorm: email } },
        create: {
          ...base,
          step: step + 1,
          subject: "",
          messageId: ourId(domain),
          sendId: `send-${crypto.randomBytes(6).toString("hex")}`,
          inReplyTo: row.messageId,
          references: row.messageId,
          dueAt: new Date(Date.now() + 3 * DAY),
          status: "QUEUED",
        },
        update: {},
        select: { id: true },
      }),
    );
    queuedId = q.id;
  }
  const reserved = await db.companyReservation.findFirst({ where: { campaignId: campaign.id, companyId: person.companyId, releasedAt: null } });
  if (!reserved) await dbWrite((c) => c.companyReservation.create({ data: { campaignId: campaign.id, companyId: person.companyId } }));
  return { recipientId, emailId: row.id, messageId: row.messageId, queuedId };
}

/** Puts a person into a campaign waiting for their first email (SCHEDULED, step 0 QUEUED). */
export async function schedule(campaign: TestCampaign, person: { id: number; companyId: number; email: string | null }) {
  const dbWrite = await write();
  const email = person.email!.toLowerCase();
  const recipient = await dbWrite((c) =>
    c.campaignRecipient.create({
      data: { campaignId: campaign.id, companyId: person.companyId, personId: person.id, emailNorm: email, state: "SCHEDULED", currentStep: 0 },
    }),
  );
  const q = await dbWrite((c) =>
    c.outboundEmail.create({
      data: {
        campaignId: campaign.id,
        recipientId: recipient.id,
        personId: person.id,
        companyId: person.companyId,
        senderId: campaign.senderId,
        mode: campaign.mode,
        toEmail: person.email!,
        toNorm: email,
        companyName: "Snapshot",
        fromAddress: campaign.fromAddress,
        subject: "",
        text: "",
        html: "",
        step: 0,
        messageId: ourId(campaign.mode === "DRY_RUN" ? "dry-run.invalid" : DOMAIN),
        sendId: `send-${crypto.randomBytes(6).toString("hex")}`,
        dueAt: new Date(Date.now() + DAY),
        status: "QUEUED",
      },
    }),
  );
  return { recipientId: recipient.id, queuedId: q.id };
}

/** The event lane's reply work, until nothing is left (fresh back-off map). */
export async function processAll(now: Date = new Date()) {
  const { processPendingInbound } = await import("@/server/services/replies");
  let processed = 0;
  for (let i = 0; i < 20; i++) {
    const r = await processPendingInbound({ now, limit: 100, failures: new Map() });
    processed += r.processed;
    if (r.processed + r.failed === 0) break;
  }
  return processed;
}

/** One stored reply, every column. */
export async function inbound(id: number | null) {
  const db = await reader();
  return db.inboundMessage.findUniqueOrThrow({ where: { id: id! } });
}

/** One recipient's state and stop fields. */
export async function recipient(id: number) {
  const db = await reader();
  return db.campaignRecipient.findUniqueOrThrow({
    where: { id },
    select: { state: true, stopReason: true, holdReason: true, heldAt: true, stoppedByInboundId: true, currentStep: true },
  });
}

/** One email's status and lastError. */
export async function email(id: number) {
  const db = await reader();
  return db.outboundEmail.findUniqueOrThrow({ where: { id }, select: { status: true, lastError: true, sentAt: true } });
}

/** A user's notifications, oldest first (type, title, body, link). */
export async function notificationsOf(userId: number) {
  const db = await reader();
  return db.notification.findMany({ where: { userId }, orderBy: { id: "asc" }, select: { type: true, title: true, body: true, link: true } });
}

/** Activities of a type, oldest first. */
export async function activities(type: string) {
  const db = await reader();
  return db.activityLog.findMany({ where: { type }, orderBy: { id: "asc" } });
}

/** Deletes every notification (a clean slate between cases). */
export async function clearNotifications() {
  const dbWrite = await write();
  await dbWrite((c) => c.notification.deleteMany({}));
}

/** Writes a Setting directly (tests only). */
export async function setSetting(key: string, value: unknown) {
  const dbWrite = await write();
  await dbWrite((c) => c.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } }));
}

/**
 * A reply stored the way Milestone 3 stored it (kind null, no text fields, a collapsed snippet), unprocessed, e.g. the
 * backlog the first M4 start processes. `bodyAvailable: false` = a log-only recovery (the migration's data update).
 */
export async function storeM3Reply(input: {
  fromEmail: string;
  toAddress?: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
  inReplyTo?: string | null;
  references?: string | null;
  headers?: Array<[string, string]>;
  source?: "NOTIFY" | "CATCHUP";
  bodyAvailable?: boolean;
  messageIdHeader?: string | null;
}) {
  const dbWrite = await write();
  const db = await reader();
  const toAddress = input.toAddress ?? `ali@${DOMAIN}`;
  const sender = await db.senderAddress.findUnique({ where: { address: toAddress }, select: { id: true } });
  return dbWrite((c) =>
    c.inboundMessage.create({
      data: {
        messageIdHeader: input.messageIdHeader === undefined ? `m3.${next()}.${crypto.randomBytes(4).toString("hex")}@example.org` : input.messageIdHeader,
        receivedAt: input.receivedAt,
        toAddress,
        senderAddressId: sender?.id ?? null,
        fromEmail: input.fromEmail,
        subject: input.subject,
        snippet: input.snippet,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references ?? null,
        headers: (input.headers ?? []) as never,
        bodyAvailable: input.bodyAvailable ?? true,
        kind: null,
        source: input.source ?? "NOTIFY",
        processedAt: null,
      },
    }),
  );
}
