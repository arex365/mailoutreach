import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeMember, makeOwner, personFor, seedEmail, setSetting } from "../mail-events/seed";

const t = await createTestDb("catch-up-suppressions");
const mg = await connectFakeMailgun();
const { db, dbTx, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { stopRecipients } = await import("@/server/services/mail-events/stops");
const { runCatchUp } = await import("@/server/services/mailgun/catch-up");
const { pushLocalSuppressions, addManualSuppression, removeOwnSuppression, REMOVE_REFUSED } = await import(
  "@/server/services/mailgun/suppressions"
);
const { ServiceError } = await import("@/server/services/companies/mutations");

const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
let owner: { id: number; name: string };

beforeAll(async () => {
  const o = await makeOwner();
  owner = { id: o.id, name: o.name };
});

beforeEach(async () => {
  mg.fake.reset();
  await dbWrite(async (c) => {
    await c.suppression.deleteMany({});
    await c.job.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { in: ["sending.pause", "notices"] } } });
  });
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("pulling Mailgun's lists", () => {
  it("adds the addresses, flags the people, stops their emails, with one summary activity and one complaint notice", async () => {
    const b = await seedEmail({ createdById: owner.id, email: "b1@pull.de" });
    const c = await seedEmail({ createdById: owner.id, email: "c1@pull.de" });
    const u = await seedEmail({ createdById: owner.id, email: "u1@pull.de", status: "QUEUED", followUp: false });
    mg.fake.addSuppression("bounces", "b1@pull.de", { code: "550", error: "No such mailbox" });
    mg.fake.addSuppression("complaints", "c1@pull.de");
    mg.fake.addSuppression("unsubscribes", "u1@pull.de");
    const summary = await runCatchUp({ reason: "manual", mailgun });
    expect(summary.suppressionsAdded).toBe(3);

    expect(await db.suppression.findUnique({ where: { emailNorm: "b1@pull.de" } })).toMatchObject({
      reason: "BOUNCED",
      source: "mailgun-sync",
      detail: "No such mailbox",
      pushedToMailgunAt: expect.any(Date),
    });
    expect(await db.suppression.findUnique({ where: { emailNorm: "c1@pull.de" } })).toMatchObject({ reason: "COMPLAINED" });
    expect(await db.suppression.findUnique({ where: { emailNorm: "u1@pull.de" } })).toMatchObject({ reason: "UNSUBSCRIBED" });
    expect((await db.person.findUniqueOrThrow({ where: { id: b.personId } })).bouncedAt).toBeInstanceOf(Date);
    expect((await db.person.findUniqueOrThrow({ where: { id: c.personId } })).complainedAt).toBeInstanceOf(Date);
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: b.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: "bounced" });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: u.emailId } })).toMatchObject({
      status: "SKIPPED",
      lastError: "Stopped: this address unsubscribed",
    });

    // One summary activity, no per-address ones (and the events are stored processed: the lane won't add any).
    const pulled = await db.activityLog.findMany({ where: { type: "mailgun.listsPulled" } });
    expect(pulled.map((a) => a.summary)).toEqual(["Mailgun's lists added 3 addresses to the do-not-email list"]);
    expect(await db.activityLog.count({ where: { type: { startsWith: "email." }, campaignId: { in: [b.campaignId, c.campaignId, u.campaignId] } } })).toBe(0);
    expect(await db.mailEvent.count({ where: { recipient: { in: ["b1@pull.de", "c1@pull.de", "u1@pull.de"] }, processedAt: null } })).toBe(0);
    const notes = await db.notification.findMany({ where: { type: "email.complained", title: "Mailgun's complaint list has 1 new address" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("They won't be emailed again. Settings › Deliverability lists them.");

    // A second pull changes nothing and says nothing.
    await runCatchUp({ reason: "hourly", mailgun });
    expect(await db.activityLog.count({ where: { type: "mailgun.listsPulled" } })).toBe(1);
  });

  it("applies an address again when it was removed from Mailgun's list and added back later", async () => {
    mg.fake.addSuppression("unsubscribes", "again@pull.de", { createdAt: new Date("2026-09-01T10:00:00Z") });
    await runCatchUp({ reason: "manual", mailgun });
    expect(await db.suppression.count({ where: { emailNorm: "again@pull.de" } })).toBe(1);
    // Taken off both lists, then unsubscribed again.
    const ctx = await mailgun();
    if (!ctx.connected) throw new Error("not connected");
    await ctx.client.deleteSuppression(ctx.domain, "unsubscribes", "again@pull.de");
    await dbWrite((c) => c.suppression.delete({ where: { emailNorm: "again@pull.de" } }));
    mg.fake.addSuppression("unsubscribes", "again@pull.de", { createdAt: new Date("2026-09-20T10:00:00Z") });
    await runCatchUp({ reason: "manual", mailgun });
    expect(await db.suppression.findUnique({ where: { emailNorm: "again@pull.de" } })).toMatchObject({ reason: "UNSUBSCRIBED" });
    expect(await db.mailEvent.count({ where: { recipient: "again@pull.de", dedupeKey: { startsWith: "sup:unsubscribes:" } } })).toBe(2);
  });

  it("keeps the reason of an address already on the local list (the entry may be our own push)", async () => {
    const { personId } = await personFor("mine@pull.de");
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "mine@pull.de", reason: "MANUAL", source: "manual", pushedToMailgunAt: null } }));
    mg.fake.addSuppression("bounces", "mine@pull.de");
    await runCatchUp({ reason: "manual", mailgun });
    expect(await db.suppression.findUnique({ where: { emailNorm: "mine@pull.de" } })).toMatchObject({
      reason: "MANUAL",
      source: "manual",
      pushedToMailgunAt: expect.any(Date),
    });
    expect((await db.person.findUniqueOrThrow({ where: { id: personId } })).bouncedAt).toBeNull();
  });

  it("pulling back the app's own push never relabels a stopped person as unsubscribed", async () => {
    // (a) "Do not email" by hand: stopped as "suppressed".
    const manual = await seedEmail({ createdById: owner.id, email: "manual@echo.de" });
    await addManualSuppression(owner, { email: "manual@echo.de", reason: "MANUAL" });
    // (b) A hard bounce (stopped as "bounced") whose entry isn't at Mailgun yet (e.g. after a domain change).
    const bounced = await seedEmail({ createdById: owner.id, email: "bounced@echo.de" });
    await dbTx(async (tx) => {
      await tx.suppression.create({ data: { emailNorm: "bounced@echo.de", reason: "BOUNCED", source: "webhook", pushedToMailgunAt: null } });
      await stopRecipients(tx, { emailNorm: "bounced@echo.de", reason: "bounced", scope: "real", now: new Date() });
    });
    const before = async (s: typeof manual) => ({
      recipient: await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId }, select: { state: true, stopReason: true } }),
      followUp: await db.outboundEmail.findUniqueOrThrow({ where: { id: s.followUpId! }, select: { status: true, lastError: true } }),
    });
    const manualBefore = await before(manual);
    const bouncedBefore = await before(bounced);
    expect(manualBefore).toEqual({
      recipient: { state: "STOPPED", stopReason: "suppressed" },
      followUp: { status: "SKIPPED", lastError: "Stopped: this address is on the do-not-email list" },
    });
    expect(bouncedBefore).toEqual({
      recipient: { state: "STOPPED", stopReason: "bounced" },
      followUp: { status: "SKIPPED", lastError: "Stopped: this address bounced" },
    });

    // The push puts both on Mailgun's unsubscribes list; the next catch-up pulls them back as "unsubscribed" entries.
    expect((await pushLocalSuppressions({ mailgun })).pushed).toBe(2);
    await runCatchUp({ reason: "hourly", mailgun });
    expect(await db.mailEvent.count({ where: { recipient: { in: ["manual@echo.de", "bounced@echo.de"] }, dedupeKey: { startsWith: "sup:unsubscribes:" } } })).toBe(2);

    expect(await before(manual)).toEqual(manualBefore);
    expect(await before(bounced)).toEqual(bouncedBefore);
    expect(await db.suppression.findUniqueOrThrow({ where: { emailNorm: "manual@echo.de" } })).toMatchObject({ reason: "MANUAL" });
    expect(await db.suppression.findUniqueOrThrow({ where: { emailNorm: "bounced@echo.de" } })).toMatchObject({ reason: "BOUNCED" });
    for (const s of [manual, bounced]) {
      expect((await db.person.findUniqueOrThrow({ where: { id: s.personId } })).unsubscribedAt).toBeNull();
    }
  });

  it("a list entry for an address the app already lists stops a waiting person with the app's own reason", async () => {
    const s = await seedEmail({ createdById: owner.id, email: "waiting@echo.de", status: "QUEUED", followUp: false });
    // On the local list by hand, but this recipient is still waiting (nothing stopped it yet).
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "waiting@echo.de", reason: "MANUAL", source: "manual", pushedToMailgunAt: null } }));
    mg.fake.addSuppression("unsubscribes", "waiting@echo.de");
    await runCatchUp({ reason: "hourly", mailgun });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: "suppressed" });
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).toMatchObject({
      status: "SKIPPED",
      lastError: "Stopped: this address is on the do-not-email list",
    });
    expect(await db.suppression.findUniqueOrThrow({ where: { emailNorm: "waiting@echo.de" } })).toMatchObject({ reason: "MANUAL", pushedToMailgunAt: expect.any(Date) });
  });

  it("a new address on Mailgun's unsubscribes list still stops as unsubscribed", async () => {
    const s = await seedEmail({ createdById: owner.id, email: "fresh@echo.de", status: "QUEUED", followUp: false });
    mg.fake.addSuppression("unsubscribes", "fresh@echo.de");
    await runCatchUp({ reason: "hourly", mailgun });
    expect(await db.campaignRecipient.findUniqueOrThrow({ where: { id: s.recipientId } })).toMatchObject({ state: "STOPPED", stopReason: "unsubscribed" });
    expect(await db.suppression.findUniqueOrThrow({ where: { emailNorm: "fresh@echo.de" } })).toMatchObject({ reason: "UNSUBSCRIBED" });
  });
});

