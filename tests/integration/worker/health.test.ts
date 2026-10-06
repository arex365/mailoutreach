import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("worker-health");
const { db } = await import("@/server/db");
const { GET } = await import("@/app/api/health/route");
const { acquireLease, releaseLease } = await import("../../../worker/lease");

type Health = { ok: boolean; database: string; workerLastSeen: string | null; time: string };

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("GET /api/health", () => {
  it("answers ok with no worker seen yet, and nothing else", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Health;
    expect(Object.keys(body).sort()).toEqual(["database", "ok", "time", "workerLastSeen"]);
    expect(body).toMatchObject({ ok: true, database: "ok", workerLastSeen: null });
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it("reports when the background sender last checked in", async () => {
    await acquireLease("health-test");
    const body = (await (await GET()).json()) as Health;
    expect(body.workerLastSeen).not.toBeNull();
    expect(Date.parse(body.time) - Date.parse(body.workerLastSeen!)).toBeLessThan(10_000);

    await releaseLease("health-test");
    const after = (await (await GET()).json()) as Health;
    expect(after.workerLastSeen).toBeNull();
  });

  it("answers 503 when the database doesn't respond", async () => {
    vi.spyOn(db, "$queryRawUnsafe").mockRejectedValueOnce(new Error("SQLITE_CANTOPEN"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Health;
    expect(body).toMatchObject({ ok: false, database: "error", workerLastSeen: null });
    expect(JSON.stringify(body)).not.toContain("SQLITE");
  });
});
