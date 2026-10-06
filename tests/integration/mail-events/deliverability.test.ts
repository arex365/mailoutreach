import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { eventData, makeMember, makeOwner, seedEmail, setSetting, setState } from "./seed";

const t = await createTestDb("mail-deliverability");
const { db, dbWrite } = await import("@/server/db");
const { normalizeWebhookEventData } = await import("@/core/mailgun/events");
const { applyMailEventNow } = await import("@/server/services/mail-events/apply");
const { listSuppressionPage, loadCountedRows, loadHealthView, thresholdWarnings } = await import(
  "@/server/services/mail-events/deliverability"
);

let ownerId: number;

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
  await makeMember("Ali", "ali@polygonparadise.test", { replyInbox: "ali.khan@gmail.com" });
  await setSetting("mailgun.domain", "send.example.com");
  await setSetting("sending.testList", ["box@outlook.com"]);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("Settings › Deliverability read model", () => {
  it("counts the bounces and complaints behind the pause and shows which emails they are", async () => {
    const bounced = await seedEmail({ createdById: ownerId });
    const complained = await seedEmail({ createdById: ownerId });
    await seedEmail({ createdById: ownerId });
    await applyMailEventNow(normalizeWebhookEventData(eventData(bounced, "bounce"))!, "WEBHOOK");
    await applyMailEventNow(normalizeWebhookEventData(eventData(complained, "complain"))!, "WEBHOOK");
    const list = await dbWrite((c) => c.list.create({ data: { name: "Germany Q4" } }));
    await dbWrite((c) => c.companyList.create({ data: { companyId: bounced.companyId, listId: list.id } }));

    const view = await loadHealthView("Asia/Karachi");
    expect(view.counts).toMatchObject({ bounces: 1, complaints: 1, bounceSample: 3, complaintSample: 3 });
    expect(view.bounceLine).toBe("1 of the last 3 emails bounced · sending pauses above 6 (3%) · Mailgun's own limit is 5%.");
    expect(view.complaintLine).toBe("1 of the last 3 emails was marked as spam · sending pauses above 1 (0.1%) · Mailgun's own limit is 0.08%.");
    expect(view.bounceNote).toBe("Only 3 live emails so far; the limit is counted per 200.");
    expect(view.sinceNote).toBeNull();
    expect(view.bounceLimit).toBe(6);

    const rows = await loadCountedRows(view.counts.bounceEmailIds, "bounce");
    expect(rows).toEqual([
      expect.objectContaining({
        emailId: bounced.emailId,
        address: bounced.toNorm,
        companyId: bounced.companyId,
        campaignId: bounced.campaignId,
        lists: ["Germany Q4"],
        reason: "bounce",
        code: 550,
      }),
    ]);
    expect((await loadCountedRows(view.counts.complaintEmailIds, "complaint"))[0]).toMatchObject({ emailId: complained.emailId });
  });

  it("counts only since the last resume", async () => {
    await setState("health.baseline", { since: new Date(Date.now() + 60_000).toISOString(), resumedById: ownerId });
    const view = await loadHealthView("UTC");
    expect(view.counts).toMatchObject({ bounces: 0, bounceSample: 0 });
    expect(view.sinceNote).toMatch(/^Counting since you resumed on \d{1,2} \w+\.$/);
    await setState("health.baseline", {});
  });

  it("lists the do-not-email list with search, filters, where from, and who may be removed", async () => {
    await dbWrite((c) =>
      c.suppression.createMany({
        data: [
          { emailNorm: "box@outlook.com", reason: "UNSUBSCRIBED", source: "webhook", pushedToMailgunAt: new Date() },
          { emailNorm: "ali.khan@gmail.com", reason: "BOUNCED", source: "mailgun-sync", pushedToMailgunAt: new Date() },
          { emailNorm: "manual@x.de", reason: "MANUAL", source: "manual" },
        ],
      }),
    );
    const all = await listSuppressionPage({});
    expect(all.total).toBe(5);
    const byAddress = Object.fromEntries(all.rows.map((r) => [r.address, r]));
    expect(byAddress["box@outlook.com"]).toMatchObject({ why: "Unsubscribed", from: "Mailgun", inMailgun: "yes", removable: { kind: "test-list" } });
    expect(byAddress["ali.khan@gmail.com"]).toMatchObject({ removable: { kind: "reply-inbox", userName: "Ali" } });
    expect(byAddress["manual@x.de"]).toMatchObject({ why: "Do not email", from: "You", inMailgun: "waiting", removable: null });
    const complainedRow = all.rows.find((r) => r.reason === "COMPLAINED")!;
    expect(complainedRow).toMatchObject({ campaignId: expect.any(Number), companyId: expect.any(Number), why: "Complained" });

    expect((await listSuppressionPage({ q: "OUTLOOK" })).rows.map((r) => r.address)).toEqual(["box@outlook.com"]);
    expect((await listSuppressionPage({ filter: "MANUAL" })).rows.map((r) => r.address)).toEqual(["manual@x.de"]);
    expect(await listSuppressionPage({ q: "nobody-here" })).toMatchObject({ rows: [], total: 0 });
  });

  it("warns about thresholds above Mailgun's own limits", () => {
    expect(thresholdWarnings({ bouncePercent: 3, complaintPercent: 0.05 })).toEqual({ bounce: null, complaint: null });
    expect(thresholdWarnings({ bouncePercent: 5.5, complaintPercent: 0.1 })).toEqual({
      bounce: "Above Mailgun's own limit of 5%: Mailgun may suspend your account before the app pauses.",
      complaint: "Above Mailgun's own limit of 0.08%: Mailgun may suspend your account before the app pauses.",
    });
  });
});
