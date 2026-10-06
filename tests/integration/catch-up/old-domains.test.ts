import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { DAY, HOUR, makeUser } from "../stops-holds/world";

/**
 * Old sending domains the catch-up couldn't check (M6-DESIGN L10, §7.2, §7.3): kept in `CatchUpState.oldDomains`
 * with since when (Settings › Sending & Mailgun and the dashboard show them through `oldDomainLines`), cleared once
 * the domain is checked fine, gone from Mailgun or no longer synced, and the Owner hears once after 24 hours (at most
 * once a day, "catchup-old-domain"). Everything goes through the fake Mailgun; an older domain "fails" through an
 * injected fetch that answers 503 for its URLs.
 */

const OLDER = "older.example.com";
const OLDEST = "oldest.example.com";
const GONE = "gone.example.com";
const STALE = "stale.example.com";
const OWNER_ZONE = "America/New_York";

const t = await createTestDb("catch-up-old-domains");
const mg = await connectFakeMailgun({ fake: { otherDomains: [OLDER, OLDEST] } });
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const catchUp = await import("@/server/services/mailgun/catch-up");
const { runCatchUp, nextOldDomainProblems, oldDomainNoticeDue, oldDomainNoticeCopy, OLD_DOMAIN_NOTICE_KEY } = catchUp;
const { readTyped } = await import("@/server/state-typed");
const { parseCatchUpState, OLD_DOMAIN_PROBLEMS_MAX, OLD_DOMAIN_TEXT_MAX } = await import("@/core/system-state-parse");
const { oldDomainLines } = await import("@/core/mailgun/catch-up-status");
const { formatShortDate } = await import("@/core/time/format");
const { createCatchUpJob } = await import("../../../worker/jobs/mailgun-catch-up");

/** Domains whose Mailgun URLs answer 503 (Mailgun had a problem on its side) until removed. */
const failing = new Set<string>();
const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  for (const d of failing) {
    if (url.includes(d)) {
      return new Response(JSON.stringify({ message: "Service Unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    }
  }
  return fetch(input, init);
};
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0, fetchImpl });

const problemText = (d: string) => `Couldn't check the old domain ${d} this time: Mailgun had a problem on its side. The next check tries again.`;
const NOTICE_TITLE = "Couldn't check an old sending domain";

let ownerId: number;
let memberId: number;

beforeAll(async () => {
  ownerId = (await makeUser("Arslan", { role: "OWNER", timeZone: OWNER_ZONE })).id;
  memberId = (await makeUser("Ali", { timeZone: "Asia/Karachi" })).id;
  await dbWrite(async (c) => {
    for (const name of [OLDER, OLDEST]) {
      await c.sendingDomain.create({ data: { name, region: "EU", active: false, lastLiveSendAt: new Date(Date.now() - DAY) } });
    }
  });
});

beforeEach(async () => {
  mg.fake.reset();
  failing.clear();
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: { in: ["sending.pause", "mailgun.catchUp", "catchup.outage", "notices", "mailgun.setup"] } } });
    await c.syncCursor.deleteMany({});
    await c.notification.deleteMany({});
  });
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

async function state() {
  return (await readTyped("mailgun.catchUp", parseCatchUpState)).value;
}

