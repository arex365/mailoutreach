import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { email, enroll, makeCampaign, makeCompany, makePerson, makeUser, recipient } from "../stops-holds/world";

/**
 * commitCheckResult (M5-DESIGN §2.6): the one door that stores an address-check result, in one short transaction.
 */

const t = await createTestDb("verification-commit");
const mg = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { commitCheckResult, invalidSuppressionDetail } = await import("@/server/services/verification/commit");
const { pushLocalSuppressions } = await import("@/server/services/mailgun/suppressions");
const { fromMailgun, unreadableResult } = await import("@/core/verification/mailgun-map");
const { fakeValidationBody } = await import("@/core/verification/fake-rules");
const { DEFAULT_VERIFICATION_POLICY } = await import("@/core/rules/eligibility");
type CheckResult = import("@/core/verification/types").CheckResult;
type CommitCheckInput = import("@/server/services/verification/commit").CommitCheckInput;

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeUser("Arslan", { role: "OWNER" })).id;
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

const NOW = new Date("2026-09-23T08:00:00Z");

/** What the fake answers for `address` (its rules), mapped: the result a real run would commit. */
function resultFor(address: string, callsSoFar = 0): CheckResult {
  const r = fromMailgun(fakeValidationBody(address, { callsSoFar }).body, { emailNorm: address.toLowerCase() });
  if (r === "unreadable") throw new Error(`unreadable answer for ${address}`);
  return r;
}

async function personAt(local: string, domain = "valid.test") {
  const n = Math.random().toString(36).slice(2, 7);
  const company = await makeCompany(`Firma ${n}`);
  const person = await makePerson(company.id, `${local}${n}@${domain}`);
  return { company, person, emailNorm: person.emailNorm!, email: person.email! };
}

function input(p: { person: { id: number; companyId: number }; emailNorm: string; email: string }, result: CheckResult, extra: Partial<CommitCheckInput> = {}): CommitCheckInput {
  return {
    person: { id: p.person.id, companyId: p.person.companyId, email: p.email, emailNorm: p.emailNorm },
    emailNorm: p.emailNorm,
    result,
    unreadable: false,
    provider: "mailgun-fake",
    costUsd: 0.012,
    jobId: 41,
    source: "wizard",
    now: NOW,
    ...extra,
  };
}

const personRow = (id: number) =>
  db.person.findUniqueOrThrow({
    where: { id },
    select: {
      verificationStatus: true,
      verificationRisk: true,
      verifiedAt: true,
      verificationProvider: true,
      verificationDisposable: true,
      verificationUnknowns: true,
    },
  });

const checkRows = (emailNorm: string) => db.verificationCheck.findMany({ where: { emailNorm }, orderBy: { id: "asc" } });

describe("commitCheckResult: the row and the person", () => {
  it("a VALID result writes the row with every field and updates the person", async () => {
    const p = await personAt("info+web");
    const result = resultFor(p.emailNorm);
    const out = await commitCheckResult(input(p, result, { costUsd: 0.0120000004 }));
    expect(out).toEqual({ decision: "send", personUpdated: true, suppressed: false, leftOut: 0, stopped: 0, settled: { released: 0, leftOut: 0 } });
    const [row] = await checkRows(p.emailNorm);
    expect(row).toMatchObject({
      personId: p.person.id,
      emailNorm: p.emailNorm,
      provider: "mailgun-fake",
      status: "VALID",
      risk: "LOW",
      isRole: true,
      isDisposable: false,
      didYouMean: null,
      reasons: [],
      costUsd: 0.012,
      jobId: 41,
      source: "wizard",
      checkedAt: NOW,
    });
    expect(row!.raw).toMatchObject({ result: "deliverable", root_address: expect.stringContaining("info@") });
    expect(await personRow(p.person.id)).toEqual({
      verificationStatus: "VALID",
      verificationRisk: "LOW",
      verifiedAt: NOW,
      verificationProvider: "mailgun-fake",
      verificationDisposable: false,
      verificationUnknowns: 0,
    });
  });

  it("an address changed during the call leaves the person alone; the paid row stays", async () => {
    const p = await personAt("anna");
    await dbWrite((c) => c.person.update({ where: { id: p.person.id }, data: { emailNorm: `changed.${p.person.id}@valid.test`, email: `changed.${p.person.id}@valid.test` } }));
    const out = await commitCheckResult(input(p, resultFor(p.emailNorm)));
    expect(out.personUpdated).toBe(false);
    expect(out.decision).toBe("send");
    expect(await checkRows(p.emailNorm)).toHaveLength(1);
    expect((await personRow(p.person.id)).verificationStatus).toBeNull();
  });

  it("UNKNOWN adds one to the unknowns in a row; any other result resets them; the throwaway flag follows the result", async () => {
    const p = await personAt("g", "greylist.test");
    await commitCheckResult(input(p, resultFor(p.emailNorm, 0)));
    expect(await personRow(p.person.id)).toMatchObject({ verificationStatus: "UNKNOWN", verificationUnknowns: 1 });
    await commitCheckResult(input(p, resultFor(p.emailNorm, 0)));
    expect((await personRow(p.person.id)).verificationUnknowns).toBe(2);
    await commitCheckResult(input(p, { ...resultFor(p.emailNorm, 1), isDisposable: true }));
    expect(await personRow(p.person.id)).toMatchObject({ verificationStatus: "VALID", verificationUnknowns: 0, verificationDisposable: true });
    await commitCheckResult(input(p, resultFor(p.emailNorm, 1)));
    expect((await personRow(p.person.id)).verificationDisposable).toBe(false);
  });

  it("the decision follows the current policy (throwaway included)", async () => {
    const low = await personAt("x", "catchall-low.test");
    expect((await commitCheckResult(input(low, resultFor(low.emailNorm)))).decision).toBe("send");
    const temp = await personAt("temp");
    expect((await commitCheckResult(input(temp, resultFor(temp.emailNorm)))).decision).toBe("block");
    await setSetting("verification.policy", { ...DEFAULT_VERIFICATION_POLICY, catchAllLow: "block", disposable: "send" } as never, null);
    try {
      expect((await commitCheckResult(input(low, resultFor(low.emailNorm)))).decision).toBe("block");
      expect((await commitCheckResult(input(temp, resultFor(temp.emailNorm)))).decision).toBe("send");
    } finally {
      await setSetting("verification.policy", { ...DEFAULT_VERIFICATION_POLICY } as never, null);
    }
  });
});

