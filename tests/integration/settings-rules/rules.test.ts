import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { daysAgo, makeCompany, makeDraft, makeUser } from "../campaigns/seed";

/**
 * "The 30-day rule" card (M6-DESIGN §5.3, L11): the three rule settings are validated with the card's exact errors,
 * a change that affects campaigns comes back as confirmation lines without any write, the confirmed save writes every
 * changed key and one activity per key in one transaction (a failure inside it changes nothing), and only the Owner
 * may save.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
/** When set, the n-th logActivity call from now on throws (to break the save's transaction half-way). */
const breakAt = vi.hoisted(() => ({ call: 0, seen: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction,
    requireOwnerAction: async () => {
      const user = await requireUserAction();
      if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
      return user;
    },
  };
});
vi.mock("@/server/activity", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/activity")>();
  return {
    ...real,
    logActivity: async (...args: Parameters<typeof real.logActivity>) => {
      if (breakAt.call > 0) {
        breakAt.seen += 1;
        if (breakAt.seen === breakAt.call) throw new Error("The disk is full.");
      }
      return real.logActivity(...args);
    },
  };
});

const t = await createTestDb("settings-rules");
const { db, dbWrite } = await import("@/server/db");
const { getSettings } = await import("@/server/settings");
const rules = await import("@/server/services/settings/rules");
const { saveRulesAction } = await import("@/app/(app)/settings/limits/actions");
const { expirePausedReservations } = await import("@/server/services/reservations");

const { saveRules, validateRules, parseSharedDomains, normalizeSharedDomain, loadRulesView, RULES_TEXT, BUILT_IN_SHARED_DOMAINS } = rules;

const DAY = 86_400_000;
let owner: TestUser;
let member: TestUser;
let sara: { id: number };
let actor: { id: number; name: string };

function asUser(u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, timeZone: "Europe/Berlin", sessionId: 1 };
}

const DEFAULT_INPUT = { teamRuleDays: 30, pausedExpiryDays: 14, sharedDomains: "" };

async function ruleRows() {
  return db.setting.findMany({
    where: { key: { in: ["teamRule.days", "reservations.pausedExpiryDays", "sharedDomains.extra"] } },
    orderBy: { key: "asc" },
    select: { key: true, value: true, updatedById: true },
  });
}

async function settingsActivities() {
  return db.activityLog.findMany({ where: { type: "settings.updated" }, orderBy: { id: "asc" }, select: { summary: true, data: true, actorId: true } });
}

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER" }));
  member = asUser(await makeUser("Ali"));
  sara = await makeUser("Sara");
  actor = { id: owner.id, name: owner.name };
});

