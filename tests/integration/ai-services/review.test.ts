import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { actorOf, makeCompany, makeDraft, saveAnthropicKey, seedUsers, type SeedUser } from "./seed";

/**
 * Review decisions (docs/dev/M5-DESIGN.md §3.9, §8 P5 "review"): approve (line, source ai, previous line kept,
 * activity), edit then approve (300-character rule, U+200B removed), reject, undo within 60 s by the reviewer only,
 * undo refused after the line changed, approving a rejected draft, regenerate, try again, and two reviewers racing.
 */

const t = await createTestDb("ai-review");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const { STATE_KEYS } = await import("@/core/system-state");
const ai = await import("@/server/services/ai");
const { ServiceError, setCompanyPersonalLine } = await import("@/server/services/companies/mutations");

const NOW = new Date("2026-09-26T08:00:00Z");
const LINE = "You sell 32mm fantasy wargame miniatures in resin, both as unpainted kits and as painted display pieces.";
const PREV_AT = new Date("2026-03-03T09:00:00Z");
let owner: SeedUser;
let ali: SeedUser;
let sara: SeedUser;

beforeAll(async () => {
  ({ owner, ali, sara } = await seedUsers());
  await saveAnthropicKey(owner.id);
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.aiDraft.deleteMany({});
    await c.job.deleteMany({});
    await c.activityLog.deleteMany({});
    await c.company.deleteMany({});
    await c.systemState.deleteMany({ where: { key: STATE_KEYS.aiPause } });
  });
  await setSetting("practice.copy", false, owner.id);
});

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

async function companyWithReadyDraft(opts: { prevLine?: string | null; deleted?: boolean } = {}) {
  const companyId = await makeCompany({
    name: "Firma GmbH",
    website: "https://firma.de",
    personalLine: opts.prevLine ?? null,
    personalLineSource: opts.prevLine ? "manual" : null,
    personalLineUpdatedById: opts.prevLine ? sara.id : null,
    personalLineUpdatedAt: opts.prevLine ? PREV_AT : null,
    deletedAt: opts.deleted ? NOW : null,
  });
  const draftId = await makeDraft({
    companyId,
    status: "READY",
    line: LINE,
    evidenceQuote: "32mm fantasy wargame miniatures",
    evidenceSource: "homepage",
    calls: 1,
    costUsd: 0.006,
    draftedAt: NOW,
  });
  return { companyId, draftId };
}

const company = (id: number) => db.company.findUniqueOrThrow({ where: { id } });
const draft = (id: number) => db.aiDraft.findUniqueOrThrow({ where: { id } });

