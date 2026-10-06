import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { actorOf, makeCompany, makeDraft, saveAnthropicKey, seedUsers, type SeedUser } from "./seed";

/**
 * Who a start drafts and the start itself (docs/dev/M5-DESIGN.md §3.2, §3.3, §3.9.1, §8 P5 "selection" and "start"):
 * every skip reason, redraft, the 1,000 cap, list input, the payload with the server's own estimate, priorities, dedupe
 * keys, `maxAttempts`, `createdById`, the `ai.run` activity, the refusals, and the practice copy's exceptions.
 */

const t = await createTestDb("ai-select");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { deleteSecret } = await import("@/server/secrets");
const { STATE_KEYS } = await import("@/core/system-state");
const { setState } = await import("@/server/state");
const { selectForDrafting, startDraftRun, draftStartView, estimateDraftRun, NO_KEY_MEMBER_TEXT, NO_KEY_OWNER_TEXT, ESTIMATE_CHANGED_TEXT } =
  await import("@/server/services/ai");
const { ServiceError } = await import("@/server/services/companies/mutations");

const NOW = new Date("2026-09-26T08:00:00Z");
let owner: SeedUser;
let ali: SeedUser;

beforeAll(async () => {
  ({ owner, ali } = await seedUsers());
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function reset() {
  await dbWrite(async (c) => {
    await c.aiDraft.deleteMany({});
    await c.job.deleteMany({});
    await c.activityLog.deleteMany({});
    await c.companyList.deleteMany({});
    await c.list.deleteMany({});
    await c.company.deleteMany({});
    await c.systemState.deleteMany({ where: { key: STATE_KEYS.aiPause } });
  });
  await setSetting("practice.copy", false, owner.id);
  await setSetting("ai.monthlyLimitUsd", 20, owner.id);
  await setSetting("ai.model", "claude-haiku-4-5-20251001", owner.id);
  await saveAnthropicKey(owner.id);
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("selectForDrafting", () => {
  beforeEach(reset);

  it("drafts own websites and skips each reason once", async () => {
    const firma = await makeCompany({ name: "Firma GmbH", website: "https://firma.de" });
    const wix = await makeCompany({ name: "Anna Minis", website: "https://anna.wixsite.com/minis" });
    const deleted = await makeCompany({ name: "Gone", website: "https://gone.de", deletedAt: NOW });
    const none = await makeCompany({ name: "No Site" });
    const insta = await makeCompany({ name: "Insta Only", instagram: "sculpt_by_anna" });
    const etsy = await makeCompany({ name: "Etsy Shop", website: "https://www.etsy.com/shop/foominis" });
    const instaSite = await makeCompany({ name: "Insta Site", website: "https://www.instagram.com/foo_minis" });
    const hasLine = await makeCompany({ name: "Has Line", website: "https://line.de", personalLine: "Your busts are great." });
    const ready = await makeCompany({ name: "Ready", website: "https://ready.de" });
    const queued = await makeCompany({ name: "Queued", website: "https://queued.de" });
    await makeDraft({ companyId: ready, status: "READY", line: "A line." });
    await makeDraft({ companyId: queued, status: "QUEUED" });
    // A finished draft doesn't keep a company out.
    const approvedBefore = await makeCompany({ name: "Old Draft", website: "https://old.de" });
    await makeDraft({ companyId: approvedBefore, status: "REJECTED", line: "Old." });

    const ids = [firma, wix, deleted, none, insta, etsy, instaSite, hasLine, ready, queued, approvedBefore, 999_999, firma];
    const sel = await selectForDrafting({ companyIds: ids }, { redraft: false });
    expect(sel.companies).toBe(12);
    expect(sel.toDraft).toEqual([firma, wix, approvedBefore]);
    expect(sel.skipped).toEqual({ deleted: 2, noWebsite: 1, socialOnly: 3, hasLine: 1, waiting: 2 });
    expect(sel.redraftable).toEqual([hasLine]);

    const again = await selectForDrafting({ companyIds: ids }, { redraft: true });
    expect(again.toDraft).toEqual([firma, wix, hasLine, approvedBefore]);
    expect(again.skipped.hasLine).toBe(0);
    expect(again.redraftable).toEqual([hasLine]);
  });

  it("drafts a site builder's <name>.<builder> sites as the company's own website; the bare platform stays social", async () => {
    // WEB-08, selection side: the reader reads these (siteBuilderSite), so the start must not skip them up front.
    const wp = await makeCompany({ name: "Anna Minis", website: "https://anna-minis.wordpress.com/" });
    const bc = await makeCompany({ name: "Dragon Forge", website: "https://dragonforge.bigcartel.com" });
    const bare = await makeCompany({ name: "Platform", website: "https://wordpress.com/" });
    const lang = await makeCompany({ name: "Language Sub", website: "https://de.wordpress.com/" });
    const sel = await selectForDrafting({ companyIds: [wp, bc, bare, lang] }, { redraft: false });
    expect(sel.toDraft).toEqual([wp, bc]);
    expect(sel.skipped).toMatchObject({ socialOnly: 2 });
  });

  it("reads a list's members, deleted ones counted, and refuses a list that's gone", async () => {
    const a = await makeCompany({ name: "A", website: "https://a.de" });
    const b = await makeCompany({ name: "B", website: "https://b.de", deletedAt: NOW });
    const list = await dbWrite((c) => c.list.create({ data: { name: "Germany Q4" } }));
    await dbWrite((c) => c.companyList.createMany({ data: [{ companyId: a, listId: list.id }, { companyId: b, listId: list.id }] }));
    const sel = await selectForDrafting({ listId: list.id }, { redraft: false });
    expect(sel).toMatchObject({ companies: 2, toDraft: [a], skipped: { deleted: 1 } });
    expect(await refusal(selectForDrafting({ listId: list.id + 100 }, { redraft: false }))).toMatch(/That list doesn't exist any more/);
  });

  it("refuses more than 1,000 companies at a time", async () => {
    await dbWrite((c) =>
      c.company.createMany({
        data: Array.from({ length: 1_001 }, (_, i) => ({ name: `Co ${i}`, nameNorm: `co ${i}`, website: `https://co${i}.example` })),
      }),
    );
    const ids = (await db.company.findMany({ select: { id: true } })).map((c) => c.id);
    const view = await draftStartView(actorOf(ali), { companyIds: ids }, { redraft: false, now: NOW });
    expect(view.tooMany).toBe(true);
    expect(view.blocker).toBe("That's 1,001 companies. Draft at most 1,000 at a time.");
    expect(await refusal(startDraftRun(actorOf(ali), { companyIds: ids }, { redraft: false, source: "contacts", confirmedAtMostUsd: 100, now: NOW }))).toBe(
      "That's 1,001 companies. Draft at most 1,000 at a time.",
    );
    expect(await db.aiDraft.count()).toBe(0);
  });
});

describe("startDraftRun", () => {
  beforeEach(reset);

  it("creates the job and one QUEUED draft per company with the server's own estimate", async () => {
    const a = await makeCompany({ name: "Firma GmbH", website: "https://firma.de" });
    const b = await makeCompany({ name: "Butikk AS", website: "https://butikk.no" });
    const skip = await makeCompany({ name: "Insta", instagram: "anna" });
    const expected = await estimateDraftRun(2, NOW);

    const res = await startDraftRun(actorOf(ali), { companyIds: [a, b, skip] }, { redraft: false, confirmedAtMostUsd: 1e9, source: "contacts", now: NOW });
    expect(res.count).toBe(2);
    expect(res.message).toBe("Drafting 2 lines. You'll get a notification when they're ready.");

    const job = await db.job.findUniqueOrThrow({ where: { id: res.jobId } });
    expect(job).toMatchObject({ type: "ai.draftLines", status: "QUEUED", priority: 10, maxAttempts: 4, activeDedupeKey: null, createdById: ali.id });
    expect(job.payload).toEqual({
      source: "contacts",
      companyCount: 2,
      aboutUsd: expected.aboutUsd,
      atMostUsd: expected.atMostUsd,
      model: "claude-haiku-4-5-20251001",
    });
    // Not the browser's 1e9: the server's own "at most".
    expect((job.payload as { atMostUsd: number }).atMostUsd).toBeCloseTo(0.021, 9);

    const drafts = await db.aiDraft.findMany({ where: { jobId: res.jobId }, orderBy: { companyId: "asc" } });
    expect(drafts.map((d) => d.companyId)).toEqual([a, b]);
    for (const d of drafts) {
      expect(d).toMatchObject({ status: "QUEUED", createdById: ali.id, model: "claude-haiku-4-5-20251001", promptVersion: "pl-2026-09-26", calls: 0 });
    }
    const activity = await db.activityLog.findFirstOrThrow({ where: { type: "ai.run" } });
    expect(activity).toMatchObject({ actorId: ali.id, summary: "Ali asked Claude to draft lines for 2 companies (about $0.01)." });
    expect(activity.data).toMatchObject({ jobId: res.jobId, source: "contacts", companyCount: 2, model: "claude-haiku-4-5-20251001" });
  });

  it("carries the list id for a list start", async () => {
    const a = await makeCompany({ name: "A", website: "https://a.de" });
    const list = await dbWrite((c) => c.list.create({ data: { name: "Norway" } }));
    await dbWrite((c) => c.companyList.create({ data: { companyId: a, listId: list.id } }));
    const res = await startDraftRun(actorOf(ali), { listId: list.id }, { redraft: false, confirmedAtMostUsd: 1, source: "list", now: NOW });
    const job = await db.job.findUniqueOrThrow({ where: { id: res.jobId } });
    expect(job.priority).toBe(10);
    expect(job.payload).toMatchObject({ source: "list", companyCount: 1, listId: list.id });
    expect(res.message).toBe("Drafting 1 line. You'll get a notification when it's ready.");
  });

  it("a panel start is one company at priority 25 with its dedupe key, and can't run twice", async () => {
    const a = await makeCompany({ name: "Firma GmbH", website: "https://firma.de" });
    const res = await startDraftRun(actorOf(owner), { companyId: a }, { redraft: false, source: "panel", now: NOW });
    expect(res.message).toBe("Drafting a line for Firma GmbH.");
    const job = await db.job.findUniqueOrThrow({ where: { id: res.jobId } });
    expect(job).toMatchObject({ priority: 25, maxAttempts: 4, activeDedupeKey: `ai:company:${a}`, createdById: owner.id });
    expect(job.payload).toMatchObject({ source: "panel", companyCount: 1, atMostUsd: (await estimateDraftRun(1, NOW)).atMostUsd });
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "ai.run" } })).summary).toBe(
      "Arslan asked Claude to draft a line for Firma GmbH (about $0.01).",
    );
    expect(await refusal(startDraftRun(actorOf(owner), { companyId: a }, { redraft: false, source: "panel", now: NOW }))).toBe(
      "A line for Firma GmbH is already being drafted.",
    );
    await dbWrite((c) => c.aiDraft.updateMany({ where: { companyId: a }, data: { status: "READY" } }));
    expect(await refusal(startDraftRun(actorOf(owner), { companyId: a }, { redraft: false, source: "panel", now: NOW }))).toBe(
      "A line for Firma GmbH is already waiting for review.",
    );
  });

  it("says why one company can't be drafted, and refuses an empty selection", async () => {
    const none = await makeCompany({ name: "No Site" });
    const insta = await makeCompany({ name: "Insta", instagram: "anna" });
    const deleted = await makeCompany({ name: "Gone", website: "https://gone.de", deletedAt: NOW });
    const line = await makeCompany({ name: "Has Line", website: "https://line.de", personalLine: "Your line." });
    const start = (id: number) => startDraftRun(actorOf(ali), { companyId: id }, { redraft: false, source: "panel", now: NOW });
    expect(await refusal(start(none))).toBe("No Site has no website, so there's nothing to read.");
    expect(await refusal(start(insta))).toBe("Insta only has an Instagram or other social link, so there's nothing to read.");
    expect(await refusal(start(deleted))).toBe("This company was deleted.");
    expect(await refusal(start(line))).toBe("Has Line already has a personal line.");
    const redrafted = await startDraftRun(actorOf(ali), { companyId: line }, { redraft: true, source: "panel", now: NOW });
    expect(redrafted.count).toBe(1);
    expect(
      await refusal(startDraftRun(actorOf(ali), { companyIds: [none, insta] }, { redraft: false, source: "contacts", confirmedAtMostUsd: 1, now: NOW })),
    ).toBe("None of these companies can be drafted.");
  });

  it("refuses without a key (Owner and Member words), while paused, without a price, over the limit, and when the estimate grew", async () => {
    const a = await makeCompany({ name: "Firma GmbH", website: "https://firma.de" });
    const start = (who: SeedUser, confirmed?: number) =>
      startDraftRun(actorOf(who), { companyIds: [a] }, { redraft: false, confirmedAtMostUsd: confirmed, source: "contacts", now: NOW });

    await deleteSecret("anthropic.apiKey");
    expect(await refusal(start(owner, 1))).toBe(NO_KEY_OWNER_TEXT);
    expect(await refusal(start(ali, 1))).toBe(NO_KEY_MEMBER_TEXT);
    expect(NO_KEY_OWNER_TEXT).toBe("Add your Anthropic API key in Settings › AI first.");
    expect(NO_KEY_MEMBER_TEXT).toBe("Ask the Owner to add an Anthropic API key in Settings › AI.");
    await saveAnthropicKey(owner.id);

    const pauseText = "AI drafting paused: Anthropic didn't accept the API key. Paste a new key in Settings › AI, then click Resume drafting.";
    await setState(STATE_KEYS.aiPause, { paused: true, kind: "key_rejected", text: pauseText, since: NOW.toISOString(), until: null, model: null, detail: null });
    expect(await refusal(start(ali, 1))).toBe(pauseText);
    await setState(STATE_KEYS.aiPause, { paused: false, kind: null, text: "", since: null, until: null, model: null, detail: null });

    await setSetting("ai.model", "claude-x", owner.id);
    expect(await refusal(start(ali, 1))).toBe("No price is saved for the model “claude-x”. Enter its prices in Settings › AI.");
    await setSetting("ai.model", "claude-haiku-4-5-20251001", owner.id);

    await makeDraft({ companyId: a, status: "READY", line: "x", costUsd: 20, calls: 1, draftedAt: new Date("2026-09-10T10:00:00Z") });
    await dbWrite((c) => c.aiDraft.updateMany({ data: { status: "APPROVED" } }));
    expect(await refusal(start(ali, 1))).toBe(
      "AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until 1 October.",
    );
    await setSetting("ai.monthlyLimitUsd", 21, owner.id);

    const est = await estimateDraftRun(1, NOW);
    expect(await refusal(start(ali, est.atMostUsd / 1.2))).toBe(ESTIMATE_CHANGED_TEXT);
    // Within 10 %: fine.
    const ok = await start(ali, est.atMostUsd / 1.05);
    expect(ok.count).toBe(1);
  });

  it("the practice copy starts without a key, while paused and over the limit, at $0", async () => {
    const a = await makeCompany({ name: "Firma GmbH", website: "https://firma.de" });
    await setSetting("practice.copy", true, owner.id);
    await deleteSecret("anthropic.apiKey");
    await setState(STATE_KEYS.aiPause, { paused: true, kind: "billing", text: "Paused.", since: NOW.toISOString(), until: null, model: null, detail: null });
    await setSetting("ai.monthlyLimitUsd", 1, owner.id);
    await makeDraft({ companyId: a, status: "APPROVED", line: "x", costUsd: 5, calls: 1, draftedAt: new Date("2026-09-10T10:00:00Z") });

    const view = await draftStartView(actorOf(ali), { companyIds: [a] }, { redraft: true, now: NOW });
    expect(view.blocker).toBeNull();
    expect(view.estimate).toMatchObject({ practiceCopy: true, aboutUsd: 0, atMostUsd: 0, overLimit: false, mayReachLimit: false });

    const res = await startDraftRun(actorOf(ali), { companyIds: [a] }, { redraft: true, confirmedAtMostUsd: 0, source: "contacts", now: NOW });
    const job = await db.job.findUniqueOrThrow({ where: { id: res.jobId } });
    expect(job.payload).toEqual({ source: "contacts", companyCount: 1, aboutUsd: 0, atMostUsd: 0, model: "practice" });
    expect(await db.aiDraft.findFirstOrThrow({ where: { jobId: res.jobId } })).toMatchObject({ model: "practice", status: "QUEUED" });
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "ai.run" } })).summary).toBe(
      "Ali asked Claude to draft lines for 1 company (practice copy, free).",
    );
  });

  it("the dialog view shows the same refusal as the start", async () => {
    const a = await makeCompany({ name: "Firma GmbH", website: "https://firma.de" });
    await deleteSecret("anthropic.apiKey");
    const view = await draftStartView(actorOf(ali), { companyIds: [a] }, { redraft: false, now: NOW });
    expect(view.selection.toDraft).toEqual([a]);
    expect(view.readiness).toMatchObject({ practiceCopy: false, hasKey: false });
    expect(view.blocker).toBe(NO_KEY_MEMBER_TEXT);
    expect(view.estimate.companies).toBe(1);
  });
});
