import { describe, expect, it } from "vitest";

// Importing @/server/db creates the Prisma client; with this phase set it runs no query at import, and these tests run
// none either, so no database file is ever opened.
process.env.NEXT_PHASE = "phase-production-build";
const { isRetryableDbError, pauseForOtherWriters, TAKE_WRITE_LOCK, withDbRetry, WRITE_PAUSE_MAX_MS, WRITE_PAUSE_MS } = await import("@/server/db");
const { Prisma } = await import("@/generated/prisma/client");

function known(code: string, message: string, originalCode?: string) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "7.10.0",
    meta: originalCode ? { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode, originalMessage: "database is locked", kind: "SocketTimeout" } } } : undefined,
  });
}

/** What dbTx's lock statement throws when the other process kept the lock past the busy timeout (measured, Prisma 7.10). */
const RAW_BUSY = known("P2010", "\nInvalid `prisma.$executeRawUnsafe()` invocation:\n\n\nRaw query failed. Code: `SQLITE_BUSY`. Message: `database is locked`", "SQLITE_BUSY");

describe("isRetryableDbError (DATA-02)", () => {
  it("retries a model query's busy error and a transaction that couldn't start or expired", () => {
    for (const code of ["P1008", "P2028", "P2034"]) expect(isRetryableDbError(known(code, "Operation has timed out"))).toBe(true);
  });

  it("retries a raw statement's busy error (P2010), by its driver code or its text", () => {
    expect(isRetryableDbError(RAW_BUSY)).toBe(true);
    expect(isRetryableDbError(known("P2010", "Raw query failed.", "SQLITE_BUSY_SNAPSHOT"))).toBe(true);
    expect(isRetryableDbError(known("P2010", "Raw query failed. Code: `SQLITE_BUSY_SNAPSHOT`. Message: `database is locked`"))).toBe(true);
  });

  it("never retries other failures", () => {
    expect(isRetryableDbError(known("P2002", "Unique constraint failed on the fields: (`token`)"))).toBe(false);
    expect(isRetryableDbError(known("P2010", "Raw query failed. Code: `SQLITE_ERROR`. Message: `near \"UPDTE\": syntax error`", "SQLITE_ERROR"))).toBe(false);
    expect(isRetryableDbError(new Error("Something else broke"))).toBe(false);
    expect(isRetryableDbError("nope")).toBe(false);
  });

  it("still retries a plain busy error", () => {
    expect(isRetryableDbError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
  });
});

describe("withDbRetry", () => {
  it("tries again after a raw busy error and returns the result", async () => {
    let calls = 0;
    const result = await withDbRetry(async () => {
      calls += 1;
      if (calls < 3) throw RAW_BUSY;
      return "saved";
    });
    expect(result).toBe("saved");
    expect(calls).toBe(3);
  });

  it("gives up at once on an error that isn't about a busy database", async () => {
    let calls = 0;
    const err = known("P2002", "Unique constraint failed");
    await expect(
      withDbRetry(async () => {
        calls += 1;
        throw err;
      }),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });
});

describe("dbTx's lock statement and the pause between chunks", () => {
  it("is a write that changes nothing", () => {
    expect(TAKE_WRITE_LOCK).toMatch(/^UPDATE "SystemState" SET "key" = "key" WHERE 0$/);
  });

  it("pauses 10 ms after a short chunk, a quarter of a long one, and never more than 50 ms", async () => {
    const took = async (heldMs?: number) => {
      const t0 = performance.now();
      await pauseForOtherWriters(heldMs);
      return performance.now() - t0;
    };
    expect(WRITE_PAUSE_MS).toBe(10);
    expect(WRITE_PAUSE_MAX_MS).toBe(50);
    // Timers may fire a millisecond early; they never fire much later than asked on an idle test runner.
    expect(await took()).toBeGreaterThanOrEqual(WRITE_PAUSE_MS - 2);
    expect(await took(160)).toBeGreaterThanOrEqual(40 - 2);
    const capped = await took(10_000);
    expect(capped).toBeGreaterThanOrEqual(WRITE_PAUSE_MAX_MS - 2);
    expect(capped).toBeLessThan(1_000);
  });
});
