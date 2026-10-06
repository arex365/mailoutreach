import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The daily clean-up's Milestone 5 rules (M5-DESIGN §3.4.9, D17): saved website pages older than 60 days go unless a
 * waiting (READY) or in-progress (QUEUED, FETCHING, DRAFTING) draft points at them; saved robots.txt files older than
 * 7 days go.
 */

const t = await createTestDb("worker-cleanup-snapshots");
const { db, dbWrite } = await import("@/server/db");
const { runCleanup, cleanupSummary, CLEANUP_RULES } = await import("../../../worker/jobs/cleanup");

const dirs: string[] = [];

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = new Date("2026-09-26T10:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
/** Empty folders for the log and test-file rules, so the run touches no real files. */
function emptyDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-m5-"));
  dirs.push(d);
  return d;
}

describe("snapshots and robots.txt", () => {
  it("deletes old pages no waiting or in-progress draft uses, and old robots.txt files", async () => {
    const company = await dbWrite((c) => c.company.create({ data: { name: "Figuren Werkstatt", nameNorm: "figuren werkstatt" } }));
    const snap = (days: number, kind = "homepage") =>
      dbWrite((c) =>
        c.websiteSnapshot.create({
          data: { companyId: company.id, url: `https://www.figuren-werkstatt.example/${days}`, pageKind: kind, text: "Wir bauen Figuren.", chars: 18, fetchedAt: ago(days) },
        }),
      );
    const fresh = await snap(59);
    const oldFree = await snap(61);
    const oldFree2 = await snap(90, "second_page");
    const oldForReady = await snap(70);
    const oldForReadyPage = await snap(70, "second_page");
    const oldForDrafting = await snap(65);
    const oldForApproved = await snap(80);
    const oldForRejected = await snap(80);
    const draft = (status: "READY" | "DRAFTING" | "APPROVED" | "REJECTED", home: number | null, page: number | null = null) =>
      dbWrite((c) =>
        c.aiDraft.create({ data: { companyId: company.id, model: "claude-haiku-4-5-20251001", promptVersion: "p1", status, homeSnapshotId: home, pageSnapshotId: page } }),
      );
    await draft("READY", oldForReady.id, oldForReadyPage.id);
    await draft("DRAFTING", oldForDrafting.id);
    await draft("APPROVED", oldForApproved.id);
    await draft("REJECTED", null, oldForRejected.id);

    await dbWrite((c) =>
      c.robotsCache.createMany({
        data: [
          { host: "https://www.figuren-werkstatt.example", status: 200, body: "User-agent: *\nAllow: /", fetchedAt: ago(8) },
          { host: "https://butikk.example", status: 404, body: "", fetchedAt: ago(6) },
        ],
      }),
    );

    const counts = await runCleanup({ now: NOW, logsDir: emptyDir(), testDataDir: emptyDir() });
    expect(counts).toMatchObject({ snapshots: 4, robots: 1 });
    const left = (await db.websiteSnapshot.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((s) => s.id);
    expect(left).toEqual([fresh.id, oldForReady.id, oldForReadyPage.id, oldForDrafting.id].sort((a, b) => a - b));
    expect(left).not.toContain(oldFree.id);
    expect(left).not.toContain(oldFree2.id);
    expect(left).not.toContain(oldForApproved.id);
    expect(left).not.toContain(oldForRejected.id);
    expect((await db.robotsCache.findMany()).map((r) => r.host)).toEqual(["https://butikk.example"]);

    expect(cleanupSummary(counts)).toBe("Removed 4 saved website pages older than 60 days and 1 saved robots.txt file older than 7 days.");
    expect(CLEANUP_RULES).toMatchObject({ snapshotDays: 60, robotsDays: 7 });

    // A second run finds nothing more.
    expect(await runCleanup({ now: NOW, logsDir: emptyDir(), testDataDir: emptyDir() })).toMatchObject({ snapshots: 0, robots: 0 });
  });

  it("walks more than one chunk of 500 pages", async () => {
    const company = await dbWrite((c) => c.company.create({ data: { name: "Butikk AS", nameNorm: "butikk as" } }));
    await dbWrite((c) =>
      c.websiteSnapshot.createMany({
        data: Array.from({ length: 1_203 }, (_, i) => ({
          companyId: company.id,
          url: `https://butikk.example/p${i}`,
          pageKind: "homepage",
          text: "",
          chars: 0,
          skipReason: "unreachable",
          fetchedAt: ago(100),
        })),
      }),
    );
    const kept = await dbWrite((c) =>
      c.websiteSnapshot.create({ data: { companyId: company.id, url: "https://butikk.example/", pageKind: "homepage", text: "Keramikk", chars: 8, fetchedAt: ago(100) } }),
    );
    await dbWrite((c) => c.aiDraft.create({ data: { companyId: company.id, model: "m", promptVersion: "p1", status: "QUEUED", homeSnapshotId: kept.id } }));
    const counts = await runCleanup({ now: NOW, logsDir: emptyDir(), testDataDir: emptyDir() });
    expect(counts.snapshots).toBe(1_203);
    expect(await db.websiteSnapshot.count({ where: { companyId: company.id } })).toBe(1);
  });
});
