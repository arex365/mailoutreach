import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeClaude, type FakeClaudeConnection } from "../helpers/claude";
import { draftsOf, fixtureReader, makeCompany, ORIGIN, resetAiState, runAiJob, seedUsers, startRun, type TestUser } from "./harness";

/**
 * The drafting job over the fixture sites with the fake Claude (M5-DESIGN §8 P8 tests; B12 "AI checks and the link
 * picker (fixture sites)"): READY with quotes found in the stored snapshots, NO_LINE for unusable sites without a Claude
 * request, costs = usage × prices, the token measurement, `ai.draftsReady`; the injection, hidden-text and
 * metadata-only fixtures; and snapshot reuse.
 */

const t = await createTestDb("ai-drafting-run");
const { db, dbWrite } = await import("@/server/db");
const { normalizeForMatch } = await import("@/core/ai/normalize");
const { HAIKU_MODEL } = await import("@/core/ai/types");
const { STATE_KEYS } = await import("@/core/system-state");
const { regenerateDraft } = await import("@/server/services/ai/start");

let users: { owner: TestUser; ali: TestUser };
let cl: FakeClaudeConnection;

beforeAll(async () => {
  users = await seedUsers();
  cl = await connectFakeClaude();
});
afterEach(async () => {
  cl.fake.reset();
  await resetAiState(users.owner);
});
afterAll(async () => {
  await cl.stop();
  await db.$disconnect();
  t.cleanup();
});

function messageRequests() {
  return cl.fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/messages");
}

