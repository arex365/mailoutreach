import { describe, expect, it } from "vitest";
import { BACKUP_STALE_MS, backupAge } from "@/core/backups/age";

/**
 * M6 step C contract (M6-DESIGN §3.6, §7.8): how old the newest backup is. The backups service's re-export is checked
 * in tests/integration/contracts-m6/settings-and-migration.test.ts (importing it opens a database).
 */

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-09-27T12:00:00.000Z");

describe("backupAge", () => {
  it("is stale after 36 hours", () => {
    expect(BACKUP_STALE_MS).toBe(36 * HOUR);
  });

  it("says never when there is no backup", () => {
    expect(backupAge(null, now)).toEqual({ state: "never", ageMs: null });
  });

  it("is ok up to exactly 36 hours, and stale after", () => {
    expect(backupAge(new Date(now.getTime() - HOUR), now)).toEqual({ state: "ok", ageMs: HOUR });
    expect(backupAge(new Date(now.getTime() - 36 * HOUR), now)).toEqual({ state: "ok", ageMs: 36 * HOUR });
    expect(backupAge(new Date(now.getTime() - 36 * HOUR - 1), now)).toEqual({ state: "stale", ageMs: 36 * HOUR + 1 });
    expect(backupAge(new Date(now.getTime() - 72 * HOUR), now).state).toBe("stale");
  });

  it("treats a backup dated in the future (clock set back) as fresh", () => {
    expect(backupAge(new Date(now.getTime() + HOUR), now)).toEqual({ state: "ok", ageMs: -HOUR });
  });
});
