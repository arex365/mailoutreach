import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { TESS, freshCheck, holdLease, resetGoLive, seedLiveTest, setupGoLive, type GoLiveWorld } from "./helpers";

/**
 * The go-live checklist's inputs (M6-DESIGN §2.4, `loadGateInputs`): the live test (§0.3), the check's freshness, the
 * background sender, the Access choice, the newest backup, address checks tried, a practice restore, today's hand-set
 * limit; and the blockers and recommendations built from them. Against the fake Mailgun; nothing reaches the network.
 */

const t = await createTestDb("go-live-gate-inputs");
const { db, dbWrite } = await import("@/server/db");
const { setState } = await import("@/server/state");
const { capDayOf, addCapDays } = await import("@/core/sending/capday");
const { MODE_GATE_TEXTS, GO_LIVE_RECOMMENDATION_TEXTS } = await import("@/core/sending/mode-gates");
const { goLiveBlockersFor, goLiveRecommendationsFor, loadGateInputs, loadLiveTest } = await import("@/server/services/reply-test");

const ZONE = "Asia/Karachi";
const MINUTE = 60_000;
let world: GoLiveWorld;

beforeAll(async () => {
  world = await setupGoLive();
});

beforeEach(async () => {
  await resetGoLive();
  const now = new Date();
  await freshCheck(now);
  await holdLease(now);
  await dbWrite(async (c) => {
    await c.mailEvent.deleteMany({});
    await c.outboundEmail.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaign.deleteMany({});
    await c.backup.deleteMany({});
    await c.verificationCheck.deleteMany({});
    await c.setting.deleteMany({ where: { key: { in: ["remoteAccess.accessOff", "backups.secondFolder"] } } });
  });
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the live test", () => {
  it("is 'delivered' for a SENT LIVE email on the current domain to a test-list address with a delivered event", async () => {
    await seedLiveTest(world);
    expect((await loadGateInputs()).liveTest).toBe("delivered");
    expect(goLiveBlockersFor(await loadGateInputs())).toEqual([]);
  });

  it("is 'sent' without the delivered event, or with a permanent failure", async () => {
    await seedLiveTest(world, { delivered: false });
    expect((await loadGateInputs()).liveTest).toBe("sent");
    expect(goLiveBlockersFor(await loadGateInputs())).toEqual([MODE_GATE_TEXTS.liveTestSent]);
    await dbWrite(async (c) => {
      await c.mailEvent.deleteMany({});
      await c.outboundEmail.deleteMany({});
    });
    await seedLiveTest(world, { delivered: true, failed: true });
    expect((await loadGateInputs()).liveTest).toBe("sent");
  });

  it("any delivered one among several is enough", async () => {
    await seedLiveTest(world, { delivered: false });
    await seedLiveTest(world, { delivered: true });
    expect((await loadGateInputs()).liveTest).toBe("delivered");
  });

  it("is 'none' for dry runs and test mode, another domain, an address off the list, or an email not sent", async () => {
    expect((await loadGateInputs()).liveTest).toBe("none");
    expect(goLiveBlockersFor(await loadGateInputs())).toEqual([MODE_GATE_TEXTS.liveTestNone]);
    await seedLiveTest(world, { mode: "DRY_RUN" });
    await seedLiveTest(world, { mode: "TEST" });
    const other = await dbWrite((c) => c.sendingDomain.create({ data: { name: "old.example.com", region: "EU", active: false } }));
    await seedLiveTest(world, { domainId: other.id });
    await seedLiveTest(world, { domainId: null });
    await seedLiveTest(world, { to: "someone@prospect.example" });
    await seedLiveTest(world, { status: "UNKNOWN" });
    expect((await loadGateInputs()).liveTest).toBe("none");
    // Tess delivered, then removed from the test list: her email no longer proves anything.
    await seedLiveTest(world);
    expect((await loadGateInputs()).liveTest).toBe("delivered");
    await setSettingValue("sending.testList", ["other@test-mailbox.example"]);
    expect((await loadGateInputs()).liveTest).toBe("none");
    expect(await loadLiveTest(world.mg.domainId, [])).toBe("none");
    expect(await loadLiveTest(null, [TESS])).toBe("none");
  });
});

