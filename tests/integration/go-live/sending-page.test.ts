import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { setSettingValue } from "../campaigns/seed";
import { freshCheck, holdLease, resetGoLive, seedLiveTest, setupGoLive, type GoLiveWorld } from "./helpers";

/**
 * Settings › Sending & Mailgun's data around go-live (M6-DESIGN §2.5, §2.7, §5.2): the Go live card's state and words,
 * the mode choices and the Test list card before and after go-live, and the older sending domains on the "Check with
 * Mailgun" card (L10). Against the fake Mailgun; nothing reaches the network.
 */

vi.mock("server-only", () => ({}));

const t = await createTestDb("go-live-sending-page");
const { db } = await import("@/server/db");
const { setState } = await import("@/server/state");
const { goLive } = await import("@/server/services/go-live");
const { loadSendingPage } = await import("@/app/(app)/settings/sending/load");

let world: GoLiveWorld;
const viewer = () => ({
  id: world.owner.id,
  email: "arslan@polygonparadise.test",
  name: "Arslan",
  role: "OWNER" as const,
  timeZone: "Europe/Berlin",
  sessionId: 1,
});

beforeAll(async () => {
  world = await setupGoLive();
  await seedLiveTest(world);
});

beforeEach(async () => {
  await resetGoLive();
  const now = new Date();
  await freshCheck(now);
  await holdLease(now);
});

afterAll(async () => {
  await world.mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the Sending & Mailgun page around go-live", () => {
  it("before go-live: the ready card with its dialog, the test-list words", async () => {
    const page = await loadSendingPage(viewer());
    expect(page.goLive).toMatchObject({ state: "ready", title: "Go live", blockers: [] });
    expect(page.goLive.dialogItems[0]).toBe(
      "New campaigns send real email to everyone eligible, not only your test list. Sending mode switches to Live.",
    );
    expect(page.goLiveOn).toBe(false);
    expect(page.modeOptions.find((o) => o.key === "LIVE")?.title).toBe("Live (test list only)");
    expect(page.testListDescription).toBe("The mailboxes that can receive real email before you go live.");
    expect(JSON.stringify(page)).not.toMatch(/Milestone/);
  });

  it("after go-live: the live card, 'Live', and what the test list is for now", async () => {
    await goLive(world.owner, { now: new Date() });
    const page = await loadSendingPage(viewer());
    expect(page.goLive).toMatchObject({ state: "live", cantSwitchOff: "This can't be switched off. To stop sending at any time, use Pause all sending." });
    expect(page.goLive.description).toMatch(/^Live on send\.example\.com since .+ \(switched on by Arslan\)\. New live campaigns email everyone eligible\.$/);
    expect(page.goLive.warmupLine).toMatch(/^Warm-up step 1 of 20: 50 a day\./);
    expect(page.goLiveOn).toBe(true);
    expect(page.modeOptions.find((o) => o.key === "LIVE")).toMatchObject({
      title: "Live",
      text: "Real emails from your sending domain to everyone eligible, inside sending hours and under the daily limit.",
    });
    expect(page.testListDescription).toBe("The mailboxes Test mode and the reply test use.");
    expect(page.testListHint).toBe(
      "Test mode only emails these addresses, and the reply test uses them. Emails to them in a live campaign now count as emailed.",
    );
  });

  it("shows older sending domains the catch-up couldn't check", async () => {
    await setState("mailgun.catchUp", {
      lastStartedAt: new Date().toISOString(),
      lastFinishedAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      lastErrorKind: null,
      lastReason: "hourly",
      lastSummary: null,
      oldDomains: [{ domain: "mail.example.com", since: "2026-09-25T08:00:00.000Z", lastAt: new Date().toISOString(), text: "401" }],
    });
    const page = await loadSendingPage(viewer());
    expect(page.checkWithMailgun?.oldDomains).toHaveLength(1);
    expect(page.checkWithMailgun?.oldDomains[0]).toMatch(
      /^Mailgun's logs for the old domain mail\.example\.com haven't been checked since \d+ Sept?\. Replies and bounces to its last emails may be missed\.$/,
    );
  });

  it("the practice copy: its own card sentence, no Check with Mailgun card", async () => {
    await setSettingValue("practice.copy", true);
    const page = await loadSendingPage(viewer());
    expect(page.goLive).toMatchObject({ state: "practice", description: "The practice copy never sends real email, so it can't go live." });
    expect(page.checkWithMailgun).toBeNull();
  });
});
