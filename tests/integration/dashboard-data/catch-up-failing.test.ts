import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeOwner, setState } from "../mail-events/seed";

/**
 * Review DASHBOARD-1: when the check with Mailgun has never succeeded, every retry moves `lastStartedAt`, so "failing
 * for more than 2 hours" (the dashboard's mailgun-check item) and "3 hours" (the Owner's notice) must be measured from
 * when it started failing: `CatchUpState.failingSince`, set by the first failed run, kept by the retries and cleared
 * by a complete run. Against the fake Mailgun; a failed run is a Mailgun context that throws.
 */

const t = await createTestDb("dashboard-catch-up-failing");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runCatchUp, checkCatchUpAge } = await import("@/server/services/mailgun/catch-up");
const { readTyped } = await import("@/server/state-typed");
const { parseCatchUpState } = await import("@/core/system-state-parse");
const { catchUpFailing, catchUpStatusLine } = await import("@/core/mailgun/catch-up-status");
const { mailgunCheckOverdue } = await import("@/core/dashboard/attention");

const MIN = 60_000;
const DAY = 86_400_000;
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
const broken = async (): Promise<never> => {
  throw new Error("Mailgun didn't answer");
};

async function state() {
  return (await readTyped("mailgun.catchUp", parseCatchUpState)).value;
}

beforeAll(async () => {
  await makeOwner();
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("failingSince", () => {
  it("is set by the first failed run, kept by the retries, and cleared by a complete run", async () => {
    await setState("mailgun.catchUp", null);
    const now = new Date();
    const first = new Date(now.getTime() - 2 * DAY);
    const retry = new Date(now.getTime() - 15 * MIN);

    // A new install whose check never works (never a success).
    await expect(runCatchUp({ reason: "startup", now: first, mailgun: broken })).rejects.toThrow();
    let s = await state();
    expect(s).toMatchObject({ lastStartedAt: first.toISOString(), lastSuccessAt: null, failingSince: first.toISOString() });
    expect(catchUpFailing(s)).toBe(true);

    // Two days of retries: the last start is 15 minutes old, the streak still started two days ago.
    await expect(runCatchUp({ reason: "hourly", now: retry, mailgun: broken })).rejects.toThrow();
    s = await state();
    expect(s.lastStartedAt).toBe(retry.toISOString());
    expect(s.failingSince).toBe(first.toISOString());

    // The dashboard's item and the Owner's notice now see it.
    const facts = { failing: catchUpFailing(s), lastSuccessAt: s.lastSuccessAt, lastStartedAt: s.lastStartedAt, failingSince: s.failingSince };
    expect(mailgunCheckOverdue(facts, now)).toBe(true);
    // Without the record, the last start alone would hide it (what happened before the fix).
    expect(mailgunCheckOverdue({ ...facts, failingSince: undefined }, now)).toBe(false);
    expect(await checkCatchUpAge({ now, mailgun })).toBe(true);
    const note = await db.notification.findFirstOrThrow({ where: { title: "The app can't check with Mailgun" } });
    // Since the first failure two days ago (a date and a time), not since the last retry (a time today).
    expect(note.body).toMatch(/^The app hasn't been able to check Mailgun since \d{1,2} \S+( \d{4})? \d{2}:\d{2}\. Bounces and unsubscribes may be late\./);
    expect(catchUpStatusLine(s, "Asia/Karachi", now)).toMatchObject({
      failing: true,
      line: "The app hasn't been able to check Mailgun yet. Bounces and unsubscribes may be late.",
    });

    // A complete run: working again, the streak is over.
    await runCatchUp({ reason: "manual", now, mailgun });
    s = await state();
    expect(s.lastSuccessAt).toBe(now.toISOString());
    expect(s.failingSince).toBeUndefined();
    expect(catchUpFailing(s)).toBe(false);

    // Failing again later starts a new streak there; the last success counts first.
    const later = new Date(now.getTime() + 10 * MIN);
    await expect(runCatchUp({ reason: "hourly", now: later, mailgun: broken })).rejects.toThrow();
    s = await state();
    expect(s).toMatchObject({ lastSuccessAt: now.toISOString(), failingSince: later.toISOString() });
    expect(mailgunCheckOverdue({ failing: true, lastSuccessAt: s.lastSuccessAt, lastStartedAt: s.lastStartedAt, failingSince: s.failingSince }, later)).toBe(false);
  });

  it("parses: kept when it is a time, left out otherwise (states written before it parse as before)", () => {
    expect(parseCatchUpState({ failingSince: "2026-09-21T10:00:00.000Z" }).failingSince).toBe("2026-09-21T10:00:00.000Z");
    expect(parseCatchUpState({ failingSince: null })).not.toHaveProperty("failingSince");
    expect(parseCatchUpState({ failingSince: "soon" })).not.toHaveProperty("failingSince");
    expect(parseCatchUpState({})).not.toHaveProperty("failingSince");
  });
});