describe("approve", () => {
  it("writes the company's line with source ai, keeps the previous line on the draft and logs it", async () => {
    const { companyId, draftId } = await companyWithReadyDraft({ prevLine: "Sara's own line." });
    const res = await ai.approveDraft(actorOf(ali), draftId, { now: NOW });
    expect(res).toEqual({ message: "Approved. Firma GmbH's emails now use this line.", companyName: "Firma GmbH" });
    expect(await company(companyId)).toMatchObject({
      personalLine: LINE,
      personalLineSource: "ai",
      personalLineUpdatedById: ali.id,
      personalLineUpdatedAt: NOW,
    });
    expect(await draft(draftId)).toMatchObject({
      status: "APPROVED",
      finalLine: LINE,
      reviewAction: "approved",
      reviewedById: ali.id,
      reviewedAt: NOW,
      prevLine: "Sara's own line.",
      prevLineSource: "manual",
      prevLineUpdatedById: sara.id,
      prevLineUpdatedAt: PREV_AT,
    });
    const act = await db.activityLog.findFirstOrThrow({ where: { type: "company.personalLine" } });
    expect(act).toMatchObject({ actorId: ali.id, companyId, summary: "Ali approved an AI line" });
    expect(act.data).toEqual({ line: LINE, source: "ai", draftId, edited: false });
  });

  it("edit then approve: invisible characters removed, spaces collapsed, the 300-character rule", async () => {
    const { companyId, draftId } = await companyWithReadyDraft();
    const long = "x".repeat(301);
    const tooLong = await refusal(ai.approveDraft(actorOf(ali), draftId, { line: long, now: NOW }));
    expect(tooLong).toBe("Keep the personal line under 300 characters (it's 301 now).");
    expect(await refusal(ai.approveDraft(actorOf(ali), draftId, { line: " ​ ", now: NOW }))).toBe("Write the line before you approve it.");
    expect((await draft(draftId)).status).toBe("READY");

    await ai.approveDraft(actorOf(ali), draftId, { line: "  You print   large​ figures⁠ for theatre.\n", now: NOW });
    expect((await company(companyId)).personalLine).toBe("You print large figures for theatre.");
    expect(await draft(draftId)).toMatchObject({ finalLine: "You print large figures for theatre.", reviewAction: "edited", line: LINE });
    const act = await db.activityLog.findFirstOrThrow({ where: { type: "company.personalLine" } });
    expect(act.data).toMatchObject({ edited: true, line: "You print large figures for theatre." });
  });

  it("an unchanged edit counts as a plain approval", async () => {
    const { draftId } = await companyWithReadyDraft();
    await ai.approveDraft(actorOf(ali), draftId, { line: ` ${LINE} `, now: NOW });
    expect((await draft(draftId)).reviewAction).toBe("approved");
  });

  it("refuses a deleted company and a draft that isn't waiting", async () => {
    const { draftId } = await companyWithReadyDraft({ deleted: true });
    expect(await refusal(ai.approveDraft(actorOf(ali), draftId, { now: NOW }))).toBe("This company was deleted.");
    const co = await makeCompany({ name: "B", website: "https://b.de" });
    const queued = await makeDraft({ companyId: co, status: "QUEUED" });
    expect(await refusal(ai.approveDraft(actorOf(ali), queued, { now: NOW }))).toBe("This line isn't waiting for review any more. Refresh the page.");
    expect(await refusal(ai.approveDraft(actorOf(ali), 999_999, { now: NOW }))).toBe("This line isn't on the list any more. Refresh the page.");
  });

  it("two reviewers racing: the second hears who reviewed it", async () => {
    const { companyId, draftId } = await companyWithReadyDraft();
    const results = await Promise.allSettled([
      ai.approveDraft(actorOf(ali), draftId, { now: NOW }),
      ai.approveDraft(actorOf(sara), draftId, { line: "Sara's edit of the line.", now: NOW }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    const winner = (await draft(draftId)).reviewedById === ali.id ? "Ali" : "Sara";
    expect(lost.reason.message).toBe(`This line was already reviewed by ${winner}. Refresh the page.`);
    expect(await db.activityLog.count({ where: { type: "company.personalLine", companyId } })).toBe(1);
    expect(await refusal(ai.rejectDraft(actorOf(sara), draftId, { now: NOW }))).toBe(`This line was already reviewed by ${winner}. Refresh the page.`);
  });

  it("a rejected draft can still be approved", async () => {
    const { companyId, draftId } = await companyWithReadyDraft();
    await ai.rejectDraft(actorOf(sara), draftId, { now: NOW });
    await ai.approveDraft(actorOf(ali), draftId, { now: new Date(NOW.getTime() + 120_000) });
    expect(await draft(draftId)).toMatchObject({ status: "APPROVED", reviewedById: ali.id, reviewAction: "approved" });
    expect((await company(companyId)).personalLine).toBe(LINE);
  });
});

describe("reject and undo", () => {
  it("reject logs ai.rejected; its undo puts the draft back without activity", async () => {
    const { companyId, draftId } = await companyWithReadyDraft();
    expect(await ai.rejectDraft(actorOf(ali), draftId, { now: NOW })).toEqual({ message: "Rejected." });
    expect(await draft(draftId)).toMatchObject({ status: "REJECTED", reviewAction: "rejected", reviewedById: ali.id });
    const act = await db.activityLog.findFirstOrThrow({ where: { type: "ai.rejected" } });
    expect(act).toMatchObject({ actorId: ali.id, companyId, summary: "Ali rejected an AI line" });

    expect(await ai.undoDraft(actorOf(ali), draftId, { now: new Date(NOW.getTime() + 5_000) })).toEqual({ message: "Undone." });
    expect(await draft(draftId)).toMatchObject({ status: "READY", reviewAction: "undone", reviewedById: null, reviewedAt: null });
    expect(await db.activityLog.count()).toBe(1);
  });

  it("undo of an approval restores the previous line, within 60 s, by the reviewer only", async () => {
    const { companyId, draftId } = await companyWithReadyDraft({ prevLine: "Sara's own line." });
    await ai.approveDraft(actorOf(ali), draftId, { now: NOW });
    expect(await refusal(ai.undoDraft(actorOf(sara), draftId, { now: new Date(NOW.getTime() + 5_000) }))).toBe(
      "Undo is only possible right after you approve or reject.",
    );
    expect(await refusal(ai.undoDraft(actorOf(ali), draftId, { now: new Date(NOW.getTime() + 61_000) }))).toBe(
      "Undo is only possible right after you approve or reject.",
    );
    const res = await ai.undoDraft(actorOf(ali), draftId, { now: new Date(NOW.getTime() + 59_000) });
    expect(res.message).toBe("Undone. Firma GmbH's line is back to what it was.");
    expect(await company(companyId)).toMatchObject({
      personalLine: "Sara's own line.",
      personalLineSource: "manual",
      personalLineUpdatedById: sara.id,
      personalLineUpdatedAt: PREV_AT,
    });
    expect(await draft(draftId)).toMatchObject({ status: "READY", finalLine: null, prevLine: null, reviewAction: "undone" });
    const undo = await db.activityLog.findFirstOrThrow({ where: { type: "company.personalLine", summary: "Ali undid the AI line" } });
    expect(undo.data).toMatchObject({ line: "Sara's own line.", draftId, undone: true });
    // Nothing to undo any more.
    expect(await refusal(ai.undoDraft(actorOf(ali), draftId, { now: new Date(NOW.getTime() + 60_000) }))).toBe(
      "Undo is only possible right after you approve or reject.",
    );
  });

  it("undo is refused once the line was changed since", async () => {
    const { companyId, draftId } = await companyWithReadyDraft();
    await ai.approveDraft(actorOf(ali), draftId, { now: NOW });
    await setCompanyPersonalLine({ id: sara.id, name: "Sara" }, companyId, "Sara changed it.");
    expect(await refusal(ai.undoDraft(actorOf(ali), draftId, { now: new Date(NOW.getTime() + 5_000) }))).toBe(
      "The line was changed since; undo isn't possible.",
    );
    expect((await company(companyId)).personalLine).toBe("Sara changed it.");
    expect((await draft(draftId)).status).toBe("APPROVED");
  });
});

describe("regenerate and try again", () => {
  it("regenerate: the old draft becomes REJECTED 'regenerated', a new QUEUED draft avoids the last lines", async () => {
    const { companyId, draftId } = await companyWithReadyDraft();
    await makeDraft({ companyId, status: "REJECTED", line: "An older line.", createdAt: new Date("2026-09-01T00:00:00Z") });
    const res = await ai.regenerateDraft(actorOf(ali), draftId, { refetch: true, now: NOW });
    expect(res.message).toBe("Drafting a new line for Firma GmbH.");
    expect(await draft(draftId)).toMatchObject({ status: "REJECTED", reviewAction: "regenerated", reviewedById: ali.id, reviewedAt: NOW, costUsd: 0.006 });

    const fresh = await db.aiDraft.findFirstOrThrow({ where: { jobId: res.jobId } });
    expect(fresh).toMatchObject({ companyId, status: "QUEUED", refetch: true, createdById: ali.id, promptVersion: "pl-2026-09-26", calls: 0 });
    expect(fresh.avoidLines).toEqual([LINE, "An older line."]);
    const job = await db.job.findUniqueOrThrow({ where: { id: res.jobId } });
    const one = await ai.estimateDraftRun(1, NOW);
    expect(job).toMatchObject({ priority: 25, maxAttempts: 4, activeDedupeKey: `ai:draft:${fresh.id}`, createdById: ali.id });
    expect(job.payload).toEqual({ source: "regenerate", companyCount: 1, aboutUsd: one.aboutUsd, atMostUsd: one.atMostUsd, model: "claude-haiku-4-5-20251001" });
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "ai.run" } })).summary).toBe(
      "Ali asked Claude to draft a new line for Firma GmbH (about $0.01).",
    );
    // While the new line is being drafted, nothing else regenerates.
    expect(await refusal(ai.regenerateDraft(actorOf(sara), draftId, { refetch: false, now: NOW }))).toBe(
      "A line for Firma GmbH is already being drafted.",
    );
  });

  it("regenerating an approved line keeps the approval and only marks it", async () => {
    const { draftId } = await companyWithReadyDraft();
    await ai.approveDraft(actorOf(ali), draftId, { now: NOW });
    const res = await ai.regenerateDraft(actorOf(sara), draftId, { refetch: false, now: NOW });
    expect(await draft(draftId)).toMatchObject({ status: "APPROVED", reviewAction: "regenerated", reviewedById: ali.id, finalLine: LINE });
    expect((await db.aiDraft.findFirstOrThrow({ where: { jobId: res.jobId } })).refetch).toBe(false);
  });

  it("try again on No line and Failed: a new draft, the old one keeps its status and cost and leaves its tab", async () => {
    const companyId = await makeCompany({ name: "Butikk AS", website: "https://butikk.no" });
    const noLine = await makeDraft({ companyId, status: "NO_LINE", reasonIfNull: "thin", calls: 1, costUsd: 0.002, draftedAt: NOW });
    const res = await ai.retryDraft(actorOf(ali), noLine, { now: NOW });
    expect(res.message).toBe("Drafting a new line for Butikk AS.");
    expect(await draft(noLine)).toMatchObject({ status: "NO_LINE", reviewAction: "retried", costUsd: 0.002, calls: 1 });
    const fresh = await db.aiDraft.findFirstOrThrow({ where: { jobId: res.jobId } });
    expect(fresh).toMatchObject({ status: "QUEUED", refetch: true, avoidLines: null });
    const job = await db.job.findUniqueOrThrow({ where: { id: res.jobId } });
    expect(job).toMatchObject({ priority: 25, activeDedupeKey: `ai:draft:${fresh.id}` });
    expect(job.payload).toMatchObject({ source: "retry", companyCount: 1 });
    // Billed money stays counted.
    expect(await ai.monthSpendUsd(NOW)).toBe(0.002);

    const list = await ai.listDrafts({ id: ali.id, timeZone: "Europe/Berlin" }, { tab: "no-line", now: NOW });
    expect(list.rows).toEqual([]);
    expect(list.counts["no-line"]).toBe(0);
    expect(await refusal(ai.retryDraft(actorOf(ali), noLine, { now: NOW }))).toBe("This draft was already tried again. Refresh the page.");

    const other = await makeCompany({ name: "Grid Shop", website: "https://grid.example" });
    const failed = await makeDraft({ companyId: other, status: "FAILED", error: "Claude couldn't be reached. Click Try again." });
    await ai.retryDraft(actorOf(ali), failed, { now: NOW });
    expect(await draft(failed)).toMatchObject({ status: "FAILED", reviewAction: "retried" });
    expect((await ai.listDrafts({ id: ali.id, timeZone: "Europe/Berlin" }, { tab: "failed", now: NOW })).rows).toEqual([]);
  });

  it("try again only on No line / Failed, regenerate only on reviewable lines", async () => {
    const { draftId } = await companyWithReadyDraft();
    expect(await refusal(ai.retryDraft(actorOf(ali), draftId, { now: NOW }))).toBe("This draft can't be tried again any more. Refresh the page.");
    const co = await makeCompany({ name: "B", website: "https://b.de" });
    const noLine = await makeDraft({ companyId: co, status: "NO_LINE", reasonIfNull: "thin" });
    expect(await refusal(ai.regenerateDraft(actorOf(ali), noLine, { refetch: false, now: NOW }))).toBe(
      "This line can't be regenerated any more. Refresh the page.",
    );
  });

  it("regenerate is refused while AI drafting is paused, and when the company has no website any more", async () => {
    const { companyId, draftId } = await companyWithReadyDraft();
    const text = "AI drafting paused: Anthropic refused the request for a billing reason. Check Billing in the Anthropic Console, then click Resume drafting.";
    await setState(STATE_KEYS.aiPause, { paused: true, kind: "billing", text, since: NOW.toISOString(), until: null, model: null, detail: null });
    expect(await refusal(ai.regenerateDraft(actorOf(ali), draftId, { refetch: false, now: NOW }))).toBe(text);
    expect((await draft(draftId)).status).toBe("READY");
    await dbWrite((c) => c.systemState.deleteMany({ where: { key: STATE_KEYS.aiPause } }));
    await dbWrite((c) => c.company.update({ where: { id: companyId }, data: { website: null } }));
    expect(await refusal(ai.regenerateDraft(actorOf(ali), draftId, { refetch: false, now: NOW }))).toBe(
      "Firma GmbH has no website, so there's nothing to read.",
    );
  });
});
