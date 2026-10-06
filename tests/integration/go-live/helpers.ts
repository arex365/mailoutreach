/**
 * Shared set-up for the go-live tests (M6-DESIGN §2.4–§2.8, §8 P2): the M3 world (the fake Mailgun on
 * send.example.com, Arslan the Owner and Ali a Member with working reply routes, a green checklist, Setup A passed on
 * the domain) plus what going live needs on top: the test list with Tess ("Test mailboxes"), a fresh check of the
 * Domain checklist, a background sender with a fresh heartbeat and a delivered live test email. Bo is a switched-off
 * teammate. Call createTestDb() first; every helper imports the server modules lazily. Nothing reaches the network.
 */
import type { SendMode, SendStatus } from "@/generated/prisma/client";
import { makeCompany, makeUser, setSettingValue } from "../campaigns/seed";
import { checklistRows, setupM3, type M3World } from "../sending-m3/helpers";

export const TESS = "tess@test-mailbox.example";

export type GoLiveWorld = M3World & { bo: { id: number; name: string }; tess: { companyId: number; personId: number } };

/** The M3 world ready to go live, except the live test (seedLiveTest) and a fresh check (freshCheck, holdLease). */
export async function setupGoLive(): Promise<GoLiveWorld> {
  const world = await setupM3({ testList: [TESS] });
  const { dbWrite } = await import("@/server/db");
  const bo = await makeUser("Bo", { email: "bo@polygonparadise.test" });
  await dbWrite((c) => c.user.update({ where: { id: bo.id }, data: { active: false } }));
  const { company, people } = await makeCompany({ name: "Test mailboxes", domain: "test-mailbox.example", people: [{ name: "Tess", email: TESS }] });
  return { ...world, bo: { id: bo.id, name: bo.name }, tess: { companyId: company.id, personId: people[0]!.id } };
}

/** The Domain checklist, all green, checked for `domain` at `at` (SystemState "domain.check"). */
export async function freshCheck(at: Date, domain = "send.example.com", error: string | null = null): Promise<void> {
  const { setState } = await import("@/server/state");
  await setState("domain.check", { domain, region: "EU", checkedAt: at.toISOString(), lastVerifyAt: null, rows: checklistRows(), error });
}

/** The background sender's lease with its heartbeat at `at` (fresh for a minute). */
export async function holdLease(at: Date): Promise<void> {
  const { dbWrite } = await import("@/server/db");
  await dbWrite((c) =>
    c.workerLease.upsert({
      where: { id: 1 },
      create: { id: 1, workerId: "go-live-test", heartbeatAt: at, startedAt: at },
      update: { heartbeatAt: at, startedAt: at },
    }),
  );
}

let seq = 0;

/**
 * A sent email of a finished campaign on `domainId` (the live test, §0.3): LIVE and SENT to Tess by default, with a
 * `delivered` event unless told otherwise, and a permanent failure when `failed`. Returns the email's id.
 */
export async function seedLiveTest(
  world: GoLiveWorld,
  opts: {
    domainId?: number | null;
    to?: string;
    mode?: SendMode;
    status?: SendStatus;
    delivered?: boolean;
    failed?: boolean;
    at?: Date;
  } = {},
): Promise<number> {
  const { dbWrite } = await import("@/server/db");
  seq += 1;
  const at = opts.at ?? new Date();
  const to = (opts.to ?? TESS).toLowerCase();
  const mode = opts.mode ?? "LIVE";
  const campaign = await dbWrite((c) =>
    c.campaign.create({
      data: {
        name: `Live test ${seq}`,
        createdById: world.owner.id,
        senderId: world.member.id,
        mode,
        status: "FINISHED",
        sendingDomainId: opts.domainId === undefined ? world.mg.domainId : opts.domainId,
        launchedAt: at,
        launchedGoLive: false,
      },
    }),
  );
  const recipient = await dbWrite((c) =>
    c.campaignRecipient.create({
      data: { campaignId: campaign.id, companyId: world.tess.companyId, personId: world.tess.personId, emailNorm: to, state: "FINISHED" },
    }),
  );
  const messageId = `pp.golive${seq}.${Date.now()}@send.example.com`;
  const status = opts.status ?? "SENT";
  const email = await dbWrite((c) =>
    c.outboundEmail.create({
      data: {
        campaignId: campaign.id,
        recipientId: recipient.id,
        personId: world.tess.personId,
        companyId: world.tess.companyId,
        senderId: world.member.id,
        step: 0,
        mode,
        toEmail: to,
        toNorm: to,
        companyName: "Test mailboxes",
        fromAddress: "Ali <ali@send.example.com>",
        subject: "Live test",
        text: "t",
        html: "h",
        messageId,
        sendId: `golive-${seq}-${Date.now()}`,
        dueAt: at,
        status,
        claimedAt: at,
        sentAt: status === "SENT" ? at : null,
        providerId: messageId,
      },
    }),
  );
  const events: Array<{ type: string; severity: string | null }> = [];
  if (opts.delivered !== false) events.push({ type: "delivered", severity: null });
  if (opts.failed) events.push({ type: "failed", severity: "permanent" });
  for (const e of events) {
    seq += 1;
    await dbWrite((c) =>
      c.mailEvent.create({
        data: {
          dedupeKey: `golive-event-${seq}-${Date.now()}`,
          type: e.type,
          severity: e.severity,
          reason: e.type === "failed" ? "bounce" : null,
          occurredAt: new Date(at.getTime() + 60_000),
          messageId,
          recipient: to,
          outboundEmailId: email.id,
          source: "WEBHOOK",
          raw: {},
          processedAt: new Date(at.getTime() + 60_000),
        },
      }),
    );
  }
  return email.id;
}

/** Back to "not live": go-live settings cleared, mode TEST, no hand-set limit, no pause, the test list with Tess. */
export async function resetGoLive(): Promise<void> {
  const { dbWrite } = await import("@/server/db");
  for (const [key, value] of [
    ["sending.goLive", false],
    ["sending.goLiveAt", null],
    ["sending.goLiveDomain", null],
    ["sending.mode", "TEST"],
    ["sending.capOverride", null],
    ["sending.testList", [TESS]],
    ["practice.copy", false],
  ] as const) {
    await setSettingValue(key, value);
  }
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: { in: ["sending.pause", "restore", "health.baseline", "warmup"] } } });
    await c.activityLog.deleteMany({ where: { type: "sending.goLive" } });
    await c.notification.deleteMany({});
  });
}
