import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, makeList, saveTestAnthropicKey, seedSessionUsers, type TestUser } from "./seed";

/**
 * The "Draft personal lines" dialog's server side (docs/dev/M5-DESIGN.md §6.8, §6.11, §8 P9): the counts and skip
 * reasons, the cost and month lines, over the monthly limit, no key (the Owner's and a Member's words), too many, the
 * company panel's one company, a list, the practice copy, and the start (the confirmed "at most" is only used to refuse
 * a cost that grew; the job carries the server's own estimate).
 */

const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
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

const t = await createTestDb("ai-screens-start");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { deleteSecret } = await import("@/server/secrets");
const { STATE_KEYS } = await import("@/core/system-state");
const { monthBounds } = await import("@/core/time/month");
const { pauseAi } = await import("@/server/services/ai/pause");
const { estimateDraftLinesAction, startDraftLinesAction } = await import("@/app/(app)/contacts/ai-actions");
const { draftDialogTexts } = await import("@/components/ai/draft-lines-text");

let owner: TestUser;
let ali: TestUser;

beforeAll(async () => {
  ({ owner, ali } = await seedSessionUsers());
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  auth.user = null;
  await dbWrite(async (c) => {
    await c.aiDraft.deleteMany({});
    await c.job.deleteMany({});
    await c.activityLog.deleteMany({});
    await c.notification.deleteMany({});
    await c.companyList.deleteMany({});
    await c.list.deleteMany({});
    await c.company.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { in: [STATE_KEYS.aiPause, STATE_KEYS.notices] } } });
  });
  await setSetting("practice.copy", false, owner.id);
  await setSetting("ai.monthlyLimitUsd", 20, owner.id);
  await saveTestAnthropicKey(owner.id);
});

/** Seven companies: two draftable, then one for each skip reason. */
async function mixedCompanies() {
  const a = await makeCompany({ name: "Figuren Werkstatt", website: "https://figuren.example" });
  const b = await makeCompany({ name: "Butikk AS", website: "https://butikk.example" });
  const noSite = await makeCompany({ name: "Offline GmbH" });
  const insta = await makeCompany({ name: "Insta Creator", instagram: "insta.creator" });
  const withLine = await makeCompany({ name: "Line GmbH", website: "https://line.example", personalLine: "Your busts are hand-painted." });
  const waiting = await makeCompany({ name: "Waiting AB", website: "https://waiting.example" });
  await makeDraft({ companyId: waiting, status: "READY", line: "A line." });
  const deleted = await makeCompany({ name: "Deleted Co", website: "https://deleted.example", deletedAt: new Date() });
  return { a, b, noSite, insta, withLine, waiting, deleted, all: [a, b, noSite, insta, withLine, waiting, deleted] };
}