describe("a run over the fixture sites", () => {
  it("drafts the readable sites with Claude and gives the others No line without a request", async () => {
    const ids = {
      figuren: await makeCompany({ name: "Figuren Werkstatt", website: ORIGIN.deFiguren, country: "DE" }),
      butikk: await makeCompany({ name: "Butikk AS", website: ORIGIN.noButikk, country: "NO" }),
      grid: await makeCompany({ name: "Grid Shop", website: ORIGIN.shopGrid, country: "GB" }),
      jsOnly: await makeCompany({ name: "App Shop", website: ORIGIN.jsOnly }),
      parked: await makeCompany({ name: "Parked Co", website: ORIGIN.parked }),
      blocked: await makeCompany({ name: "Blocked Co", website: ORIGIN.blocked }),
      insta: await makeCompany({ name: "Insta Creator", instagram: "insta_creator" }),
    };
    const jobId = await startRun(users.ali, Object.values(ids));
    // Instagram only: skipped at the start, no draft.
    expect((await draftsOf(jobId)).has(ids.insta)).toBe(false);

    const { reader, transport } = await fixtureReader();
    const res = await runAiJob({ reader });
    expect(res.outcome).toBe("done");

    const drafts = await draftsOf(jobId);
    for (const key of ["figuren", "butikk", "grid"] as const) {
      const d = drafts.get(ids[key])!;
      expect(d).toMatchObject({
        status: "READY",
        model: HAIKU_MODEL,
        calls: 1,
        inputTokens: 3_000,
        outputTokens: 120,
        costUsd: 0.0036, // (3,000 × $1 + 120 × $5) / 1e6
        stopReason: "end_turn",
        reasonIfNull: null,
        error: null,
      });
      expect(d.requestId).toMatch(/^req_fake_\d+$/);
      expect(d.draftedAt).toBeInstanceOf(Date);
      expect(d.homeSnapshotId).not.toBeNull();
      // The quote is on the stored page it names (exactly the text Claude was sent).
      const snapId = d.evidenceSource === "second_page" ? d.pageSnapshotId : d.homeSnapshotId;
      const snap = await db.websiteSnapshot.findUniqueOrThrow({ where: { id: snapId! } });
      expect(normalizeForMatch(`${snap.title ?? ""}\n${snap.text}`)).toContain(normalizeForMatch(d.evidenceQuote!).replace(/[.]+$/, ""));
      expect(d.evidenceUrl).toBe(snap.finalUrl);
    }
    expect(drafts.get(ids.figuren)).toMatchObject({ evidenceSource: "second_page", evidenceUrl: `${ORIGIN.deFiguren}/galerie` });
    expect(drafts.get(ids.butikk)).toMatchObject({ evidenceSource: "second_page", evidenceUrl: `${ORIGIN.noButikk}/produkter` });

    for (const [key, code] of [["jsOnly", "js_only"], ["parked", "parked"], ["blocked", "blocked"]] as const) {
      const d = drafts.get(ids[key])!;
      expect(d).toMatchObject({ status: "NO_LINE", reasonIfNull: code, calls: 0, costUsd: null, draftedAt: null, model: HAIKU_MODEL });
      const skip = await db.websiteSnapshot.findUniqueOrThrow({ where: { id: d.homeSnapshotId! } });
      expect(skip).toMatchObject({ companyId: ids[key], skipReason: code, text: "" });
    }

    // Exactly three paid requests, none of them for the unusable sites.
    const sent = messageRequests();
    expect(sent).toHaveLength(3);
    for (const r of sent) {
      const text: string = r.body.messages[0].content;
      for (const origin of [ORIGIN.jsOnly, ORIGIN.parked, ORIGIN.blocked]) expect(text).not.toContain(new URL(origin).hostname);
      expect(r.body).toMatchObject({ model: HAIKU_MODEL, max_tokens: 600 });
      expect(r.body).not.toHaveProperty("temperature");
      expect(r.body.output_config).not.toHaveProperty("effort");
    }
    // The prompt's tokens were measured once with the free countTokens, and kept.
    expect(cl.fake.requests.filter((r) => r.path === "/v1/messages/count_tokens")).toHaveLength(1);
    const tokens = await db.systemState.findUniqueOrThrow({ where: { key: STATE_KEYS.aiTokens } });
    const entry = (tokens.value as { entries: Record<string, { systemTokens: number }> }).entries[`${HAIKU_MODEL}|pl-2026-09-26`];
    expect(entry?.systemTokens).toBeGreaterThan(1_000);

    // Snapshots: both pages of the German site, one of the shop grid's home and its collection.
    const figurenSnaps = await db.websiteSnapshot.findMany({ where: { companyId: ids.figuren }, orderBy: { id: "asc" } });
    expect(figurenSnaps.map((s) => [s.pageKind, s.finalUrl, s.lang])).toEqual([
      ["homepage", `${ORIGIN.deFiguren}/`, "de"],
      ["second_page", `${ORIGIN.deFiguren}/galerie`, "de"],
    ]);
    expect(transport.calls.length).toBeGreaterThan(6);

    // The requester is told; the job's summary says the same.
    const note = await db.notification.findFirstOrThrow({ where: { userId: users.ali.id, type: "ai.draftsReady" } });
    expect(note).toMatchObject({
      title: "AI lines ready to review",
      body: "3 lines are waiting for you. 3 companies got no line. Cost $0.01.",
      link: "/ai-lines",
    });
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "DONE", progressDone: 6, progressTotal: 6 });
    expect(job.result).toMatchObject({
      summary: "3 lines are waiting for review. 3 companies got no line. Cost $0.01.",
      ready: 3,
      noLine: 3,
      failed: 0,
      costUsd: 0.0108,
      stopped: null,
    });
  });

  it("a panel run tells nobody (the panel shows the result)", async () => {
    const id = await makeCompany({ name: "Panel Co", website: ORIGIN.shopGrid });
    const jobId = await startRun(users.ali, [id], { source: "panel" });
    const before = await db.notification.count({ where: { type: "ai.draftsReady" } });
    const { reader } = await fixtureReader();
    expect((await runAiJob({ reader })).outcome).toBe("done");
    expect((await draftsOf(jobId)).get(id)?.status).toBe("READY");
    expect(await db.notification.count({ where: { type: "ai.draftsReady" } })).toBe(before);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).result).toMatchObject({ summary: "1 line is waiting for review. Cost less than $0.01." });
  });
});

