import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("worker-lease");
const { db, dbWrite } = await import("@/server/db");
const { acquireLease, renewLease, releaseLease, ownsLease, readLease } = await import("../../../worker/lease");
const { getWorkerStatus } = await import("@/server/worker-status");

beforeEach(async () => {
  await dbWrite((c) => c.workerLease.deleteMany({}));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("worker lease", () => {
  it("lets the first worker take it and makes the second one wait", async () => {
    expect(await acquireLease("w1")).toMatchObject({ acquired: true, decision: "take", previousOwner: null });
    expect(await acquireLease("w2")).toMatchObject({ acquired: false, holder: "w1" });
    expect(await ownsLease("w1")).toBe(true);
    expect(await ownsLease("w2")).toBe(false);
    expect((await getWorkerStatus()).running).toBe(true);
  });

  it("renews only for the holder", async () => {
    await acquireLease("w1");
    const later = new Date(Date.now() + 15_000);
    expect(await renewLease("w1", later)).toBe(true);
    expect((await readLease())?.heartbeatAt.getTime()).toBe(later.getTime());
    expect(await renewLease("w2")).toBe(false);
    expect(await acquireLease("w1")).toMatchObject({ acquired: true, decision: "renew" });
  });

  it("lets another worker take over after 60 s without a heartbeat; the old one then loses it", async () => {
    await acquireLease("w1");
    await dbWrite((c) => c.workerLease.update({ where: { id: 1 }, data: { heartbeatAt: new Date(Date.now() - 61_000) } }));
    expect(await acquireLease("w2")).toMatchObject({ acquired: true, decision: "take", previousOwner: "w1" });
    expect((await readLease())?.workerId).toBe("w2");
    expect(await renewLease("w1")).toBe(false);
    expect(await ownsLease("w1")).toBe(false);
  });

  it("releases on shutdown so the next worker can start straight away", async () => {
    await acquireLease("w1");
    expect(await releaseLease("w2")).toBe(false);
    expect(await releaseLease("w1")).toBe(true);
    expect((await readLease())?.heartbeatAt.getTime()).toBe(0);
    expect((await getWorkerStatus()).running).toBe(false);
    expect(await acquireLease("w2")).toMatchObject({ acquired: true, previousOwner: "w1" });
  });

  it("creates the row safely when two workers start at the same moment", async () => {
    const [a, b] = await Promise.all([acquireLease("w1"), acquireLease("w2")]);
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
    expect(await db.workerLease.count()).toBe(1);
  });
});
