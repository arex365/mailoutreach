/**
 * Settings › Backups' Back up now button and the backup the page shows as waiting (review SCREENS-03). Save folder
 * queues the first copy to the second folder and refreshes the page, and someone else may click Back up now too: the
 * button then follows that backup, so the page shows whether it (and its copy) worked. When a backup finishes, the page
 * shows none waiting any more; that never clears what the button says about the one it followed (a failure stays on
 * screen). Pure and browser-safe.
 */

/**
 * Whether the button starts following `waiting` (the backup the server shows as waiting after a refresh) while it
 * follows `following` (null: none).
 */
export function startsFollowing(waiting: number | null, following: number | null): boolean {
  return waiting !== null && waiting !== following;
}
