import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChecklistRow } from "@/core/system-state";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { checklistRows, launchTo, resetSendingState, setupM3, worldClock, type M3World } from "../sending-m3/helpers";

/**
 * Review SEND-1: Retry can bring a finished test or live campaign back to Running, but a From address change is refused
 * only while such a campaign is scheduled, running or paused. So Retry itself refuses ("from-changed") when the
 * campaign's From line is no longer what today's settings use: a shared-From campaign after the From address was
 * cleared or changed (or its reply address's sending domain was replaced), a per-person campaign after a From address
 * was saved. Nothing changes then: the email stays failed, the person stopped and the campaign finished. Per-person mode
 * (no From address saved) and dry runs are unchanged. The fake Mailgun only; nothing reaches the network.
 */

const t = await createTestDb("shared-from-retry");
const { db, dbWrite } = await import("@/server/db");
const { retryEmail, retrySnapshotProblem, RETRY_FROM_TEXTS, FAILED_STOP_REASON } = await import("@/server/services/campaigns/control");
const { CampaignError } = await import("@/server/services/campaigns/errors");
const { saveFromAddress } = await import("@/server/services/mailgun/connect");
const { setState } = await import("@/server/state");
const { TEAM_FROM_TEXTS } = await import("@/core/sending/from-address");

const TEAM = "contact@example.com";
const ALI = "ali@send.example.com";
const LIST = Array.from({ length: 10 }, (_, i) => `r${i}@retry-${i}.de`);

let world: M3World;

/** Shared-From mode on (the From address, a reply test passed with it, a green from-mx row) or off (per-person). */
async function useTeamFrom(on: boolean): Promise<void> {
  await setSettingValue("mailgun.fromAddress", on ? TEAM : null);
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: world.mg.domain,
    mailboxes: [],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: world.owner.id,
    note: null,
    from: on ? TEAM : null,
  });
  const fromMx: ChecklistRow = { key: "from-mx", group: "dns", status: "ok", title: "Mail for example.com stays with your mail provider (MX)", text: "", fix: null, records: [], detail: null };
  const rows = [...checklistRows(), ...(on ? [fromMx] : [])];
  await setState("domain.check", { domain: world.mg.domain, region: "EU", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows, error: null });
}

/** Launches one email to `to` in today's mode, then makes it fail for good: the email FAILED, the campaign finished. */
async function finishedWithFailedEmail(to: string): Promise<{ campaignId: number; emailId: number; recipientId: number }> {
  const clock = worldClock(world);
  const { campaignId } = await launchTo(world, [to], { now: clock.now() });
  const row = await db.outboundEmail.findFirstOrThrow({ where: { campaignId, step: 0 } });
  await dbWrite(async (c) => {
    await c.outboundEmail.update({ where: { id: row.id }, data: { status: "FAILED", lastError: "Mailgun refused it", claimedAt: null } });
    await c.campaignRecipient.update({ where: { id: row.recipientId }, data: { state: "STOPPED", stopReason: FAILED_STOP_REASON, nextDueAt: null } });
    await c.campaign.update({ where: { id: campaignId }, data: { status: "FINISHED", finishedAt: clock.now() } });
  });
  return { campaignId, emailId: row.id, recipientId: row.recipientId };
}

async function refusal(p: Promise<unknown>): Promise<unknown> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignError);
  expect(err).toMatchObject({ code: "from-changed" });
  return err;
}

/** Nothing changed after a refused retry. */
async function expectUntouched(ids: { campaignId: number; emailId: number; recipientId: number }): Promise<void> {
  expect((await db.campaign.findUniqueOrThrow({ where: { id: ids.campaignId } })).status).toBe("FINISHED");
  expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: ids.emailId } })).status).toBe("FAILED");
  expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: ids.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: FAILED_STOP_REASON });
  expect(await db.activityLog.count({ where: { type: "campaign.emailRetried", campaignId: ids.campaignId } })).toBe(0);
}

