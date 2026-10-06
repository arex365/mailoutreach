import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { HOUR, email, enroll, makeCampaign, makeCompany, makeInbound, makePerson, makeUser } from "./world";

/**
 * RECHECK (M5-DESIGN §2.7): `moveToRecheck` (compare-and-set) and every row of the settle table of
 * `settleRecheckForPerson`, including the pending holds a released recipient gets (possible reply, outage).
 */

const t = await createTestDb("stops-recheck");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { moveToRecheck, settleRecheckForPerson, loadCheckPolicy, RECHECK_LEFT_OUT_TEXT } = await import("@/server/services/verification/settle");
const { DEFAULT_VERIFICATION_POLICY } = await import("@/core/rules/eligibility");

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeUser("Arslan", { role: "OWNER" })).id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const NOW = new Date("2026-09-24T10:00:00Z");
const FIRST_UNKNOWN = new Date(NOW.getTime() - 25 * HOUR);
const RECHECK_AT = new Date(FIRST_UNKNOWN.getTime() + 24 * HOUR);

type Check = {
  verificationStatus?: "VALID" | "INVALID" | "RISKY" | "CATCH_ALL" | "UNKNOWN" | "DO_NOT_SEND" | null;
  verificationRisk?: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN" | null;
  verifiedAt?: Date | null;
  verificationProvider?: string | null;
  verificationDisposable?: boolean;
  verificationUnknowns?: number;
  emailNorm?: string;
  email?: string;
  deletedAt?: Date | null;
};

/** A person waiting in RECHECK in a LIVE campaign (first email QUEUED, reserved), with `check` as their result now. */
async function waiting(check: Check, opts: { mode?: "LIVE" | "TEST" | "DRY_RUN"; recheckAt?: Date | null } = {}) {
  const n = Math.random().toString(36).slice(2, 7);
  const company = await makeCompany(`Firma ${n}`);
  const person = await makePerson(company.id, `anna.${n}@firma.test`);
  const campaign = await makeCampaign({ createdById: ownerId, mode: opts.mode ?? "LIVE" });
  const r = await enroll(campaign, person, { first: true, state: "RECHECK" });
  const nextDueAt = new Date(NOW.getTime() + HOUR);
  await dbWrite((c) =>
    c.campaignRecipient.update({
      where: { id: r.recipientId },
      data: { recheckAt: opts.recheckAt === undefined ? RECHECK_AT : opts.recheckAt, nextDueAt },
    }),
  );
  await dbWrite((c) =>
    c.person.update({
      where: { id: person.id },
      data: {
        verificationStatus: "UNKNOWN",
        verificationRisk: "UNKNOWN",
        verifiedAt: FIRST_UNKNOWN,
        verificationProvider: "mailgun",
        verificationUnknowns: 1,
        ...check,
      },
    }),
  );
  return { company, person, campaign, r, nextDueAt };
}

const settle = (personId: number) => dbTx((tx) => settleRecheckForPerson(tx, personId, NOW));

async function state(id: number) {
  return db.campaignRecipient.findUniqueOrThrow({
    where: { id },
    select: { state: true, included: true, exclusionReason: true, currentStep: true, nextDueAt: true, recheckAt: true, holdReason: true },
  });
}

describe("moveToRecheck (compare-and-set)", () => {
  it("moves a SCHEDULED recipient with no recheckAt to RECHECK once", async () => {
    const n = Math.random().toString(36).slice(2, 7);
    const company = await makeCompany(`Firma ${n}`);
    const person = await makePerson(company.id, `ola.${n}@butikk.test`);
    const campaign = await makeCampaign({ createdById: ownerId });
    const r = await enroll(campaign, person, { first: true });
    const at = new Date(NOW.getTime() + 24 * HOUR);
    expect(await dbTx((tx) => moveToRecheck(tx, { recipientId: r.recipientId, recheckAt: at, now: NOW }))).toBe(true);
    expect(await state(r.recipientId)).toMatchObject({ state: "RECHECK", recheckAt: at });
    expect(await dbTx((tx) => moveToRecheck(tx, { recipientId: r.recipientId, recheckAt: at, now: NOW }))).toBe(false);
    // Released after its re-check (recheckAt kept): it never waits twice.
    await dbWrite((c) => c.campaignRecipient.update({ where: { id: r.recipientId }, data: { state: "SCHEDULED" } }));
    expect(await dbTx((tx) => moveToRecheck(tx, { recipientId: r.recipientId, recheckAt: at, now: NOW }))).toBe(false);
    // Only SCHEDULED recipients.
    const w = await enroll(campaign, await makePerson(company.id, `ben.${n}@butikk.test`));
    expect(await dbTx((tx) => moveToRecheck(tx, { recipientId: w.recipientId, recheckAt: at, now: NOW }))).toBe(false);
  });
});

