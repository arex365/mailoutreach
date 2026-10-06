import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CompanyStatus } from "@/generated/prisma/client";
import { createTestDb } from "../helpers/test-db";

/**
 * The Companies tile's numbers (M6-DESIGN §4.3, D8): the status counts and the reply rate. Emailed = companies (not
 * deleted) with `firstContactedAt`; replied = those with `repliedAt`; last 30 days by `firstContactedAt`.
 */

const t = await createTestDb("dashboard-pipeline");
const { db, dbWrite } = await import("@/server/db");
const { loadPipeline, REPLY_RATE_RECENT_DAYS } = await import("@/server/services/dashboard/pipeline");
const { replyRate30Text, replyRateText } = await import("@/core/dashboard/pipeline");

const DAY = 86_400_000;
const NOW = new Date("2026-09-23T08:00:00.000Z");
let seq = 0;

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  await dbWrite((c) => c.company.deleteMany({}));
});

async function company(opts: {
  status?: CompanyStatus;
  firstContactedAt?: Date | null;
  repliedAt?: Date | null;
  importedLastContactAt?: Date | null;
  deleted?: boolean;
}) {
  seq += 1;
  const name = `Company ${seq}`;
  return dbWrite((c) =>
    c.company.create({
      data: {
        name,
        nameNorm: name.toLowerCase(),
        status: opts.status ?? "NOT_CONTACTED",
        firstContactedAt: opts.firstContactedAt ?? null,
        repliedAt: opts.repliedAt ?? null,
        importedLastContactAt: opts.importedLastContactAt ?? null,
        deletedAt: opts.deleted ? new Date(NOW.getTime() - DAY) : null,
      },
    }),
  );
}

describe("loadPipeline", () => {
  it("is all zero with no companies: 'No companies emailed yet.'", async () => {
    const view = await loadPipeline(NOW);
    expect(view.counts).toEqual({
      all: 0,
      byStatus: { NOT_CONTACTED: 0, CONTACTED: 0, REPLIED: 0, CLIENT: 0, NOT_INTERESTED: 0, DO_NOT_CONTACT: 0 },
    });
    expect(view.replyRate).toEqual({ replied: 0, emailed: 0, last30: { replied: 0, emailed: 0 } });
    expect(replyRateText(view.replyRate)).toBe("No companies emailed yet.");
    expect(replyRate30Text(view.replyRate)).toBeNull();
  });

  it("counts statuses of companies that aren't deleted", async () => {
    await company({ status: "NOT_CONTACTED" });
    await company({ status: "NOT_CONTACTED" });
    await company({ status: "CONTACTED", firstContactedAt: new Date(NOW.getTime() - 2 * DAY) });
    await company({ status: "REPLIED", firstContactedAt: new Date(NOW.getTime() - 3 * DAY), repliedAt: new Date(NOW.getTime() - DAY) });
    await company({ status: "CLIENT", firstContactedAt: new Date(NOW.getTime() - 90 * DAY), repliedAt: new Date(NOW.getTime() - 80 * DAY) });
    await company({ status: "DO_NOT_CONTACT" });
    await company({ status: "CONTACTED", deleted: true, firstContactedAt: new Date(NOW.getTime() - DAY) });
    const view = await loadPipeline(NOW);
    expect(view.counts).toEqual({
      all: 6,
      byStatus: { NOT_CONTACTED: 2, CONTACTED: 1, REPLIED: 1, CLIENT: 1, NOT_INTERESTED: 0, DO_NOT_CONTACT: 1 },
    });
  });

  it("the reply rate leaves out deleted companies and imported-only contacts; last 30 days by first contact", async () => {
    const recent = (days: number) => new Date(NOW.getTime() - days * DAY);
    // Emailed in the last 30 days: 3, one of them replied.
    await company({ status: "CONTACTED", firstContactedAt: recent(1) });
    await company({ status: "CONTACTED", firstContactedAt: recent(29) });
    await company({ status: "REPLIED", firstContactedAt: recent(10), repliedAt: recent(2) });
    // Emailed earlier: 2, both replied (one only yesterday: it still belongs to its first-contact month).
    await company({ status: "REPLIED", firstContactedAt: recent(40), repliedAt: recent(1) });
    await company({ status: "CLIENT", firstContactedAt: recent(200), repliedAt: recent(190) });
    // Not counted: deleted (emailed and replied), imported-only (replied too), never contacted.
    await company({ status: "REPLIED", firstContactedAt: recent(5), repliedAt: recent(4), deleted: true });
    await company({ status: "REPLIED", importedLastContactAt: recent(100), repliedAt: recent(3) });
    await company({ status: "CONTACTED", importedLastContactAt: recent(60) });
    await company({});

    const view = await loadPipeline(NOW);
    expect(view.replyRate).toEqual({ replied: 3, emailed: 5, last30: { replied: 1, emailed: 3 } });
    expect(replyRateText(view.replyRate)).toBe("Reply rate: 60% (3 of 5 companies you emailed replied)");
    expect(replyRate30Text(view.replyRate)).toBe("Last 30 days: 33% (1 of 3)");
  });

  it("the last 30 days start exactly 30 days before now", async () => {
    expect(REPLY_RATE_RECENT_DAYS).toBe(30);
    await company({ status: "CONTACTED", firstContactedAt: new Date(NOW.getTime() - 30 * DAY) });
    await company({ status: "CONTACTED", firstContactedAt: new Date(NOW.getTime() - 30 * DAY - 1) });
    const view = await loadPipeline(NOW);
    expect(view.replyRate).toEqual({ replied: 0, emailed: 2, last30: { replied: 0, emailed: 1 } });
    expect(replyRateText(view.replyRate)).toBe("Reply rate: 0% (0 of 2 companies you emailed replied)");
    expect(replyRate30Text(view.replyRate)).toBe("Last 30 days: 0% (0 of 1)");
  });
});
