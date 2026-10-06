import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeAiJob, makeCompany, makeDraft, seedUsers, type SeedUser } from "./seed";

/**
 * The review queue's data (docs/dev/M5-DESIGN.md §3.9 "Lists", §6.7, §8 P5 "lists"): tab counts and orders,
 * pagination, the card (snippet found / in the title / approximate / cleared snapshot, current line, `canUndoUntil`),
 * the run cards, the panel's draft state and the sidebar count.
 */

const t = await createTestDb("ai-queue");
const { db, dbWrite } = await import("@/server/db");
const ai = await import("@/server/services/ai");
const { formatShortDate } = await import("@/core/time/format");

const NOW = new Date("2026-09-26T08:00:00Z");
const TZ = "Europe/Berlin";
let ali: SeedUser;
let sara: SeedUser;

beforeAll(async () => {
  ({ ali, sara } = await seedUsers());
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.aiDraft.deleteMany({});
    await c.websiteSnapshot.deleteMany({});
    await c.job.deleteMany({});
    await c.company.deleteMany({});
  });
});

async function snapshot(companyId: number, data: { title: string | null; text: string; lang?: string; kind?: string; fetchedAt?: Date }): Promise<number> {
  const row = await dbWrite((c) =>
    c.websiteSnapshot.create({
      data: {
        companyId,
        url: "https://firma.de",
        finalUrl: "https://firma.de/",
        pageKind: data.kind ?? "homepage",
        httpStatus: 200,
        title: data.title,
        text: data.text,
        chars: data.text.length,
        lang: data.lang ?? "de",
        fetchedAt: data.fetchedAt ?? new Date("2026-09-25T09:00:00Z"),
      },
      select: { id: true },
    }),
  );
  return row.id;
}

describe("tabs", () => {
  it("counts every tab, orders each and leaves out retried drafts and deleted companies", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    const gone = await makeCompany({ name: "Gone", website: "https://gone.de", deletedAt: NOW });
    const w1 = await makeDraft({ companyId: co, status: "READY", line: "One.", createdAt: new Date("2026-09-20T00:00:00Z") });
    const w2 = await makeDraft({ companyId: co, status: "READY", line: "Two.", createdAt: new Date("2026-09-21T00:00:00Z") });
    await makeDraft({ companyId: gone, status: "READY", line: "Gone." });
    const a1 = await makeDraft({ companyId: co, status: "APPROVED", line: "A1.", reviewedById: ali.id, reviewedAt: new Date("2026-09-22T00:00:00Z") });
    const a2 = await makeDraft({ companyId: co, status: "APPROVED", line: "A2.", reviewedById: ali.id, reviewedAt: new Date("2026-09-23T00:00:00Z") });
    const r1 = await makeDraft({ companyId: co, status: "REJECTED", line: "R1.", reviewedById: ali.id, reviewedAt: new Date("2026-09-22T00:00:00Z") });
    const n1 = await makeDraft({ companyId: co, status: "NO_LINE", reasonIfNull: "parked" });
    await makeDraft({ companyId: co, status: "NO_LINE", reasonIfNull: "thin", reviewAction: "retried" });
    const f1 = await makeDraft({ companyId: co, status: "FAILED", error: "Claude couldn't be reached. Click Try again." });
    await makeDraft({ companyId: co, status: "QUEUED" });

    const viewer = { id: ali.id, timeZone: TZ };
    const waiting = await ai.listDrafts(viewer, { tab: "waiting", now: NOW });
    expect(waiting.counts).toEqual({ waiting: 2, approved: 2, rejected: 1, "no-line": 1, failed: 1 });
    expect(waiting.rows.map((r) => r.id)).toEqual([w1, w2]);
    expect(waiting).toMatchObject({ page: 1, pageCount: 1 });
    expect((await ai.listDrafts(viewer, { tab: "approved", now: NOW })).rows.map((r) => r.id)).toEqual([a2, a1]);
    expect((await ai.listDrafts(viewer, { tab: "rejected", now: NOW })).rows.map((r) => r.id)).toEqual([r1]);
    expect((await ai.listDrafts(viewer, { tab: "no-line", now: NOW })).rows.map((r) => r.id)).toEqual([n1]);
    expect((await ai.listDrafts(viewer, { tab: "failed", now: NOW })).rows.map((r) => r.id)).toEqual([f1]);
    expect(await ai.aiQueueCounts()).toEqual({ waiting: 2 });
  });

  it("orders No line and Failed newest first", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    const older = await makeDraft({ companyId: co, status: "FAILED", error: "x" });
    const newer = await makeDraft({ companyId: co, status: "FAILED", error: "y" });
    await dbWrite((c) => c.aiDraft.update({ where: { id: older }, data: { error: "x again" } }));
    const rows = (await ai.listDrafts({ id: ali.id, timeZone: TZ }, { tab: "failed", now: NOW })).rows.map((r) => r.id);
    expect(rows).toEqual([older, newer]);
  });

  it("pages 20 cards at a time and clamps the page", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) ids.push(await makeDraft({ companyId: co, status: "READY", line: `Line ${i}.`, createdAt: new Date(Date.UTC(2026, 8, 1, i)) }));
    const viewer = { id: ali.id, timeZone: TZ };
    const first = await ai.listDrafts(viewer, { tab: "waiting", page: 1, now: NOW });
    expect(first.rows).toHaveLength(20);
    expect(first.pageCount).toBe(2);
    const second = await ai.listDrafts(viewer, { tab: "waiting", page: 2, now: NOW });
    expect(second.rows.map((r) => r.id)).toEqual(ids.slice(20));
    expect((await ai.listDrafts(viewer, { tab: "waiting", page: 9, now: NOW })).page).toBe(2);
    expect((await ai.listDrafts(viewer, { tab: "waiting", page: 0, now: NOW })).page).toBe(1);
  });
});

