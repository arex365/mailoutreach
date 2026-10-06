import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeAiJob, makeCompany, makeDraft, makeOtherJob, saveTestAnthropicKey, seedSessionUsers, type TestUser } from "./seed";

/**
 * The AI lines page's actions (docs/dev/M5-DESIGN.md §6.7, §6.11, §8 P9): Approve, Edit then approve, Reject and Undo
 * (the card's 10 seconds and the server's 60), Regenerate with both options, Try again, Stop (a backup job's id is
 * refused and left alone), Resume (the Owner only), and the refusals people see (already reviewed, a deleted company,
 * a paused queue).
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

const t = await createTestDb("ai-screens-review");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { STATE_KEYS } = await import("@/core/system-state");
const actions = await import("@/app/(app)/ai-lines/actions");
const { listDrafts } = await import("@/server/services/ai/queue");
const { getAiPause, pauseAi } = await import("@/server/services/ai/pause");

const LINE = "You sell 32mm fantasy wargame miniatures in resin, both as unpainted kits and as painted display pieces.";
let owner: TestUser;
let ali: TestUser;
let sara: TestUser;

beforeAll(async () => {
  ({ owner, ali, sara } = await seedSessionUsers());
  await saveTestAnthropicKey(owner.id);
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
    await c.company.deleteMany({});
    await c.systemState.deleteMany({ where: { key: { in: [STATE_KEYS.aiPause, STATE_KEYS.notices] } } });
  });
  await setSetting("practice.copy", false, owner.id);
});

async function readyDraft(opts: { prevLine?: string | null; deleted?: boolean; name?: string } = {}) {
  const companyId = await makeCompany({
    name: opts.name ?? "Firma GmbH",
    website: "https://firma.de",
    personalLine: opts.prevLine ?? null,
    personalLineSource: opts.prevLine ? "manual" : null,
    personalLineUpdatedById: opts.prevLine ? sara.id : null,
    personalLineUpdatedAt: opts.prevLine ? new Date("2026-03-03T09:00:00Z") : null,
    deletedAt: opts.deleted ? new Date() : null,
  });
  const draftId = await makeDraft({
    companyId,
    status: "READY",
    line: LINE,
    evidenceQuote: "32mm fantasy wargame miniatures",
    evidenceSource: "homepage",
    calls: 1,
    costUsd: 0.006,
    draftedAt: new Date(),
  });
  return { companyId, draftId };
}

const company = (id: number) => db.company.findUniqueOrThrow({ where: { id } });
const draft = (id: number) => db.aiDraft.findUniqueOrThrow({ where: { id } });

describe("Approve, Edit then approve, Reject and Undo", () => {
  it("Approve writes the company's line (source ai); the reviewer's card offers Undo for 10 s; Undo within 60 s restores it", async () => {
    const { companyId, draftId } = await readyDraft({ prevLine: "An older line." });
    auth.user = ali;
    const res = await actions.approveDraftAction({ draftId });
    expect(res).toMatchObject({ ok: true, message: "Approved. Firma GmbH's emails now use this line.", data: { companyName: "Firma GmbH" } });
    expect(await company(companyId)).toMatchObject({ personalLine: LINE, personalLineSource: "ai", personalLineUpdatedById: ali.id });

    // The button's 10 seconds: only the reviewer's card has an Undo time, 10 s after the review.
    const reviewedAt = (await draft(draftId)).reviewedAt!;
    const mine = await listDrafts({ id: ali.id, timeZone: "Europe/Berlin" }, { tab: "approved", now: new Date(reviewedAt.getTime() + 1_000) });
    expect(mine.rows[0]!.canUndoUntil).toBe(new Date(reviewedAt.getTime() + 10_000).toISOString());
    const theirs = await listDrafts({ id: sara.id, timeZone: "Europe/Berlin" }, { tab: "approved", now: new Date(reviewedAt.getTime() + 1_000) });
    expect(theirs.rows[0]!.canUndoUntil).toBeNull();
    const late = await listDrafts({ id: ali.id, timeZone: "Europe/Berlin" }, { tab: "approved", now: new Date(reviewedAt.getTime() + 11_000) });
    expect(late.rows[0]!.canUndoUntil).toBeNull();

    // Someone else can't undo it.
    auth.user = sara;
    expect(await actions.undoDraftAction({ draftId })).toEqual({ ok: false, error: "Undo is only possible right after you approve or reject." });

    // The server's 60 seconds: 30 s after the review still works (the card's button is gone, a slow click isn't).
    await dbWrite((c) => c.aiDraft.update({ where: { id: draftId }, data: { reviewedAt: new Date(Date.now() - 30_000) } }));
    auth.user = ali;
    expect(await actions.undoDraftAction({ draftId })).toMatchObject({ ok: true, message: "Undone. Firma GmbH's line is back to what it was." });
    expect(await company(companyId)).toMatchObject({ personalLine: "An older line.", personalLineSource: "manual" });
    expect((await draft(draftId)).status).toBe("READY");
  });

  it("Undo is refused more than 60 s after the review", async () => {
    const { draftId } = await readyDraft();
    auth.user = ali;
    expect((await actions.approveDraftAction({ draftId })).ok).toBe(true);
    await dbWrite((c) => c.aiDraft.update({ where: { id: draftId }, data: { reviewedAt: new Date(Date.now() - 61_000) } }));
    expect(await actions.undoDraftAction({ draftId })).toEqual({ ok: false, error: "Undo is only possible right after you approve or reject." });
    expect((await draft(draftId)).status).toBe("APPROVED");
  });

  it("Edit then approve saves the edited line; over 300 characters is refused on the line itself", async () => {
    const { companyId, draftId } = await readyDraft();
    auth.user = ali;
    const tooLong = await actions.approveDraftAction({ draftId, line: `You ${"sell miniatures ".repeat(30)}.` });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.fieldErrors?.line?.[0]).toMatch(/^Keep the personal line under 300 characters/);
    expect((await draft(draftId)).status).toBe("READY");

    const edited = "You sell 32mm wargame miniatures in resin, as kits and painted pieces.";
    const res = await actions.approveDraftAction({ draftId, line: `  ${edited}​ ` });
    expect(res.ok).toBe(true);
    expect(await draft(draftId)).toMatchObject({ status: "APPROVED", finalLine: edited, reviewAction: "edited" });
    expect((await company(companyId)).personalLine).toBe(edited);
  });

  it("Reject, then Undo puts it back on Waiting", async () => {
    const { draftId } = await readyDraft();
    auth.user = ali;
    expect(await actions.rejectDraftAction({ draftId })).toMatchObject({ ok: true, message: "Rejected." });
    expect((await draft(draftId)).status).toBe("REJECTED");
    expect(await actions.undoDraftAction({ draftId })).toMatchObject({ ok: true, message: "Undone." });
    expect((await draft(draftId)).status).toBe("READY");
  });

  it("errors: already reviewed by someone else, and a deleted company", async () => {
    const { draftId } = await readyDraft();
    auth.user = sara;
    expect((await actions.approveDraftAction({ draftId })).ok).toBe(true);
    auth.user = ali;
    expect(await actions.approveDraftAction({ draftId })).toEqual({ ok: false, error: "This line was already reviewed by Sara. Refresh the page." });
    expect(await actions.rejectDraftAction({ draftId })).toEqual({ ok: false, error: "This line was already reviewed by Sara. Refresh the page." });

    const gone = await readyDraft({ name: "Gone GmbH", deleted: true });
    expect(await actions.approveDraftAction({ draftId: gone.draftId })).toEqual({ ok: false, error: "This company was deleted." });
    expect(await actions.approveDraftAction({ draftId: 0 })).toMatchObject({ ok: false });
  });
});

describe("Regenerate and Try again", () => {
  it("Regenerate writes a new line (refetch off) or reads the website again (refetch on)", async () => {
    const a = await readyDraft();
    auth.user = ali;
    const res = await actions.regenerateDraftAction({ draftId: a.draftId, refetch: false });
    expect(res).toMatchObject({ ok: true, message: "Drafting a new line for Firma GmbH." });
    expect(await draft(a.draftId)).toMatchObject({ status: "REJECTED", reviewAction: "regenerated" });
    const fresh = await db.aiDraft.findFirstOrThrow({ where: { companyId: a.companyId, status: "QUEUED" } });
    expect(fresh.refetch).toBe(false);
    expect(fresh.avoidLines).toEqual([LINE]);
    const job = await db.job.findUniqueOrThrow({ where: { id: res.ok ? res.data.jobId : 0 } });
    expect(job).toMatchObject({ type: "ai.draftLines", priority: 25, activeDedupeKey: `ai:draft:${fresh.id}`, createdById: ali.id });

    const b = await readyDraft({ name: "Butikk AS" });
    const again = await actions.regenerateDraftAction({ draftId: b.draftId, refetch: true });
    expect(again).toMatchObject({ ok: true, message: "Drafting a new line for Butikk AS." });
    expect((await db.aiDraft.findFirstOrThrow({ where: { companyId: b.companyId, status: "QUEUED" } })).refetch).toBe(true);
  });

  it("Regenerate is refused with the pause's sentence while the AI queue is paused", async () => {
    const { draftId } = await readyDraft();
    const text = "AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until 1 November.";
    await pauseAi("monthly_limit", { text, until: new Date(Date.now() + 86_400_000) });
    auth.user = ali;
    expect(await actions.regenerateDraftAction({ draftId, refetch: false })).toEqual({ ok: false, error: text });
  });

  it("Try again makes a new draft; the old one keeps its cost and leaves the Failed tab", async () => {
    const companyId = await makeCompany({ name: "Firma GmbH", website: "https://firma.de" });
    const failed = await makeDraft({ companyId, status: "FAILED", error: "Claude couldn't be reached. Click Try again.", calls: 1, costUsd: 0.004 });
    auth.user = sara;
    const res = await actions.retryDraftAction({ draftId: failed });
    expect(res).toMatchObject({ ok: true, message: "Drafting a new line for Firma GmbH." });
    expect(await draft(failed)).toMatchObject({ status: "FAILED", reviewAction: "retried", costUsd: 0.004 });
    const fresh = await db.aiDraft.findFirstOrThrow({ where: { companyId, status: "QUEUED" } });
    expect(fresh).toMatchObject({ refetch: true, createdById: sara.id });
    const tab = await listDrafts({ id: sara.id, timeZone: "Europe/Berlin" }, { tab: "failed" });
    expect(tab.rows.map((r) => r.id)).not.toContain(failed);
    expect(await actions.retryDraftAction({ draftId: failed })).toEqual({ ok: false, error: "This draft was already tried again. Refresh the page." });
  });
});

describe("Stop and Resume", () => {
  it("Stop refuses a backup job's id and leaves the job alone", async () => {
    const backup = await makeOtherJob("backup.run");
    const catchUp = await makeOtherJob("mailgun.catchUp", "RUNNING");
    auth.user = ali;
    expect(await actions.stopDraftRunAction({ jobId: backup })).toEqual({ ok: false, error: "This isn't an AI drafting run." });
    expect(await actions.stopDraftRunAction({ jobId: catchUp })).toEqual({ ok: false, error: "This isn't an AI drafting run." });
    expect((await db.job.findUniqueOrThrow({ where: { id: backup } })).status).toBe("QUEUED");
    expect((await db.job.findUniqueOrThrow({ where: { id: catchUp } })).cancelRequestedAt).toBeNull();
  });

  it("Stop on a queued run cancels it and takes its companies off the list; a running one is asked to stop", async () => {
    const queued = await makeAiJob("QUEUED", { createdById: ali.id });
    const c1 = await makeCompany({ name: "A", website: "https://a.example" });
    const c2 = await makeCompany({ name: "B", website: "https://b.example" });
    await makeDraft({ companyId: c1, jobId: queued, status: "QUEUED" });
    await makeDraft({ companyId: c2, jobId: queued, status: "QUEUED" });
    auth.user = sara;
    expect(await actions.stopDraftRunAction({ jobId: queued })).toMatchObject({ ok: true, message: "Drafting stopped before it started." });
    expect((await db.job.findUniqueOrThrow({ where: { id: queued } })).status).toBe("CANCELLED");
    expect(await db.aiDraft.count({ where: { jobId: queued } })).toBe(0);

    const running = await makeAiJob("RUNNING");
    expect(await actions.stopDraftRunAction({ jobId: running })).toMatchObject({
      ok: true,
      message: "Stopping. The companies being drafted right now are finished first.",
    });
    expect((await db.job.findUniqueOrThrow({ where: { id: running } })).cancelRequestedAt).not.toBeNull();
  });

  it("Resume drafting is the Owner's", async () => {
    await pauseAi("key_rejected", {
      text: "AI drafting paused: Anthropic didn't accept the API key. Paste a new key in Settings › AI, then click Resume drafting.",
      until: null,
    });
    auth.user = ali;
    expect(await actions.resumeAiAction()).toEqual({ ok: false, error: "Only the Owner can do this." });
    expect((await getAiPause()).paused).toBe(true);
    auth.user = owner;
    expect(await actions.resumeAiAction()).toMatchObject({ ok: true, message: "AI drafting resumed.", data: { resumed: true } });
    expect((await getAiPause()).paused).toBe(false);
    expect(await actions.resumeAiAction()).toMatchObject({ ok: true, message: "AI drafting isn't paused.", data: { resumed: false } });
  });

  it("every action refuses without a session", async () => {
    const { draftId } = await readyDraft();
    auth.user = null;
    const signedOut = { ok: false, error: "Your session has ended. Please sign in again." };
    expect(await actions.approveDraftAction({ draftId })).toEqual(signedOut);
    expect(await actions.rejectDraftAction({ draftId })).toEqual(signedOut);
    expect(await actions.undoDraftAction({ draftId })).toEqual(signedOut);
    expect(await actions.regenerateDraftAction({ draftId, refetch: true })).toEqual(signedOut);
    expect(await actions.retryDraftAction({ draftId })).toEqual(signedOut);
    expect(await actions.stopDraftRunAction({ jobId: 1 })).toEqual(signedOut);
    expect(await actions.resumeAiAction()).toEqual(signedOut);
    expect((await draft(draftId)).status).toBe("READY");
  });
});
