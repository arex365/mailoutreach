/**
 * Test data for the stop, hold and outage tests (M4-DESIGN §2.6, §2.8). Call createTestDb() first: every helper imports
 * the database lazily. A "recipient" here is a CampaignRecipient with its emails: the steps already SENT (with their
 * sent times) and at most one QUEUED email for the step it waits for, plus the campaign's reservation on the company.
 */
import type { CampaignStatus, InboundKind, RecipientState, Role, SendMode } from "@/generated/prisma/client";

async function dbWrite() {
  return (await import("@/server/db")).dbWrite;
}

let seq = 0;
function next(): number {
  seq += 1;
  return seq;
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export async function makeUser(
  name: string,
  opts: { role?: Role; email?: string; active?: boolean; timeZone?: string; replyInbox?: string | null } = {},
) {
  const write = await dbWrite();
  const email = opts.email ?? `${name.toLowerCase()}${next()}@polygonparadise.test`;
  return write((c) =>
    c.user.create({
      data: {
        name,
        email,
        role: opts.role ?? "MEMBER",
        active: opts.active ?? true,
        timeZone: opts.timeZone ?? "Europe/Berlin",
        replyInbox: opts.replyInbox === undefined ? email : opts.replyInbox,
      },
    }),
  );
}

export async function makeCompany(name?: string, opts: { domain?: string | null } = {}) {
  const write = await dbWrite();
  const n = next();
  const companyName = name ?? `Company ${n}`;
  return write((c) =>
    c.company.create({ data: { name: companyName, nameNorm: companyName.toLowerCase(), domain: opts.domain ?? null } }),
  );
}

export async function makePerson(companyId: number, email: string, name?: string) {
  const write = await dbWrite();
  const norm = email.toLowerCase();
  return write((c) => c.person.create({ data: { companyId, name: name ?? norm.split("@")[0]!, email, emailNorm: norm } }));
}

export async function makeCampaign(opts: {
  createdById: number;
  senderId?: number | null;
  mode?: SendMode;
  status?: CampaignStatus;
  name?: string;
}) {
  const write = await dbWrite();
  const n = next();
  return write((c) =>
    c.campaign.create({
      data: {
        name: opts.name ?? `Campaign ${n}`,
        createdById: opts.createdById,
        senderId: opts.senderId === undefined ? opts.createdById : opts.senderId,
        status: opts.status ?? "RUNNING",
        mode: opts.mode ?? "LIVE",
        fromAddress: "Ali <ali@send.example.com>",
        launchedAt: new Date(Date.now() - 10 * DAY),
        steps: {
          create: [
            { step: 0, subject: "Hello", body: "Hi" },
            { step: 1, subject: null, body: "Again", delayDays: 3 },
            { step: 2, subject: null, body: "Last", delayDays: 4 },
          ],
        },
      },
    }),
  );
}

export type Enrolled = { recipientId: number; queuedId: number | null; sentIds: number[] };

/**
 * Puts a person into a campaign. Default: a follow-up waiting (step 0 SENT a day ago, step 1 QUEUED, WAITING,
 * currentStep 1). `first: true`: waiting for the first email (SCHEDULED, step 0 QUEUED, nothing sent).
 */
export async function enroll(
  campaign: { id: number; mode: SendMode | null; senderId: number | null },
  person: { id: number; companyId: number; emailNorm: string | null; email: string | null },
  opts: {
    first?: boolean;
    state?: RecipientState;
    currentStep?: number;
    sent?: Array<{ step: number; sentAt: Date }>;
    queuedStep?: number | null;
    holdReason?: string | null;
    heldAt?: Date | null;
    stopReason?: string | null;
    reserve?: boolean;
  } = {},
): Promise<Enrolled> {
  const write = await dbWrite();
  const first = opts.first === true;
  const sent = opts.sent ?? (first ? [] : [{ step: 0, sentAt: new Date(Date.now() - DAY) }]);
  const queuedStep = opts.queuedStep === undefined ? (first ? 0 : 1) : opts.queuedStep;
  const email = person.emailNorm!;
  const recipient = await write((c) =>
    c.campaignRecipient.create({
      data: {
        campaignId: campaign.id,
        companyId: person.companyId,
        personId: person.id,
        emailNorm: email,
        state: opts.state ?? (first ? "SCHEDULED" : "WAITING"),
        currentStep: opts.currentStep ?? (first ? 0 : 1),
        holdReason: opts.holdReason ?? null,
        heldAt: opts.heldAt ?? (opts.holdReason ? new Date(Date.now() - HOUR) : null),
        stopReason: opts.stopReason ?? null,
      },
    }),
  );
  const base = {
    campaignId: campaign.id,
    recipientId: recipient.id,
    personId: person.id,
    companyId: person.companyId,
    senderId: campaign.senderId,
    mode: campaign.mode ?? "LIVE",
    toEmail: person.email ?? email,
    toNorm: email,
    companyName: "Snapshot",
    fromAddress: "Ali <ali@send.example.com>",
    subject: "Hello",
    text: "Hi",
    html: "<p>Hi</p>",
  };
  const sentIds: number[] = [];
  for (const s of sent) {
    const n = next();
    const row = await write((c) =>
      c.outboundEmail.create({
        data: {
          ...base,
          step: s.step,
          messageId: `pp.w${n}.${s.step}@send.example.com`,
          sendId: `send-w${n}`,
          dueAt: s.sentAt,
          status: "SENT",
          sentAt: s.sentAt,
          providerId: `pp.w${n}.${s.step}@send.example.com`,
        },
      }),
    );
    sentIds.push(row.id);
  }
  let queuedId: number | null = null;
  if (queuedStep !== null) {
    const n = next();
    const row = await write((c) =>
      c.outboundEmail.create({
        data: {
          ...base,
          step: queuedStep,
          messageId: `pp.w${n}.${queuedStep}@send.example.com`,
          sendId: `send-w${n}`,
          dueAt: new Date(Date.now() + DAY),
          status: "QUEUED",
        },
      }),
    );
    queuedId = row.id;
  }
  if (opts.reserve !== false) {
    const { db } = await import("@/server/db");
    const held = await db.companyReservation.findFirst({ where: { campaignId: campaign.id, companyId: person.companyId, releasedAt: null } });
    if (!held) await write((c) => c.companyReservation.create({ data: { campaignId: campaign.id, companyId: person.companyId } }));
  }
  return { recipientId: recipient.id, queuedId, sentIds };
}

/** A processed (or not) InboundMessage in the shape reply processing leaves it (M4-DESIGN §3.8 step 10). */
export async function makeInbound(opts: {
  kind: InboundKind | null;
  companyId?: number | null;
  campaignId?: number | null;
  heldCompanyId?: number | null;
  replyScope?: "real" | "campaign" | "none" | null;
  assigneeId?: number | null;
  processed?: boolean;
  answeredAt?: Date | null;
  answerOutcome?: string | null;
  fromEmail?: string;
  receivedAt?: Date;
}) {
  const write = await dbWrite();
  const n = next();
  return write((c) =>
    c.inboundMessage.create({
      data: {
        messageIdHeader: `m${n}@example.org`,
        receivedAt: opts.receivedAt ?? new Date(Date.now() - HOUR),
        toAddress: "ali@send.example.com",
        fromEmail: opts.fromEmail ?? `someone${n}@example.org`,
        subject: "Re: Hello",
        snippet: "Thanks",
        kind: opts.kind,
        companyId: opts.companyId ?? null,
        campaignId: opts.campaignId ?? null,
        heldCompanyId: opts.heldCompanyId ?? null,
        replyScope: opts.replyScope === undefined ? (opts.kind ? "real" : null) : opts.replyScope,
        assigneeId: opts.assigneeId ?? null,
        answeredAt: opts.answeredAt ?? null,
        answerOutcome: opts.answerOutcome ?? null,
        source: "NOTIFY",
        processedAt: opts.processed === false ? null : new Date(),
      },
    }),
  );
}

/** One recipient's state, hold and stop fields. */
export async function recipient(id: number) {
  const { db } = await import("@/server/db");
  return db.campaignRecipient.findUniqueOrThrow({
    where: { id },
    select: { state: true, stopReason: true, holdReason: true, heldAt: true, stoppedByInboundId: true, currentStep: true, nextDueAt: true },
  });
}

/** One email's status and lastError. */
export async function email(id: number) {
  const { db } = await import("@/server/db");
  return db.outboundEmail.findUniqueOrThrow({ where: { id }, select: { status: true, lastError: true } });
}

/** Writes SystemState "catchup.outage" (any shape; parsed leniently by the app). */
export async function setOutage(value: Record<string, unknown> | null) {
  const write = await dbWrite();
  await write(async (c) => {
    await c.systemState.deleteMany({ where: { key: "catchup.outage" } });
    if (value) await c.systemState.create({ data: { key: "catchup.outage", value: value as never, version: 1 } });
  });
}

/** The parsed SystemState "catchup.outage". */
export async function readOutage() {
  const { readTyped } = await import("@/server/state-typed");
  const { parseOutageState } = await import("@/core/system-state-parse");
  return (await readTyped("catchup.outage", parseOutageState)).value;
}
