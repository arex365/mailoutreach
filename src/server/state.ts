import { Prisma } from "@/generated/prisma/client";
import { db, dbWrite } from "./db";

/**
 * Worker-owned state (SystemState): pause state, health baseline, warm-up step,
 * periodic task last-success times, restore marker… Updated with compare-and-set
 * on `version` so an Owner edit can never silently overwrite a worker update.
 */

export type StateRow<T> = { value: T; version: number; updatedAt: Date };

export async function getState<T>(key: string): Promise<StateRow<T> | null> {
  const row = await db.systemState.findUnique({ where: { key } });
  return row ? { value: row.value as T, version: row.version, updatedAt: row.updatedAt } : null;
}

/** True for the unique-key error a create gets when another process created the same row first. */
function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === "P2002";
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

/**
 * Writes only if the stored version still equals expectedVersion (null = row must not exist).
 * Creating a row can race with the other process (the web app and the worker both create "sending.pause", for
 * example when "Pause all" meets an automatic pause): the loser gets false, never an error, so every CAS loop
 * simply re-reads and tries again (M3-DESIGN §4.2.7).
 */
export async function casState<T>(key: string, expectedVersion: number | null, value: T): Promise<boolean> {
  const json = value as unknown as Prisma.InputJsonValue;
  return dbWrite(async (c) => {
    if (expectedVersion === null) {
      const existing = await c.systemState.findUnique({ where: { key }, select: { key: true } });
      if (existing) return false;
      try {
        await c.systemState.create({ data: { key, value: json, version: 1 } });
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
      return true;
    }
    const res = await c.systemState.updateMany({
      where: { key, version: expectedVersion },
      data: { value: json, version: { increment: 1 } },
    });
    return res.count === 1;
  });
}

/** Unconditional write (use only where last-writer-wins is fine, e.g. a heartbeat). */
export async function setState<T>(key: string, value: T): Promise<void> {
  const json = value as unknown as Prisma.InputJsonValue;
  await dbWrite((c) =>
    c.systemState.upsert({
      where: { key },
      create: { key, value: json, version: 1 },
      update: { value: json, version: { increment: 1 } },
    }),
  );
}