describe("the company is read again when it is drafted", () => {
  it("deleted after the start → FAILED; website removed → No line; an Instagram link put in → No line, social only", async () => {
    const deleted = await makeCompany({ name: "Gone Co", website: ORIGIN.shopGrid });
    const noSite = await makeCompany({ name: "No Site Co", website: ORIGIN.noButikk });
    const social = await makeCompany({ name: "Social Co", website: ORIGIN.deFiguren });
    const jobId = await startRun(users.ali, [deleted, noSite, social]);
    await dbWrite(async (c) => {
      await c.company.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
      await c.company.update({ where: { id: noSite }, data: { website: null, domain: null } });
      await c.company.update({ where: { id: social }, data: { website: "https://www.instagram.com/social_co", domain: null } });
    });
    const { reader, transport } = await fixtureReader();
    expect((await runAiJob({ reader })).outcome).toBe("done");
    const drafts = await draftsOf(jobId);
    expect(drafts.get(deleted)).toMatchObject({ status: "FAILED", error: "This company was deleted.", calls: 0 });
    expect(drafts.get(noSite)).toMatchObject({ status: "NO_LINE", reasonIfNull: "no_website", calls: 0 });
    expect(drafts.get(social)).toMatchObject({ status: "NO_LINE", reasonIfNull: "social_only", calls: 0 });
    expect(transport.calls).toHaveLength(0);
    expect(messageRequests()).toHaveLength(0);
    expect((await db.notification.findFirstOrThrow({ where: { userId: users.ali.id, type: "ai.draftsReady" }, orderBy: { id: "desc" } })).body).toBe(
      "2 companies got no line and 1 failed.",
    );
  });
});

describe("untrusted pages", () => {
  it("injection: READY with the warning, and our tags never reach Claude from the page", async () => {
    const id = await makeCompany({ name: "Miniatur Studio Nord", website: ORIGIN.injection, country: "DE" });
    const jobId = await startRun(users.ali, [id]);
    const { reader } = await fixtureReader();
    await runAiJob({ reader });
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d.status).toBe("READY");
    expect(d.flags).toEqual(expect.arrayContaining([{ code: "injection-hint", text: "The website contains text addressed to AI; check the line carefully." }]));

    const full: string = messageRequests()[0]!.body.messages[0].content;
    // The data blocks (the last line is our task sentence, which names the tags).
    const text = full.slice(0, full.lastIndexOf("\n"));
    // Exactly our own tags: the page's nested "<<company/website_pages>" and its encoded tags were stripped.
    expect(text.split("<website_pages>")).toHaveLength(2);
    expect(text.split("</website_pages>")).toHaveLength(2);
    expect(text.split("<company>")).toHaveLength(2);
    expect(text.split("</company>")).toHaveLength(2);
    expect(text).not.toContain("<<company");
    expect(text).not.toContain("<company/website_pages>");
    expect(text).toContain("Miniatur Studio");
  });

  it("hidden text: READY with the hidden-text warning", async () => {
    const id = await makeCompany({ name: "Escape Props", website: ORIGIN.hiddenText });
    const jobId = await startRun(users.ali, [id]);
    const { reader } = await fixtureReader();
    await runAiJob({ reader });
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d.status).toBe("READY");
    expect(d.flags).toEqual(expect.arrayContaining([{ code: "hidden-text", text: "The website hides some text from visitors; check the line carefully." }]));
  });

  it("a metadata-only page: its metadata is what Claude gets and what the quote is checked against", async () => {
    const id = await makeCompany({ name: "Mythwood Miniatures", website: ORIGIN.jsMeta });
    const jobId = await startRun(users.ali, [id]);
    const { reader } = await fixtureReader();
    await runAiJob({ reader });
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d.status).toBe("READY");
    expect(d.flags).toEqual(expect.arrayContaining([expect.objectContaining({ code: "metadata-only" })]));
    const snap = await db.websiteSnapshot.findUniqueOrThrow({ where: { id: d.homeSnapshotId! } });
    expect(snap.notes).toEqual(["metadata-only"]);
    const page = JSON.parse((messageRequests()[0]!.body.messages[0].content as string).split("\n")[2]!) as { text: string };
    expect(page.text).toBe(snap.text);
    expect(normalizeForMatch(snap.text)).toContain(normalizeForMatch(d.evidenceQuote!));
  });

  it("a quote from page text that was never sent fails the quote check, twice → READY with the warning", async () => {
    const id = await makeCompany({ name: "Mythwood Two", website: ORIGIN.jsMeta });
    // The noscript text is removed by the extraction: Claude never saw it.
    cl.fake.script((u) => u.includes("js-meta.example"), {
      evidence_source: "homepage",
      evidence_quote: "Please enable JavaScript to view our shop",
      line: "You cast fantasy heroes and monsters in grey resin as unassembled kits.",
      reason_if_null: null,
    });
    const jobId = await startRun(users.ali, [id]);
    const { reader } = await fixtureReader();
    await runAiJob({ reader });
    const d = (await draftsOf(jobId)).get(id)!;
    expect(d).toMatchObject({ status: "READY", calls: 2 });
    expect(d.flags).toEqual(expect.arrayContaining([{ code: "quote-not-found", text: "The quote wasn't found word for word on the page." }]));
    expect(messageRequests()[1]!.body.messages[0].content).toContain(
      "<previous_problem>The evidence quote was not found word for word on the page. Copy it exactly.</previous_problem>",
    );
  });
});