describe("pushing the local list", () => {
  it("sends every entry Mailgun doesn't have yet, at most 999 per call", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ emailNorm: `push${i}@local.de`, reason: "MANUAL" as const, source: "manual" }));
    await dbWrite((c) => c.suppression.createMany({ data: rows }));
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "already@local.de", reason: "BOUNCED", source: "webhook", pushedToMailgunAt: new Date() } }));
    mg.fake.requests.length = 0;
    const res = await pushLocalSuppressions({ mailgun });
    expect(res.pushed).toBe(1500);
    const posts = mg.fake.requests.filter((r) => r.method === "POST" && r.path === `/v3/${mg.domain}/unsubscribes`);
    expect(posts.map((p) => (p.body as unknown[]).length)).toEqual([999, 501]);
    expect((posts[0]!.body as Array<{ tags: string[] }>)[0]!.tags).toEqual(["*"]);
    expect(await db.suppression.count({ where: { pushedToMailgunAt: null } })).toBe(0);
    expect(mg.fake.state().suppressions.unsubscribes.some((e) => e.address === "already@local.de")).toBe(false);
    expect((await pushLocalSuppressions({ mailgun })).pushed).toBe(0);
  });

  it("never pushes in the practice copy", async () => {
    await dbWrite((c) => c.suppression.create({ data: { emailNorm: "practice@local.de", reason: "UNSUBSCRIBED", source: "manual" } }));
    await setSetting("practice.copy", true);
    try {
      mg.fake.requests.length = 0;
      expect((await pushLocalSuppressions({ mailgun })).pushed).toBe(0);
      expect(mg.fake.requests.some((r) => r.path.endsWith("/unsubscribes"))).toBe(false);
    } finally {
      await setSetting("practice.copy", false);
    }
  });
});

