import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeUser } from "../campaigns/seed";

/**
 * resumeSending writes the health baseline BEFORE clearing the pause (M3-DESIGN §4.2.6): a failure between the two
 * steps must leave sending paused (never resumed with the old baseline). The failure is injected into casState for
 * "sending.pause" only.
 */

const failures = vi.hoisted(() => ({ pauseWrite: false }));

vi.mock("@/server/state", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/state")>();
  return {
    ...real,
    casState: async (key: string, expected: number | null, value: unknown) => {
      if (failures.pauseWrite && key === "sending.pause") throw new Error("SQLITE_IOERR: disk I/O error (injected)");
      return real.casState(key, expected, value);
    },
  };
});

const t = await createTestDb("foundations-pause-crash");
const { db } = await import("@/server/db");
const { pauseSending, resumeSending, getPauseState } = await import("@/server/services/sending/pause");
const { readTyped } = await import("@/server/state-typed");
const { parseHealthBaseline } = await import("@/core/system-state-parse");
const { STATE_KEYS } = await import("@/core/system-state");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("resumeSending after a failure between its steps", () => {
  it("stays paused, with the new baseline already written", async () => {
    const now = new Date("2026-09-23T10:00:00Z");
    const owner = await makeUser("Arslan", { role: "OWNER" });
    await pauseSending({
      kind: "health-bounce",
      reason: "7 of the last 200 emails bounced",
      fixText: "Click Resume.",
      detail: { count: 7, sample: 200 },
      now,
    });
    failures.pauseWrite = true;
    await expect(resumeSending({ actorId: owner.id, actorName: "Arslan", now })).rejects.toThrow(/injected/);
    failures.pauseWrite = false;

    expect((await getPauseState()).paused).toBe(true);
    expect((await readTyped(STATE_KEYS.healthBaseline, parseHealthBaseline)).value).toMatchObject({
      since: now.toISOString(),
      acknowledged: { kind: "health-bounce", count: 7, sample: 200 },
    });
    expect(await db.activityLog.count({ where: { type: "sending.resumed" } })).toBe(0);

    // trying again works
    expect((await resumeSending({ actorId: owner.id, actorName: "Arslan", now })).resumed).toBe(true);
  });
});