describe("the checklist's freshness", () => {
  it("is fresh within the hour, stale after 61 minutes or with an error", async () => {
    const now = new Date();
    await freshCheck(new Date(now.getTime() - 59 * MINUTE));
    expect((await loadGateInputs(now)).checkFresh).toBe(true);
    await freshCheck(new Date(now.getTime() - 61 * MINUTE));
    const stale = await loadGateInputs(now);
    expect(stale.checkFresh).toBe(false);
    await seedLiveTest(world);
    expect(goLiveBlockersFor(stale)[0]).toBe(MODE_GATE_TEXTS.checkStale);
    await freshCheck(now, "send.example.com", "Mailgun didn't answer.");
    expect((await loadGateInputs(now)).checkFresh).toBe(false);
    // A check of another domain says nothing about this one.
    await freshCheck(now, "old.example.com");
    expect((await loadGateInputs(now)).checkFresh).toBe(false);
  });

  it("is stale when the check ran before the Access choice last changed", async () => {
    await freshCheck(new Date(Date.now() - 5 * MINUTE));
    await setSettingValue("remoteAccess.accessOff", true);
    const gate = await loadGateInputs();
    expect(gate.accessOff).toBe(true);
    expect(gate.accessOffChangedAt).toBeInstanceOf(Date);
    expect(gate.checkFresh).toBe(false);
    await freshCheck(new Date());
    expect((await loadGateInputs()).checkFresh).toBe(true);
  });
});

describe("the other inputs", () => {
  it("the background sender: a fresh heartbeat runs, a stale one doesn't", async () => {
    const now = new Date();
    await holdLease(new Date(now.getTime() - 30_000));
    expect((await loadGateInputs(now)).workerRunning).toBe(true);
    await holdLease(new Date(now.getTime() - 2 * MINUTE));
    const gate = await loadGateInputs(now);
    expect(gate.workerRunning).toBe(false);
    await seedLiveTest(world);
    expect(goLiveBlockersFor(gate)).toContain(MODE_GATE_TEXTS.workerStopped);
  });

  it("the Access choice, off by default", async () => {
    expect(await loadGateInputs()).toMatchObject({ accessOff: false, accessOffChangedAt: null });
    await setSettingValue("remoteAccess.accessOff", true);
    expect((await loadGateInputs()).accessOff).toBe(true);
  });

  it("the newest app backup (Daily or Back up now), the second folder", async () => {
    expect(await loadGateInputs()).toMatchObject({ newestBackupAt: null, secondFolder: null });
    const older = new Date(Date.now() - 50 * 3_600_000);
    const newer = new Date(Date.now() - 3 * 3_600_000);
    await dbWrite(async (c) => {
      await c.backup.create({ data: { fileName: "app-a.db", createdAt: older, sizeBytes: 1, kind: "AUTO" } });
      await c.backup.create({ data: { fileName: "app-b.db", createdAt: newer, sizeBytes: 1, kind: "MANUAL" } });
      // A script's backup row kind never counts as the newest app backup.
      await c.backup.create({ data: { fileName: "app-c.db", createdAt: new Date(), sizeBytes: 1, kind: "PRE_UPDATE" } });
    });
    await setSettingValue("backups.secondFolder", "  D:\\Backups  ");
    expect(await loadGateInputs()).toMatchObject({ newestBackupAt: newer, secondFolder: "D:\\Backups" });
  });

  it("address checks tried: only a check with a Mailgun result counts", async () => {
    expect((await loadGateInputs()).checksTried).toBe(false);
    await dbWrite((c) => c.verificationCheck.create({ data: { emailNorm: "a@b.example", provider: "fake", status: "VALID", risk: "LOW" } }));
    expect((await loadGateInputs()).checksTried).toBe(false);
    // The fake Mailgun's results count while the app talks to it (as here).
    await dbWrite((c) => c.verificationCheck.create({ data: { emailNorm: "a@b.example", provider: "mailgun-fake", status: "VALID", risk: "LOW" } }));
    expect((await loadGateInputs()).checksTried).toBe(true);
  });

  it("a practice restore: resumed or acknowledged", async () => {
    const restore = {
      status: "done",
      restoredFrom: "2026-09-20T08:00:00.000Z",
      scanFrom: null,
      markerAt: null,
      file: null,
      handledAt: null,
      report: null,
      acknowledgedAt: null,
      acknowledgedById: null,
    };
    expect((await loadGateInputs()).restoreDone).toBe(false);
    await setState("restore", restore);
    expect((await loadGateInputs()).restoreDone).toBe(false);
    await setState("restore", { ...restore, resumedAt: "2026-09-20T09:00:00.000Z", resumedById: world.owner.id });
    expect((await loadGateInputs()).restoreDone).toBe(true);
    await setState("restore", { ...restore, acknowledgedAt: "2026-09-20T09:00:00.000Z", acknowledgedById: world.owner.id });
    expect((await loadGateInputs()).restoreDone).toBe(true);
  });

  it("today's hand-set limit only when it is for today's cap day", async () => {
    const now = new Date();
    const today = capDayOf(now, ZONE);
    await setSettingValue("sending.capOverride", { capDay: today, cap: 400, byUserId: world.owner.id, at: now.toISOString() });
    expect((await loadGateInputs(now)).capOverrideToday).toBe(400);
    await setSettingValue("sending.capOverride", { capDay: addCapDays(today, -1), cap: 400, byUserId: world.owner.id, at: now.toISOString() });
    expect((await loadGateInputs(now)).capOverrideToday).toBeNull();
  });

  it("when and where the Owner last went live", async () => {
    await setSettingValue("sending.goLiveAt", "2026-09-23T08:30:00.000Z");
    await setSettingValue("sending.goLiveDomain", "Send.Example.com");
    expect(await loadGateInputs()).toMatchObject({ goLiveAt: "2026-09-23T08:30:00.000Z", goLiveDomain: "send.example.com" });
  });
});