describe("DraftCardView", () => {
  it("builds a waiting card: snippet, host, language, read date, warnings, current line and cost", async () => {
    const co = await makeCompany({
      name: "Firma GmbH",
      website: "https://www.firma.de",
      personalLine: "Sara's own line.",
      personalLineSource: "manual",
      personalLineUpdatedById: sara.id,
      personalLineUpdatedAt: new Date("2026-03-03T09:00:00Z"),
    });
    const home = await snapshot(co, { title: "Firma", text: "Willkommen. Handbemalte Fantasy-Büsten im Maßstab 1:6. Kontakt." });
    const id = await makeDraft({
      companyId: co,
      status: "READY",
      line: "Your hand-painted 1:6 fantasy busts are made in your workshop.",
      evidenceQuote: "Handbemalte Fantasy-Büsten im Maßstab 1:6",
      evidenceSource: "homepage",
      evidenceUrl: "https://www.firma.de/",
      homeSnapshotId: home,
      costUsd: 0.0057,
      requestId: "req_abc",
      flags: [{ code: "injection-hint", text: "The website contains text addressed to AI; check the line carefully." }],
    });
    const [card] = (await ai.listDrafts({ id: ali.id, timeZone: TZ }, { tab: "waiting", now: NOW })).rows;
    expect(card).toEqual({
      id,
      status: "READY",
      company: { id: co, name: "Firma GmbH", website: "https://www.firma.de", host: "firma.de" },
      line: "Your hand-painted 1:6 fantasy busts are made in your workshop.",
      finalLine: null,
      words: 10,
      snippet: { before: "Firma Willkommen. ", match: "Handbemalte Fantasy-Büsten im Maßstab 1:6", after: ". Kontakt." },
      snippetNote: null,
      quote: "Handbemalte Fantasy-Büsten im Maßstab 1:6",
      evidenceUrl: "https://www.firma.de/",
      evidenceHost: "firma.de",
      pageLang: "de",
      readAt: "2026-09-25T09:00:00.000Z",
      flags: [{ code: "injection-hint", text: "The website contains text addressed to AI; check the line carefully." }],
      noLineText: null,
      error: null,
      requestId: "req_abc",
      currentLine: { line: "Sara's own line.", sourceText: "Written by Sara on 3 Mar" },
      reviewedText: null,
      canUndoUntil: null,
      costText: "$0.006",
    });
  });

  it("finds a quote in the title or on the other page, and explains a missing snippet", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    const home = await snapshot(co, { title: "Hand-painted 32mm miniatures", text: "Shop now." });
    const second = await snapshot(co, { title: "Galerie", text: "Resin busts at 1:6 scale.", kind: "second_page", lang: "en" });
    const card = async (data: Parameters<typeof makeDraft>[0]) => {
      const id = await makeDraft(data);
      return (await ai.draftCards({ id: ali.id, timeZone: TZ }, [id], NOW))[0]!;
    };
    const base = { companyId: co, status: "READY" as const, line: "A line.", homeSnapshotId: home, pageSnapshotId: second };

    const inTitle = await card({ ...base, evidenceQuote: "Hand-painted 32mm miniatures", evidenceSource: "homepage" });
    expect(inTitle.snippet).toEqual({ before: "", match: "Hand-painted 32mm miniatures", after: " Shop now." });

    const otherPage = await card({ ...base, evidenceQuote: "Resin busts at 1:6 scale", evidenceSource: "homepage" });
    expect(otherPage.snippet?.match).toBe("Resin busts at 1:6 scale");

    const approximate = await card({ ...base, evidenceQuote: "Resin busts at 1:8 scale", evidenceSource: "second_page" });
    expect(approximate).toMatchObject({ snippet: null, snippetNote: "The exact words weren't found on the saved page.", pageLang: "en" });

    const cleared = await card({ ...base, evidenceQuote: "Resin busts at 1:6 scale", evidenceSource: "second_page", pageSnapshotId: 999_999, homeSnapshotId: 999_998 });
    expect(cleared).toMatchObject({ snippet: null, snippetNote: "The saved page text was cleared; open the page to check the quote." });
  });

  it("shows who reviewed, 'edited', and Undo for the reviewer for 10 seconds only", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de", personalLine: "Edited line." });
    const reviewedAt = new Date(NOW.getTime() - 4_000);
    const id = await makeDraft({
      companyId: co,
      status: "APPROVED",
      line: "Claude's line.",
      finalLine: "Edited line.",
      reviewAction: "edited",
      reviewedById: ali.id,
      reviewedAt,
    });
    const [mine] = await ai.draftCards({ id: ali.id, timeZone: TZ }, [id], NOW);
    const day = formatShortDate(reviewedAt, TZ, NOW);
    expect(day).toMatch(/^26 Sept?$/);
    expect(mine).toMatchObject({
      reviewedText: `Approved by Ali on ${day} · edited`,
      canUndoUntil: new Date(reviewedAt.getTime() + 10_000).toISOString(),
      words: 2,
      currentLine: null,
    });
    const [theirs] = await ai.draftCards({ id: sara.id, timeZone: TZ }, [id], NOW);
    expect(theirs!.canUndoUntil).toBeNull();
    const [late] = await ai.draftCards({ id: ali.id, timeZone: TZ }, [id], new Date(reviewedAt.getTime() + 10_001));
    expect(late!.canUndoUntil).toBeNull();

    // Cleaning the spaces of Claude's line isn't an edit; an edit stays "edited" after a Regenerate replaced the action.
    const cleaned = await makeDraft({ companyId: co, status: "APPROVED", line: "Two  spaces.", finalLine: "Two spaces.", reviewAction: "approved", reviewedById: ali.id, reviewedAt });
    const regenerated = await makeDraft({ companyId: co, status: "APPROVED", line: "Claude's.", finalLine: "Mine.", reviewAction: "regenerated", reviewedById: ali.id, reviewedAt });
    const [c1, c2] = await ai.draftCards({ id: ali.id, timeZone: TZ }, [cleaned, regenerated], NOW);
    expect(c1!.reviewedText).toBe(`Approved by Ali on ${day}`);
    expect(c2).toMatchObject({ reviewedText: `Approved by Ali on ${day} · edited`, canUndoUntil: null });

    const rejected = await makeDraft({ companyId: co, status: "REJECTED", line: "R.", reviewAction: "rejected", reviewedById: sara.id, reviewedAt });
    const [r] = await ai.draftCards({ id: ali.id, timeZone: TZ }, [rejected], NOW);
    expect(r).toMatchObject({ reviewedText: `Rejected by Sara on ${day}`, canUndoUntil: null, currentLine: { line: "Edited line." } });
  });

  it("No line and Failed cards carry the reason and the error", async () => {
    const co = await makeCompany({ name: "Parked Co", website: "https://parked.example" });
    const skip = await snapshot(co, { title: null, text: "", fetchedAt: new Date("2026-09-24T10:00:00Z") });
    await dbWrite((c) => c.websiteSnapshot.update({ where: { id: skip }, data: { skipReason: "parked" } }));
    const noLine = await makeDraft({ companyId: co, status: "NO_LINE", reasonIfNull: "parked", homeSnapshotId: skip });
    const failed = await makeDraft({ companyId: co, status: "FAILED", error: "Claude couldn't be reached. Click Try again.", requestId: "req_9" });
    const [n, f] = await ai.draftCards({ id: ali.id, timeZone: TZ }, [noLine, failed], NOW);
    expect(n).toMatchObject({ noLineText: "Domain is parked or for sale", readAt: "2026-09-24T10:00:00.000Z", snippet: null, snippetNote: null, costText: "$0" });
    expect(f).toMatchObject({ error: "Claude couldn't be reached. Click Try again.", requestId: "req_9", noLineText: null });
    expect(f!.readAt).not.toBeNull();
  });
});