/** The stored JSON as written (not parsed), to see which fields are really there. */
async function rawState(): Promise<Record<string, unknown>> {
  return (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
}

async function seedOldDomains(list: Array<{ domain: string; since: Date; lastAt?: Date; text?: string }>) {
  const value = {
    lastStartedAt: null,
    oldDomains: list.map((p) => ({
      domain: p.domain,
      since: p.since.toISOString(),
      lastAt: (p.lastAt ?? p.since).toISOString(),
      text: p.text ?? problemText(p.domain),
    })),
  };
  await dbWrite((c) =>
    c.systemState.upsert({
      where: { key: "mailgun.catchUp" },
      create: { key: "mailgun.catchUp", value, version: 1 },
      update: { value, version: { increment: 1 } },
    }),
  );
}

async function notices() {
  return db.notification.findMany({ where: { title: NOTICE_TITLE }, orderBy: { id: "asc" } });
}

describe("runCatchUp keeps the old domains it couldn't check", () => {
  it("records a problem with since when it was first seen; later runs keep since and move lastAt", async () => {
    failing.add(OLDER);
    const t0 = new Date();
    const first = await runCatchUp({ reason: "startup", now: t0, mailgun });
    expect(first.domains).toEqual([mg.domain, OLDEST]);
    expect(first.oldDomainProblems).toEqual([{ domain: OLDER, gone: false, text: problemText(OLDER) }]);
    expect((await state()).oldDomains).toEqual([
      { domain: OLDER, since: t0.toISOString(), lastAt: t0.toISOString(), text: problemText(OLDER) },
    ]);
    // The active domain still succeeded: an old domain never blocks it.
    expect(await state()).toMatchObject({ lastSuccessAt: t0.toISOString(), lastError: null });

    const t1 = new Date(t0.getTime() + HOUR);
    await runCatchUp({ reason: "hourly", now: t1, mailgun });
    const s = await state();
    expect(s.oldDomains).toEqual([{ domain: OLDER, since: t0.toISOString(), lastAt: t1.toISOString(), text: problemText(OLDER) }]);
    // What Settings › Sending & Mailgun and the dashboard say about it.
    expect(oldDomainLines(s, OWNER_ZONE, t1)).toEqual([
      `Mailgun's logs for the old domain ${OLDER} haven't been checked since ${formatShortDate(t0, OWNER_ZONE, t1)}. Replies and bounces to its last emails may be missed.`,
    ]);
    expect(await notices()).toEqual([]);
  });

  it("keeps several domains, each with its own since", async () => {
    failing.add(OLDER);
    const t0 = new Date();
    await runCatchUp({ reason: "startup", now: t0, mailgun });
    failing.add(OLDEST);
    const t1 = new Date(t0.getTime() + HOUR);
    await runCatchUp({ reason: "hourly", now: t1, mailgun });
    expect((await state()).oldDomains).toEqual([
      { domain: OLDER, since: t0.toISOString(), lastAt: t1.toISOString(), text: problemText(OLDER) },
      { domain: OLDEST, since: t1.toISOString(), lastAt: t1.toISOString(), text: problemText(OLDEST) },
    ]);
  });

  it("clears a domain once it is checked fine again, and leaves the field out when none is left", async () => {
    failing.add(OLDER);
    failing.add(OLDEST);
    const t0 = new Date();
    await runCatchUp({ reason: "startup", now: t0, mailgun });
    expect((await state()).oldDomains?.map((p) => p.domain)).toEqual([OLDER, OLDEST]);

    failing.delete(OLDER);
    await runCatchUp({ reason: "hourly", now: new Date(t0.getTime() + HOUR), mailgun });
    expect((await state()).oldDomains?.map((p) => p.domain)).toEqual([OLDEST]);

    failing.clear();
    const res = await runCatchUp({ reason: "hourly", now: new Date(t0.getTime() + 2 * HOUR), mailgun });
    expect(res.domains).toEqual([mg.domain, OLDER, OLDEST]);
    await expect(rawState()).resolves.not.toHaveProperty("oldDomains");
    expect((await state()).oldDomains).toBeUndefined();
    // A failing domain later starts a new "since".
    failing.add(OLDER);
    const t3 = new Date(t0.getTime() + 3 * HOUR);
    await runCatchUp({ reason: "hourly", now: t3, mailgun });
    expect((await state()).oldDomains).toEqual([{ domain: OLDER, since: t3.toISOString(), lastAt: t3.toISOString(), text: problemText(OLDER) }]);
  });

  it("drops a domain Mailgun no longer has and one that isn't synced any more", async () => {
    const now = new Date();
    const extra = await dbWrite(async (c) => [
      // Not in the fake's account: Mailgun answers "Domain not found".
      await c.sendingDomain.create({ data: { name: GONE, region: "EU", active: false, lastLiveSendAt: new Date(now.getTime() - DAY) } }),
      // No live email for 70 days: not checked any more.
      await c.sendingDomain.create({ data: { name: STALE, region: "EU", active: false, lastLiveSendAt: new Date(now.getTime() - 70 * DAY) } }),
    ]);
    try {
      await seedOldDomains([
        { domain: GONE, since: new Date(now.getTime() - 3 * HOUR) },
        { domain: STALE, since: new Date(now.getTime() - 50 * DAY) },
        { domain: OLDER, since: new Date(now.getTime() - 2 * HOUR) },
      ]);
      const res = await runCatchUp({ reason: "hourly", now, mailgun });
      expect(res.oldDomainProblems).toEqual([
        { domain: GONE, gone: true, text: `The old domain ${GONE} is no longer in your Mailgun account, so the app stopped checking it.` },
      ]);
      expect((await state()).oldDomains).toBeUndefined();
      expect((await db.sendingDomain.findUniqueOrThrow({ where: { name: GONE } })).lastLiveSendAt).toBeNull();
      // Nothing about them reaches the Owner, even with a 50-day-old entry that was dropped.
      expect(await notices()).toEqual([]);
    } finally {
      await dbWrite((c) => c.sendingDomain.deleteMany({ where: { id: { in: extra.map((d) => d.id) } } }));
    }
  });

  it("brings the old domains up to date on a run whose active domain failed", async () => {
    failing.add(OLDER);
    mg.fake.failNext("GET /v3/domains/:d/sending_queues", { kind: "status", status: 503, body: { message: "Service Unavailable" } }, 4);
    const now = new Date();
    await expect(runCatchUp({ reason: "hourly", now, mailgun })).rejects.toThrow(/Mailgun had a problem/);
    const s = await state();
    expect(s).toMatchObject({ lastSuccessAt: null, lastErrorKind: "server" });
    expect(s.oldDomains).toEqual([{ domain: OLDER, since: now.toISOString(), lastAt: now.toISOString(), text: problemText(OLDER) }]);
  });

  it("leaves the list alone when Mailgun isn't connected (nothing was checked)", async () => {
    const since = new Date(Date.now() - 3 * DAY);
    await seedOldDomains([{ domain: OLDER, since }]);
    const before = (await state()).oldDomains;
    const notConnected = async () => ({ connected: false as const, reason: "no-key" as const, text: "The Mailgun API key isn't saved yet." });
    await runCatchUp({ reason: "hourly", mailgun: notConnected });
    expect((await state()).oldDomains).toEqual(before);
    // And tells nobody: the Owner hears only after a run that tried the domain.
    expect(await notices()).toEqual([]);
  });

  it("the job's summary still names the problem", async () => {
    failing.add(OLDER);
    const job = createCatchUpJob({ mailgun });
    const ctx = { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => undefined };
    const res = (await job.handler({ reason: "manual" }, ctx)) as { summary: string };
    expect(res.summary).toContain(problemText(OLDER));
    expect((await state()).oldDomains?.map((p) => p.domain)).toEqual([OLDER]);
  });
});

describe("the Owner's notice after 24 hours", () => {
  it("comes once after 24 hours, never twice within 24 hours, and only to the Owner", async () => {
    failing.add(OLDER);
    const t0 = new Date();
    await runCatchUp({ reason: "startup", now: t0, mailgun });
    await runCatchUp({ reason: "hourly", now: new Date(t0.getTime() + 24 * HOUR - 60_000), mailgun });
    expect(await notices()).toEqual([]);

    const day = new Date(t0.getTime() + 24 * HOUR);
    await runCatchUp({ reason: "hourly", now: day, mailgun });
    const sent = await notices();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      userId: ownerId,
      type: "system.mailgun",
      title: NOTICE_TITLE,
      body: `The app hasn't been able to check Mailgun's logs for the old domain ${OLDER} since ${formatShortDate(t0, OWNER_ZONE, day)}. Replies and bounces to its last emails may be missed. Check that the domain still exists in Mailgun and that the key works.`,
      link: "/settings/sending",
    });
    expect(await db.notification.count({ where: { userId: memberId } })).toBe(0);
    const stored = (await db.systemState.findUniqueOrThrow({ where: { key: "notices" } })).value as Record<string, string>;
    expect(stored[OLD_DOMAIN_NOTICE_KEY]).toBe(day.toISOString());

    // Within the next 24 hours: nothing more, even with a second domain failing for a day.
    failing.add(OLDEST);
    await runCatchUp({ reason: "hourly", now: new Date(t0.getTime() + 25 * HOUR), mailgun });
    await runCatchUp({ reason: "hourly", now: new Date(t0.getTime() + 48 * HOUR - 60_000), mailgun });
    expect(await notices()).toHaveLength(1);

    // A day after the first notice, the next one (still about the domain unchecked longest).
    const later = new Date(t0.getTime() + 48 * HOUR);
    await runCatchUp({ reason: "hourly", now: later, mailgun });
    const again = await notices();
    expect(again).toHaveLength(2);
    expect(again[1]!.body).toContain(`for the old domain ${OLDER} since ${formatShortDate(t0, OWNER_ZONE, later)}.`);
  });

  it("stops once the domain is checked fine again", async () => {
    await seedOldDomains([{ domain: OLDER, since: new Date(Date.now() - 2 * DAY) }]);
    await runCatchUp({ reason: "hourly", mailgun });
    expect((await state()).oldDomains).toBeUndefined();
    expect(await notices()).toEqual([]);
  });

  it("writes the date in the Owner's time zone", async () => {
    const now = new Date();
    // 02:00 UTC two days ago: the evening before in New York, the morning of that day in Karachi.
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2, 2, 0, 0));
    await seedOldDomains([{ domain: OLDER, since }]);
    failing.add(OLDER);
    await runCatchUp({ reason: "hourly", now, mailgun });
    const [note] = await notices();
    const newYork = formatShortDate(since, OWNER_ZONE, now);
    expect(newYork).not.toBe(formatShortDate(since, "Asia/Karachi", now));
    expect(note!.body).toContain(`since ${newYork}.`);
    expect((await state()).oldDomains).toEqual([
      { domain: OLDER, since: since.toISOString(), lastAt: now.toISOString(), text: problemText(OLDER) },
    ]);
  });
});