describe("blockers and recommendations from the inputs", () => {
  it("names Setup B and a Mailgun that isn't connected", async () => {
    await seedLiveTest(world);
    await setSettingValue("mailgun.unsubscribeTest", {
      setup: "B",
      status: "passed",
      domain: "send.example.com",
      mailboxes: [],
      headersOk: true,
      decidedAt: new Date().toISOString(),
      decidedById: world.owner.id,
      note: null,
    });
    try {
      expect(goLiveBlockersFor(await loadGateInputs())).toEqual([MODE_GATE_TEXTS.setupA]);
    } finally {
      await setSettingValue("mailgun.unsubscribeTest", {
        setup: "A",
        status: "passed",
        domain: "send.example.com",
        mailboxes: [],
        headersOk: true,
        decidedAt: new Date().toISOString(),
        decidedById: world.owner.id,
        note: null,
      });
    }
    await dbWrite((c) => c.secret.deleteMany({ where: { key: "mailgun.apiKey" } }));
    try {
      expect(goLiveBlockersFor(await loadGateInputs())).toEqual([MODE_GATE_TEXTS.connect]);
    } finally {
      const { setSecret } = await import("@/server/secrets");
      await setSecret("mailgun.apiKey", world.mg.apiKey, null);
    }
  });

  it("recommends from the inputs, with the app folder checked against the user's folders", async () => {
    const gate = await loadGateInputs();
    const env = { USERPROFILE: "C:\\Users\\polyg", OneDrive: "C:\\Users\\polyg\\OneDrive" };
    const inPictures = goLiveRecommendationsFor({ ...gate, appFolder: "C:\\Users\\polyg\\Pictures\\outreach" }, env);
    expect(inPictures).toContain(GO_LIVE_RECOMMENDATION_TEXTS.appFolder("Pictures"));
    expect(inPictures).toEqual(
      expect.arrayContaining([
        GO_LIVE_RECOMMENDATION_TEXTS.checks,
        GO_LIVE_RECOMMENDATION_TEXTS.secondFolder,
        GO_LIVE_RECOMMENDATION_TEXTS.backupNever,
        GO_LIVE_RECOMMENDATION_TEXTS.restore,
      ]),
    );
    expect(goLiveRecommendationsFor({ ...gate, appFolder: "C:\\Outreach" }, env)).not.toContain(GO_LIVE_RECOMMENDATION_TEXTS.appFolder("Pictures"));
    // Nothing once live, and nothing in the practice copy.
    expect(goLiveRecommendationsFor({ ...gate, goLive: true }, env)).toEqual([]);
    expect(goLiveRecommendationsFor({ ...gate, practiceCopy: true }, env)).toEqual([]);
  });
});