describe("runs and states", () => {
  it("lists running and waiting runs with their counts and spend", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    const running = await makeAiJob("RUNNING", { createdById: ali.id });
    const deferredAt = new Date(NOW.getTime() + 600_000);
    const deferred = await makeAiJob("QUEUED", { createdById: sara.id, runAt: deferredAt, result: { deferred: "rate-limited", carry: {} } });
    await makeAiJob("DONE");
    await makeDraft({ companyId: co, jobId: running, status: "READY", costUsd: 0.004 });
    await makeDraft({ companyId: co, jobId: running, status: "NO_LINE" });
    await makeDraft({ companyId: co, jobId: running, status: "DRAFTING", costUsd: 0.003 });
    await makeDraft({ companyId: co, jobId: running });
    await makeDraft({ companyId: co, jobId: deferred });
    const runs = await ai.activeRuns(NOW);
    expect(runs).toEqual([
      { jobId: running, total: 4, done: 2, spentUsd: 0.007, status: "RUNNING", waitingUntil: null, requestedByName: "Ali", deferred: null },
      { jobId: deferred, total: 1, done: 0, spentUsd: 0, status: "QUEUED", waitingUntil: deferredAt.toISOString(), requestedByName: "Sara", deferred: "rate-limited" },
    ]);
  });

  it("companyDraftState says drafting, waiting or nothing", async () => {
    const co = await makeCompany({ name: "Firma", website: "https://firma.de" });
    expect(await ai.companyDraftState(co)).toBeNull();
    const ready = await makeDraft({ companyId: co, status: "READY" });
    expect(await ai.companyDraftState(co)).toBe("waiting");
    await makeDraft({ companyId: co, status: "FETCHING" });
    expect(await ai.companyDraftState(co)).toBe("drafting");
    await dbWrite((c) => c.aiDraft.deleteMany({ where: { id: { not: ready } } }));
    await dbWrite((c) => c.aiDraft.update({ where: { id: ready }, data: { status: "APPROVED" } }));
    expect(await ai.companyDraftState(co)).toBeNull();
  });
});
