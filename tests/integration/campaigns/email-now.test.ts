import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeUser, setSettingValue } from "./seed";

const t = await createTestDb("campaign-email-now");
const { db } = await import("@/server/db");
const { emailCompanyNow } = await import("@/server/services/campaigns/email-now");
const { CampaignError } = await import("@/server/services/campaigns/errors");

let ali: { id: number };

beforeAll(async () => {
  ali = await makeUser("Ali", { role: "OWNER", email: "ali@polygonparadise.test", senderDisplayName: "Ali from Polygon Paradise" });
});

beforeEach(async () => {
  await setSettingValue("practice.copy", false);
  await setSettingValue("sending.mode", "DRY_RUN");
  await setSettingValue("sending.goLive", true);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const actor = () => ({ id: ali.id, name: "Ali" });

describe("emailCompanyNow", () => {
  it("makes a one-company campaign and launches it", async () => {
    const c = await makeCompany({ name: "Quick GmbH", people: [{ name: "Anna", email: "anna@quick-gmbh.de" }] });
    const res = await emailCompanyNow(actor(), c.company.id);
    expect(res.launched).toBe(true);
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: res.campaignId }, include: { recipients: true } });
    expect(campaign.name).toBe("Email now: Quick GmbH");
    expect(["SCHEDULED", "RUNNING"]).toContain(campaign.status);
    expect(campaign.recipients).toHaveLength(1);
  });

  it("refuses a company nobody can email, and leaves no draft behind", async () => {
    const c = await makeCompany({ name: "Blocked AG", status: "DO_NOT_CONTACT", people: [{ name: "Bea", email: "bea@blocked-ag.de" }] });
    await expect(emailCompanyNow(actor(), c.company.id)).rejects.toBeInstanceOf(CampaignError);
    expect(await db.campaign.count({ where: { name: "Email now: Blocked AG" } })).toBe(0);
  });

  it("refuses a company that doesn't exist", async () => {
    await expect(emailCompanyNow(actor(), 999_999)).rejects.toMatchObject({ code: "not-found" });
  });
});