describe("adding and removing by hand", () => {
  it("adds an address, stops its waiting emails at once and queues the push", async () => {
    const s = await seedEmail({ createdById: owner.id, email: "hand@stop.de", status: "QUEUED", followUp: false });
    const res = await addManualSuppression(owner, { email: "Hand@Stop.DE", reason: "UNSUBSCRIBED" });
    expect(res).toEqual({ created: true, stopped: 1 });
    expect(await db.suppression.findUnique({ where: { emailNorm: "hand@stop.de" } })).toMatchObject({ reason: "UNSUBSCRIBED", source: "manual" });
    expect((await db.person.findUniqueOrThrow({ where: { id: s.personId } })).unsubscribedAt).toBeInstanceOf(Date);
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: s.emailId } })).toMatchObject({ status: "SKIPPED" });
    expect(await db.activityLog.findFirst({ where: { type: "suppression.added", personId: s.personId } })).toMatchObject({
      actorId: owner.id,
      summary: "Arslan added hand@stop.de to the do-not-email list (unsubscribed)",
    });
    expect(await db.job.findFirst({ where: { type: "mailgun.syncSuppressions", activeDedupeKey: "mailgun:push" } })).not.toBeNull();
    await expect(addManualSuppression(owner, { email: "not an address", reason: "MANUAL" })).rejects.toBeInstanceOf(ServiceError);
  });

  it("takes a test-list address and an active user's reply inbox off the list (here and at Mailgun), nobody else", async () => {
    await makeMember("Ali", "ali@polygonparadise.test", { replyInbox: "ali.khan@gmail.com" });
    await makeMember("Old", "old@polygonparadise.test", { replyInbox: "old.inbox@gmail.com", active: false });
    await setSetting("sending.testList", ["Box@Outlook.com"]);
    const { personId } = await personFor("box@outlook.com");
    for (const a of ["box@outlook.com", "ali.khan@gmail.com", "old.inbox@gmail.com", "someone@studio.de"]) {
      await dbWrite((c) => c.suppression.create({ data: { emailNorm: a, reason: "UNSUBSCRIBED", source: "webhook", pushedToMailgunAt: new Date() } }));
      mg.fake.addSuppression("unsubscribes", a);
    }
    await dbWrite((c) => c.person.update({ where: { id: personId }, data: { unsubscribedAt: new Date(), bouncedAt: new Date() } }));

    expect(await removeOwnSuppression(owner, "box@outlook.com", { mailgun })).toEqual({ removed: true, mailgunProblem: null });
    expect(await db.suppression.findUnique({ where: { emailNorm: "box@outlook.com" } })).toBeNull();
    expect(await db.person.findUniqueOrThrow({ where: { id: personId } })).toMatchObject({ unsubscribedAt: null, bouncedAt: null });
    expect(mg.fake.state().suppressions.unsubscribes.some((e) => e.address === "box@outlook.com")).toBe(false);
    expect(await db.job.findFirst({ where: { type: "mailgun.syncRoutes", activeDedupeKey: "mailgun:routes" } })).not.toBeNull();
    expect(await db.activityLog.findFirst({ where: { type: "suppression.removed" } })).toMatchObject({
      summary: "Arslan took box@outlook.com off the do-not-email list",
    });

    expect((await removeOwnSuppression(owner, "ali.khan@gmail.com", { mailgun })).removed).toBe(true);
    for (const a of ["old.inbox@gmail.com", "someone@studio.de"]) {
      const err = await removeOwnSuppression(owner, a, { mailgun }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as Error).message).toBe(REMOVE_REFUSED);
      expect(await db.suppression.findUnique({ where: { emailNorm: a } })).not.toBeNull();
    }
  });
});