describe("settleRecheckForPerson: the §2.7 table", () => {
  it("UNKNOWN before recheckAt (the first unknown), policy 'recheck': stays RECHECK", async () => {
    const w = await waiting({});
    expect(await settle(w.person.id)).toEqual({ released: 0, leftOut: 0 });
    expect((await state(w.r.recipientId)).state).toBe("RECHECK");
  });

  it("UNKNOWN at or after recheckAt (the re-check said unknown again): left out 'Address couldn't be checked'", async () => {
    const w = await waiting({ verifiedAt: RECHECK_AT, verificationUnknowns: 2 });
    expect(await settle(w.person.id)).toEqual({ released: 0, leftOut: 1 });
    expect(await state(w.r.recipientId)).toMatchObject({ state: "EXCLUDED", included: false, exclusionReason: "Address couldn't be checked" });
    expect(await email(w.r.queuedId!)).toEqual({ status: "CANCELLED", lastError: "Address couldn't be checked" });
  });

  it("three unknowns in a row: no more paid tries, left out even before recheckAt", async () => {
    const w = await waiting({ verificationUnknowns: 3 });
    expect(await settle(w.person.id)).toEqual({ released: 0, leftOut: 1 });
    expect((await state(w.r.recipientId)).exclusionReason).toBe(RECHECK_LEFT_OUT_TEXT.couldntBeChecked);
  });

  it("UNKNOWN with 'No answer' set to Skip: left out with the policy sentence, without a paid re-check", async () => {
    await setSetting("verification.policy", { ...DEFAULT_VERIFICATION_POLICY, unknown: "block" } as never, null);
    try {
      const w = await waiting({});
      expect(await settle(w.person.id)).toEqual({ released: 0, leftOut: 1 });
      expect((await state(w.r.recipientId)).exclusionReason).toBe("The address check got no answer; your check settings skip these");
    } finally {
      await setSetting("verification.policy", { ...DEFAULT_VERIFICATION_POLICY } as never, null);
    }
  });

  it("decision send: released to SCHEDULED; step, next due time and recheckAt kept; its first email still queued", async () => {
    const w = await waiting({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: NOW, verificationUnknowns: 0 });
    expect(await settle(w.person.id)).toEqual({ released: 1, leftOut: 0 });
    expect(await state(w.r.recipientId)).toMatchObject({
      state: "SCHEDULED",
      included: true,
      currentStep: 0,
      nextDueAt: w.nextDueAt,
      recheckAt: RECHECK_AT,
      exclusionReason: null,
    });
    expect((await email(w.r.queuedId!)).status).toBe("QUEUED");
  });

  it("a released recipient is held at once when its company has an undecided possible reply", async () => {
    const w = await waiting({ verificationStatus: "VALID", verificationRisk: "MEDIUM", verifiedAt: NOW, verificationUnknowns: 0 });
    await makeInbound({ kind: "POSSIBLE_REPLY", companyId: w.company.id });
    expect(await settle(w.person.id)).toEqual({ released: 1, leftOut: 0 });
    expect(await state(w.r.recipientId)).toMatchObject({ state: "HELD", holdReason: "possible-reply" });
  });

  it("a released recipient joins an outage hold that holds others at its company", async () => {
    const w = await waiting({ verificationStatus: "CATCH_ALL", verificationRisk: "LOW", verifiedAt: NOW, verificationUnknowns: 0 });
    const other = await makeCampaign({ createdById: ownerId, mode: "LIVE" });
    const colleague = await makePerson(w.company.id, `ben.${Math.random().toString(36).slice(2, 7)}@firma.test`);
    await enroll(other, colleague, { state: "HELD", holdReason: "outage", currentStep: 1 });
    expect(await settle(w.person.id)).toEqual({ released: 1, leftOut: 0 });
    expect(await state(w.r.recipientId)).toMatchObject({ state: "HELD", holdReason: "outage" });
  });

  it("decision block: left out with the policy sentence (catch-all medium, deliverable high, throwaway)", async () => {
    const catchAll = await waiting({ verificationStatus: "CATCH_ALL", verificationRisk: "MEDIUM", verifiedAt: NOW, verificationUnknowns: 0 });
    await settle(catchAll.person.id);
    expect((await state(catchAll.r.recipientId)).exclusionReason).toBe("Can't confirm this address (medium risk); your check settings skip these");

    const risky = await waiting({ verificationStatus: "RISKY", verificationRisk: "HIGH", verifiedAt: NOW, verificationUnknowns: 0 });
    await settle(risky.person.id);
    expect((await state(risky.r.recipientId)).exclusionReason).toBe("The address check rated this address high risk; your check settings skip these");

    const temp = await waiting({ verificationStatus: "VALID", verificationRisk: "LOW", verificationDisposable: true, verifiedAt: NOW, verificationUnknowns: 0 });
    await settle(temp.person.id);
    expect((await state(temp.r.recipientId)).exclusionReason).toBe("A throwaway address; your check settings skip these");
  });

  it("undeliverable / do-not-send: left out with the check's sentence", async () => {
    const invalid = await waiting({ verificationStatus: "INVALID", verificationRisk: "HIGH", verifiedAt: NOW, verificationUnknowns: 0 });
    await settle(invalid.person.id);
    expect((await state(invalid.r.recipientId)).exclusionReason).toBe("The address check said this address doesn't exist");
    const dns = await waiting({ verificationStatus: "DO_NOT_SEND", verificationRisk: "HIGH", verifiedAt: NOW, verificationUnknowns: 0 });
    await settle(dns.person.id);
    expect((await state(dns.r.recipientId)).exclusionReason).toBe("The address check said not to email this address");
  });

  it("the address changed (result cleared, or another address): left out 'The email address changed…'", async () => {
    const cleared = await waiting({ verificationStatus: null, verificationRisk: null, verifiedAt: null, verificationProvider: null, verificationUnknowns: 0 });
    await settle(cleared.person.id);
    expect((await state(cleared.r.recipientId)).exclusionReason).toBe("The email address changed after this email was prepared");

    const moved = await waiting({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: NOW, verificationUnknowns: 0 });
    await dbWrite((c) => c.person.update({ where: { id: moved.person.id }, data: { emailNorm: `new.${moved.person.id}@firma.test`, email: `new.${moved.person.id}@firma.test` } }));
    await settle(moved.person.id);
    expect((await state(moved.r.recipientId)).exclusionReason).toBe(RECHECK_LEFT_OUT_TEXT.emailChanged);
  });

  it("a removed person: left out 'This person was removed from the company'", async () => {
    const w = await waiting({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: NOW, verificationUnknowns: 0, deletedAt: NOW });
    await settle(w.person.id);
    expect((await state(w.r.recipientId)).exclusionReason).toBe("This person was removed from the company");
  });

  it("settles the person's RECHECK recipients in every TEST/LIVE campaign, and leaves dry runs alone", async () => {
    const w = await waiting({ verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: NOW, verificationUnknowns: 0 });
    const test = await makeCampaign({ createdById: ownerId, mode: "TEST" });
    const dry = await makeCampaign({ createdById: ownerId, mode: "DRY_RUN" });
    const inTest = await enroll(test, w.person, { first: true, state: "RECHECK" });
    const inDry = await enroll(dry, w.person, { first: true, state: "RECHECK" });
    expect(await settle(w.person.id)).toEqual({ released: 2, leftOut: 0 });
    expect((await state(inTest.recipientId)).state).toBe("SCHEDULED");
    expect((await state(inDry.recipientId)).state).toBe("RECHECK");
  });

  it("a RECHECK recipient without recheckAt never waits for ever: an unknown result leaves it out", async () => {
    const w = await waiting({}, { recheckAt: null });
    expect(await settle(w.person.id)).toEqual({ released: 0, leftOut: 1 });
  });

  it("nobody waiting: nothing to do", async () => {
    const n = Math.random().toString(36).slice(2, 7);
    const company = await makeCompany(`Firma ${n}`);
    const person = await makePerson(company.id, `x.${n}@firma.test`);
    expect(await settle(person.id)).toEqual({ released: 0, leftOut: 0 });
  });
});

describe("loadCheckPolicy", () => {
  it("merges the saved policy over the defaults (a policy saved before M5 has no disposable row)", async () => {
    await dbWrite((c) =>
      c.setting.upsert({
        where: { key: "verification.policy" },
        create: { key: "verification.policy", value: { deliverableHighRisk: "send", catchAllLow: "send", catchAllMedium: "block", catchAllHigh: "block", unknown: "recheck" } },
        update: { value: { deliverableHighRisk: "send", catchAllLow: "send", catchAllMedium: "block", catchAllHigh: "block", unknown: "recheck" } },
      }),
    );
    expect(await loadCheckPolicy()).toEqual({ ...DEFAULT_VERIFICATION_POLICY, deliverableHighRisk: "send" });
    await dbWrite((c) => c.setting.delete({ where: { key: "verification.policy" } }));
    expect(await loadCheckPolicy()).toEqual(DEFAULT_VERIFICATION_POLICY);
  });
});