describe("commitCheckResult: row-only commits", () => {
  it("a Settings test of an undeliverable address writes the row only: no suppression, no person, no campaign", async () => {
    const p = await personAt("bad");
    const live = await makeCampaign({ createdById: ownerId });
    const r = await enroll(live, p.person, { first: true });
    const out = await commitCheckResult({ ...input(p, resultFor(p.emailNorm)), person: null, source: "settings", jobId: null });
    expect(out).toEqual({ decision: null, personUpdated: false, suppressed: false, leftOut: 0, stopped: 0, settled: { released: 0, leftOut: 0 } });
    const [row] = await checkRows(p.emailNorm);
    expect(row).toMatchObject({ personId: null, status: "INVALID", source: "settings", costUsd: 0.012 });
    expect(await db.suppression.findUnique({ where: { emailNorm: p.emailNorm } })).toBeNull();
    expect((await personRow(p.person.id)).verificationStatus).toBeNull();
    expect((await recipient(r.recipientId)).state).toBe("SCHEDULED");
    // Even with a person given, a settings check never touches them.
    await commitCheckResult({ ...input(p, resultFor(p.emailNorm)), source: "settings" });
    expect((await personRow(p.person.id)).verificationStatus).toBeNull();
    expect(await db.suppression.findUnique({ where: { emailNorm: p.emailNorm } })).toBeNull();
  });

  it("an unreadable answer writes a charged row and leaves the person alone", async () => {
    const p = await personAt("weird");
    await dbWrite((c) => c.person.update({ where: { id: p.person.id }, data: { verificationStatus: "VALID", verificationRisk: "LOW", verifiedAt: new Date("2026-08-01T00:00:00Z"), verificationProvider: "mailgun" } }));
    const raw = fakeValidationBody(p.emailNorm).body;
    const out = await commitCheckResult(input(p, unreadableResult(raw), { unreadable: true }));
    expect(out.decision).toBeNull();
    expect(out.personUpdated).toBe(false);
    const [row] = await checkRows(p.emailNorm);
    expect(row).toMatchObject({ status: "UNKNOWN", risk: "UNKNOWN", reasons: ["app:unreadable_response"], costUsd: 0.012, raw: { result: "maybe" } });
    expect(await personRow(p.person.id)).toMatchObject({ verificationStatus: "VALID", verificationProvider: "mailgun", verificationUnknowns: 0 });
  });
});

