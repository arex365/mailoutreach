import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * How the process's write lock and dbTx fit together (docs/dev/CONVENTIONS.md "SQLite transactions"): dbTx takes
 * SQLite's write lock with its first statement; withWriteLock is re-entrant, so dbTx/dbWrite inside it (the final check
 * before a send puts emails back from under it) run at once; and a read under withWriteLock never sees another flow's
 * half-done transaction, while a plain read does (one connection per process), which is why the final check locks.
 */

const t = await createTestDb("db-lock");
const { db, dbTx, dbWrite, withWriteLock } = await import("@/server/db");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function value(key: string): Promise<unknown> {
  return (await db.setting.findUnique({ where: { key } }))?.value ?? null;
}

function put(key: string, v: number) {
  return { where: { key }, create: { key, value: v }, update: { value: v } };
}

describe("dbTx and withWriteLock", () => {
  it("dbTx and dbWrite inside withWriteLock run at once (re-entrant) and commit", async () => {
    const started = Date.now();
    const out = await withWriteLock(async () => {
      await dbTx((tx) => tx.setting.upsert(put("lock.reentrant.a", 1)));
      await dbWrite((c) => c.setting.upsert(put("lock.reentrant.b", 2)));
      return dbTx(async (tx) => (await tx.setting.findUnique({ where: { key: "lock.reentrant.a" } }))?.value);
    });
    expect(out).toBe(1);
    expect(await value("lock.reentrant.b")).toBe(2);
    // No waiting for a lock the same flow already holds (a deadlock would hit Prisma's 5 s maxWait).
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("dbTx calls from different flows run one after the other: read-then-write loses no update", async () => {
    await dbWrite((c) => c.setting.upsert(put("lock.counter", 0)));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        dbTx(async (tx) => {
          const cur = Number((await tx.setting.findUnique({ where: { key: "lock.counter" } }))?.value ?? 0);
          await sleep(1);
          await tx.setting.update({ where: { key: "lock.counter" }, data: { value: cur + 1 } });
        }),
      ),
    );
    expect(await value("lock.counter")).toBe(20);
  });

  it("a read under withWriteLock waits for another flow's open transaction; a plain read sees it half-done", async () => {
    await dbWrite(async (c) => {
      await c.setting.upsert(put("lock.half.x", 0));
      await c.setting.upsert(put("lock.half.y", 0));
    });
    let firstWritten!: () => void;
    const halfway = new Promise<void>((r) => (firstWritten = r));
    const writer = dbTx(async (tx) => {
      await tx.setting.update({ where: { key: "lock.half.x" }, data: { value: 1 } });
      firstWritten();
      await sleep(150);
      await tx.setting.update({ where: { key: "lock.half.y" }, data: { value: 1 } });
    });
    await halfway;
    // The same connection: a plain read runs inside the open transaction and sees x without y.
    expect([await value("lock.half.x"), await value("lock.half.y")]).toEqual([1, 0]);
    // Under the lock: after the transaction, both.
    const locked = await withWriteLock(async () => [await value("lock.half.x"), await value("lock.half.y")]);
    expect(locked).toEqual([1, 1]);
    await writer;
  });
});
