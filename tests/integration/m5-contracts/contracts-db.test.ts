import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * The Milestone 5 step-C contract pieces that touch the database (docs/dev/M5-DESIGN.md §5.6–§5.9): the migration and
 * its data update, the new setting defaults, the typed Stop (`requestJobCancel`), `waitingUntil`, `DeferJob` and the
 * `sk-ant-` redaction.
 */

const t = await createTestDb("m5-contracts");
const { db } = await import("@/server/db");
const { DeferJob, enqueueJob, isDeferJob, redactText, requestJobCancel, toPublicJob } = await import("@/server/jobs");
const { getSetting, getSettings } = await import("@/server/settings");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("migration 20260926120000_m5_checks_ai", () => {
  const M5 = "20260926120000_m5_checks_ai";
  const dir = path.resolve("prisma", "migrations");

  it("adds the columns with their defaults and counts an old unknown result as one unknown in a row", () => {
    const file = path.resolve("data", "test", `m5-migration-${process.pid}-${Date.now()}.db`);
    const raw = new Database(file);
    try {
      const names = fs
        .readdirSync(dir)
        .filter((n) => fs.existsSync(path.join(dir, n, "migration.sql")))
        .sort();
      expect(names).toContain(M5);
      for (const n of names.filter((x) => x < M5)) raw.exec(fs.readFileSync(path.join(dir, n, "migration.sql"), "utf8"));
      raw.exec(`INSERT INTO "Company" ("id", "name", "nameNorm", "updatedAt") VALUES (1, 'Acme', 'acme', CURRENT_TIMESTAMP);
        INSERT INTO "Person" ("id", "companyId", "email", "emailNorm", "verificationStatus", "updatedAt")
          VALUES (1, 1, 'a@acme.de', 'a@acme.de', 'UNKNOWN', CURRENT_TIMESTAMP),
                 (2, 1, 'b@acme.de', 'b@acme.de', 'VALID', CURRENT_TIMESTAMP),
                 (3, 1, NULL, NULL, NULL, CURRENT_TIMESTAMP);`);

      raw.exec(fs.readFileSync(path.join(dir, M5, "migration.sql"), "utf8"));

      const people = raw
        .prepare(`SELECT "id", "verificationUnknowns", "verificationDisposable" FROM "Person" ORDER BY "id"`)
        .all() as Array<{ id: number; verificationUnknowns: number; verificationDisposable: number }>;
      expect(people).toEqual([
        { id: 1, verificationUnknowns: 1, verificationDisposable: 0 },
        { id: 2, verificationUnknowns: 0, verificationDisposable: 0 },
        { id: 3, verificationUnknowns: 0, verificationDisposable: 0 },
      ]);
      const indexes = (raw.prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'index'`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
      expect(indexes).toEqual(
        expect.arrayContaining([
          "VerificationCheck_personId_checkedAt_idx",
          "VerificationCheck_jobId_idx",
          "VerificationCheck_checkedAt_idx",
          "CampaignRecipient_state_recheckAt_idx",
          "AiDraft_status_createdAt_idx",
          "AiDraft_draftedAt_idx",
          "AiDraft_jobId_idx",
        ]),
      );
    } finally {
      raw.close();
      fs.rmSync(file, { force: true });
    }
  });

  it("is what `prisma migrate deploy` applied to the test database (the client reads and writes the new columns)", async () => {
    const company = await db.company.create({ data: { name: "Acme", nameNorm: "acme" } });
    const person = await db.person.create({ data: { companyId: company.id, email: "anna@acme.de", emailNorm: "anna@acme.de" } });
    expect(person).toMatchObject({ verificationDisposable: false, verificationUnknowns: 0 });
    const draft = await db.aiDraft.create({ data: { companyId: company.id, model: "m", promptVersion: "v1" } });
    expect(draft).toMatchObject({ readAttempts: 0, calls: 0, refetch: false, draftedAt: null, reviewAction: null });
    const check = await db.verificationCheck.create({
      data: { emailNorm: "anna@acme.de", provider: "fake", status: "VALID", risk: "LOW", source: "panel" },
    });
    expect(check).toMatchObject({ isRole: false, isDisposable: false, didYouMean: null, source: "panel" });
  });
});

describe("setting defaults", () => {
  it("adds the throwaway policy row, the check limits and the AI prices", async () => {
    expect(await getSetting("verification.policy")).toEqual({
      deliverableHighRisk: "block",
      catchAllLow: "send",
      catchAllMedium: "block",
      catchAllHigh: "block",
      disposable: "block",
      unknown: "recheck",
    });
    const s = await getSettings([
      "verification.includedPerMonth",
      "verification.concurrency",
      "verification.monthlyLimitUsd",
      "ai.customModel",
    ] as const);
    expect(s).toEqual({
      "verification.includedPerMonth": 0,
      "verification.concurrency": 2,
      "verification.monthlyLimitUsd": 100,
      "ai.customModel": null,
    });
    const prices = await getSetting("ai.prices");
    expect(prices["claude-haiku-4-5-20251001"]).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
    // A copy: changing it never changes the default.
    prices["claude-haiku-4-5-20251001"]!.inputPerMTok = 99;
    expect((await getSetting("ai.prices"))["claude-haiku-4-5-20251001"]!.inputPerMTok).toBe(1);
  });
});

describe("requestJobCancel (Stop acts on its own job type only)", () => {
  const later = () => new Date(Date.now() + 3_600_000);

  it("cancels a queued job of that type at once and frees its dedupe key", async () => {
    const job = await enqueueJob({ type: "verify.addresses", runAt: later(), dedupeKey: "verify:test-1" });
    expect(await requestJobCancel(job.id, { type: "verify.addresses" })).toBe("cancelled");
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "CANCELLED", activeDedupeKey: null });
    expect(row.finishedAt).not.toBeNull();
    expect(await requestJobCancel(job.id, { type: "verify.addresses" })).toBe("finished");
  });

  it("refuses another type's job and leaves it alone", async () => {
    const backup = await enqueueJob({ type: "backup.run", runAt: later() });
    expect(await requestJobCancel(backup.id, { type: "verify.addresses" })).toBe("not-found");
    expect(await requestJobCancel(999_999, { type: "ai.draftLines" })).toBe("not-found");
    expect((await db.job.findUniqueOrThrow({ where: { id: backup.id } })).status).toBe("QUEUED");
  });

  it("asks a running job to stop at its next safe point", async () => {
    const job = await enqueueJob({ type: "ai.draftLines" });
    await db.job.update({ where: { id: job.id }, data: { status: "RUNNING" } });
    const now = new Date("2026-09-26T10:00:00Z");
    expect(await requestJobCancel(job.id, { type: "ai.draftLines", now })).toBe("requested");
    const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "RUNNING", cancelRequestedAt: now });
  });
});

describe("toPublicJob, DeferJob and redaction", () => {
  it("says until when a queued job waits, and nothing otherwise", async () => {
    const now = new Date();
    const runAt = new Date(now.getTime() + 60_000);
    const waiting = await enqueueJob({ type: "verify.addresses", runAt });
    expect(toPublicJob(waiting, now).waitingUntil).toBe(runAt.toISOString());
    expect(toPublicJob(waiting, new Date(runAt.getTime() + 1)).waitingUntil).toBeNull();
    expect(toPublicJob({ ...waiting, status: "RUNNING" }, now).waitingUntil).toBeNull();
  });

  it("DeferJob carries its instant, reason and carry, and is recognised", () => {
    const runAt = new Date("2026-09-26T10:05:00Z");
    const err = new DeferJob(runAt, "rate-limited", { carry: { cursor: 3 }, summary: "Waiting for Mailgun." });
    expect(isDeferJob(err)).toBe(true);
    expect(err).toMatchObject({ name: "DeferJob", runAt, reason: "rate-limited", opts: { carry: { cursor: 3 } } });
    expect(err.message).toBe("Deferred until 2026-09-26T10:05:00.000Z (rate-limited)");
    expect(isDeferJob(new Error("no"))).toBe(false);
    expect(isDeferJob({ deferJob: true })).toBe(false);
  });

  it("hides Anthropic keys even when they aren't saved", () => {
    expect(redactText("401 from Claude with sk-ant-api03-AbCdEf_123-xyz0987654 in the header")).toBe(
      "401 from Claude with [hidden] in the header",
    );
    expect(redactText("sk-ant-short")).toBe("sk-ant-short");
  });
});
