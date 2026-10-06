import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";

/**
 * Step C of docs/dev/MAIN-DOMAIN-DESIGN.md, the parts that need a database or the fake Mailgun (§7.1, §7.4, §7.5,
 * §7.8): the two new settings, loadTeamFrom's own-mailbox table (§2.2), the plan loaders, the rolling count
 * countMailgunSendsSince (O23), the Mailgun context's mode and the client's own-mailbox sender check (O6), the send-only
 * "limit" kind through the client (O24), and connectFakeMailgun's new options. App mode stays exactly as before.
 */

const t = await createTestDb("own-mailbox-contracts");
const { db, dbTx, dbWrite } = await import("@/server/db");
const { getSetting, setSetting, SETTING_DEFAULTS } = await import("@/server/settings");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");
const { loadPlanLimits, loadEffectiveMaxDailyCap } = await import("@/server/services/mailgun/plan");
const { countMailgunSendsSince } = await import("@/server/services/sending/usage");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { MailgunError } = await import("@/server/mailgun/errors");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");
const { MAILGUN_PLAN_FACTS } = await import("@/core/mailgun/plan");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

/** Removes the settings this file writes, so each block starts from a fresh database's view. */
async function clearSettings(): Promise<void> {
  await dbWrite((c) =>
    c.setting.deleteMany({
      where: { key: { in: ["mailgun.replies", "mailgun.plan", "mailgun.fromAddress", "mailgun.domain", "sending.maxDailyCap"] } },
    }),
  );
}

describe("settings (§7.1)", () => {
  it("mailgun.replies defaults to app and mailgun.plan to null", async () => {
    expect(SETTING_DEFAULTS["mailgun.replies"]).toBe("app");
    expect(SETTING_DEFAULTS["mailgun.plan"]).toBeNull();
    expect(await getSetting("mailgun.replies")).toBe("app");
    expect(await getSetting("mailgun.plan")).toBeNull();
  });
});

