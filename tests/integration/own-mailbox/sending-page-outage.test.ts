import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeOwner, setState } from "../mail-events/seed";
import type { OutageHoldSummary } from "@/server/services/sequences/holds";

/**
 * Settings › Sending & Mailgun in own-mailbox mode after the PC was off (review REPLIES-09 / SCREENS-07): replies never
 * pass through Mailgun there and nothing is put on hold for a gap (O27), so the "Check with Mailgun" card never says
 * replies may have been missed; it says what the gap really cost (Mailgun's reports of those days) and that the people
 * who bounced, complained or unsubscribed are still stopped. And the Test list card's own-mailbox words (SCREENS-11).
 */

vi.mock("server-only", () => ({}));

const t = await createTestDb("own-mailbox-sending-page-outage");
const mg = await connectFakeMailgun({
  domain: "example.com",
  region: "US",
  replies: "own-mailbox",
  fromAddress: "contact@example.com",
  plan: "free",
  fake: { plan: "free", receivesMail: false },
});
const { db } = await import("@/server/db");
const { buildOutageView, loadSendingPage, ownOutageLine } = await import("@/app/(app)/settings/sending/load");
const { TEST_LIST_TEXTS_OWN } = await import("@/components/settings/sending/texts");

const ZONE = "Asia/Karachi";
const NOW = new Date("2026-10-06T06:00:00Z");
const FROM = "contact@example.com";
const recent = { detectedAt: "2026-10-06T05:00:00.000Z" };
const ctx = { zone: ZONE, now: NOW, logRetentionDays: 1, ownMailbox: { from: FROM } };

function summary(over: Partial<OutageHoldSummary> = {}): OutageHoldSummary {
  return {
    detected: true,
    applied: true,
    from: "2026-10-03T06:00:00.000Z",
    to: "2026-10-05T06:00:00.000Z",
    total: 0,
    textOnly: false,
    bySender: [],
    ...over,
  };
}

const LINE =
  "Mailgun's reports from 3 Oct to 5 Oct (deliveries, bounces, complaints and unsubscribes) couldn't be read: the PC was off for more than 1 day, and Mailgun keeps them only that long on your plan. Anyone who bounced, complained or unsubscribed then is still stopped, because the app also reads Mailgun's lists. Replies aren't affected: they go straight to contact@example.com, as always.";

let ownerId = 0;

beforeAll(async () => {
  ownerId = (await makeOwner("Arslan", "arslan@polygonparadise.test")).id;
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the outage line in own-mailbox mode (review REPLIES-09 / SCREENS-07)", () => {
  it("found or handled, nobody held: one neutral line about Mailgun's reports, never 'replies may have been missed'", () => {
    for (const applied of [true, false]) {
      const view = buildOutageView(summary({ applied }), recent, ctx);
      expect(view).toEqual({ tone: "neutral", line: LINE, senders: [], colleagues: null });
      expect(view!.line).not.toMatch(/may have been missed|can't be sure it saw every reply|on hold/);
    }
    expect(ownOutageLine("from 3 Oct to 5 Oct", 1, FROM)).toBe(LINE);
    // No fitting From yet: the mailbox in general words; no window: "Some of Mailgun's reports".
    expect(buildOutageView(summary({ from: null, to: null }), recent, { ...ctx, ownMailbox: { from: null } })!.line).toBe(
      "Some of Mailgun's reports (deliveries, bounces, complaints and unsubscribes) couldn't be read: the PC was off for more than 1 day, and Mailgun keeps them only that long on your plan. Anyone who bounced, complained or unsubscribed then is still stopped, because the app also reads Mailgun's lists. Replies aren't affected: they go straight to your own mailbox, as always.",
    );
  });

  it("for 7 days only; nothing about replies recovered without text (no stored replies in this mode)", () => {
    expect(buildOutageView(summary(), { detectedAt: "2026-09-20T00:00:00.000Z" }, ctx)).toBeNull();
    expect(buildOutageView(summary({ textOnly: true, from: null, to: null }), recent, ctx)).toBeNull();
    expect(buildOutageView(summary({ detected: false }), recent, ctx)).toBeNull();
  });

  it("people still held from an app-mode hold before the switch keep today's lines and buttons", () => {
    const view = buildOutageView(summary({ total: 2, bySender: [{ userId: 2, name: "Ali", active: true, held: 2, firstEmailsWaiting: 0 }] }), recent, ctx)!;
    expect(view.tone).toBe("warning");
    expect(view.senders.map((s) => s.buttonLabel)).toEqual(["Continue Ali's follow-ups"]);
  });

  it("app mode reads as before", () => {
    expect(buildOutageView(summary(), recent, { zone: ZONE, now: NOW, logRetentionDays: 5 })!.line).toBe(
      "Replies from 3 Oct to 5 Oct may have been missed while the PC was off. No follow-ups are on hold now.",
    );
  });
});

describe("loadSendingPage in own-mailbox mode", () => {
  it("the Check with Mailgun card's outage line and the Test list card use own-mailbox words", async () => {
    await setState("catchup.outage", {
      detectedAt: "2026-10-06T05:00:00.000Z",
      from: "2026-10-03T06:00:00.000Z",
      to: "2026-10-05T06:00:00.000Z",
      beyondLogRetention: true,
      beyondMessageRetention: true,
      handledAt: "2026-10-06T05:05:00.000Z",
      heldFor: "2026-10-03T06:00:00.000Z",
      heldTo: "2026-10-05T06:00:00.000Z",
      heldCount: 0,
    });
    const page = await loadSendingPage({ id: ownerId, email: "arslan@polygonparadise.test", name: "Arslan", role: "OWNER", timeZone: ZONE, sessionId: 1 }, NOW);
    expect(page.ownMailbox).toBe(true);
    expect(page.checkWithMailgun?.outage).toEqual({ tone: "neutral", line: LINE, senders: [], colleagues: null });
    expect(page.testListHint).toBe(TEST_LIST_TEXTS_OWN.hint);
    expect(page.testListEmpty).toBe(TEST_LIST_TEXTS_OWN.empty);
    expect(JSON.stringify(page)).not.toMatch(/may have been missed/);
  });
});
