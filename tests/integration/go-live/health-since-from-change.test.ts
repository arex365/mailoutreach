import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChecklistRow } from "@/core/system-state";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { checklistRows } from "../sending-m3/helpers";
import { TESS, freshCheck, holdLease, resetGoLive, seedLiveTest, setupGoLive, type GoLiveWorld } from "./helpers";

/**
 * Review REPLIES-02: bounces and complaints count from the FIRST go-live on the sending domain. A From address change
 * ends go-live on the same Mailgun domain (SHARED-FROM-DESIGN F13); going live again must not drop the earlier live
 * period's complaints from the automatic pause, Domain health or the warm-up's health. Only a go-live on another sending
 * domain starts counting again. The warm-up itself still restarts at every go-live. The fake Mailgun only; nothing
 * reaches the network.
 */

const t = await createTestDb("go-live-health-from-change");
const { db, dbWrite } = await import("@/server/db");
const { getSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const { goLive } = await import("@/server/services/go-live");
const { saveFromAddress } = await import("@/server/services/mailgun/connect");
const { loadHealthView } = await import("@/server/services/mail-events/deliverability");
const { runHealthCheck } = await import("@/server/services/sending/health-check");
const { getPauseState } = await import("@/server/services/sending/pause");
const { loadWarmupProgress } = await import("@/server/services/sending/warmup-days");
const { formatShortDate } = await import("@/core/time/format");

const TZ = "Europe/Berlin";
const FROM = "contact@example.com";
const D = "send.example.com";
const MIN = 60_000;
let world: GoLiveWorld;
let seq = 0;

/** The Domain checklist, all green plus a green from-mx row (shared-From mode), checked at `at`. */
async function teamCheck(at: Date): Promise<void> {
  const fromMx: ChecklistRow = { key: "from-mx", group: "dns", status: "ok", title: "Mail for example.com stays with your mail provider (MX)", text: "", fix: null, records: [], detail: null };
  await setState("domain.check", { domain: D, region: "EU", checkedAt: at.toISOString(), lastVerifyAt: null, rows: [...checklistRows(), fromMx], error: null });
}

/** The reply test passed on the domain for `from` (null = per-person). */
async function replyTestPassed(from: string | null): Promise<void> {
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain: D,
    from,
    mailboxes: [{ address: TESS, provider: "other", inboxOk: true, authOk: "pass", authFromHeaders: false, placementOk: true, dmarcOk: "pass", dmarcFromHeaders: false }],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: world.owner.id,
    note: null,
  });
}

/** A live email to a prospect sent at `at` that drew a complaint. */
async function complaintAt(at: Date): Promise<number> {
  seq += 1;
  const emailId = await seedLiveTest(world, { at, to: `prospect${seq}@real-company.example` });
  await dbWrite((c) =>
    c.mailEvent.create({
      data: {
        dedupeKey: `health-from-change-complaint-${seq}-${Date.now()}`,
        type: "complained",
        occurredAt: new Date(at.getTime() + MIN),
        recipient: `prospect${seq}@real-company.example`,
        outboundEmailId: emailId,
        source: "WEBHOOK",
        raw: {},
        processedAt: new Date(at.getTime() + MIN),
      },
    }),
  );
  return emailId;
}

beforeAll(async () => {
  world = await setupGoLive();
});