async function factsOf(input: Parameters<typeof estimateDraftLinesAction>[0], redraft = false) {
  const res = await estimateDraftLinesAction(input, { redraft });
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

describe("the dialog's facts and words", () => {
  it("counts, skip lines, the redraft checkbox, cost with Haiku's defaults and this month's spend", async () => {
    const c = await mixedCompanies();
    auth.user = owner;
    const f = await factsOf({ companyIds: c.all });
    expect(f).toMatchObject({
      single: false,
      companies: 7,
      toDraft: 2,
      skipped: { deleted: 1, noWebsite: 1, socialOnly: 1, hasLine: 1, waiting: 1 },
      redraftable: 1,
      blocker: null,
      isOwner: true,
      hasKey: true,
    });
    // (1,400 + 2,500) × $1 + 200 × $5 per million, +15 %: $0.005635 per company; at most $0.0105.
    expect(f.estimate.aboutUsd).toBeCloseTo(0.01127, 6);
    expect(f.estimate.atMostUsd).toBeCloseTo(0.021, 6);
    const words = draftDialogTexts(f);
    expect(words.countLine).toBe("2 companies will be drafted.");
    expect(words.skipLines).toEqual([
      "1 was deleted",
      "1 has no website",
      "1 only has an Instagram or other social link",
      "1 already has a line being drafted or waiting for review",
    ]);
    expect(words.hasLineLine).toBe("1 already has a personal line");
    expect(words.redraftLabel).toBe("Draft new lines for these too (1)");
    expect(words.costLine).toBe("About $0.01, at most $0.02 with Claude Haiku 4.5.");
    expect(words.monthLine).toBe("This month: $0 of your $20 limit used.");
    expect(words.buttonLabel).toBe("Draft 2 lines");

    const redraft = await factsOf({ companyIds: c.all }, true);
    expect(redraft.toDraft).toBe(3);
    expect(redraft.redraft).toBe(true);
    expect(draftDialogTexts(redraft).redraftLabel).toBe("Draft new lines for these too (1)");
  });

  it("over the monthly limit: the A6 sentence refuses, the start button stays off", async () => {
    const c = await mixedCompanies();
    await makeDraft({ companyId: c.a, status: "APPROVED", calls: 1, costUsd: 20.5, draftedAt: new Date() });
    auth.user = ali;
    const f = await factsOf({ companyIds: [c.b] });
    const reset = monthBounds(new Date(), "Asia/Karachi").resetLabel;
    expect(f.estimate.overLimit).toBe(true);
    expect(f.blocker).toBe(`AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until ${reset}.`);
    expect(draftDialogTexts(f).monthLine).toBe("This month: $20.50 of your $20 limit used.");
    expect(draftDialogTexts(f).canStart).toBe(false);
  });

  it("no key: the Owner is sent to Settings › AI, a Member asks the Owner", async () => {
    const c = await mixedCompanies();
    await deleteSecret("anthropic.apiKey");
    auth.user = owner;
    const o = await factsOf({ companyIds: [c.a] });
    expect(o.blocker).toBe("Add your Anthropic API key in Settings › AI first.");
    expect(draftDialogTexts(o).showSettingsLink).toBe(true);
    auth.user = ali;
    const m = await factsOf({ companyIds: [c.a] });
    expect(m.blocker).toBe("Ask the Owner to add an Anthropic API key in Settings › AI.");
    expect(draftDialogTexts(m).showSettingsLink).toBe(false);
  });

  it("paused: the pause's own sentence", async () => {
    const c = await mixedCompanies();
    const text = "AI drafting paused: Anthropic refused the request for a billing reason. Check Billing in the Anthropic Console, then click Resume drafting.";
    await pauseAi("billing", { text, until: null });
    auth.user = ali;
    expect((await factsOf({ companyIds: [c.a] })).blocker).toBe(text);
    expect(await startDraftLinesAction({ companyIds: [c.a], redraft: false, confirmedAtMostUsd: 1 })).toEqual({ ok: false, error: text });
  });

  it("too many companies at once", async () => {
    const rows = Array.from({ length: 1_001 }, (_, i) => ({ name: `Shop ${i}`, nameNorm: `shop ${i}`, website: `https://shop${i}.example` }));
    await dbWrite(async (c) => {
      for (let i = 0; i < rows.length; i += 500) await c.company.createMany({ data: rows.slice(i, i + 500) });
    });
    const ids = (await db.company.findMany({ select: { id: true } })).map((r) => r.id);
    auth.user = ali;
    const f = await factsOf({ companyIds: ids });
    expect(f.toDraft).toBe(1_001);
    expect(f.blocker).toBe("That's 1,001 companies. Draft at most 1,000 at a time.");
  });

  it("the company panel's one company: its name, its own skip sentences, and a new line even when it has one", async () => {
    const c = await mixedCompanies();
    auth.user = ali;
    const noSite = await factsOf({ companyId: c.noSite });
    expect(noSite).toMatchObject({ single: true, companyName: "Offline GmbH", toDraft: 0 });
    expect(noSite.blocker).toBe("Offline GmbH has no website, so there's nothing to read.");
    expect(draftDialogTexts(noSite).title).toBe("Draft a personal line for Offline GmbH");
    expect((await factsOf({ companyId: c.insta })).blocker).toBe("Insta Creator only has an Instagram or other social link, so there's nothing to read.");
    expect((await factsOf({ companyId: c.waiting })).blocker).toBe("A line for Waiting AB is already waiting for review.");
    const withLine = await factsOf({ companyId: c.withLine });
    expect(withLine).toMatchObject({ toDraft: 1, blocker: null, redraft: true });
    expect(draftDialogTexts(withLine).buttonLabel).toBe("Draft line");
  });

  it("a list's companies", async () => {
    const c = await mixedCompanies();
    const listId = await makeList("Germany Q4", [c.a, c.noSite, c.withLine]);
    auth.user = ali;
    const f = await factsOf({ listId });
    expect(f).toMatchObject({ companies: 3, toDraft: 1, skipped: { noWebsite: 1, hasLine: 1 } });
    expect(await estimateDraftLinesAction({ listId: 999_999 }, { redraft: false })).toMatchObject({ ok: false });
  });

  it("the practice copy: free, no key needed", async () => {
    const c = await mixedCompanies();
    await setSetting("practice.copy", true, owner.id);
    await deleteSecret("anthropic.apiKey");
    auth.user = ali;
    const f = await factsOf({ companyIds: [c.a, c.b] });
    expect(f.estimate).toMatchObject({ practiceCopy: true, aboutUsd: 0, atMostUsd: 0 });
    expect(f.blocker).toBeNull();
    expect(draftDialogTexts(f).costLine).toBe("The practice copy writes made-up lines for free. No website is read.");
  });
});

describe("starting from the dialog", () => {
  it("refuses a start without the confirmed cost, or whose cost grew more than 10 %; the job carries the server's estimate", async () => {
    const c = await mixedCompanies();
    auth.user = ali;
    const f = await factsOf({ companyIds: [c.a, c.b] });
    const changed = { ok: false, error: "The estimate changed. Open the dialog again to see the new cost." };
    expect(await startDraftLinesAction({ companyIds: [c.a, c.b], redraft: false } as never)).toEqual(changed);
    expect(await startDraftLinesAction({ companyIds: [c.a, c.b], redraft: false, confirmedAtMostUsd: 0.001 })).toEqual(changed);
    expect(await db.job.count()).toBe(0);

    const res = await startDraftLinesAction({ companyIds: [c.a, c.b], redraft: false, confirmedAtMostUsd: f.estimate.atMostUsd });
    expect(res).toMatchObject({ ok: true, message: "Drafting 2 lines. You'll get a notification when they're ready.", data: { count: 2 } });
    const job = await db.job.findUniqueOrThrow({ where: { id: res.ok ? res.data.jobId : 0 } });
    expect(job).toMatchObject({ type: "ai.draftLines", priority: 10, maxAttempts: 4, activeDedupeKey: null, createdById: ali.id });
    expect(job.payload).toMatchObject({ source: "contacts", companyCount: 2, atMostUsd: f.estimate.atMostUsd });
    expect(await db.aiDraft.count({ where: { jobId: job.id, status: "QUEUED", createdById: ali.id } })).toBe(2);
  });

  it("a list start and the panel's one-company start", async () => {
    const c = await mixedCompanies();
    const listId = await makeList("Norway", [c.a]);
    auth.user = ali;
    const f = await factsOf({ listId });
    const list = await startDraftLinesAction({ listId, redraft: false, confirmedAtMostUsd: f.estimate.atMostUsd });
    expect(list).toMatchObject({ ok: true, message: "Drafting 1 line. You'll get a notification when it's ready." });
    expect((await db.job.findUniqueOrThrow({ where: { id: list.ok ? list.data.jobId : 0 } })).payload).toMatchObject({ source: "list", listId });

    const panel = await startDraftLinesAction({ companyId: c.withLine });
    expect(panel).toMatchObject({ ok: true, message: "Drafting a line for Line GmbH." });
    const job = await db.job.findUniqueOrThrow({ where: { id: panel.ok ? panel.data.jobId : 0 } });
    expect(job).toMatchObject({ priority: 25, activeDedupeKey: `ai:company:${c.withLine}` });
    expect(await startDraftLinesAction({ companyId: c.withLine })).toEqual({ ok: false, error: "A line for Line GmbH is already being drafted." });
  });

  it("refuses without a session", async () => {
    const c = await mixedCompanies();
    auth.user = null;
    const signedOut = { ok: false, error: "Your session has ended. Please sign in again." };
    expect(await estimateDraftLinesAction({ companyIds: [c.a] }, { redraft: false })).toEqual(signedOut);
    expect(await startDraftLinesAction({ companyIds: [c.a], redraft: false, confirmedAtMostUsd: 1 })).toEqual(signedOut);
    expect(await db.job.count()).toBe(0);
  });
});
