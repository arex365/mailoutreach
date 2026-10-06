import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeCompany, makeDraft, seedUsers, type SeedUser } from "./seed";

/**
 * The drafting estimate on real rows (docs/dev/M5-DESIGN.md §3.3, §8 P5 "estimate"): the Haiku and Sonnet defaults,
 * measured `ai.tokens`, running averages after 10 drafts, `mayReachLimit` / `overLimit`, and the office month
 * (Asia/Karachi): a draft whose last call ended 30 Sep 19:30 UTC is October's spend.
 */

const t = await createTestDb("ai-estimate");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const { STATE_KEYS } = await import("@/core/system-state");
const { formatUsd } = await import("@/core/money");
const { estimateDraftRun, monthSpendUsd, aiSpendThisMonth } = await import("@/server/services/ai");

const HAIKU = "claude-haiku-4-5-20251001";
const NOW = new Date("2026-09-26T08:00:00Z");
let owner: SeedUser;
let companyId: number;

beforeAll(async () => {
  ({ owner } = await seedUsers());
  companyId = await makeCompany({ name: "Firma GmbH", website: "https://firma.de" });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.aiDraft.deleteMany({});
    await c.systemState.deleteMany({ where: { key: STATE_KEYS.aiTokens } });
  });
  await setSetting("ai.monthlyLimitUsd", 20, owner.id);
  await setSetting("ai.model", HAIKU, owner.id);
  await setSetting("practice.copy", false, owner.id);
});