beforeEach(async () => {
  await resetGoLive();
  await setSettingValue("sending.goLiveFrom", null);
  await setSettingValue("sending.healthSinceGoLiveAt", null);
  await dbWrite(async (c) => {
    await c.setting.deleteMany({ where: { key: "mailgun.fromAddress" } });
    await c.mailEvent.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.notification.deleteMany({});
  });
  await replyTestPassed(null);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("health counting across go-lives (review REPLIES-02)", () => {
  it("live → From change → live again: the first live period's complaint still counts, pauses at the second, and keeps the warm-up unhealthy", async () => {
    // 1. Live per-person 30 minutes ago.
    const first = new Date(Date.now() - 30 * MIN);
    await seedLiveTest(world, { at: new Date(first.getTime() - MIN) });
    await freshCheck(first);
    await holdLease(first);
    expect((await goLive(world.owner, { now: first })).alreadyLive).toBe(false);
    expect(await getSetting("sending.healthSinceGoLiveAt")).toEqual({ since: first.toISOString(), goLiveAt: first.toISOString(), domain: D });

    // 2. A real prospect complains about an email of that first live period.
    await complaintAt(new Date(first.getTime() + 5 * MIN));

    // 3. The documented way back: change the From address (go-live ends), redo the reply test and a live test, go live.
    const saved = await saveFromAddress(world.owner, { fromAddress: FROM, confirmEndGoLive: true });
    expect(saved).toMatchObject({ ok: true, goLiveEnded: true });
    expect(await getSetting("sending.goLive")).toBe(false);
    await replyTestPassed(FROM);
    const liveTestId = await seedLiveTest(world, { at: new Date() });
    const liveTest = await db.outboundEmail.findUniqueOrThrow({ where: { id: liveTestId }, select: { campaignId: true } });
    await dbWrite(async (c) => {
      await c.campaign.update({ where: { id: liveTest.campaignId }, data: { fromAddress: FROM, replyTo: world.senderAddress } });
      await c.outboundEmail.update({ where: { id: liveTestId }, data: { replyTo: world.senderAddress } });
    });
    const again = new Date();
    await teamCheck(again);
    await holdLease(again);
    expect((await goLive(world.owner, { now: again })).alreadyLive).toBe(false);

    // The go-live moved; health keeps counting from the first go-live on this domain.
    expect(await getSetting("sending.goLiveAt")).toBe(again.toISOString());
    expect(await getSetting("sending.healthSinceGoLiveAt")).toEqual({ since: first.toISOString(), goLiveAt: again.toISOString(), domain: D });

    // Domain health (Settings › Deliverability and the dashboard) still shows the complaint, counted since the first go-live.
    const now = new Date();
    const view = await loadHealthView(TZ, now);
    expect(view.counts.complaints).toBe(1);
    expect(view.sinceNote).toBe(`Counting since you went live on ${formatShortDate(first, TZ, now)}.`);

    // The warm-up's health judgement sees it too (while the ramp itself restarted at this go-live).
    expect((await loadWarmupProgress(now)).today?.healthy).toBe(false);

    // The health check: the half-limit warning now, and the next complaint pauses sending (the default limit is 1).
    expect(await runHealthCheck({ now })).toMatchObject({ paused: false, warned: ["complaint"] });
    await complaintAt(new Date(Date.now() + 1_000));
    expect((await runHealthCheck({ now: new Date() })).paused).toBe(true);
    expect((await getPauseState()).kind).toBe("health-complaint");
  });

  it("a go-live on another sending domain starts counting again", async () => {
    // Live on an older domain before (a domain change ended it); a complaint from that time.
    const old = new Date(Date.now() - 3 * 60 * MIN);
    await setSettingValue("sending.goLiveAt", old.toISOString());
    await setSettingValue("sending.goLiveDomain", "old.example.com");
    await setSettingValue("sending.healthSinceGoLiveAt", { since: old.toISOString(), goLiveAt: old.toISOString(), domain: "old.example.com" });
    await complaintAt(new Date(old.getTime() + 10 * MIN));
    // Before going live here, counting still runs from the old go-live (as before this change).
    expect((await loadHealthView(TZ)).counts.complaints).toBe(1);

    await seedLiveTest(world, { at: new Date(Date.now() - MIN) });
    const now = new Date();
    await freshCheck(now);
    await holdLease(now);
    await goLive(world.owner, { now });
    expect(await getSetting("sending.healthSinceGoLiveAt")).toEqual({ since: now.toISOString(), goLiveAt: now.toISOString(), domain: D });
    const view = await loadHealthView(TZ, now);
    expect(view.counts.complaints).toBe(0);
    expect(view.sinceNote).toBe(`Counting since you went live on ${formatShortDate(now, TZ, now)}.`);
  });

  it("a go-live written without the new setting (an older install, a seed) counts from sending.goLiveAt, as before", async () => {
    const at = new Date(Date.now() - 60 * MIN);
    await setSettingValue("sending.goLive", true);
    await setSettingValue("sending.goLiveAt", at.toISOString());
    await setSettingValue("sending.goLiveDomain", D);
    // A value an earlier go-live wrote no longer applies once "sending.goLiveAt" was written by someone else.
    await setSettingValue("sending.healthSinceGoLiveAt", { since: "2026-01-01T00:00:00.000Z", goLiveAt: "2026-01-01T00:00:00.000Z", domain: D });
    await complaintAt(new Date(at.getTime() - 10 * MIN));
    const view = await loadHealthView(TZ);
    expect(view.counts.complaints).toBe(0);
    expect(view.sinceNote).toBe(`Counting since you went live on ${formatShortDate(at, TZ, new Date())}.`);
  });
});
