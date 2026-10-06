/**
 * The sentence a backup's summary gets when its copy to the second folder failed (review SCREENS-03). runBackup
 * (src/server/services/backups.ts) writes it into the backup task's summary, and Settings › Backups' Back up now button
 * shows that summary as a warning instead of a plain "saved" when it is there, so the page says whether the copy
 * worked. Pure and browser-safe.
 */

/** Where the copy's failure starts in a backup's summary. */
export const COPY_FAILED_PREFIX = "The copy to the second folder failed:";

/**
 * What to do when Windows refused the background sender access to the second folder (EPERM/EACCES): the service
 * accounts only get access through install-services.bat, which makes no copy itself.
 */
export const NOT_ALLOWED_FIX = "If the app runs as a Windows service, run install-services.bat on the office PC, then click Back up now.";

/** " The copy to the second folder failed: <reason>." (plus what to do when access was refused), for a summary. */
export function copyFailedNote(reason: string, notAllowed: boolean): string {
  return ` ${COPY_FAILED_PREFIX} ${reason}.${notAllowed ? ` ${NOT_ALLOWED_FIX}` : ""}`;
}

/** Whether a backup's summary says its copy to the second folder failed. */
export function summaryHasCopyFailure(summary: string | null | undefined): summary is string {
  return typeof summary === "string" && summary.includes(COPY_FAILED_PREFIX);
}