beforeAll(async () => {
  world = await setupM3({ testList: LIST });
});

beforeEach(async () => {
  world.mg.fake.reset();
  await resetSendingState();
  await setSettingValue("sending.testList", LIST);
  await setSettingValue("sending.mode", "TEST");
  await setSettingValue("sending.goLive", false);
  await setSettingValue("mailgun.domain", world.mg.domain);
  await useTeamFrom(true);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("Retry after the From address changed (review SEND-1)", () => {
  it("a shared-From campaign after the From address was cleared: refused, nothing changes; with the same From again it runs", async () => {
    const ids = await finishedWithFailedEmail(LIST[0]!);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: ids.campaignId } })).toMatchObject({ fromAddress: TEAM, replyTo: ALI });

    // The documented way back: clear the From address (no test or live campaign is active: this one finished).
    expect(await saveFromAddress(world.owner, { fromAddress: "" })).toMatchObject({ ok: true, fromAddress: null });
    const err = await refusal(retryEmail(ids.emailId, world.owner.id));
    expect((err as Error).message).toBe(RETRY_FROM_TEXTS.fromChanged(TEAM));
    expect((err as Error).message).toBe(
      "This campaign was launched with the From address contact@example.com, which has changed since. Start a new campaign to email this person again.",
    );
    await expectUntouched(ids);

    // Another shared From address: refused too.
    await setSettingValue("mailgun.fromAddress", "hello@example.com");
    await refusal(retryEmail(ids.emailId, world.owner.id));
    await expectUntouched(ids);

    // The From address it was launched with: Retry works as before.
    await setSettingValue("mailgun.fromAddress", TEAM);
    const res = await retryEmail(ids.emailId, world.owner.id);
    expect(res.status).toBe("QUEUED");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: ids.campaignId } })).status).toBe("RUNNING");
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: ids.emailId } })).toMatchObject({ status: "QUEUED", fromAddress: `Ali from Polygon Paradise <${TEAM}>`, replyTo: ALI });
  });

  it("a live campaign is refused the same way (an UNCONFIRMED email too, before any duplicate question)", async () => {
    await setSettingValue("sending.mode", "LIVE");
    const ids = await finishedWithFailedEmail(LIST[1]!);
    await dbWrite((c) => c.outboundEmail.update({ where: { id: ids.emailId }, data: { status: "UNCONFIRMED" } }));
    await setSettingValue("mailgun.fromAddress", null);
    const err = await refusal(retryEmail(ids.emailId, world.owner.id, { confirmDuplicateRisk: true }));
    expect((err as Error).message).toBe(RETRY_FROM_TEXTS.fromChanged(TEAM));
    expect((await db.outboundEmail.findUniqueOrThrow({ where: { id: ids.emailId } })).status).toBe("UNCONFIRMED");
  });

  it("a per-person campaign after a From address was saved: refused; cleared again, it runs as before", async () => {
    await useTeamFrom(false);
    const ids = await finishedWithFailedEmail(LIST[2]!);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: ids.campaignId } })).toMatchObject({ fromAddress: ALI, replyTo: null });

    expect(await saveFromAddress(world.owner, { fromAddress: TEAM })).toMatchObject({ ok: true, fromAddress: TEAM });
    const err = await refusal(retryEmail(ids.emailId, world.owner.id));
    expect((err as Error).message).toBe(RETRY_FROM_TEXTS.nowShared(TEAM));
    await expectUntouched(ids);

    await setSettingValue("mailgun.fromAddress", null);
    expect((await retryEmail(ids.emailId, world.owner.id)).status).toBe("QUEUED");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: ids.campaignId } })).status).toBe("RUNNING");
  });

  it("per-person mode throughout is unchanged: Retry reopens the finished campaign", async () => {
    await useTeamFrom(false);
    const ids = await finishedWithFailedEmail(LIST[3]!);
    const res = await retryEmail(ids.emailId, world.owner.id);
    expect(res.status).toBe("QUEUED");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: ids.campaignId } })).status).toBe("RUNNING");
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: ids.recipientId } })).toMatchObject({ state: "SCHEDULED", stopReason: null });
  });

  it("a dry run never reaches Mailgun, so it is never refused", async () => {
    await setSettingValue("sending.mode", "DRY_RUN");
    const ids = await finishedWithFailedEmail(LIST[4]!);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: ids.campaignId } })).toMatchObject({ fromAddress: TEAM, replyTo: ALI });
    await setSettingValue("mailgun.fromAddress", null);
    expect((await retryEmail(ids.emailId, world.owner.id)).status).toBe("QUEUED");
  });

  it("a shared-From campaign whose reply address's sending domain was replaced: refused", async () => {
    const ids = await finishedWithFailedEmail(LIST[5]!);
    // The same From address still fits the new sending domain (F14), but the campaign's reply address is on the old one.
    await setSettingValue("mailgun.domain", "mail.example.com");
    try {
      const err = await refusal(retryEmail(ids.emailId, world.owner.id));
      expect((err as Error).message).toBe(RETRY_FROM_TEXTS.domainChanged("send.example.com"));
      await expectUntouched(ids);
    } finally {
      await setSettingValue("mailgun.domain", world.mg.domain);
    }
  });
});

