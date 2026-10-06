import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportOptions } from "@/core/import/types";
import type { JobContext } from "@/server/jobs";
import { createTestDb } from "../helpers/test-db";
import { email, enroll, makeCampaign, makePerson, recipient } from "../stops-holds/world";

/**
 * A status set by an import stops follow-ups like the same status set in the panel (SPEC-07, M4-DESIGN §2.7, D18,
 * owner note §12.3 item 5): when a file with "update duplicates" moves a company to Replied, Client, Not interested or
 * Do not contact, its open recipients in every campaign stop at once ("status:<STATUS>", their queued emails skipped),
 * and a campaign left with nothing to send finishes after the import. Other statuses stop nothing.
 */

const t = await createTestDb("import-status-stops");
const { db, dbWrite } = await import("@/server/db");
const { parseUploadedFile } = await import("@/server/services/imports/parse-file");
const { createImportSession } = await import("@/server/services/imports/sessions");
const { runImportCommitJob } = await import("@/server/services/imports/commit");
const { suggestMapping } = await import("@/core/import/column-matching");
const { DEFAULT_IMPORT_OPTIONS } = await import("@/core/import/types");

let ali: { id: number; name: string };

beforeAll(async () => {
  ali = await dbWrite((c) => c.user.create({ data: { email: "ali@example.com", name: "Ali", role: "OWNER" }, select: { id: true, name: true } }));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

async function stage(text: string, options: Partial<ImportOptions> = {}) {
  const parsed = parseUploadedFile(new TextEncoder().encode(text), "old-tool.csv");
  const id = await createImportSession({ userId: ali.id, fileName: "old-tool.csv", parsed });
  const mapping = suggestMapping(parsed.table.headers, parsed.table.rows.map((r) => r.cells)).map((s) => s.mapping);
  await dbWrite((c) => c.importSession.update({ where: { id }, data: { mapping, options: { ...DEFAULT_IMPORT_OPTIONS, ...options }, status: "MAPPED" } }));
  return id;
}

function ctx(): JobContext {
  return { jobId: 1, createdById: ali.id, signal: new AbortController().signal, progress: async () => undefined };
}

async function company(name: string, domain: string, status: "CONTACTED" | "NOT_CONTACTED" = "CONTACTED") {
  return dbWrite((c) =>
    c.company.create({ data: { name, nameNorm: name.toLowerCase(), website: `https://${domain}`, domain, country: "DE", status } }),
  );
}

describe("an import that changes a company's status (SPEC-07)", () => {
  it("stops the follow-ups of companies it marks Do not contact, Replied or Client, in every campaign, and finishes emptied campaigns", async () => {
    const germany = await makeCampaign({ createdById: ali.id, senderId: ali.id, name: "Germany Q4" });
    const nordics = await makeCampaign({ createdById: ali.id, senderId: ali.id, name: "Nordics" });

    const firma = await company("Firma GmbH", "firma.de");
    const anna = await enroll(germany, await makePerson(firma.id, "anna@firma.de", "Anna Berg")); // follow-up 1 waiting
    const ben = await enroll(germany, await makePerson(firma.id, "ben@firma.de", "Ben Braun"), { first: true }); // first email waiting
    const annaNordics = await enroll(nordics, await makePerson(firma.id, "info@firma.de", "General inbox"));

    const nord = await company("Nord Studio", "nord.no");
    const ola = await enroll(nordics, await makePerson(nord.id, "ola@nord.no", "Ola Nordmann"));

    const buyer = await company("Buyer Co", "buyer.de");
    const bo = await enroll(germany, await makePerson(buyer.id, "bo@buyer.de", "Bo Berg"));

    const talking = await company("Talking Co", "talking.de", "NOT_CONTACTED");
    const tom = await enroll(germany, await makePerson(talking.id, "tom@talking.de", "Tom Tal"));

    const id = await stage(
      [
        "Company,Website,Status",
        "Firma GmbH,firma.de,Do not contact",
        "Nord Studio,nord.no,Replied",
        "Buyer Co,buyer.de,Hired",
        "Talking Co,talking.de,Contacted",
      ].join("\n"),
      { duplicates: "update" },
    );
    const result = await runImportCommitJob({ sessionId: id }, ctx());
    expect(result).toMatchObject({ updated: 4 });

    const status = async (companyId: number) => (await db.company.findUniqueOrThrow({ where: { id: companyId } })).status;
    expect([await status(firma.id), await status(nord.id), await status(buyer.id), await status(talking.id)]).toEqual([
      "DO_NOT_CONTACT",
      "REPLIED",
      "CLIENT",
      "CONTACTED",
    ]);

    // Firma: everyone stops, in both campaigns, first emails included, as a panel change would do it.
    for (const r of [anna, ben, annaNordics]) {
      expect(await recipient(r.recipientId)).toMatchObject({ state: "STOPPED", holdReason: null, nextDueAt: null });
      expect((await recipient(r.recipientId)).stopReason).toBe("status:DO_NOT_CONTACT");
      expect(await email(r.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: the company was marked Do not contact" });
    }
    expect(await recipient(ola.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "status:REPLIED" });
    expect(await recipient(bo.recipientId)).toMatchObject({ state: "STOPPED", stopReason: "status:CLIENT" });
    expect(await email(bo.queuedId!)).toEqual({ status: "SKIPPED", lastError: "Stopped: the company was marked Client" });
    // "Contacted" stops nothing.
    expect(await recipient(tom.recipientId)).toMatchObject({ state: "WAITING", stopReason: null });
    expect((await email(tom.queuedId!)).status).toBe("QUEUED");

    // Nordics had nobody else left: it finished right after the import and let go of its companies. Germany Q4 still
    // waits for Tom.
    expect(await db.campaign.findUniqueOrThrow({ where: { id: nordics.id }, select: { status: true } })).toEqual({ status: "FINISHED" });
    expect(await db.companyReservation.count({ where: { campaignId: nordics.id, releasedAt: null } })).toBe(0);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: germany.id }, select: { status: true } })).toEqual({ status: "RUNNING" });
    expect(await db.companyReservation.count({ where: { campaignId: germany.id, companyId: firma.id, releasedAt: null } })).toBe(0);
  });

  it("stops nothing when the import keeps a protected status", async () => {
    const campaign = await makeCampaign({ createdById: ali.id, senderId: ali.id, name: "Kept" });
    const kept = await dbWrite((c) =>
      c.company.create({ data: { name: "Kept Client", nameNorm: "kept client", website: "https://kept.de", domain: "kept.de", status: "CLIENT" } }),
    );
    // A recipient still open at a Client company (e.g. added before it became a client); the import changes nothing.
    const kim = await enroll(campaign, await makePerson(kept.id, "kim@kept.de", "Kim Kept"));
    const id = await stage(["Company,Website,Status", "Kept Client,kept.de,Replied"].join("\n"), { duplicates: "update" });
    await runImportCommitJob({ sessionId: id }, ctx());
    expect((await db.company.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("CLIENT");
    expect(await recipient(kim.recipientId)).toMatchObject({ state: "WAITING", stopReason: null });
  });
});