describe("the old-domain rules (pure)", () => {
  const now = new Date("2026-09-25T10:00:00.000Z");
  const earlier = new Date("2026-09-24T09:00:00.000Z");

  it("nextOldDomainProblems keeps since, drops gone and repeated domains, cuts the text, keeps the last 10", () => {
    const previous = [
      { domain: OLDER, since: earlier.toISOString(), lastAt: earlier.toISOString(), text: "old text" },
      { domain: STALE, since: earlier.toISOString(), lastAt: earlier.toISOString(), text: "x" },
    ];
    const long = "y".repeat(OLD_DOMAIN_TEXT_MAX + 50);
    expect(
      nextOldDomainProblems(
        previous,
        [
          { domain: OLDER, gone: false, text: "new text" },
          { domain: GONE, gone: true, text: "gone" },
          { domain: OLDEST, gone: false, text: long },
          { domain: OLDER, gone: false, text: "again" },
        ],
        now,
      ),
    ).toEqual([
      { domain: OLDER, since: earlier.toISOString(), lastAt: now.toISOString(), text: "new text" },
      { domain: OLDEST, since: now.toISOString(), lastAt: now.toISOString(), text: "y".repeat(OLD_DOMAIN_TEXT_MAX) },
    ]);
    expect(nextOldDomainProblems(undefined, [], now)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ domain: `d${i}.example.com`, gone: false, text: "t" }));
    const kept = nextOldDomainProblems(undefined, many, now);
    expect(kept).toHaveLength(OLD_DOMAIN_PROBLEMS_MAX);
    expect(kept.map((p) => p.domain)).toEqual(many.slice(2).map((p) => p.domain));
  });

  it("oldDomainNoticeDue picks the domain unchecked longest, from exactly 24 hours", () => {
    const entry = (domain: string, since: Date) => ({ domain, since: since.toISOString(), lastAt: now.toISOString(), text: "t" });
    expect(oldDomainNoticeDue(undefined, now)).toBeNull();
    expect(oldDomainNoticeDue([entry(OLDER, new Date(now.getTime() - 24 * HOUR + 1))], now)).toBeNull();
    expect(oldDomainNoticeDue([entry(OLDER, new Date(now.getTime() - 24 * HOUR))], now)?.domain).toBe(OLDER);
    expect(
      oldDomainNoticeDue([entry(OLDER, new Date(now.getTime() - 30 * HOUR)), entry(OLDEST, new Date(now.getTime() - 50 * HOUR))], now)?.domain,
    ).toBe(OLDEST);
    expect(oldDomainNoticeDue([{ domain: OLDER, since: "not a date", lastAt: "x", text: "t" }], now)).toBeNull();
  });

  it("oldDomainNoticeCopy is the design's notice", () => {
    expect(oldDomainNoticeCopy("mail.example.com", "25 Sep")).toEqual({
      title: "Couldn't check an old sending domain",
      body: "The app hasn't been able to check Mailgun's logs for the old domain mail.example.com since 25 Sep. Replies and bounces to its last emails may be missed. Check that the domain still exists in Mailgun and that the key works.",
      link: "/settings/sending",
    });
  });
});