describe("snapshots", () => {
  it("a second run within 30 days reuses them; Read the website again reads it again", async () => {
    const id = await makeCompany({ name: "Reuse Werkstatt", website: ORIGIN.deFiguren });
    const { reader, transport } = await fixtureReader();
    const first = await startRun(users.ali, [id]);
    await runAiJob({ reader });
    const d1 = (await draftsOf(first)).get(id)!;
    expect(d1.status).toBe("READY");
    const callsAfterFirst = transport.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Reviewed, so the company can be drafted again.
    await dbWrite((c) => c.aiDraft.update({ where: { id: d1.id }, data: { status: "REJECTED", reviewAction: "rejected" } }));
    const second = await startRun(users.ali, [id]);
    await runAiJob({ reader });
    const d2 = (await draftsOf(second)).get(id)!;
    expect(d2.status).toBe("READY");
    expect(transport.calls.length).toBe(callsAfterFirst);
    expect([d2.homeSnapshotId, d2.pageSnapshotId]).toEqual([d1.homeSnapshotId, d1.pageSnapshotId]);

    // Regenerate with "Read the website again": a fresh read and new snapshots.
    const { jobId: third } = await regenerateDraft(users.ali, d2.id, { refetch: true });
    await runAiJob({ reader });
    const d3 = [...(await draftsOf(third)).values()][0]!;
    expect(d3.refetch).toBe(true);
    expect(transport.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(d3.homeSnapshotId).not.toBe(d1.homeSnapshotId);
    // The regenerated draft was asked not to repeat the earlier lines.
    expect(messageRequests().at(-1)!.body.messages[0].content).toContain("<avoid_repeating>");
  });

  it("a skip from the last 24 hours is reused without reading the site again", async () => {
    const id = await makeCompany({ name: "Parked Again", website: ORIGIN.parked });
    const { reader, transport } = await fixtureReader();
    const first = await startRun(users.ali, [id]);
    await runAiJob({ reader });
    expect((await draftsOf(first)).get(id)).toMatchObject({ status: "NO_LINE", reasonIfNull: "parked" });
    const reads = transport.calls.length;

    const second = await startRun(users.ali, [id]);
    await runAiJob({ reader });
    expect((await draftsOf(second)).get(id)).toMatchObject({ status: "NO_LINE", reasonIfNull: "parked", calls: 0 });
    expect(transport.calls.length).toBe(reads);
    expect(messageRequests()).toHaveLength(0);
  });
});
