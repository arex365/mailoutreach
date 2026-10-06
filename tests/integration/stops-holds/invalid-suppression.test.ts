import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { email, enroll, makeCampaign, makeCompany, makePerson, makeUser, recipient } from "./world";

/**
 * addInvalidSuppression (M5-DESIGN §2.6 step 4, D9): the one door for an INVALID do-not-email entry. Never pushed to
 * Mailgun (it isn't an unsubscribe); everyone already emailed at the address is stopped with the code `invalid`.
 */

const t = await createTestDb("stops-invalid");
const mg = await connectFakeMailgun();
const { db, dbTx, dbWrite } = await import("@/server/db");
const { addInvalidSuppression, pushLocalSuppressions } = await import("@/server/services/mailgun/suppressions");
const { STOP_SKIP_TEXT } = await import("@/server/services/mail-events/stops");

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeUser("Arslan", { role: "OWNER" })).id;
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

const NOW = new Date("2026-09-26T10:00:00Z");
const DETAIL = "Mailgun: undeliverable (mailbox_does_not_exist)";

async function setup() {
  const n = Math.random().toString(36).slice(2, 7);
  const company = await makeCompany(`Firma ${n}`);
  const anna = await makePerson(company.id, `anna.${n}@firma.test`);
  return { company, anna, norm: anna.emailNorm! };
}

const add = (emailNorm: string, extra: { personId?: number | null; companyId?: number | null } = {}) =>
  dbTx((tx) => addInvalidSuppression(tx, { emailNorm, detail: DETAIL, personId: extra.personId ?? null, companyId: extra.companyId ?? null, now: NOW }));

describe("addInvalidSuppression", () => {
  it("adds an INVALID entry from the address check, marked pushed so it never goes to Mailgun, and stops everyone emailed", async () => {
    const w = await setup();
    const live = await makeCampaign({ createdById: ownerId, mode: "LIVE" });
    const other = await makeCampaign({ createdById: ownerId, mode: "TEST" });
    const waiting = await enroll(live, w.anna);
    const waitingToo = await enroll(other, w.anna);
    const res = await add(w.norm.toUpperCase(), { personId: w.anna.id, companyId: w.company.id });
    expect(res).toEqual({ changed: true, stopped: 2 });
    const row = await db.suppression.findUniqueOrThrow({ where: { emailNorm: w.norm } });
    expect(row).toMatchObject({ reason: "INVALID", source: "verification", detail: DETAIL });
    expect(row.pushedToMailgunAt?.toISOString()).toBe(NOW.toISOString());
    for (const r of [waiting, waitingToo]) {
      expect(await recipient(r.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "invalid", nextDueAt: null });
      expect(await email(r.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: the address check said not to email this address" });
    }
    expect(STOP_SKIP_TEXT.invalid).toBe("Stopped: the address check said not to email this address");
    // Again: nothing changes.
    expect(await add(w.norm)).toEqual({ changed: false, stopped: 0 });
  });

  it("upgrades a MANUAL entry (never pushed as INVALID; a pushed one keeps its date) and keeps a stronger one", async () => {
    const manual = await setup();
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: manual.norm, reason: "MANUAL", source: "manual", detail: "Added by Arslan", pushedToMailgunAt: null } }));
    expect((await add(manual.norm)).changed).toBe(true);
    const upgraded = await db.suppression.findUniqueOrThrow({ where: { emailNorm: manual.norm } });
    expect(upgraded).toMatchObject({ reason: "INVALID", source: "verification", detail: DETAIL });
    expect(upgraded.pushedToMailgunAt?.toISOString()).toBe(NOW.toISOString());

    const pushed = await setup();
    const pushedAt = new Date("2026-09-01T00:00:00Z");
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: pushed.norm, reason: "MANUAL", source: "manual", pushedToMailgunAt: pushedAt } }));
    await add(pushed.norm);
    expect((await db.suppression.findUniqueOrThrow({ where: { emailNorm: pushed.norm } })).pushedToMailgunAt?.toISOString()).toBe(pushedAt.toISOString());

    const unsub = await setup();
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: unsub.norm, reason: "UNSUBSCRIBED", source: "webhook", pushedToMailgunAt: null } }));
    const live = await makeCampaign({ createdById: ownerId, mode: "LIVE" });
    const r = await enroll(live, unsub.anna);
    expect(await add(unsub.norm)).toEqual({ changed: false, stopped: 1 });
    expect(await db.suppression.findUniqueOrThrow({ where: { emailNorm: unsub.norm } })).toMatchObject({ reason: "UNSUBSCRIBED", source: "webhook" });
    expect((await recipient(r.recipientId)).stopReason).toBe("invalid");
  });

  it("an `invalid` stop replaces a weaker `suppressed` one; a later bounce replaces `invalid`", async () => {
    const w = await setup();
    const live = await makeCampaign({ createdById: ownerId, mode: "LIVE" });
    const r = await enroll(live, w.anna, { state: "STOPPED", stopReason: "suppressed", queuedStep: null });
    await add(w.norm);
    expect((await recipient(r.recipientId)).stopReason).toBe("invalid");
    const { stopRecipients } = await import("@/server/services/mail-events/stops");
    await dbTx((tx) => stopRecipients(tx, { emailNorm: w.norm, reason: "bounced", scope: "real", now: NOW }));
    expect((await recipient(r.recipientId)).stopReason).toBe("bounced");
  });

  it("pushLocalSuppressions never sends an INVALID entry to Mailgun (and still pushes the others)", async () => {
    const invalid = await setup();
    const manual = await setup();
    // An INVALID row written before M5's door (not marked pushed): the push skips it anyway.
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: invalid.norm, reason: "INVALID", source: "verification", pushedToMailgunAt: null } }));
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: manual.norm, reason: "MANUAL", source: "manual", pushedToMailgunAt: null } }));
    await dbWrite((c) => c.suppression.updateMany({ where: { emailNorm: { notIn: [invalid.norm, manual.norm] } }, data: { pushedToMailgunAt: NOW } }));
    const res = await pushLocalSuppressions({ now: NOW });
    expect(res.pushed).toBe(1);
    const unsubscribes = mg.fake.state().suppressions.unsubscribes.map((s) => s.address);
    expect(unsubscribes).toContain(manual.norm);
    expect(unsubscribes).not.toContain(invalid.norm);
    expect((await db.suppression.findUniqueOrThrow({ where: { emailNorm: invalid.norm } })).pushedToMailgunAt).toBeNull();
  });
});
