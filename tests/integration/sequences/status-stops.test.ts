import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { daysAgo, makeCompany, makeDraft, makeUser, setSettingValue, type StepSeed } from "../campaigns/seed";

/**
 * Company status changes by hand (M4-DESIGN §2.7, D18, D19): Replied, Client, Not interested and Do not contact stop
 * the company's follow-ups at once, in every campaign, in the status write's own transaction (bulk changes in
 * transactions of at most 50 companies); other statuses stop nothing; and a company "put back by hand" is stopped
 * again at send time once it replies after the launch.
 */

const stopCalls = vi.hoisted(() => [] as number[]);
vi.mock("@/server/services/mail-events/stops", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/services/mail-events/stops")>();
  return {
    ...original,
    stopCompaniesForStatus: (...args: Parameters<typeof original.stopCompaniesForStatus>) => {
      stopCalls.push(args[1].companyIds.length);
      return original.stopCompaniesForStatus(...args);
    },
  };
});
/** While on, the finish check's transaction fails (as when the database stays busy): releasing the reservations throws. */
const finishFails = vi.hoisted(() => ({ on: false }));
vi.mock("@/server/services/reservations", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/services/reservations")>();
  return {
    ...original,
    releaseCampaignReservations: (...args: Parameters<typeof original.releaseCampaignReservations>) => {
      if (finishFails.on) return Promise.reject(new Error("The database stayed busy (test)"));
      return original.releaseCampaignReservations(...args);
    },
  };
});

const t = await createTestDb("sequences-status-stops");
const { db, dbWrite } = await import("@/server/db");
const { launchCampaign } = await import("@/server/services/campaigns/launch");
const { setCompanyStatus } = await import("@/server/services/companies/mutations");
const { bulkSetStatus, BULK_STOP_CHUNK } = await import("@/server/services/companies/bulk");
const loop = await import("@/server/services/sending/loop");

const STEPS: StepSeed[] = [
  { step: 0, subject: "3D models for your shop", body: "First" },
  { step: 1, body: "Second", delayDays: 3 },
];

let ali: { id: number; name: string };
let n = 0;

beforeAll(async () => {
  const owner = await makeUser("Arslan", { role: "OWNER" });
  ali = { id: owner.id, name: owner.name };
});

beforeEach(async () => {
  stopCalls.splice(0);
  await setSettingValue("practice.copy", false);
  await dbWrite((c) => c.campaign.updateMany({ where: { status: { in: ["RUNNING", "SCHEDULED"] } }, data: { status: "CANCELLED" } }));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

/** A launched dry run (ignores sending hours) to these people. */
async function launch(people: Array<{ companyId: number; personId: number; warnings?: object }>, steps: StepSeed[] = STEPS) {
  n += 1;
  const draft = await makeDraft({ name: `Status ${n}`, createdById: ali.id, steps, recipients: people });
  await launchCampaign(draft.id, ali.id);
  return draft.id;
}

async function company(name: string, people = 1) {
  const { company: c, people: ps } = await makeCompany({ name, people: Array.from({ length: people }, (_, i) => ({ name: `P${i}`, email: `p${i}@${name.toLowerCase().replace(/\W+/g, "")}.de` })) });
  return { id: c.id, people: ps.map((p) => ({ companyId: c.id, personId: p.id })) };
}

describe("setting a status by hand", () => {
  it("Client stops the company's open recipients in every campaign at once", async () => {
    const firma = await company("Firma Client", 2);
    const other = await company("Other Co");
    const first = await launch([firma.people[0]!, other.people[0]!]);
    const second = await launch([firma.people[1]!]);
    const res = await setCompanyStatus(ali, firma.id, "CLIENT");
    expect(res).toMatchObject({ changed: true, stopped: 2 });
    const recipients = await db.campaignRecipient.findMany({ where: { companyId: firma.id, campaignId: { in: [first, second] } } });
    expect(recipients.map((r) => [r.state, r.stopReason])).toEqual([
      ["STOPPED", "status:CLIENT"],
      ["STOPPED", "status:CLIENT"],
    ]);
    const emails = await db.outboundEmail.findMany({ where: { companyId: firma.id, campaignId: { in: [first, second] } } });
    expect(emails.every((e) => e.status === "SKIPPED" && e.lastError === "Stopped: the company was marked Client")).toBe(true);
    // The other company carries on; the second campaign had nobody else, so it finished at once.
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: first, companyId: other.id } })).state).toBe("SCHEDULED");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: second } })).status).toBe("FINISHED");
    expect(stopCalls).toEqual([1]);
  });

  it("Contacted (or any other status) stops nothing; setting the same status again changes nothing", async () => {
    const co = await company("Contacted Co");
    const id = await launch(co.people);
    expect(await setCompanyStatus(ali, co.id, "CONTACTED")).toMatchObject({ changed: true, stopped: 0 });
    expect(await setCompanyStatus(ali, co.id, "CONTACTED")).toMatchObject({ changed: false, stopped: 0 });
    expect((await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: id } })).state).toBe("SCHEDULED");
    expect(stopCalls).toEqual([]);
  });

  it("bulk: 120 companies set to Not interested, stopped in transactions of at most 50 companies", async () => {
    const companies = [];
    for (let i = 0; i < 120; i++) companies.push(await company(`Bulk Stop ${i}`));
    const id = await launch(companies.map((c) => c.people[0]!));
    const res = await bulkSetStatus(
      companies.map((c) => c.id),
      "NOT_INTERESTED",
      ali,
    );
    expect(res).toMatchObject({ requested: 120, changed: 120 });
    expect(BULK_STOP_CHUNK).toBe(50);
    expect(stopCalls).toEqual([50, 50, 20]);
    expect(await db.campaignRecipient.count({ where: { campaignId: id, state: "STOPPED", stopReason: "status:NOT_INTERESTED" } })).toBe(120);
    expect(await db.outboundEmail.count({ where: { campaignId: id, status: "QUEUED" } })).toBe(0);
    expect((await db.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("FINISHED");
    // A bulk change to a status that stops nothing keeps the usual chunks and stops nothing.
    stopCalls.splice(0);
    await bulkSetStatus(companies.map((c) => c.id), "CONTACTED", ali);
    expect(stopCalls).toEqual([]);
  }, 60_000);
});

