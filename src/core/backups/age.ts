/**
 * How old the newest backup is (M6-DESIGN §3.6): the old-backup warning on the dashboard, Settings › Backups and the
 * go-live recommendations all use this one rule. Pure and browser-safe.
 */

/** M6 contract (M6-DESIGN §3.6): how old the newest backup is. Pure. */
export const BACKUP_STALE_MS = 36 * 60 * 60 * 1000;
export type BackupAgeState = "ok" | "stale" | "never";
export function backupAge(newestAt: Date | null, now: Date): { state: BackupAgeState; ageMs: number | null } {
  if (!newestAt) return { state: "never", ageMs: null };
  const ageMs = now.getTime() - newestAt.getTime();
  return { state: ageMs > BACKUP_STALE_MS ? "stale" : "ok", ageMs };
}
