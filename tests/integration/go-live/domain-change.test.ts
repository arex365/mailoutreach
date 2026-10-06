import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, setSettingValue } from "../campaigns/seed";
import { launchTo } from "../sending-m3/helpers";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { TESS, freshCheck, holdLease, seedLiveTest, setupGoLive, type GoLiveWorld } from "./helpers";

/**
 * A sending-domain change ends go-live (M6-DESIGN §2.8, G8): live on send.example.com → "Save and connect" with
 * send2.example.com → `sending.goLive` false in the same transaction (when and where kept, for "You were live on …"),
 * the activity says so, the connect message says what to do; a new live campaign then reaches only the test list; and
 * going live again on send2 needs its own checklist, reply test and delivered live test. Two local fake Mailguns;
 * nothing reaches the network.
 */

const t = await createTestDb("go-live-domain-change");
const { db, dbWrite } = await import("@/server/db");
const { getSettings } = await import("@/server/settings");
const { connectMailgun } = await import("@/server/services/mailgun/connect");
const { goLive, loadGoLiveView } = await import("@/server/services/go-live");
const { loadSendGuard } = await import("@/server/mailgun/context");
const { checkSendGuard } = await import("@/server/mailgun/send-guard");

const NEW = "send2.example.com";
const PROSPECT = "anna@firma.example";
let world: GoLiveWorld;
let fake2: FakeMailgun;

/** Setup A passed on `domain` (the reply test belongs to one domain). */
async function replyTestPassedOn(domain: string): Promise<void> {
  await setSettingValue("mailgun.unsubscribeTest", {
    setup: "A",
    status: "passed",
    domain,
    mailboxes: [],
    headersOk: true,
    decidedAt: new Date().toISOString(),
    decidedById: world.owner.id,
    note: null,
  });
}

beforeAll(async () => {
  world = await setupGoLive();
  fake2 = await startFakeMailgun({ domain: NEW, region: "EU" });
  // The prospect's address is checked, so the only thing that can keep her out is the test-list rule.
  await makeCompany({
    name: "Firma GmbH",
    domain: "firma.example",
    people: [{ name: "Anna", email: PROSPECT, verificationStatus: "VALID", verifiedAt: new Date(Date.now() - 86_400_000) }],
  });
});

afterAll(async () => {
  await world.mg.stop();
  await fake2.close();
  await db.$disconnect();
  t.cleanup();
});

describe("a domain change after go-live", () => {
  it("goes live on send.example.com first", async () => {
    const now = new Date();
    await seedLiveTest(world);
    await freshCheck(now);
    await holdLease(now);
    expect(await goLive(world.owner, { now })).toMatchObject({ alreadyLive: false });
    expect(await getSettings(["sending.goLive", "sending.goLiveDomain"] as const)).toEqual({
      "sending.goLive": true,
      "sending.goLiveDomain": "send.example.com",
    });
  });

  it("ends go-live in the same save, keeps when and where, logs it and says what to do", async () => {
    const before = await getSettings(["sending.goLiveAt"] as const);
    process.env.OUTREACH_MAILGUN_BASE_URL = fake2.origin;
    const res = await connectMailgun(world.owner, { region: "EU", domain: NEW, apiKey: null }, { retryDelayMs: () => 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message).toMatch(/^Connected to send2\.example\.com \(EU\)\./);
    expect(res.message.endsWith(
      " You were live on send.example.com: go live again on send2.example.com when its checklist is green (Settings › Sending & Mailgun › Go live).",
    )).toBe(true);

    expect(await getSettings(["mailgun.domain", "sending.goLive", "sending.goLiveAt", "sending.goLiveDomain"] as const)).toEqual({
      "mailgun.domain": NEW,
      "sending.goLive": false,
      "sending.goLiveAt": before["sending.goLiveAt"],
      "sending.goLiveDomain": "send.example.com",
    });
    expect((await db.setting.findUniqueOrThrow({ where: { key: "sending.goLive" } })).updatedById).toBe(world.owner.id);
    const changed = await db.activityLog.findFirstOrThrow({ where: { type: "mailgun.domainChanged" } });
    expect(changed.data).toMatchObject({ from: "send.example.com", to: NEW, goLiveEnded: true });

    const view = await loadGoLiveView();
    expect(view).toMatchObject({ live: false, domain: NEW, endedOnDomain: "send.example.com" });
  });

  it("a new live campaign reaches only the test list", async () => {
    const now = new Date();
    await freshCheck(now, NEW);
    await holdLease(now);
    await replyTestPassedOn(NEW);
    // The addresses moved to send2 with their routes being set up; the route sync would make them work.
    await dbWrite((c) => c.senderAddress.updateMany({ where: { retiredAt: null }, data: { routeStatus: "ok" } }));
    await setSettingValue("sending.mode", "LIVE");

    const { campaignId } = await launchTo(world, [TESS, PROSPECT], { now, name: "After the change" });
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.launchedGoLive).toBe(false);
    const recipients = await db.campaignRecipient.findMany({ where: { campaignId }, select: { emailNorm: true, state: true, exclusionReason: true } });
    const anna = recipients.find((r) => r.emailNorm === PROSPECT)!;
    const tess = recipients.find((r) => r.emailNorm === TESS)!;
    expect(anna.state).toBe("EXCLUDED");
    expect(anna.exclusionReason).toMatch(/^Not on the test list/);
    expect(tess.state).not.toBe("EXCLUDED");

    // And the Mailgun client guard stops any live email to her.
    const guard = await loadSendGuard();
    expect(guard.goLive).toBe(false);
    expect(() => checkSendGuard({ to: PROSPECT, purpose: "campaign", guard })).toThrow(
      `Stopped by the test-list guard: ${PROSPECT} isn't on your test list.`,
    );
    await dbWrite((c) => c.campaign.update({ where: { id: campaignId }, data: { status: "FINISHED" } }));
  });

  it("going live again needs send2's own delivered live test, then goes live on send2", async () => {
    const now = new Date();
    await freshCheck(now, NEW);
    await holdLease(now);
    // The delivered live test on send.example.com proves nothing about send2.
    expect((await loadGoLiveView(now)).blockers).toEqual([
      "Send one live campaign to your test list first, and check that it arrived (Going-live guide, step 3).",
    ]);
    const send2 = await db.sendingDomain.findUniqueOrThrow({ where: { name: NEW } });
    await seedLiveTest(world, { domainId: send2.id });
    expect((await loadGoLiveView(now)).blockers).toEqual([]);
    expect(await goLive(world.owner, { now })).toMatchObject({ alreadyLive: false });
    expect(await getSettings(["sending.goLive", "sending.goLiveDomain", "sending.goLiveAt"] as const)).toEqual({
      "sending.goLive": true,
      "sending.goLiveDomain": NEW,
      "sending.goLiveAt": now.toISOString(),
    });
    expect((await loadGoLiveView(now)).endedOnDomain).toBeNull();
  });

  it("changing the domain while not live leaves go-live alone and says nothing about it", async () => {
    await setSettingValue("sending.goLive", false);
    process.env.OUTREACH_MAILGUN_BASE_URL = world.mg.fake.origin;
    const res = await connectMailgun(world.owner, { region: "EU", domain: "send.example.com", apiKey: null }, { retryDelayMs: () => 0 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).not.toContain("You were live");
    const changes = await db.activityLog.findMany({ where: { type: "mailgun.domainChanged" }, orderBy: { id: "desc" }, take: 1 });
    expect(changes[0]!.data).not.toHaveProperty("goLiveEnded");
  });
});