beforeEach(async () => {
  auth.user = owner;
  breakAt.call = 0;
  breakAt.seen = 0;
  await dbWrite(async (c) => {
    await c.activityLog.deleteMany({});
    await c.notification.deleteMany({});
    await c.companyReservation.deleteMany({});
    await c.campaignRecipient.deleteMany({});
    await c.campaignStep.deleteMany({});
    await c.campaign.deleteMany({});
    await c.person.deleteMany({});
    await c.company.deleteMany({});
    await c.setting.deleteMany({ where: { key: { in: ["teamRule.days", "reservations.pausedExpiryDays", "sharedDomains.extra"] } } });
  });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("validation (the card's exact errors)", () => {
  it("the two day fields: whole numbers in range", () => {
    for (const bad of [0, 366, 1.5, -3, Number.NaN, "abc", "", null]) {
      const r = validateRules({ ...DEFAULT_INPUT, teamRuleDays: bad });
      expect(r.ok, String(bad)).toBe(false);
      if (!r.ok) expect(r.fieldErrors).toEqual({ teamRuleDays: ["Use a whole number of days from 1 to 365."] });
    }
    for (const bad of [0, 91, 2.5]) {
      const r = validateRules({ ...DEFAULT_INPUT, pausedExpiryDays: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fieldErrors).toEqual({ pausedExpiryDays: ["Use a whole number of days from 1 to 90."] });
    }
    expect(validateRules({ teamRuleDays: 1, pausedExpiryDays: 1, sharedDomains: "" })).toEqual({
      ok: true,
      value: { teamRuleDays: 1, pausedExpiryDays: 1, sharedDomains: [] },
    });
    expect(validateRules({ teamRuleDays: 365, pausedExpiryDays: 90, sharedDomains: "" }).ok).toBe(true);
    // Every field is checked at once.
    const all = validateRules({ teamRuleDays: 0, pausedExpiryDays: 0, sharedDomains: "not a domain" });
    expect(all.ok).toBe(false);
    if (!all.ok) expect(Object.keys(all.fieldErrors).sort()).toEqual(["pausedExpiryDays", "sharedDomains", "teamRuleDays"]);
  });

  it("each domain line: the box's line number in the error", () => {
    expect(parseSharedDomains("firma.example\n\nnot a domain")).toEqual({ ok: false, error: "Line 3 isn't a domain. Write it like example.com." });
    for (const bad of ["anna@firma.example", "https://firma.example/", "firma.example/about", "com", "co.uk", "1.2.3.4", "localhost", "a..b.example", "-a.example"]) {
      expect(parseSharedDomains(`ok.example\n${bad}`), bad).toEqual({ ok: false, error: "Line 2 isn't a domain. Write it like example.com." });
    }
  });

  it("stores lower case, drops blank lines, duplicates and the built-in domains silently", () => {
    expect(parseSharedDomains(" Firma.Example. \r\n\r\nstudio.example\nFIRMA.example\ngmail.com\nGMAIL.COM\ninstagram.com\nmail.firma.example")).toEqual({
      ok: true,
      domains: ["firma.example", "studio.example", "mail.firma.example"],
    });
    expect(normalizeSharedDomain("münchen.example")).toBe("xn--mnchen-3ya.example");
    expect(normalizeSharedDomain("example.co.uk")).toBe("example.co.uk");
    expect(parseSharedDomains("")).toEqual({ ok: true, domains: [] });
  });

  it("at most 200 domains", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `d${i}.example`).join("\n");
    const ok = parseSharedDomains(`${lines(200)}\n\n\n`);
    expect(ok.ok && ok.domains.length).toBe(200);
    expect(parseSharedDomains(lines(201))).toEqual({ ok: false, error: "Use at most 200 lines, one domain per line." });
  });

  it("the built-in list is the app's own shared domains", () => {
    expect(BUILT_IN_SHARED_DOMAINS).toContain("gmail.com");
    expect(BUILT_IN_SHARED_DOMAINS).toContain("instagram.com");
    expect(new Set(BUILT_IN_SHARED_DOMAINS).size).toBe(BUILT_IN_SHARED_DOMAINS.length);
  });
});

describe("saving without an effect on campaigns", () => {
  it("nothing changed: no write, no activity", async () => {
    expect(await saveRules(actor, DEFAULT_INPUT)).toEqual({ message: "Nothing changed, so there was nothing to save." });
    expect(await ruleRows()).toEqual([]);
    expect(await settingsActivities()).toEqual([]);
  });

  it("invalid input: the field errors, nothing written", async () => {
    expect(await saveRules(actor, { ...DEFAULT_INPUT, teamRuleDays: 0 })).toEqual({
      message: "Some rules need fixing. Check the highlighted fields.",
      fieldErrors: { teamRuleDays: ["Use a whole number of days from 1 to 365."] },
    });
    expect(await ruleRows()).toEqual([]);
  });

  it("writes only the changed key, with who changed it, and one activity for it", async () => {
    const res = await saveRules(actor, { ...DEFAULT_INPUT, sharedDomains: "firma.example\nstudio.example" });
    expect(res).toEqual({ message: "Rules saved. They apply to new launches and to every email from now on." });
    expect(await ruleRows()).toEqual([{ key: "sharedDomains.extra", value: ["firma.example", "studio.example"], updatedById: owner.id }]);
    expect(await settingsActivities()).toEqual([
      {
        summary: "Arslan changed the shared email domains",
        data: { key: "sharedDomains.extra", from: [], to: ["firma.example", "studio.example"] },
        actorId: owner.id,
      },
    ]);
    // The same list in another order is no change.
    expect((await saveRules(actor, { ...DEFAULT_INPUT, sharedDomains: "studio.example\nfirma.example" })).message).toBe(
      "Nothing changed, so there was nothing to save.",
    );
    expect(await settingsActivities()).toHaveLength(1);
    // Raising the rule with no running campaign asks nothing.
    expect((await saveRules(actor, { ...DEFAULT_INPUT, teamRuleDays: 45, sharedDomains: "firma.example\nstudio.example" })).message).toBe(RULES_TEXT.saved);
    const s = await getSettings(["teamRule.days", "reservations.pausedExpiryDays", "sharedDomains.extra"] as const);
    expect(s).toEqual({ "teamRule.days": 45, "reservations.pausedExpiryDays": 14, "sharedDomains.extra": ["firma.example", "studio.example"] });
    expect((await settingsActivities()).map((a) => a.summary)).toEqual([
      "Arslan changed the shared email domains",
      "Arslan set the 30-day rule to 45 days",
    ]);
  });

  it("the view shows the saved values and the built-in list", async () => {
    expect(await loadRulesView()).toEqual({ teamRuleDays: 30, pausedExpiryDays: 14, sharedDomains: [], builtIn: [...BUILT_IN_SHARED_DOMAINS] });
    await saveRules(actor, { teamRuleDays: 21, pausedExpiryDays: 10, sharedDomains: "firma.example" }, { confirmed: true });
    expect(await loadRulesView()).toMatchObject({ teamRuleDays: 21, pausedExpiryDays: 10, sharedDomains: ["firma.example"] });
  });
});

/** A running (or other) campaign whose sender is `senderId`, with one recipient of `companyId` in `state`. */
async function campaignWith(opts: {
  name: string;
  senderId: number;
  status: "RUNNING" | "SCHEDULED" | "PAUSED" | "FINISHED";
  companyId: number;
  personId: number;
  state?: "PENDING" | "WAITING" | "FINISHED" | "STOPPED";
  pausedAt?: Date | null;
}) {
  const c = await makeDraft({ name: opts.name, createdById: opts.senderId, senderId: opts.senderId, recipients: [{ companyId: opts.companyId, personId: opts.personId }] });
  await dbWrite(async (tx) => {
    await tx.campaign.update({ where: { id: c.id }, data: { status: opts.status, mode: "LIVE", launchedAt: daysAgo(1), launchedGoLive: true, pausedAt: opts.pausedAt ?? null } });
    await tx.campaignRecipient.updateMany({ where: { campaignId: c.id }, data: { state: opts.state ?? "PENDING" } });
  });
  return c;
}

async function emailedCompany(name: string, daysBack: number, byId: number, opts: { deleted?: boolean } = {}) {
  const { company, people } = await makeCompany({ name, people: [{}], deletedAt: opts.deleted ? daysAgo(1) : null });
  await dbWrite((c) => c.company.update({ where: { id: company.id }, data: { lastEmailedAt: daysAgo(daysBack), lastEmailedById: byId, lastContactAt: daysAgo(daysBack) } }));
  return { company, person: people[0]! };
}

describe("the impact confirmation (§5.3)", () => {
  it("a rule shorter than 30 days: the sentence, nothing written until confirmed", async () => {
    const res = await saveRules(actor, { ...DEFAULT_INPUT, teamRuleDays: 21 });
    expect(res).toEqual({
      message: "Check what these rules change, then save them.",
      needsConfirm: { lines: ["Companies become free for teammates after 21 days instead of 30, so two people may email the same company sooner."] },
    });
    expect(await ruleRows()).toEqual([]);
    expect(await settingsActivities()).toEqual([]);

    expect(await saveRules(actor, { ...DEFAULT_INPUT, teamRuleDays: 21 }, { confirmed: true })).toEqual({ message: RULES_TEXT.saved });
    expect(await ruleRows()).toEqual([{ key: "teamRule.days", value: 21, updatedById: owner.id }]);
    expect(await settingsActivities()).toEqual([
      { summary: "Arslan set the 30-day rule to 21 days", data: { key: "teamRule.days", from: 30, to: 21 }, actorId: owner.id },
    ]);
    // Lowering further (still below 30) names the current length; 1 day is singular.
    expect((await saveRules(actor, { ...DEFAULT_INPUT, teamRuleDays: 1 })).needsConfirm?.lines).toEqual([
      "Companies become free for teammates after 1 day instead of 21, so two people may email the same company sooner.",
    ]);
  });

  it("a longer rule: companies a teammate emailed in the new part of the window, with someone still to email in a running campaign", async () => {
    // Counted: emailed 40 days ago by Sara, Ali's running campaign still has someone to email there (twice).
    const a = await emailedCompany("Anna Studio", 40, sara.id);
    const b = await emailedCompany("Berta Prints", 35, sara.id);
    await campaignWith({ name: "Germany Q4", senderId: member.id, status: "RUNNING", companyId: a.company.id, personId: a.person.id });
    await campaignWith({ name: "Spain", senderId: member.id, status: "SCHEDULED", companyId: b.company.id, personId: b.person.id, state: "WAITING" });
    // Not counted: emailed by the campaign's own sender, too recently, too long ago, deleted, only finished recipients,
    // or the campaign isn't running.
    const own = await emailedCompany("Own Company", 40, member.id);
    await campaignWith({ name: "Own", senderId: member.id, status: "RUNNING", companyId: own.company.id, personId: own.person.id });
    const recent = await emailedCompany("Recent", 20, sara.id);
    await campaignWith({ name: "Recent", senderId: member.id, status: "RUNNING", companyId: recent.company.id, personId: recent.person.id });
    const old = await emailedCompany("Old", 50, sara.id);
    await campaignWith({ name: "Old", senderId: member.id, status: "RUNNING", companyId: old.company.id, personId: old.person.id });
    const gone = await emailedCompany("Gone", 40, sara.id, { deleted: true });
    await campaignWith({ name: "Gone", senderId: member.id, status: "RUNNING", companyId: gone.company.id, personId: gone.person.id });
    const done = await emailedCompany("Done", 40, sara.id);
    await campaignWith({ name: "Done", senderId: member.id, status: "RUNNING", companyId: done.company.id, personId: done.person.id, state: "FINISHED" });
    const finished = await emailedCompany("Finished", 40, sara.id);
    await campaignWith({ name: "Finished", senderId: member.id, status: "FINISHED", companyId: finished.company.id, personId: finished.person.id });

    const res = await saveRules(actor, { ...DEFAULT_INPUT, teamRuleDays: 45 });
    expect(res.needsConfirm?.lines).toEqual([
      "2 companies in running campaigns were emailed by a teammate between 30 and 45 days ago; their people are skipped from their next email on.",
    ]);
    expect(await ruleRows()).toEqual([]);

    // One company: the singular sentence.
    await dbWrite((c) => c.company.update({ where: { id: b.company.id }, data: { lastEmailedById: member.id } }));
    expect((await saveRules(actor, { ...DEFAULT_INPUT, teamRuleDays: 45 })).needsConfirm?.lines).toEqual([
      "1 company in running campaigns was emailed by a teammate between 30 and 45 days ago; its people are skipped from their next email on.",
    ]);
    expect(await saveRules(actor, { ...DEFAULT_INPUT, teamRuleDays: 45 }, { confirmed: true })).toEqual({ message: RULES_TEXT.saved });
    expect((await getSettings(["teamRule.days"] as const))["teamRule.days"]).toBe(45);
  });

  it("a new shared domain that companies use: one line per such domain", async () => {
    await makeCompany({ name: "Firma One", domain: "firma.example" });
    await makeCompany({ name: "Firma Two", domain: "firma.example" });
    await makeCompany({ name: "Firma Deleted", domain: "firma.example", deletedAt: daysAgo(2) });
    await makeCompany({ name: "Studio", domain: "studio.example" });
    const res = await saveRules(actor, { ...DEFAULT_INPUT, sharedDomains: "firma.example\nstudio.example\nnobody.example" });
    expect(res.needsConfirm?.lines).toEqual([
      "2 companies use firma.example. The app would stop grouping them, and replies from it would no longer stop follow-ups there.",
      "1 company uses studio.example. The app would stop grouping it, and replies from it would no longer stop follow-ups there.",
    ]);
    expect(await ruleRows()).toEqual([]);
    // A domain already on the list isn't asked about again.
    await saveRules(actor, { ...DEFAULT_INPUT, sharedDomains: "firma.example\nstudio.example" }, { confirmed: true });
    expect(await saveRules(actor, { ...DEFAULT_INPUT, sharedDomains: "firma.example\nstudio.example\nnobody.example" })).toEqual({
      message: RULES_TEXT.saved,
    });
  });

  it("a shorter paused-campaign expiry: the campaigns it releases now, then their companies are released", async () => {
    const now = new Date();
    const long = await makeCompany({ name: "Long Pause", people: [{}] });
    const c1 = await campaignWith({
      name: "Paused long ago",
      senderId: member.id,
      status: "PAUSED",
      companyId: long.company.id,
      personId: long.people[0]!.id,
      pausedAt: new Date(now.getTime() - 10 * DAY),
    });
    const short = await makeCompany({ name: "Short Pause", people: [{}] });
    const c2 = await campaignWith({
      name: "Paused yesterday",
      senderId: member.id,
      status: "PAUSED",
      companyId: short.company.id,
      personId: short.people[0]!.id,
      pausedAt: new Date(now.getTime() - 1 * DAY),
    });
    const extra = await Promise.all([1, 2].map((i) => makeCompany({ name: `Extra ${i}` })));
    await dbWrite(async (c) => {
      const p1 = new Date(now.getTime() - 10 * DAY);
      for (const companyId of [long.company.id, ...extra.map((e) => e.company.id)]) {
        await c.companyReservation.create({ data: { companyId, campaignId: c1.id, reservedAt: p1, expiresAt: new Date(p1.getTime() + 14 * DAY) } });
      }
      // Already released: not counted, not touched.
      await c.companyReservation.create({ data: { companyId: short.company.id, campaignId: c1.id, reservedAt: p1, releasedAt: p1 } });
      const p2 = new Date(now.getTime() - 1 * DAY);
      await c.companyReservation.create({ data: { companyId: short.company.id, campaignId: c2.id, reservedAt: p2, expiresAt: new Date(p2.getTime() + 14 * DAY) } });
    });

    const res = await saveRules(actor, { ...DEFAULT_INPUT, pausedExpiryDays: 7 }, { now });
    expect(res.needsConfirm?.lines).toEqual(["1 paused campaign would release its 3 companies now."]);
    expect(await ruleRows()).toEqual([]);
    const before = await db.companyReservation.findMany({ where: { campaignId: c1.id, releasedAt: null }, select: { expiresAt: true } });
    expect(before.every((r) => r.expiresAt!.getTime() > now.getTime())).toBe(true);

    expect(await saveRules(actor, { ...DEFAULT_INPUT, pausedExpiryDays: 7 }, { confirmed: true, now })).toEqual({ message: RULES_TEXT.saved });
    expect(await settingsActivities()).toEqual([
      {
        summary: "Arslan set paused campaigns to keep their companies for 7 days",
        data: { key: "reservations.pausedExpiryDays", from: 14, to: 7 },
        actorId: owner.id,
      },
    ]);
    // Paused 10 days ago → its companies' reservations ended 3 days ago; paused yesterday → they end in 6 days.
    const after1 = await db.companyReservation.findMany({ where: { campaignId: c1.id, releasedAt: null }, select: { expiresAt: true } });
    expect(after1.map((r) => r.expiresAt!.getTime())).toEqual([0, 1, 2].map(() => now.getTime() - 3 * DAY));
    const after2 = await db.companyReservation.findFirstOrThrow({ where: { campaignId: c2.id }, select: { expiresAt: true } });
    expect(after2.expiresAt!.getTime()).toBe(now.getTime() + 6 * DAY);
    // The worker's sweep then releases them and tells the launcher and the Owner.
    const swept = await expirePausedReservations(new Date(now.getTime() + 1_000));
    expect(swept).toEqual({ released: 3, campaigns: [c1.id] });
    expect(await db.notification.count({ where: { type: "campaign.reservationsExpired" } })).toBe(2);

    // Two campaigns: the plural sentence.
    await dbWrite((c) => c.campaign.update({ where: { id: c2.id }, data: { pausedAt: new Date(now.getTime() - 5 * DAY) } }));
    await dbWrite((c) => c.companyReservation.updateMany({ where: { campaignId: c2.id }, data: { expiresAt: new Date(now.getTime() + 2 * DAY) } }));
    const third = await makeCompany({ name: "Third Pause", people: [{}] });
    const c3 = await campaignWith({
      name: "Paused a week ago",
      senderId: member.id,
      status: "PAUSED",
      companyId: third.company.id,
      personId: third.people[0]!.id,
      pausedAt: new Date(now.getTime() - 6 * DAY),
    });
    await dbWrite((c) => c.companyReservation.create({ data: { companyId: third.company.id, campaignId: c3.id, expiresAt: new Date(now.getTime() + DAY) } }));
    expect((await saveRules(actor, { ...DEFAULT_INPUT, pausedExpiryDays: 4 }, { now })).needsConfirm?.lines).toEqual([
      "2 paused campaigns would release their 2 companies now.",
    ]);
  });

  it("a longer expiry gives paused campaigns more time, but never brings back an expired reservation", async () => {
    const now = new Date();
    const p = await makeCompany({ name: "Paused Co", people: [{}] });
    const other = await makeCompany({ name: "Expired Co" });
    const c = await campaignWith({ name: "Paused", senderId: member.id, status: "PAUSED", companyId: p.company.id, personId: p.people[0]!.id, pausedAt: new Date(now.getTime() - 3 * DAY) });
    await dbWrite(async (tx) => {
      await tx.companyReservation.create({ data: { companyId: p.company.id, campaignId: c.id, expiresAt: new Date(now.getTime() + 11 * DAY) } });
      await tx.companyReservation.create({ data: { companyId: other.company.id, campaignId: c.id, expiresAt: new Date(now.getTime() - 60_000) } });
    });
    expect(await saveRules(actor, { ...DEFAULT_INPUT, pausedExpiryDays: 30 }, { now })).toEqual({ message: RULES_TEXT.saved });
    const rows = await db.companyReservation.findMany({ where: { campaignId: c.id }, orderBy: { id: "asc" }, select: { expiresAt: true } });
    expect(rows[0]!.expiresAt!.getTime()).toBe(now.getTime() + 27 * DAY);
    expect(rows[1]!.expiresAt!.getTime()).toBe(now.getTime() - 60_000);
  });

  it("several changes: every line, in the card's order; confirmed, one activity per changed key", async () => {
    await makeCompany({ name: "Firma", domain: "firma.example" });
    const now = new Date();
    const p = await makeCompany({ name: "Paused Co", people: [{}] });
    const c = await campaignWith({ name: "Paused", senderId: member.id, status: "PAUSED", companyId: p.company.id, personId: p.people[0]!.id, pausedAt: new Date(now.getTime() - 5 * DAY) });
    await dbWrite((tx) => tx.companyReservation.create({ data: { companyId: p.company.id, campaignId: c.id, expiresAt: new Date(now.getTime() + 9 * DAY) } }));
    const input = { teamRuleDays: 21, pausedExpiryDays: 3, sharedDomains: "firma.example" };
    expect((await saveRules(actor, input, { now })).needsConfirm?.lines).toEqual([
      "Companies become free for teammates after 21 days instead of 30, so two people may email the same company sooner.",
      "1 company uses firma.example. The app would stop grouping it, and replies from it would no longer stop follow-ups there.",
      "1 paused campaign would release its 1 company now.",
    ]);
    await saveRules(actor, input, { now, confirmed: true });
    expect((await settingsActivities()).map((a) => (a.data as { key: string }).key)).toEqual([
      "teamRule.days",
      "reservations.pausedExpiryDays",
      "sharedDomains.extra",
    ]);
    expect((await ruleRows()).map((r) => [r.key, r.value, r.updatedById])).toEqual([
      ["reservations.pausedExpiryDays", 3, owner.id],
      ["sharedDomains.extra", ["firma.example"], owner.id],
      ["teamRule.days", 21, owner.id],
    ]);
  });
});

describe("one transaction", () => {
  it("a failure inside it leaves every key, every reservation and the log as they were", async () => {
    const now = new Date();
    const p = await makeCompany({ name: "Paused Co", people: [{}] });
    const c = await campaignWith({ name: "Paused", senderId: member.id, status: "PAUSED", companyId: p.company.id, personId: p.people[0]!.id, pausedAt: new Date(now.getTime() - 2 * DAY) });
    const expiresAt = new Date(now.getTime() + 12 * DAY);
    await dbWrite((tx) => tx.companyReservation.create({ data: { companyId: p.company.id, campaignId: c.id, expiresAt } }));
    breakAt.call = 3; // the third key's activity
    await expect(
      saveRules(actor, { teamRuleDays: 60, pausedExpiryDays: 20, sharedDomains: "firma.example" }, { confirmed: true, now }),
    ).rejects.toThrow("The disk is full.");
    expect(breakAt.seen).toBe(3);
    expect(await ruleRows()).toEqual([]);
    expect(await settingsActivities()).toEqual([]);
    expect((await db.companyReservation.findFirstOrThrow({ where: { campaignId: c.id } })).expiresAt).toEqual(expiresAt);
    breakAt.call = 0;
    expect(await saveRules(actor, { teamRuleDays: 60, pausedExpiryDays: 20, sharedDomains: "firma.example" }, { confirmed: true, now })).toEqual({
      message: RULES_TEXT.saved,
    });
    expect(await ruleRows()).toHaveLength(3);
  });
});

describe("saveRulesAction", () => {
  it("refuses a Member and writes nothing", async () => {
    auth.user = member;
    expect(await saveRulesAction({ teamRuleDays: 21, pausedExpiryDays: 7, sharedDomains: "firma.example", confirmed: true })).toEqual({
      ok: false,
      error: "Only the Owner can do this.",
    });
    expect(await ruleRows()).toEqual([]);
    expect(await settingsActivities()).toEqual([]);
  });

  it("returns field errors with the card's sentences, also for an empty box", async () => {
    expect(await saveRulesAction({ teamRuleDays: Number.NaN, pausedExpiryDays: 91, sharedDomains: "a.example\nnope" })).toEqual({
      ok: false,
      error: "Some rules need fixing. Check the highlighted fields.",
      fieldErrors: {
        teamRuleDays: ["Use a whole number of days from 1 to 365."],
        pausedExpiryDays: ["Use a whole number of days from 1 to 90."],
        sharedDomains: ["Line 2 isn't a domain. Write it like example.com."],
      },
    });
  });

  it("asks first, then saves with confirmed", async () => {
    const asked = await saveRulesAction({ teamRuleDays: 21, pausedExpiryDays: 14, sharedDomains: "" });
    expect(asked).toEqual({
      ok: true,
      data: { needsConfirm: { lines: ["Companies become free for teammates after 21 days instead of 30, so two people may email the same company sooner."] } },
      message: "Check what these rules change, then save them.",
    });
    expect(await ruleRows()).toEqual([]);
    expect(await saveRulesAction({ teamRuleDays: 21, pausedExpiryDays: 14, sharedDomains: "", confirmed: true })).toEqual({
      ok: true,
      data: {},
      message: "Rules saved. They apply to new launches and to every email from now on.",
    });
    expect((await getSettings(["teamRule.days"] as const))["teamRule.days"]).toBe(21);
  });
});
