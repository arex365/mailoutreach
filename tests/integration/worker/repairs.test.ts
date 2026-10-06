import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("worker-repairs");
const { db, dbWrite } = await import("@/server/db");
const { getState } = await import("@/server/state");
const { ONE_OFF_REPAIRS, repairStateKey, runOneOffRepairs } = await import("../../../worker/repairs");

const quiet = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("one-off repairs at worker start-up", () => {
  it("fixes profile keys saved by older versions once, and remembers that it ran", async () => {
    // What older versions stored: "host + first path segment" and an Instagram post's "p" as a handle.
    await dbWrite((c) =>
      c.company.createMany({
        data: [
          { name: "Shop A", nameNorm: "shop a", website: "https://www.etsy.com/shop/ShopA", profileKey: "etsy.com/shop" },
          { name: "Shop B", nameNorm: "shop b", website: "https://www.etsy.com/shop/ShopB", profileKey: "etsy.com/shop" },
          { name: "Studio", nameNorm: "studio", website: "https://studio.de", domain: "studio.de", instagram: "p" },
        ],
      }),
    );
    const logger = quiet();
    expect(await runOneOffRepairs(logger)).toEqual(ONE_OFF_REPAIRS.map((r) => r.name));
    const rows = await db.company.findMany({ orderBy: { id: "asc" }, select: { profileKey: true, instagram: true } });
    expect(rows[0]!.profileKey).not.toBe(rows[1]!.profileKey);
    expect(rows[0]!.profileKey).not.toBe("etsy.com/shop");
    expect(rows[2]).toEqual({ profileKey: null, instagram: null });
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^One-off repair "profileKeys\.perPlatform" done: checked \d+ compan/));
    expect((await getState<{ summary: string }>(repairStateKey("profileKeys.perPlatform")))?.value.summary).toMatch(/fixed 3$/);

    // The next start doesn't run it again.
    const again = quiet();
    expect(await runOneOffRepairs(again)).toEqual([]);
    expect(again.info).not.toHaveBeenCalled();
  });

  it("logs a failed repair, never throws, and tries it again on the next start", async () => {
    let calls = 0;
    const flaky = [
      {
        name: "test.flaky",
        run: async () => {
          calls += 1;
          if (calls === 1) throw new Error("database is locked");
          return "ok";
        },
      },
    ];
    const first = quiet();
    expect(await runOneOffRepairs(first, flaky)).toEqual([]);
    expect(first.error).toHaveBeenCalledWith(expect.stringContaining('"test.flaky" failed'), expect.any(Error));
    expect(await getState(repairStateKey("test.flaky"))).toBeNull();
    expect(await runOneOffRepairs(quiet(), flaky)).toEqual(["test.flaky"]);
    expect(await runOneOffRepairs(quiet(), flaky)).toEqual([]);
    expect(calls).toBe(2);
  });
});