describe("estimateDraftRun", () => {
  it("uses the profile defaults: Haiku about $1.69, at most $3.15 per 300; Sonnet $5.91 / $12.77", async () => {
    const haiku = await estimateDraftRun(300, NOW);
    expect(haiku).toMatchObject({ companies: 300, model: HAIKU, modelLabel: "Claude Haiku 4.5", practiceCopy: false, priceMissing: false });
    expect(formatUsd(haiku.aboutUsd)).toBe("$1.69");
    expect(formatUsd(haiku.atMostUsd)).toBe("$3.15");
    const sonnet = await estimateDraftRun(300, NOW, { model: "claude-sonnet-5" });
    expect(sonnet.modelLabel).toBe("Claude Sonnet 5");
    expect(formatUsd(sonnet.aboutUsd)).toBe("$5.91");
    expect(formatUsd(sonnet.atMostUsd)).toBe("$12.77");
    expect(haiku.monthly).toEqual({ limitUsd: 20, spentUsd: 0, leftUsd: 20, monthLabel: "September", resetLabel: "1 October" });
    expect(haiku.overLimit).toBe(false);
    expect(haiku.mayReachLimit).toBe(false);
  });

  it("uses the measured system tokens of the model and prompt version", async () => {
    await setState(STATE_KEYS.aiTokens, { entries: { [`${HAIKU}|pl-2026-09-26`]: { systemTokens: 2_000, measuredAt: NOW.toISOString() } } });
    const e = await estimateDraftRun(300, NOW);
    // about = ((2,000 + 2,500) × $1 + 200 × $5) / 1e6 × 1.15 × 300; at most = ((2,000 + 4,000) + 600 × 5) / 1e6 × 1.25 × 300.
    expect(e.aboutUsd).toBeCloseTo(1.8975, 6);
    expect(e.atMostUsd).toBeCloseTo(3.375, 6);
    // Another prompt version's measurement doesn't count.
    await setState(STATE_KEYS.aiTokens, { entries: { [`${HAIKU}|pl-old`]: { systemTokens: 9_000, measuredAt: NOW.toISOString() } } });
    expect(formatUsd((await estimateDraftRun(300, NOW)).aboutUsd)).toBe("$1.69");
  });

  it("switches to running averages once 10 drafts of the model were drafted (cost-estimated ones left out)", async () => {
    const drafted = (i: number, extra: Partial<Parameters<typeof makeDraft>[0]> = {}) =>
      makeDraft({
        companyId,
        status: "READY",
        model: HAIKU,
        inputTokens: 2_400,
        outputTokens: 100,
        calls: 1,
        costUsd: 0.001,
        draftedAt: new Date(Date.UTC(2026, 7, 1 + i)),
        ...extra,
      });
    for (let i = 0; i < 9; i++) await drafted(i);
    // A draft of another model and one whose cost was estimated don't count.
    await drafted(20, { model: "claude-sonnet-5", inputTokens: 90_000 });
    await drafted(21, { inputTokens: 90_000, flags: [{ code: "cost-estimated", text: "estimate" }] });
    expect(formatUsd((await estimateDraftRun(300, NOW)).aboutUsd)).toBe("$1.69");

    await drafted(9);
    // Page tokens 2,400 − 1,400 = 1,000, output 100: ((1,400 + 1,000) × $1 + 100 × $5) / 1e6 × 1.15 × 300 = $1.0005.
    const e = await estimateDraftRun(300, NOW);
    expect(e.aboutUsd).toBeCloseTo(1.0005, 6);
    // "At most" never follows the averages: it stays the cap and max_tokens.
    expect(formatUsd(e.atMostUsd)).toBe("$3.15");
  });

  it("drafts that were never billed (0-token error answers) don't pull the averages down (AI-8)", async () => {
    const drafted = (i: number, extra: Partial<Parameters<typeof makeDraft>[0]> = {}) =>
      makeDraft({
        companyId,
        status: "READY",
        model: HAIKU,
        inputTokens: 2_400,
        outputTokens: 100,
        calls: 1,
        costUsd: 0.001,
        draftedAt: new Date(Date.UTC(2026, 7, 1 + i)),
        ...extra,
      });
    for (let i = 0; i < 10; i++) await drafted(i);
    const expected = (await estimateDraftRun(300, NOW)).aboutUsd;
    expect(expected).toBeCloseTo(1.0005, 6);
    // Twenty newer FAILED drafts whose only call was a 400, as recorded before such calls stopped counting.
    for (let i = 0; i < 20; i++) {
      await drafted(20 + i, { status: "FAILED", inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 });
    }
    expect((await estimateDraftRun(300, NOW)).aboutUsd).toBeCloseTo(expected, 6);
  });

  it("warns when the run may reach the limit and refuses once the month's spend reached it", async () => {
    await setSetting("ai.monthlyLimitUsd", 2, owner.id);
    await makeDraft({ companyId, status: "APPROVED", costUsd: 1.5, calls: 3, draftedAt: new Date("2026-09-02T10:00:00Z") });
    let e = await estimateDraftRun(300, NOW);
    expect(e.monthly).toMatchObject({ limitUsd: 2, spentUsd: 1.5, leftUsd: 0.5 });
    expect(e).toMatchObject({ mayReachLimit: true, overLimit: false });
    expect((await estimateDraftRun(10, NOW)).mayReachLimit).toBe(false);

    await makeDraft({ companyId, status: "FAILED", costUsd: 0.5, calls: 1, draftedAt: new Date("2026-09-20T10:00:00Z") });
    e = await estimateDraftRun(1, NOW);
    expect(e.monthly.leftUsd).toBe(0);
    expect(e.overLimit).toBe(true);
  });

  it("counts the office month in Karachi: 30 Sep 19:30 UTC is October", async () => {
    await makeDraft({ companyId, status: "READY", costUsd: 0.25, calls: 1, draftedAt: new Date("2026-09-30T19:30:00Z") });
    await makeDraft({ companyId, status: "READY", costUsd: 0.5, calls: 1, draftedAt: new Date("2026-09-30T18:59:00Z") });
    expect(await monthSpendUsd(new Date("2026-09-30T18:00:00Z"))).toBe(0.5);
    expect(await monthSpendUsd(new Date("2026-10-05T12:00:00Z"))).toBe(0.25);
    const october = await estimateDraftRun(1, new Date("2026-09-30T19:31:00Z"));
    expect(october.monthly).toMatchObject({ spentUsd: 0.25, monthLabel: "October", resetLabel: "1 November" });
    const spend = await aiSpendThisMonth(new Date("2026-10-01T00:00:00Z"));
    expect(spend).toMatchObject({ usd: 0.25, drafts: 1 });
    expect(spend.bounds.start.toISOString()).toBe("2026-09-30T19:00:00.000Z");
  });

  it("is $0 in the practice copy, with no limit", async () => {
    await setSetting("practice.copy", true, owner.id);
    await setSetting("ai.monthlyLimitUsd", 1, owner.id);
    await makeDraft({ companyId, status: "APPROVED", costUsd: 3, calls: 1, draftedAt: new Date("2026-09-02T10:00:00Z") });
    const e = await estimateDraftRun(300, NOW);
    expect(e).toMatchObject({ practiceCopy: true, aboutUsd: 0, atMostUsd: 0, overLimit: false, mayReachLimit: false });
  });

  it("says when a custom model has no price", async () => {
    await setSetting("ai.customModel", { id: "claude-x", label: "Claude X", maxTokens: 3_000, effortLow: false, checkedAt: NOW.toISOString() }, owner.id);
    const e = await estimateDraftRun(10, NOW, { model: "claude-x" });
    expect(e).toMatchObject({ model: "claude-x", modelLabel: "Claude X", priceMissing: true, aboutUsd: 0, atMostUsd: 0 });
    await setSetting("ai.prices", { "claude-x": { inputPerMTok: 3, outputPerMTok: 15 } }, owner.id);
    const priced = await estimateDraftRun(10, NOW, { model: "claude-x" });
    expect(priced.priceMissing).toBe(false);
    // ((1,820 + 5,200) × $3 + 3,000 × $15) / 1e6 × 1.25 × 10.
    expect(priced.atMostUsd).toBeCloseTo(((7_020 * 3 + 45_000) / 1e6) * 1.25 * 10, 6);
    await setSetting("ai.customModel", null, owner.id);
  });
});
