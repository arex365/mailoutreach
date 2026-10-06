/**
 * Desktop pop-up decisions (M4-DESIGN §5.2, §5.3; research notifications-and-threading Part A): which state the
 * Settings panel shows, how often the bell polls, when a pop-up may appear, and which notifications a poll shows. The
 * bell and Settings › Notifications do the browser calls; these functions only decide. Pure and browser-safe.
 */

/** What Settings › Notifications shows in "Pop-ups on this computer" (exactly one state). */
export type PopupPanelState = "insecure" | "phone" | "ask" | "on" | "off" | "blocked" | "unsupported";
/** `Notification.permission`. */
export type PopupPermission = "default" | "granted" | "denied";

/**
 * The panel's state, first match wins:
 * - "phone": only a coarse pointer (a phone or tablet) — pop-ups need a computer, whatever the address;
 * - "insecure": not a secure context (the office address over http);
 * - "unsupported": no Notification API, or `new Notification()` threw here before (an Android-like browser);
 * - "blocked": permission denied; "ask": permission not asked yet;
 * - "on" / "off": permission granted, and the switch in this browser (`localOn`; missing → the M1–M3 account switch
 *   `desktopReplies`).
 */
export function popupPanelState(i: {
  secure: boolean;
  hasApi: boolean;
  coarsePointerOnly: boolean;
  permission: PopupPermission;
  localOn: boolean | null;
  legacyDesktopReplies: boolean;
  failed: boolean;
}): PopupPanelState {
  if (i.coarsePointerOnly) return "phone";
  if (!i.secure) return "insecure";
  if (!i.hasApi || i.failed) return "unsupported";
  if (i.permission === "denied") return "blocked";
  if (i.permission !== "granted") return "ask";
  return (i.localOn ?? i.legacyDesktopReplies) ? "on" : "off";
}

/** Poll every 20 s while the tab is visible… */
export const POLL_VISIBLE_MS = 20_000;
/** …give or take up to 2 s, so several tabs don't poll in step… */
export const POLL_JITTER_MS = 2_000;
/** …and every 60 s while it is hidden with pop-ups on (browsers clamp hidden timers to once a minute anyway). */
export const POLL_HIDDEN_MS = 60_000;

/**
 * The wait before the bell's next poll: 20 s ± 2 s while visible (`random()` in [0, 1) picks the jitter), 60 s while
 * hidden with pop-ups on in this browser, and null (no polling) while hidden with pop-ups off.
 */
export function pollDelayMs(i: { hidden: boolean; popupsOn: boolean; random: () => number }): number | null {
  if (i.hidden) return i.popupsOn ? POLL_HIDDEN_MS : null;
  const r = i.random();
  const unit = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;
  return Math.round(POLL_VISIBLE_MS - POLL_JITTER_MS + unit * 2 * POLL_JITTER_MS);
}

/** A pop-up only when the person isn't looking at the app: the tab is hidden, or the window has no focus. */
export function shouldPopUp(i: { hidden: boolean; focused: boolean }): boolean {
  return i.hidden || !i.focused;
}

/** More new notifications than this at once give one batch pop-up instead. */
export const POPUP_BATCH_OVER = 3;
/** The tag of the batch pop-up (a later batch replaces it). */
export const POPUP_BATCH_TAG = "pp-n-batch";

/** The tag of one notification's pop-up ("pp-n-<id>"): a second tab showing it again replaces it. */
export function popupTag(id: number): string {
  return `pp-n-${id}`;
}

/** The batch pop-up's text: "30 new notifications" / "Open the app to see them." */
export function batchPopupText(count: number): { title: string; body: string; link: string } {
  const n = Math.max(0, Math.floor(count) || 0);
  return {
    title: `${n.toLocaleString("en-US")} new notification${n === 1 ? "" : "s"}`,
    body: "Open the app to see them.",
    link: "/notifications",
  };
}

/**
 * Which pop-ups a poll shows (M4-DESIGN §5.3), given the summary's `popups` (`items`: at most 5, oldest first;
 * `count`: how many match in total; `latestId`) and this browser's high-water mark `lastShown`:
 * - nothing above `lastShown` → nothing, the mark stays;
 * - more than 3 new (`count`, not only the 5 returned) → one batch pop-up of `count`, and the mark jumps to
 *   `latestId`, so a burst never gives several "5 new notifications" pop-ups in a row;
 * - otherwise each item above `lastShown`, oldest first, and the mark moves to the highest id.
 * An item at or below the mark is never shown again.
 */
export function pickPopups<T extends { id: number }>(
  popups: { items: readonly T[]; count: number; latestId: number | null },
  lastShown: number,
): { show: T[]; batch: number | null; newLast: number } {
  const mark = Number.isFinite(lastShown) ? Math.max(0, Math.floor(lastShown)) : 0;
  const fresh = popups.items.filter((n) => n.id > mark).sort((a, b) => a.id - b.id);
  const highest = Math.max(popups.latestId ?? 0, ...fresh.map((n) => n.id));
  if (highest <= mark) return { show: [], batch: null, newLast: mark };
  if (popups.count > POPUP_BATCH_OVER) return { show: [], batch: popups.count, newLast: highest };
  return { show: fresh, batch: null, newLast: highest };
}

/** The per-browser `localStorage` keys of one user (M4-DESIGN §5.3). */
export function popupStorageKeys(userId: number): { on: string; last: string; unsupported: string } {
  return {
    on: `pp.popups.on.${userId}`,
    last: `pp.popups.last.${userId}`,
    unsupported: `pp.popups.unsupported.${userId}`,
  };
}

/** The stored "Pop-ups in this browser" switch: "on" → true, "off" → false, anything else → null (not chosen yet). */
export function readPopupSwitch(v: string | null | undefined): boolean | null {
  if (v === "on") return true;
  if (v === "off") return false;
  return null;
}