describe("commitCheckResult: undeliverable and do-not-send", () => {
  it("INVALID: on the do-not-email list (never pushed), never-emailed recipients left out, emailed ones stopped, one activity", async () => {
    const p = await personAt("bad");
    const draftLike = await makeCampaign({ createdById: ownerId, mode: "LIVE" });
    const running = await makeCampaign({ createdById: ownerId, mode: "TEST" });
    const scheduled = await enroll(draftLike, p.person, { first: true });
    const emailed = await enroll(running, p.person);
    const out = await commitCheckResult(input(p, resultFor(p.emailNorm)));
    expect(out).toEqual({ decision: "undeliverable", personUpdated: true, suppressed: true, leftOut: 1, stopped: 1, settled: { released: 0, leftOut: 0 } });

    const sup = await db.suppression.findUniqueOrThrow({ where: { emailNorm: p.emailNorm } });
    expect(sup).toMatchObject({ reason: "INVALID", source: "verification", detail: "Mailgun: undeliverable (mailbox_does_not_exist)" });
    expect(sup.pushedToMailgunAt).not.toBeNull();

    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: scheduled.recipientId } })).toMatchObject({
      state: "EXCLUDED",
      included: false,
      exclusionReason: "The address check said this address doesn't exist",
    });
    expect(await email(scheduled.queuedId!)).toEqual({ status: "CANCELLED", lastError: "The address check said this address doesn't exist" });
    expect(await recipient(emailed.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "invalid" });
    expect(await email(emailed.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: the address check said not to email this address" });

    const activity = await db.activityLog.findFirstOrThrow({ where: { type: "person.checked", personId: p.person.id } });
    expect(activity).toMatchObject({ actorId: null, companyId: p.company.id, summary: `${p.email} doesn't exist; it's on the do-not-email list now` });

    // Mailgun never gets it: a push after the commit sends nothing for this address.
    await dbWrite((c) => c.suppression.updateMany({ where: { reason: { not: "INVALID" } }, data: { pushedToMailgunAt: NOW } }));
    const before = mg.fake.requests.filter((r) => r.path.endsWith("/unsubscribes") && r.method === "POST").length;
    expect((await pushLocalSuppressions({ now: NOW })).pushed).toBe(0);
    expect(mg.fake.requests.filter((r) => r.path.endsWith("/unsubscribes") && r.method === "POST").length).toBe(before);
  });

  it("DO_NOT_SEND: the same, with its own sentences", async () => {
    const p = await personAt("x", "disposable.test");
    const live = await makeCampaign({ createdById: ownerId });
    const r = await enroll(live, p.person, { first: true });
    const out = await commitCheckResult(input(p, resultFor(p.emailNorm)));
    expect(out).toMatchObject({ decision: "do-not-send", suppressed: true, leftOut: 1, stopped: 0 });
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: r.recipientId } })).exclusionReason).toBe("The address check said not to email this address");
    expect((await db.suppression.findUniqueOrThrow({ where: { emailNorm: p.emailNorm } })).detail).toBe(
      "Mailgun: do_not_send (mailbox_is_disposable_address)",
    );
    const activity = await db.activityLog.findFirstOrThrow({ where: { type: "person.checked", personId: p.person.id } });
    expect(activity.summary).toBe(`The address check says not to email ${p.email}; it's on the do-not-email list now`);
  });

  it("an address already unsubscribed keeps that reason", async () => {
    const p = await personAt("bad");
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: p.emailNorm, reason: "UNSUBSCRIBED", source: "webhook", pushedToMailgunAt: NOW } }));
    const out = await commitCheckResult(input(p, resultFor(p.emailNorm)));
    expect(out.suppressed).toBe(false);
    expect((await db.suppression.findUniqueOrThrow({ where: { emailNorm: p.emailNorm } })).reason).toBe("UNSUBSCRIBED");
    expect((await personRow(p.person.id)).verificationStatus).toBe("INVALID");
  });

  it("describes the provider's verdict in the entry's detail", () => {
    expect(invalidSuppressionDetail("fake", { ...resultFor("bad@valid.test"), raw: null })).toBe("Test checker: undeliverable (mailbox_does_not_exist)");
    expect(invalidSuppressionDetail("mailgun", { ...resultFor("x@nomx.test") })).toBe("Mailgun: undeliverable (no_mx)");
  });
});

describe("commitCheckResult: RECHECK", () => {
  it("a passing second check releases the person's waiting recipient in the same transaction", async () => {
    const p = await personAt("g", "greylist.test");
    await commitCheckResult(input(p, resultFor(p.emailNorm, 0), { now: new Date(NOW.getTime() - 25 * 3_600_000) }));
    const live = await makeCampaign({ createdById: ownerId });
    const r = await enroll(live, p.person, { first: true, state: "RECHECK" });
    await dbWrite((c) => c.campaignRecipient.update({ where: { id: r.recipientId }, data: { recheckAt: new Date(NOW.getTime() - 3_600_000) } }));
    const out = await commitCheckResult(input(p, resultFor(p.emailNorm, 1), { source: "recheck" }));
    expect(out.settled).toEqual({ released: 1, leftOut: 0 });
    expect((await recipient(r.recipientId)).state).toBe("SCHEDULED");
  });

  it("a second unknown leaves it out", async () => {
    const p = await personAt("t", "timeout.test");
    await commitCheckResult(input(p, resultFor(p.emailNorm), { now: new Date(NOW.getTime() - 25 * 3_600_000) }));
    const live = await makeCampaign({ createdById: ownerId });
    const r = await enroll(live, p.person, { first: true, state: "RECHECK" });
    await dbWrite((c) => c.campaignRecipient.update({ where: { id: r.recipientId }, data: { recheckAt: new Date(NOW.getTime() - 3_600_000) } }));
    const out = await commitCheckResult(input(p, resultFor(p.emailNorm), { source: "recheck" }));
    expect(out.settled).toEqual({ released: 0, leftOut: 1 });
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: r.recipientId } })).exclusionReason).toBe("Address couldn't be checked");
  });
});