describe("loadTeamFrom (§2.2)", () => {
  const D = "polygonparadise.com";

  it("app mode: today's answers, with replies 'app', no own From, and the shared From as the evidence From", async () => {
    await clearSettings();
    await setSetting("mailgun.domain", `mail.${D}`, null);
    expect(await loadTeamFrom()).toMatchObject({ address: null, saved: null, problem: null, replies: "app", ownFrom: null, evidenceFrom: null });
    await setSetting("mailgun.fromAddress", `contact@${D}`, null);
    expect(await loadTeamFrom()).toMatchObject({ address: `contact@${D}`, replies: "app", ownFrom: null, evidenceFrom: `contact@${D}`, problem: null });
    // A corrupted mode reads as app mode (fail closed, O1): the root's From is then a misfit.
    await setSetting("mailgun.domain", D, null);
    await dbWrite((c) => c.setting.upsert({ where: { key: "mailgun.replies" }, create: { key: "mailgun.replies", value: "OWN" }, update: { value: "OWN" } }));
    expect(await loadTeamFrom()).toMatchObject({ address: null, replies: "app", ownFrom: null, evidenceFrom: null });
    expect((await loadTeamFrom()).problem).toMatch(/doesn't fit your sending domain polygonparadise\.com/);
  });

  it("own-mailbox mode: nothing saved, fits, doesn't fit, no domain", async () => {
    await clearSettings();
    await setSetting("mailgun.replies", "own-mailbox", null);
    await setSetting("mailgun.domain", D, null);
    expect(await loadTeamFrom()).toMatchObject({
      address: null,
      saved: null,
      ownFrom: null,
      evidenceFrom: null,
      replies: "own-mailbox",
      problem: OWN_MAILBOX_TEXTS.fromMissing(D),
    });
    await setSetting("mailgun.fromAddress", " Contact@PolygonParadise.com ", null);
    const row = await db.setting.findUniqueOrThrow({ where: { key: "mailgun.fromAddress" } });
    const fits = await loadTeamFrom();
    expect(fits).toEqual({
      address: null,
      saved: `contact@${D}`,
      domain: D,
      problem: null,
      changedAt: row.updatedAt,
      replies: "own-mailbox",
      ownFrom: `contact@${D}`,
      evidenceFrom: `contact@${D}`,
    });
    expect(await dbTx((tx) => loadTeamFrom(tx))).toEqual(fits);
    await setSetting("mailgun.fromAddress", `contact@mail.${D}`, null);
    expect(await loadTeamFrom()).toMatchObject({
      address: null,
      ownFrom: null,
      evidenceFrom: null,
      problem: OWN_MAILBOX_TEXTS.misfit(`contact@mail.${D}`, D),
    });
    await setSetting("mailgun.domain", null, null);
    expect(await loadTeamFrom()).toMatchObject({ ownFrom: null, problem: "Connect Mailgun first: the From address must fit your sending domain." });
    await setSetting("mailgun.fromAddress", null, null);
    expect(await loadTeamFrom()).toMatchObject({ ownFrom: null, problem: null, replies: "own-mailbox" });
  });
});

describe("loadPlanLimits and loadEffectiveMaxDailyCap (O22, O23)", () => {
  it("app mode without a plan: no limits and today's maximum", async () => {
    await clearSettings();
    expect(await loadPlanLimits()).toBeNull();
    expect(await loadEffectiveMaxDailyCap()).toEqual({ maxCap: 1000, limits: null });
    await setSetting("sending.maxDailyCap", 400, null);
    expect(await loadEffectiveMaxDailyCap()).toEqual({ maxCap: 400, limits: null });
  });

  it("own-mailbox mode assumes Free; a chosen plan counts in every mode; junk reads as not chosen", async () => {
    await clearSettings();
    await setSetting("mailgun.replies", "own-mailbox", null);
    expect(await loadPlanLimits()).toEqual({ ...MAILGUN_PLAN_FACTS.free, plan: "free", assumed: true });
    expect((await loadEffectiveMaxDailyCap()).maxCap).toBe(90);
    await setSetting("sending.maxDailyCap", 60, null);
    expect(await dbTx((tx) => loadEffectiveMaxDailyCap(tx))).toMatchObject({ maxCap: 60 });
    await setSetting("mailgun.plan", "foundation", null);
    expect(await loadPlanLimits()).toMatchObject({ plan: "foundation", assumed: false, dailyLimit: null, logDays: 5 });
    await setSetting("mailgun.replies", "app", null);
    await setSetting("mailgun.plan", "free", null);
    expect(await loadEffectiveMaxDailyCap()).toMatchObject({ maxCap: 60, limits: { plan: "free", assumed: false } });
    await setSetting("sending.maxDailyCap", 1000, null);
    expect((await loadEffectiveMaxDailyCap()).maxCap).toBe(90);
    await dbWrite((c) => c.setting.update({ where: { key: "mailgun.plan" }, data: { value: "enterprise" } }));
    expect(await loadPlanLimits()).toBeNull();
  });
});

describe("countMailgunSendsSince (O23)", () => {
  const T0 = new Date("2026-09-28T00:00:00Z");
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

  it("counts what went to Mailgun locally, or Mailgun's distinct accepted events when those are more", async () => {
    expect(await countMailgunSendsSince(T0)).toEqual({ total: 0, oldestAt: null });

    const user = await dbWrite((c) => c.user.create({ data: { email: "owner@example.com", name: "Owner" } }));
    const company = await dbWrite((c) => c.company.create({ data: { name: "Acme", nameNorm: "acme" } }));
    const person = await dbWrite((c) => c.person.create({ data: { companyId: company.id, email: "anna@firma.de", emailNorm: "anna@firma.de" } }));
    const campaign = await dbWrite((c) => c.campaign.create({ data: { name: "C", createdById: user.id, mode: "LIVE" } }));
    const recipient = await dbWrite((c) =>
      c.campaignRecipient.create({ data: { campaignId: campaign.id, companyId: company.id, personId: person.id, emailNorm: "anna@firma.de" } }),
    );
    let step = 0;
    const email = (data: { mode: "DRY_RUN" | "TEST" | "LIVE"; status: "SENT" | "UNKNOWN" | "QUEUED" | "FAILED" | "SENDING"; sentAt?: Date; claimedAt?: Date }) => {
      step += 1;
      return dbWrite((c) =>
        c.outboundEmail.create({
          data: {
            campaignId: campaign.id,
            recipientId: recipient.id,
            step,
            toEmail: "anna@firma.de",
            toNorm: "anna@firma.de",
            companyName: "Acme",
            fromAddress: "contact@example.com",
            subject: "Hi",
            text: "Hi",
            html: "<p>Hi</p>",
            messageId: `pp.${step}@example.com`,
            sendId: `s${step}`,
            dueAt: T0,
            ...data,
          },
        }),
      );
    };
    await email({ mode: "LIVE", status: "SENT", sentAt: at(60) }); // counted
    await email({ mode: "TEST", status: "SENT", sentAt: at(120) }); // counted: test mode counts
    await email({ mode: "LIVE", status: "SENT", sentAt: at(-60) }); // before `since`
    await email({ mode: "DRY_RUN", status: "SENT", sentAt: at(30) }); // never went to Mailgun
    await email({ mode: "LIVE", status: "UNKNOWN", claimedAt: at(30) }); // counted from its claim
    await email({ mode: "LIVE", status: "SENDING", claimedAt: at(-5) }); // claimed before `since`
    await email({ mode: "LIVE", status: "FAILED", sentAt: at(40) }); // not SENT
    await email({ mode: "LIVE", status: "QUEUED" });
    await dbWrite((c) =>
      c.testSend.createMany({
        data: [
          { userId: user.id, to: "tess@gmail.com", subject: "t", mode: "LIVE", sentAt: at(10), status: "SENT" },
          { userId: user.id, to: "tess@gmail.com", subject: "t", mode: "LIVE", sentAt: at(15), status: "FAILED" },
          { userId: user.id, to: "tess@gmail.com", subject: "t", mode: "LIVE", sentAt: at(-10), status: "SENT" },
        ],
      }),
    );
    expect(await countMailgunSendsSince(T0)).toEqual({ total: 4, oldestAt: at(10) });
    expect(await dbTx((tx) => countMailgunSendsSince(T0, tx))).toEqual({ total: 4, oldestAt: at(10) });

    const accepted = (id: string, minutes: number, n: number) =>
      dbWrite((c) =>
        c.mailEvent.create({
          data: { dedupeKey: `acc-${id}-${n}`, type: "accepted", occurredAt: at(minutes), messageId: id, source: "LOGS", raw: {} },
        }),
      );
    // Three distinct accepted ids (one twice), one before `since`, one of another type: fewer than the app's own 4.
    await accepted("a@x", 5, 1);
    await accepted("a@x", 6, 2);
    await accepted("b@x", 7, 3);
    await accepted("c@x", 8, 4);
    await accepted("old@x", -30, 5);
    await dbWrite((c) => c.mailEvent.create({ data: { dedupeKey: "del-1", type: "delivered", occurredAt: at(9), messageId: "d@x", source: "LOGS", raw: {} } }));
    expect(await countMailgunSendsSince(T0)).toEqual({ total: 4, oldestAt: at(10) });
    // Two more accepted ids (other senders on the account): Mailgun's 5 now win, with their own oldest time.
    await accepted("e@x", 11, 6);
    await accepted("f@x", 12, 7);
    expect(await countMailgunSendsSince(T0)).toEqual({ total: 5, oldestAt: at(5) });
  });
});

describe("the Mailgun context and the client in own-mailbox mode (O1, O6, O24)", () => {
  const guard = { goLive: false, testList: new Set(["tess@gmail.com"]) };
  const msg = (from: string, extra: { replyTo?: string | null; messageId?: string } = {}) => ({
    from,
    to: "tess@gmail.com",
    subject: "Hi",
    text: "Hi",
    html: "<p>Hi</p>",
    messageId: extra.messageId ?? `pp.${Math.random().toString(36).slice(2)}@example.com`,
    replyTo: extra.replyTo ?? null,
    tags: [],
    variables: {},
    purpose: "campaign" as const,
    guard,
  });

  it("connectFakeMailgun refuses own-mailbox mode against a fake that receives mail", async () => {
    await expect(connectFakeMailgun({ replies: "own-mailbox" })).rejects.toThrow(/receivesMail: false/);
  });

  it("app mode: the context says so and the clients keep today's sender check", async () => {
    await clearSettings();
    const mg = await connectFakeMailgun({ domain: "send.example.com" });
    try {
      const ctx = await getMailgunContext({ retryDelayMs: () => 0 });
      expect(ctx).toMatchObject({ connected: true, replies: "app", ownFrom: null, ownMailboxFrom: null });
      if (!ctx.connected) throw new Error("not connected");
      const res = await ctx.sendClient.sendMessage("send.example.com", msg("Ali <ali@send.example.com>", { messageId: "pp.app1@send.example.com" }));
      expect(res.id).toBe("pp.app1@send.example.com");
    } finally {
      await mg.stop();
    }
  });

  it("own-mailbox mode: only the own From goes out, with no Reply-To; a limit refusal to a send is 'limit'", async () => {
    await clearSettings();
    const mg = await connectFakeMailgun({
      domain: "example.com",
      region: "US",
      replies: "own-mailbox",
      fromAddress: "contact@example.com",
      plan: "free",
      fake: { plan: "free", receivesMail: false, dailyLimit: 1 },
    });
    try {
      expect(await getSetting("mailgun.replies")).toBe("own-mailbox");
      expect(await getSetting("mailgun.plan")).toBe("free");
      expect(await db.senderAddress.count()).toBe(0);
      const ctx = await getMailgunContext({ retryDelayMs: () => 0 });
      expect(ctx).toMatchObject({ connected: true, replies: "own-mailbox", ownFrom: "contact@example.com", ownMailboxFrom: "contact@example.com" });
      if (!ctx.connected) throw new Error("not connected");
      const before = mg.fake.requests.length;
      for (const bad of [msg("Ali <ali@example.com>"), msg("Arslan <contact@example.com>", { replyTo: "ali@example.com" })]) {
        const err = await ctx.sendClient.sendMessage("example.com", bad).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MailgunError);
        expect(err).toMatchObject({ kind: "sender", requestStarted: false });
      }
      expect(mg.fake.requests.length).toBe(before);
      const ok = await ctx.sendClient.sendMessage("example.com", msg("Arslan from Polygon Paradise <contact@example.com>"));
      expect(ok.id).toMatch(/@example\.com$/);
      // The fake's daily limit (1) is used up: the send refusal is the new "limit" kind, never "rejected".
      const limited = await ctx.sendClient.sendMessage("example.com", msg("Arslan <contact@example.com>")).catch((e: unknown) => e);
      expect(limited).toMatchObject({ kind: "limit", status: 400, ambiguous: false });
      // The same text on another endpoint keeps today's kind.
      mg.fake.failNext("GET /v4/domains/:d", { kind: "status", status: 400, body: { message: "Domain example.com has reached its daily sending limit of 1 messages." } });
      const other = await ctx.client.getDomain("example.com").catch((e: unknown) => e);
      expect(other).toMatchObject({ kind: "rejected", status: 400 });
    } finally {
      await mg.stop();
    }
  });

  it("own-mailbox mode without a fitting From refuses every send", async () => {
    await clearSettings();
    const mg = await connectFakeMailgun({ domain: "example.com", region: "US", replies: "own-mailbox", fake: { plan: "free", receivesMail: false } });
    try {
      const ctx = await getMailgunContext({ retryDelayMs: () => 0 });
      expect(ctx).toMatchObject({ connected: true, replies: "own-mailbox", ownFrom: null, ownMailboxFrom: "" });
      if (!ctx.connected) throw new Error("not connected");
      const err = await ctx.sendClient.sendMessage("example.com", msg("Arslan <contact@example.com>")).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: "sender", requestStarted: false });
      expect((err as Error).message).toMatch(/no From address yet/);
    } finally {
      await mg.stop();
    }
  });
});
