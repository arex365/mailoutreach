import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeUser, setSettingValue } from "../campaigns/seed";

const t = await createTestDb("wizard-perf");
const { db, dbWrite } = await import("@/server/db");
const { createDraft, loadReviewPage, loadLaunchSummary } = await import("@/server/services/campaigns/draft");
const { loadAudiencePage, setPersonTicked } = await import("@/server/services/campaigns/audience");

const COMPANIES = 2_000;
let ali: { id: number; name: string };
let companyIds: number[] = [];

beforeAll(async () => {
  ali = await makeUser("Ali", { email: "ali@polygonparadise.test" });
  await setSettingValue("sending.mode", "DRY_RUN");
  const rows = Array.from({ length: COMPANIES }, (_, i) => {
    const n = String(i).padStart(4, "0");
    return { name: `Perf ${n} GmbH`, nameNorm: `perf ${n}`, domain: `perf${n}.de`, website: `https://perf${n}.de`, searchText: `perf ${n} perf${n}.de` };
  });
  await dbWrite((c) => c.company.createMany({ data: rows }));
  const companies = await db.company.findMany({ select: { id: true, domain: true }, orderBy: { id: "asc" } });
  companyIds = companies.map((c) => c.id);
  const people = companies.flatMap((c, i) => {
    const list = [{ companyId: c.id, name: `Anna ${i}`, firstName: "Anna", email: `anna@${c.domain}`, emailNorm: `anna@${c.domain}` }];
    if (i % 3 === 0) list.push({ companyId: c.id, name: "General inbox", firstName: "", email: `info@${c.domain}`, emailNorm: `info@${c.domain}` });
    return list;
  });
  for (let i = 0; i < people.length; i += 500) {
    const chunk = people.slice(i, i + 500);
    await dbWrite((c) => c.person.createMany({ data: chunk }));
  }
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("a 2,000-company audience stays quick", () => {
  it("creates the draft, pages the audience, ticks, and renders Review in reasonable time", async () => {
    let started = Date.now();
    const d = await createDraft(ali, { companyIds });
    const createMs = Date.now() - started;
    expect(d.added).toMatchObject({ added: COMPANIES, ticked: COMPANIES });

    started = Date.now();
    const page = await loadAudiencePage(d.id, { section: "included", page: 3 });
    const pageMs = Date.now() - started;
    expect(page.companies).toHaveLength(50);
    expect(page.totals).toMatchObject({ people: COMPANIES, companies: COMPANIES, all: COMPANIES });

    started = Date.now();
    const person = await db.person.findFirstOrThrow({ where: { companyId: companyIds[0]!, isGeneric: false } });
    await setPersonTicked(ali, d.id, person.id, false);
    const tickMs = Date.now() - started;

    started = Date.now();
    const review = await loadReviewPage(d.id, { filter: "missing" });
    const reviewMs = Date.now() - started;
    expect(review.counts.all).toBe(COMPANIES - 1);

    started = Date.now();
    const summary = await loadLaunchSummary(d.id);
    const summaryMs = Date.now() - started;
    expect(summary.people).toBe(COMPANIES - 1);

    console.info(`[wizard perf] create ${createMs} ms, audience page ${pageMs} ms, tick ${tickMs} ms, review ${reviewMs} ms, summary ${summaryMs} ms`);
    // Generous ceilings (a slow laptop running other tests at the same time): the real numbers are logged above.
    expect(pageMs).toBeLessThan(5_000);
    expect(tickMs).toBeLessThan(2_000);
    expect(reviewMs).toBeLessThan(10_000);
  }, 120_000);
});