describe("retrySnapshotProblem", () => {
  const team = (address: string | null, saved: string | null = address, domain: string | null = "send.example.com", problem: string | null = null) => ({
    address,
    saved,
    domain,
    problem,
  });
  const shared = { mode: "LIVE" as const, fromAddress: TEAM, replyTo: ALI };
  const perPerson = { mode: "LIVE" as const, fromAddress: ALI, replyTo: null };

  it("accepts a snapshot that matches today's settings, in both modes", () => {
    expect(retrySnapshotProblem(shared, team(TEAM))).toBeNull();
    expect(retrySnapshotProblem({ ...shared, fromAddress: " Contact@Example.com ", replyTo: "Ali@Send.Example.com" }, team(TEAM))).toBeNull();
    expect(retrySnapshotProblem(perPerson, team(null))).toBeNull();
    expect(retrySnapshotProblem({ ...perPerson, mode: "TEST" }, team(null))).toBeNull();
  });

  it("never judges a dry run (or a campaign without a mode)", () => {
    expect(retrySnapshotProblem({ ...shared, mode: "DRY_RUN" }, team(null))).toBeNull();
    expect(retrySnapshotProblem({ ...perPerson, mode: null }, team(TEAM))).toBeNull();
  });

  it("names what changed", () => {
    expect(retrySnapshotProblem(shared, team(null))).toBe(RETRY_FROM_TEXTS.fromChanged(TEAM));
    expect(retrySnapshotProblem(shared, team("hello@example.com"))).toBe(RETRY_FROM_TEXTS.fromChanged(TEAM));
    expect(retrySnapshotProblem(perPerson, team(TEAM))).toBe(RETRY_FROM_TEXTS.nowShared(TEAM));
    expect(retrySnapshotProblem(shared, team(TEAM, TEAM, "mail.example.com"))).toBe(RETRY_FROM_TEXTS.domainChanged("send.example.com"));
    expect(retrySnapshotProblem({ ...shared, fromAddress: null }, team(TEAM))).toBe(RETRY_FROM_TEXTS.unknown);
  });

  it("a saved From address that doesn't fit the sending domain answers with its own sentence", () => {
    const misfit = TEAM_FROM_TEXTS.misfit(TEAM, "send-studio.com");
    expect(retrySnapshotProblem(shared, team(null, TEAM, "send-studio.com", misfit))).toBe(misfit);
    expect(retrySnapshotProblem(perPerson, team(null, TEAM, "send-studio.com", misfit))).toBe(misfit);
  });
});
