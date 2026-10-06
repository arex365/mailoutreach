import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * `loadDashboard` on a seeded database (M6-DESIGN §4.2–§4.7): the numbers of every tile, the attention items for the
 * Owner and a Member, "Get started" and the go-live states from the settings, a source that fails dropping only its
 * tile or item (with its `[dashboard] <key>: …` line), and the rule that the dashboard only reads: with
 * `getMailgunContext`, `dbWrite` and `dbTx` throwing it still loads everything and changes no row. The view it returns
 * is plain data (what the page hands to client components), and its warm-up line is the one `loadWarmupToday` gives.
 */

const flags = vi.hoisted(() => ({ fail: new Set<string>(), noWrites: false }));

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  const refuse = (name: string) => {
    if (flags.noWrites) throw new Error(`${name} was called while the dashboard loaded`);
  };
  return {
    ...actual,
    dbWrite: ((...args: Parameters<typeof actual.dbWrite>) => {
      refuse("dbWrite");
      return actual.dbWrite(...args);
    }) as typeof actual.dbWrite,
    dbTx: ((...args: Parameters<typeof actual.dbTx>) => {
      refuse("dbTx");
      return actual.dbTx(...args);
    }) as typeof actual.dbTx,
  };
});
vi.mock("@/server/mailgun/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/mailgun/context")>();
  return {
    ...actual,
    getMailgunContext: vi.fn(async () => {
      throw new Error("the dashboard must never call getMailgunContext");
    }),
  };
});
vi.mock("@/server/services/dashboard/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/dashboard/pipeline")>();
  return {
    ...actual,
    loadPipeline: async (now: Date) => {
      if (flags.fail.has("pipeline")) throw new Error("the pipeline counts broke");
      return actual.loadPipeline(now);
    },
  };
});
vi.mock("@/server/services/ai/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/ai/queue")>();
  return {
    ...actual,
    aiQueueCounts: async () => {
      if (flags.fail.has("ai")) throw new Error("the AI queue broke");
      return actual.aiQueueCounts();
    },
  };
});
vi.mock("@/server/services/backups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/backups")>();
  return {
    ...actual,
    backupStatus: async (...args: Parameters<typeof actual.backupStatus>) => {
      if (flags.fail.has("backups")) throw new Error("the backups folder can't be read");
      return actual.backupStatus(...args);
    },
  };
});
vi.mock("@/server/services/replies/waiting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/replies/waiting")>();
  return {
    ...actual,
    listWaitingReplies: async (...args: Parameters<typeof actual.listWaitingReplies>) => {
      if (flags.fail.has("replies")) throw new Error("the replies list broke");
      return actual.listWaitingReplies(...args);
    },
  };
});

const t = await createTestDb("dashboard-load");
const { db, dbWrite } = await import("@/server/db");
const { loadDashboard } = await import("@/app/(app)/dashboard/load");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { makeUser, makeCompany, makePerson, makeCampaign, enroll, makeInbound } = await import("../stops-holds/world");
const { setSetting, setState } = await import("../mail-events/seed");