describe("a finish check that fails after the change was saved (review finding DATA-09)", () => {
  /** Runs `change` while every finish check fails; returns what was logged. */
  async function withFailingFinishCheck<T>(change: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    finishFails.on = true;
    try {
      const result = await change();
      return { result, logged: errors.mock.calls.map(([m]) => String(m)) };
    } finally {
      finishFails.on = false;
      errors.mockRestore();
    }
  }

  it("setting a status still reports the saved change and its stops; the maintenance finishes the campaign later", async () => {
    const co = await company("Finish Fails");
    const id = await launch(co.people);
    const { result, logged } = await withFailingFinishCheck(() => setCompanyStatus(ali, co.id, "CLIENT"));
    expect(result).toMatchObject({ changed: true, stopped: 1 });
    expect(logged).toContainEqual(expect.stringContaining(`the finish check of campaign #${id} failed`));
    expect((await db.company.findUniqueOrThrow({ where: { id: co.id } })).status).toBe("CLIENT");
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: id } })).toMatchObject({ state: "STOPPED", stopReason: "status:CLIENT" });
    // Nothing is left to send, but the failed check left it running: the 5-minute maintenance finishes it.
    expect((await db.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("RUNNING");
    expect((await loop.runSendingMaintenance(new Date())).finished).toContain(id);
    expect((await db.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("FINISHED");
  });

  it("bulk: the same, for every company changed", async () => {
    const a = await company("Bulk Finish A");
    const b = await company("Bulk Finish B");
    const id = await launch([a.people[0]!, b.people[0]!]);
    const { result, logged } = await withFailingFinishCheck(() => bulkSetStatus([a.id, b.id], "DO_NOT_CONTACT", ali));
    expect(result).toMatchObject({ requested: 2, changed: 2 });
    expect(logged).toContainEqual(expect.stringContaining(`the finish check of campaign #${id} failed`));
    expect(await db.campaignRecipient.count({ where: { campaignId: id, state: "STOPPED", stopReason: "status:DO_NOT_CONTACT" } })).toBe(2);
    expect((await loop.runSendingMaintenance(new Date())).finished).toContain(id);
  });
});

describe("'put back by hand' covers only replies before the launch (§2.7, D19)", () => {
  it("a put-back recipient is stopped at send time once the company replied after the launch", async () => {
    const { company: co, people } = await makeCompany({
      name: "Put Back",
      status: "REPLIED",
      people: [{ name: "Anna", email: "anna@put-back.de" }],
    });
    await dbWrite((c) => c.company.update({ where: { id: co.id }, data: { repliedAt: daysAgo(10) } }));
    const id = await launch([{ companyId: co.id, personId: people[0]!.id, warnings: { overrides: ["company-replied"] } }], [
      { step: 0, subject: "Hello", body: "First" },
      { step: 1, body: "Second", delayDays: 0 },
    ]);
    // The reply from before the launch is covered: the first email goes.
    expect((await loop.sendingTick()).sent).toBe(1);
    // A new reply after the launch: the follow-up doesn't go.
    await dbWrite((c) => c.company.update({ where: { id: co.id }, data: { repliedAt: new Date(Date.now() + 1_000) } }));
    const r = await loop.sendingTick({ now: () => new Date(Date.now() + 60_000) });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(await db.campaignRecipient.findFirstOrThrow({ where: { campaignId: id } })).toMatchObject({ state: "STOPPED" });
    expect((await db.outboundEmail.findFirstOrThrow({ where: { campaignId: id, step: 1 } })).status).toBe("SKIPPED");
  });

  it("with the reply still before the launch, the follow-up goes", async () => {
    const { company: co, people } = await makeCompany({
      name: "Still Back",
      status: "REPLIED",
      people: [{ name: "Ben", email: "ben@still-back.de" }],
    });
    await dbWrite((c) => c.company.update({ where: { id: co.id }, data: { repliedAt: daysAgo(10) } }));
    const id = await launch([{ companyId: co.id, personId: people[0]!.id, warnings: { overrides: ["company-replied"] } }], [
      { step: 0, subject: "Hello", body: "First" },
      { step: 1, body: "Second", delayDays: 0 },
    ]);
    expect((await loop.sendingTick()).sent).toBe(1);
    expect((await loop.sendingTick({ now: () => new Date(Date.now() + 60_000) })).sent).toBe(1);
    expect((await db.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("FINISHED");
  });
});