// Wednesday 23 Sep 2026, 15:00 in Karachi (the viewers' zone and the cap-day zone).
const NOW = new Date("2026-09-23T10:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;
const at = (ms: number) => new Date(NOW.getTime() - ms);

type Viewer = Parameters<typeof loadDashboard>[0];
let arslan: Viewer;
let ali: Viewer;
let germanyId: number;
let spainId: number;
let italyId: number;
let franceId: number;

const withoutDisk = (keys: string[]) => keys.filter((k) => k !== "disk-low");

afterEach(() => {
  flags.fail.clear();
  flags.noWrites = false;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeAll(async () => {
  const owner = await makeUser("Arslan", { role: "OWNER", email: "arslan@example.com", timeZone: "Asia/Karachi" });
  const member = await makeUser("Ali", { email: "ali@example.com", timeZone: "Asia/Karachi" });
  const gone = await makeUser("Bo", { email: "bo@example.com", active: false });
  arslan = { id: owner.id, email: owner.email, name: owner.name, role: "OWNER", timeZone: "Asia/Karachi", sessionId: 1 };
  ali = { id: member.id, email: member.email, name: member.name, role: "MEMBER", timeZone: "Asia/Karachi", sessionId: 2 };

  // Real data, live on send.example.com since 20 Sep; Mailgun set up (a key row; the dashboard never decrypts it).
  await setSetting("practice.copy", false);
  await setSetting("sending.capDayTimeZone", "Asia/Karachi");
  await setSetting("mailgun.domain", "send.example.com");
  await setSetting("sending.goLive", true);
  await setSetting("sending.goLiveAt", "2026-09-20T09:05:00.000Z");
  await setSetting("sending.goLiveDomain", "send.example.com");
  await dbWrite((c) => c.secret.create({ data: { key: "mailgun.apiKey", ciphertext: "not-decryptable", last4: "abcd" } }));
  // The background sender checked in 10 seconds ago.
  await dbWrite((c) => c.workerLease.create({ data: { id: 1, workerId: "test", heartbeatAt: at(10_000), startedAt: at(H) } }));
  // The Domain checklist, checked for this domain: DMARC is "bad".
  await setState("domain.check", {
    domain: "send.example.com",
    region: "EU",
    checkedAt: at(30 * 60_000).toISOString(),
    lastVerifyAt: null,
    error: null,
    rows: [
      { key: "spf", group: "dns", status: "ok", title: "Mailgun may send for your domain (SPF)", text: "Found.", fix: null, records: [], detail: null },
      { key: "dmarc", group: "dns", status: "bad", title: "DMARC policy", text: "Missing.", fix: null, records: [], detail: null },
    ],
  });

  // Companies: 3 not contacted (one without an email), 2 contacted, 1 replied; a deleted one counts nowhere.
  const figuren = await makeCompany("Figuren Werkstatt");
  const butikk = await makeCompany("Butikk AS");
  const grid = await makeCompany("Grid Shop");
  const parked = await makeCompany("Parked Co");
  await makeCompany("No Email Studio");
  const tests = await makeCompany("Test mailboxes");
  const deleted = await makeCompany("Deleted Co");
  await dbWrite(async (c) => {
    await c.company.update({ where: { id: butikk.id }, data: { status: "CONTACTED", firstContactedAt: at(40 * D) } });
    await c.company.update({ where: { id: grid.id }, data: { status: "CONTACTED", firstContactedAt: at(5 * D) } });
    await c.company.update({ where: { id: parked.id }, data: { status: "REPLIED", firstContactedAt: at(5 * D), repliedAt: at(D) } });
    await c.company.update({ where: { id: deleted.id }, data: { status: "CONTACTED", firstContactedAt: at(5 * D), deletedAt: at(D) } });
  });
  const anna = await makePerson(figuren.id, "anna@figuren.example");
  const ola = await makePerson(butikk.id, "ola@butikk.example");
  const info = await makePerson(grid.id, "info@grid.example");
  const pat = await makePerson(parked.id, "pat@parked.example");
  const tess = await makePerson(tests.id, "tess@test-mailbox.example");

  // Campaigns: Germany Q4 (live, Ali) and Spain (dry run, Arslan) running, Italy scheduled, France paused.
  const germany = await makeCampaign({ createdById: owner.id, senderId: member.id, mode: "LIVE", name: "Germany Q4" });
  const spain = await makeCampaign({ createdById: owner.id, senderId: owner.id, mode: "DRY_RUN", name: "Spain" });
  const italy = await makeCampaign({ createdById: owner.id, senderId: owner.id, mode: "LIVE", status: "SCHEDULED", name: "Italy" });
  const france = await makeCampaign({ createdById: owner.id, senderId: member.id, mode: "LIVE", status: "PAUSED", name: "France" });
  const testRun = await makeCampaign({ createdById: owner.id, mode: "LIVE", status: "FINISHED", name: "Test run" });
  await makeCampaign({ createdById: owner.id, mode: "LIVE", status: "FINISHED", name: "Old" });
  germanyId = germany.id;
  spainId = spain.id;
  italyId = italy.id;
  franceId = france.id;
  await dbWrite(async (c) => {
    await c.campaign.update({ where: { id: germany.id }, data: { launchedAt: at(5 * D), launchedGoLive: true } });
    await c.campaign.update({ where: { id: spain.id }, data: { launchedAt: at(D), launchedGoLive: true } });
    await c.campaign.update({ where: { id: italy.id }, data: { launchedAt: null, startAt: new Date(NOW.getTime() + D) } });
    await c.campaign.update({ where: { id: france.id }, data: { pausedAt: at(2 * D), pauseReason: "Paused by Arslan" } });
    await c.campaign.update({ where: { id: testRun.id }, data: { launchedGoLive: false } });
  });
  // Germany Q4: two live sends today (ola's bounced) and one email the app isn't sure about.
  await enroll(germany, anna, { sent: [{ step: 0, sentAt: at(H) }] });
  const olaSent = await enroll(germany, ola, { sent: [{ step: 0, sentAt: at(2 * H) }] });
  const unsure = await enroll(germany, info, { first: true });
  await dbWrite((c) => c.outboundEmail.update({ where: { id: unsure.queuedId! }, data: { status: "UNCONFIRMED", claimedAt: at(30 * 60_000) } }));
  // Spain: two dry-run emails in the outbox today.
  await enroll(spain, pat, { sent: [{ step: 0, sentAt: at(3 * H) }] });
  await enroll(spain, anna, { sent: [{ step: 0, sentAt: at(4 * H) }] });
  // A rehearsal send before go-live that bounced: health counts from go-live (G12), so it isn't counted.
  const rehearsal = await enroll(testRun, tess, { sent: [{ step: 0, sentAt: new Date("2026-09-19T08:00:00.000Z") }], queuedStep: null, reserve: false });
  await dbWrite(async (c) => {
    for (const [n, emailId] of [olaSent.sentIds[0]!, rehearsal.sentIds[0]!].entries()) {
      await c.mailEvent.create({
        data: { dedupeKey: `bounce-${n}`, type: "failed", severity: "permanent", occurredAt: at(H), outboundEmailId: emailId, source: "WEBHOOK", raw: {} },
      });
    }
  });

  // Replies waiting: Arslan 2 (one answered already), Ali 1 plus a dry-run reply; Bo is switched off.
  await makeInbound({ kind: "REPLY", assigneeId: owner.id, receivedAt: at(3 * H) });
  await makeInbound({ kind: "POSSIBLE_REPLY", assigneeId: owner.id, receivedAt: at(2 * H) });
  await makeInbound({ kind: "REPLY", assigneeId: owner.id, answeredAt: at(H), answerOutcome: "answered" });
  await makeInbound({ kind: "REPLY", assigneeId: member.id, receivedAt: at(5 * H) });
  await makeInbound({ kind: "REPLY", assigneeId: member.id, replyScope: "campaign", receivedAt: at(H) });
  await makeInbound({ kind: "REPLY", assigneeId: gone.id });

  // Two AI lines to review.
  await dbWrite(async (c) => {
    for (const companyId of [figuren.id, butikk.id]) {
      await c.aiDraft.create({ data: { companyId, model: "claude-haiku-4-5", promptVersion: "v1", status: "READY", line: "Your figures look great." } });
    }
  });

  // Team activity: two changes, newer per-email rows (never shown) and one older than 30 days.
  await dbWrite(async (c) => {
    await c.activityLog.create({
      data: { at: at(12 * 60_000), actorId: member.id, type: "company.status", summary: "Ali set status to Client", companyId: figuren.id },
    });
    await c.activityLog.create({ data: { at: at(H), actorId: owner.id, type: "campaign.launched", summary: "Arslan launched Spain", mode: "DRY_RUN", campaignId: spain.id } });
    await c.activityLog.create({ data: { at: at(31 * D), actorId: owner.id, type: "company.created", summary: "Arslan added Old Co" } });
    for (let i = 0; i < 20; i++) {
      await c.activityLog.create({ data: { at: at(60_000 - i), type: "email.sent", summary: "Email sent", mode: "LIVE" } });
    }
  });
});

describe("loadDashboard: the numbers (§4.3)", () => {
  it("fills every tile for the Owner", async () => {
    const v = await loadDashboard(arslan, NOW);

    expect(v.practiceCopy).toBe(false);
    expect(v.goLive).toEqual({ live: true, at: "2026-09-20T09:05:00.000Z", domain: "send.example.com", endedOnDomain: null });
    expect(v.getStarted).toBeNull();

    expect(v.pipeline).toEqual({
      counts: { all: 6, byStatus: { NOT_CONTACTED: 3, CONTACTED: 2, REPLIED: 1, CLIENT: 0, NOT_INTERESTED: 0, DO_NOT_CONTACT: 0 } },
      replyRate: { replied: 1, emailed: 3, last30: { replied: 1, emailed: 2 } },
    });

    // Two live sends and the unconfirmed one count today; dry runs don't (real data).
    expect(v.today).toEqual({
      used: 3,
      cap: 50,
      percent: 6,
      lines: ["Warm-up step 1 of 20: 50 a day. It goes up to 59 after a weekday with at least half the limit used and healthy numbers."],
      notConfigured: null,
    });

    expect(v.health?.empty).toBeNull();
    expect(v.health?.bounce).toMatchObject({ label: "Bounces toward the automatic pause", count: 1 });
    expect(v.health?.bounce.line).toMatch(/^1 of the last 2 emails bounced/);
    expect(v.health?.complaint.count).toBe(0);
    expect(v.health?.sinceNote).toMatch(/^Counting since you went live on 20 Sept?\.$/);

    // Running first (newest launch first), then scheduled; mode and sender for each.
    expect(v.campaigns?.items.map((c) => [c.id, c.name, c.senderName, c.modeLabel, c.status])).toEqual([
      [spainId, "Spain", "Arslan", "Dry run", "RUNNING"],
      [germanyId, "Germany Q4", "Ali", "Live", "RUNNING"],
      [italyId, "Italy", "Arslan", "Live", "SCHEDULED"],
    ]);
    expect(v.campaigns?.more).toBe(0);
    expect(v.campaigns?.moreHref).toBe("/campaigns");
    expect(v.campaigns?.items[1]?.progressText).toBe("First email 2 of 3 sent · 2 follow-ups");
    expect(v.campaigns?.items[1]?.percent).toEqual(expect.any(Number));

    // Each row with the company it is about (review DASHBOARD-3).
    expect(v.activity?.map((a) => [a.summary, a.actorName, a.mode, a.company?.name ?? null, a.group])).toEqual([
      ["Ali set status to Client", "Ali", null, "Figuren Werkstatt", null],
      ["Arslan launched Spain", "Arslan", "DRY_RUN", null, null],
    ]);

    expect(v.dryRun).toEqual({
      today: { dryRun: 2, testMode: 0 },
      running: { dryRun: 1, testMode: 0 },
      waitingReplies: 1,
      lines: ["Dry run today: 2 emails in the outbox · 1 campaign running", "Dry-run replies waiting: 1"],
    });

    // The viewer's own waiting replies, oldest first.
    expect(v.replies?.total).toBe(2);
    expect(v.replies?.rows.map((r) => r.kind)).toEqual(["REPLY", "POSSIBLE_REPLY"]);
  });

  it("gives the Owner and a Member their attention items", async () => {
    const owner = await loadDashboard(arslan, NOW);
    expect(withoutDisk(owner.attention.map((i) => i.key))).toEqual([
      "replies-waiting",
      "ai-lines",
      "paused-campaigns",
      "unconfirmed",
      "missing-emails",
      "backup-never",
      "second-folder-missing",
      "checklist",
    ]);
    expect(owner.attentionMore).toBe(0);
    const text = (key: string) => owner.attention.find((i) => i.key === key);
    expect(text("replies-waiting")?.text).toBe("Replies waiting for an answer: You 2 · Ali 1");
    expect(text("ai-lines")?.text).toBe("2 AI lines to review");
    expect(text("paused-campaigns")).toMatchObject({ text: "“France” is paused.", link: { href: `/campaigns/${franceId}`, label: "Open" } });
    expect(text("paused-campaigns")?.detail).toMatch(/^Paused by Arslan on 21 Sept? 2026, 15:00\. Nothing is sent until you resume it\.$/);
    expect(text("unconfirmed")).toMatchObject({
      text: "1 email needs a decision: the app isn't sure it was sent. Choose Retry or Skip.",
      link: { href: `/campaigns/${germanyId}` },
    });
    expect(text("missing-emails")?.text).toBe("1 company has no email address.");
    expect(text("checklist")).toMatchObject({ text: "Something on the Domain checklist needs fixing: DMARC policy.", link: { href: "/settings/domain" } });

    const member = await loadDashboard(ali, NOW);
    expect(withoutDisk(member.attention.map((i) => i.key))).toEqual([
      "replies-waiting",
      "ai-lines",
      "paused-campaigns",
      "unconfirmed",
      "missing-emails",
      "backup-never",
      "checklist",
    ]);
    expect(member.attention.find((i) => i.key === "replies-waiting")?.text).toBe("Replies waiting for an answer: You 1 · Arslan 2");
    expect(member.attention.find((i) => i.key === "checklist")).toMatchObject({ link: null, note: "Ask the Owner to fix this." });
    // Ali's own list includes his dry-run reply (listed, not counted in the line); a Member with companies gets no
    // Get started card.
    expect(member.replies?.total).toBe(2);
    expect(member.replies?.rows).toHaveLength(2);
    expect(member.getStarted).toBeNull();
  });
});

describe("loadDashboard: go-live states from the settings", () => {
  afterEach(async () => {
    await setSetting("sending.goLive", true);
    await setSetting("mailgun.domain", "send.example.com");
    await setSetting("practice.copy", false);
  });

  it("before go-live: the Owner's Get started, the Today lines, no after-go-live items", async () => {
    await setSetting("sending.goLive", false);
    const v = await loadDashboard(arslan, NOW);
    expect(v.goLive).toEqual({ live: false, at: null, domain: "send.example.com", endedOnDomain: null });
    // Ali is an active teammate and Mailgun is set up; no second folder yet, so that step is next.
    expect(v.getStarted?.steps.map((s) => [s.key, s.done, s.primary])).toEqual([
      ["import", true, false],
      ["team", true, false],
      ["mailgun", true, false],
      ["protect", false, true],
      ["go-live", false, false],
    ]);
    expect(v.today?.lines).toEqual(["Warm-up starts when you go live.", "Until then, real email only reaches your test list."]);
    expect(v.attention.map((i) => i.key)).not.toContain("second-folder-missing");
    expect(v.attention.map((i) => i.key)).not.toContain("checklist");
  });

  it("after a domain change ended go-live: go-live-again, and Get started is back", async () => {
    await setSetting("sending.goLive", false);
    await setSetting("mailgun.domain", "send2.example.com");
    const v = await loadDashboard(arslan, NOW);
    expect(v.goLive).toEqual({ live: false, at: null, domain: "send2.example.com", endedOnDomain: "send.example.com" });
    expect(v.attention.find((i) => i.key === "go-live-again")?.text).toBe(
      "You changed the sending domain to send2.example.com. Live campaigns only reach your test list until you go live on it.",
    );
    expect(v.getStarted).not.toBeNull();
    const member = await loadDashboard(ali, NOW);
    expect(member.attention.find((i) => i.key === "go-live-again")?.text).toBe(
      "Live campaigns only reach the test list until the Owner goes live on send2.example.com.",
    );
  });

  it("after a From address change ended go-live: go-live-again for the Owner and a Member (SHARED-FROM-DESIGN §3.8)", async () => {
    await setSetting("sending.goLive", false);
    await setSetting("mailgun.fromAddress", "contact@example.com");
    try {
      const v = await loadDashboard(arslan, NOW);
      // Same domain: no domain change, and the view keeps its shape.
      expect(v.goLive).toEqual({ live: false, at: null, domain: "send.example.com", endedOnDomain: null });
      expect(v.attention.filter((i) => i.key === "go-live-again")).toEqual([
        {
          key: "go-live-again",
          tone: "warning",
          text: "You changed the From address. Live campaigns only reach your test list until you run the reply test and go live again.",
          detail: null,
          link: { href: "/settings/sending#go-live", label: "Open Go live" },
          note: null,
        },
      ]);
      const member = await loadDashboard(ali, NOW);
      expect(member.attention.find((i) => i.key === "go-live-again")).toMatchObject({
        text: "Live campaigns only reach the test list until the Owner goes live again with the new From address.",
        link: null,
      });
      // Gone live with that From address: nothing left to do.
      await setSetting("sending.goLiveFrom", "contact@example.com");
      expect((await loadDashboard(arslan, NOW)).attention.map((i) => i.key)).not.toContain("go-live-again");
      // A saved From address that doesn't fit the sending domain is per-person mode: a change from contact@ still shows.
      await setSetting("mailgun.fromAddress", "contact@other.example.org");
      expect((await loadDashboard(arslan, NOW)).attention.map((i) => i.key)).toContain("go-live-again");
    } finally {
      await dbWrite((c) => c.setting.deleteMany({ where: { key: { in: ["mailgun.fromAddress", "sending.goLiveFrom"] } } }));
    }
    // Per-person mode throughout (the From address was never set when going live): nothing.
    await setSetting("sending.goLive", false);
    expect((await loadDashboard(arslan, NOW)).attention.map((i) => i.key)).not.toContain("go-live-again");
  });

  it("live in shared-From mode: a bad from-mx row counts on the checklist item (SHARED-FROM-DESIGN §3.8)", async () => {
    const original = (await db.systemState.findUniqueOrThrow({ where: { key: "domain.check" } })).value as { rows: unknown[] };
    const fromMx = {
      key: "from-mx",
      group: "dns",
      status: "bad",
      title: "Mail for example.com stays with your mail provider (MX)",
      text: "example.com's mail servers (MX) point to Mailgun.",
      fix: null,
      records: [],
      detail: null,
    };
    await setState("domain.check", { ...original, rows: [...original.rows, fromMx] });
    try {
      // Per-person mode: the row isn't a go-live row.
      expect((await loadDashboard(arslan, NOW)).attention.find((i) => i.key === "checklist")?.text).toBe(
        "Something on the Domain checklist needs fixing: DMARC policy.",
      );
      await setSetting("mailgun.fromAddress", "contact@example.com");
      await setSetting("sending.goLiveFrom", "contact@example.com");
      const v = await loadDashboard(arslan, NOW);
      expect(v.attention.find((i) => i.key === "checklist")?.text).toBe("Something on the Domain checklist needs fixing: DMARC policy and 1 more.");
      expect(v.attention.map((i) => i.key)).not.toContain("go-live-again");
    } finally {
      await dbWrite((c) => c.setting.deleteMany({ where: { key: { in: ["mailgun.fromAddress", "sending.goLiveFrom"] } } }));
      await setState("domain.check", original);
    }
  });

  it("the practice copy: no dry-run tile, never live, the warm-up line", async () => {
    await setSetting("practice.copy", true);
    const v = await loadDashboard(arslan, NOW);
    expect(v.practiceCopy).toBe(true);
    expect(v.goLive.live).toBe(false);
    expect(v.dryRun).toBeNull();
    expect(v.getStarted).toBeNull();
    // Dry runs count like live here: 2 live + 1 unconfirmed + 2 dry runs today.
    expect(v.today?.used).toBe(5);
    expect(v.today?.notConfigured).toBeNull();
    expect(v.today?.lines.at(-1)).toMatch(/^Warm-up step 1 of 20: 50 a day\./);
    const keys = v.attention.map((i) => i.key);
    for (const k of ["second-folder-missing", "checklist", "go-live-again", "mailgun-check"]) expect(keys).not.toContain(k);
  });

  it("remote access: a failing public address check raises tunnel-down", async () => {
    const before = process.env.APP_PUBLIC_URL;
    process.env.APP_PUBLIC_URL = "http://127.0.0.1:3999";
    try {
      await setState("tunnel.status", {
        checkedAt: at(5 * 60_000).toISOString(),
        state: "connected",
        readyConnections: 4,
        port: 20241,
        connectorId: null,
        version: null,
        versionWarning: null,
        downSince: null,
        notifiedAt: null,
        publicCheck: { at: at(5 * 60_000).toISOString(), ok: false, status: null, error: "timeout" },
        webhookPathCheck: null,
        appProtectedCheck: null,
        selfCheckNonce: null,
      });
      const v = await loadDashboard(arslan, NOW);
      expect(v.attention.find((i) => i.key === "tunnel-down")).toMatchObject({
        text: "Remote access is down: remote staff and Mailgun can't reach the app. Check the office PC's internet connection, then run status.bat.",
        link: { href: "/settings/system", label: "Open System" },
      });
    } finally {
      process.env.APP_PUBLIC_URL = before;
      await setState("tunnel.status", null);
    }
  });
});

describe("loadDashboard: review fixes", () => {
  it("Domain health after a resume with nothing sent since says since when (review DASHBOARD-6)", async () => {
    // Resumed from a health pause at NOW: every send so far is older, so nothing counts yet.
    await setState("health.baseline", { since: NOW.toISOString(), resumedById: null, acknowledged: null, warnedBounceAt: null, warnedComplaintAt: null });
    try {
      const v = await loadDashboard(arslan, NOW);
      expect(v.health?.sinceNote).toMatch(/^Counting since you resumed on 23 Sept?\.$/);
      expect(v.health?.empty).toMatch(/^Nothing sent since you resumed on 23 Sept?, so there's nothing to measure yet\.$/);
    } finally {
      await setState("health.baseline", null);
    }
  });

  it("mailgun-check shows when the check never succeeded and has failed for days, whatever the last retry (review DASHBOARD-1)", async () => {
    await setState("mailgun.catchUp", {
      lastStartedAt: at(15 * 60_000).toISOString(),
      lastFinishedAt: at(14 * 60_000).toISOString(),
      lastSuccessAt: null,
      lastError: "Mailgun had a problem on its side.",
      lastErrorKind: "server",
      lastReason: "hourly",
      lastSummary: null,
      failingSince: at(2 * D).toISOString(),
    });
    try {
      const owner = await loadDashboard(arslan, NOW);
      expect(owner.attention.find((i) => i.key === "mailgun-check")).toMatchObject({
        text: "The app hasn't been able to check Mailgun yet. Bounces and unsubscribes may be late.",
        link: { href: "/settings/sending" },
      });
      // Failing for less than 2 hours: nothing yet.
      await setState("mailgun.catchUp", {
        lastStartedAt: at(15 * 60_000).toISOString(),
        lastFinishedAt: at(14 * 60_000).toISOString(),
        lastSuccessAt: null,
        lastError: "Mailgun had a problem on its side.",
        lastErrorKind: "server",
        lastReason: "hourly",
        lastSummary: null,
        failingSince: at(H).toISOString(),
      });
      expect((await loadDashboard(arslan, NOW)).attention.map((i) => i.key)).not.toContain("mailgun-check");
    } finally {
      await setState("mailgun.catchUp", null);
    }
  });

  it("'+ N more' in Active campaigns leads to the tab the rest are on (review DASHBOARD-7)", async () => {
    const extra: number[] = [];
    try {
      // 2 more running campaigns: 4 running and 1 scheduled fill the 5, nothing left over.
      for (let i = 0; i < 2; i++) extra.push((await makeCampaign({ createdById: arslan.id, mode: "LIVE", name: `Running ${i}` })).id);
      const five = await loadDashboard(arslan, NOW);
      expect(five.campaigns?.items.map((c) => c.status)).toEqual(["RUNNING", "RUNNING", "RUNNING", "RUNNING", "SCHEDULED"]);
      expect(five.campaigns).toMatchObject({ more: 0 });
      // 1 more running: 5 running shown; 1 scheduled left over.
      extra.push((await makeCampaign({ createdById: arslan.id, mode: "LIVE", name: "Running 2" })).id);
      const scheduledLeft = await loadDashboard(arslan, NOW);
      expect(scheduledLeft.campaigns).toMatchObject({ more: 1, moreHref: "/campaigns?tab=scheduled" });
      // 1 more running: 1 running and 1 scheduled left over.
      extra.push((await makeCampaign({ createdById: arslan.id, mode: "LIVE", name: "Running 3" })).id);
      expect((await loadDashboard(arslan, NOW)).campaigns).toMatchObject({ more: 2, moreHref: "/campaigns" });
      // Italy finished: only running ones left over.
      await dbWrite((c) => c.campaign.update({ where: { id: italyId }, data: { status: "FINISHED" } }));
      expect((await loadDashboard(arslan, NOW)).campaigns).toMatchObject({ more: 1, moreHref: "/campaigns?tab=running" });
    } finally {
      await dbWrite(async (c) => {
        await c.campaign.updateMany({ where: { id: { in: extra } }, data: { status: "FINISHED" } });
        await c.campaign.update({ where: { id: italyId }, data: { status: "SCHEDULED" } });
      });
    }
  });
});

describe("loadDashboard: failures and the read-only rule (§0.2 rule 8, §4.6)", () => {
  it("a source that throws drops only its own tile or item, and says which", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    flags.fail = new Set(["pipeline", "ai", "backups", "replies"]);
    const v = await loadDashboard(arslan, NOW);
    expect(v.pipeline).toBeNull();
    expect(v.replies).toBeNull();
    expect(withoutDisk(v.attention.map((i) => i.key))).toEqual([
      "replies-waiting",
      "paused-campaigns",
      "unconfirmed",
      "missing-emails",
      "second-folder-missing",
      "checklist",
    ]);
    expect(v.attention.map((i) => i.key)).not.toContain("disk-low");
    // Everything else still loaded.
    expect(v.today).not.toBeNull();
    expect(v.health).not.toBeNull();
    expect(v.campaigns).not.toBeNull();
    expect(v.activity).not.toBeNull();
    expect(v.dryRun).not.toBeNull();
    const lines = errors.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual(
      expect.arrayContaining([
        "[dashboard] pipeline: the pipeline counts broke",
        "[dashboard] ai-lines: the AI queue broke",
        "[dashboard] backups: the backups folder can't be read",
        "[dashboard] replies: the replies list broke",
      ]),
    );
    expect(lines).toHaveLength(4);
  });

  it("never writes and never asks Mailgun: loads fully with getMailgunContext, dbWrite and dbTx throwing", async () => {
    const snapshot = async () => ({
      settings: await db.setting.findMany({ orderBy: { key: "asc" }, select: { key: true, value: true, updatedAt: true } }),
      state: await db.systemState.findMany({ orderBy: { key: "asc" }, select: { key: true, version: true } }),
      secrets: await db.secret.findMany({ orderBy: { key: "asc" }, select: { key: true, updatedAt: true } }),
      domains: await db.sendingDomain.count(),
      lease: await db.workerLease.findMany(),
      notifications: await db.notification.count(),
      activity: await db.activityLog.count(),
    });
    const before = await snapshot();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    flags.noWrites = true;
    const owner = await loadDashboard(arslan, NOW);
    const member = await loadDashboard(ali, NOW);
    flags.noWrites = false;
    expect(errors).not.toHaveBeenCalled();
    expect(getMailgunContext).not.toHaveBeenCalled();
    for (const v of [owner, member]) {
      for (const tile of [v.replies, v.pipeline, v.today, v.health, v.campaigns, v.activity]) expect(tile).not.toBeNull();
    }
    expect(await snapshot()).toEqual(before);
  });

  it("returns plain data only: strings, numbers, booleans, arrays and null", async () => {
    const v = await loadDashboard(arslan, NOW);
    const bad: string[] = [];
    const walk = (value: unknown, where: string) => {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
      if (Array.isArray(value)) return value.forEach((x, i) => walk(x, `${where}[${i}]`));
      if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        for (const [k, x] of Object.entries(value as Record<string, unknown>)) walk(x, `${where}.${k}`);
        return;
      }
      bad.push(`${where}: ${Object.prototype.toString.call(value)}`);
    };
    walk(v, "view");
    expect(bad).toEqual([]);
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    // The health tile has the numbers, never the ids of the emails behind them.
    expect(JSON.stringify(v.health)).not.toMatch(/EmailIds|emailId/);
  });
});

describe("loadDashboard: the warm-up line (§2.6)", () => {
  it("words the warm-up line exactly as loadWarmupToday would (one health count instead of two)", async () => {
    const { loadWarmupProgress } = await import("@/server/services/sending/warmup-days");
    const { warmupLine } = await import("@/core/sending/warmup-line");
    const p2Line = async () => {
      const p = await loadWarmupProgress(NOW);
      return warmupLine(p.step, p.table, p.today);
    };
    // 3 of 50 used so far: the "goes up" form.
    const before = await loadDashboard(arslan, NOW);
    expect(before.today?.lines.at(-1)).toBe(await p2Line());
    expect(before.today?.lines.at(-1)).toContain("It goes up to 59 after a weekday");

    // 30 more live sends today (healthy: 1 bounce in a window of 200): today qualifies so far, "Tomorrow 59".
    const germany = { id: germanyId, mode: "LIVE" as const, senderId: ali.id };
    for (let i = 0; i < 30; i++) {
      const company = await makeCompany(`Extra ${i}`);
      const person = await makePerson(company.id, `extra${i}@extra.example`);
      await enroll(germany, person, { sent: [{ step: 0, sentAt: at(20 * 60_000) }], queuedStep: null, reserve: false });
    }
    const after = await loadDashboard(arslan, NOW);
    expect(after.today?.used).toBe(33);
    expect(after.today?.lines.at(-1)).toBe(await p2Line());
    expect(after.today?.lines.at(-1)).toBe("Warm-up step 1 of 20: 50 a day. Tomorrow 59, if today's numbers stay healthy.");

    // The Owner's own rule (review SCREENS-10): 80 % and Monday to Saturday; 33 of 50 no longer qualifies.
    await setSetting("warmup.minUsePercent", 80);
    await setSetting("sending.window", { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00" });
    try {
      const ruled = await loadDashboard(arslan, NOW);
      expect(ruled.today?.lines.at(-1)).toBe(await p2Line());
      expect(ruled.today?.lines.at(-1)).toBe(
        "Warm-up step 1 of 20: 50 a day. It goes up to 59 after a sending day with at least 80% of the limit used and healthy numbers.",
      );
    } finally {
      await setSetting("warmup.minUsePercent", 50);
      await setSetting("sending.window", { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" });
    }
  });
});
