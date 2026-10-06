import {
  batchPopupText,
  pickPopups,
  popupPanelState,
  popupStorageKeys,
  POPUP_BATCH_TAG,
  popupTag,
  readPopupSwitch,
  type PopupPanelState,
  type PopupPermission,
} from "@/core/notifications/popups";
import type { NotificationItem } from "@/server/notifications";

/**
 * What GET /api/notifications/summary answers (M4-DESIGN §5.2): the bell's menu (`unread`, the `latest` 5), the
 * user's highest notification id, the waiting-replies count, the M1–M3 switch (`legacyDesktopReplies`) and the pop-ups
 * for this poll (empty without `after`), plus the AI lines waiting for review (`aiWaiting`, the sidebar's badge,
 * M5-DESIGN §6.7).
 */
export type SummaryResponse = {
  userId: number;
  unread: number;
  latest: NotificationItem[];
  latestId: number;
  waitingReplies: number;
  legacyDesktopReplies: boolean;
  popups: { items: NotificationItem[]; count: number; latestId: number | null };
  /** AI lines waiting for review (the Waiting tab's count). */
  aiWaiting: number;
};

/**
 * Desktop pop-ups in the browser (M4-DESIGN §5.2–§5.3), shared by the bell (which shows them) and Settings ›
 * Notifications (which switches them on). The decisions themselves are the pure functions of
 * @/core/notifications/popups; this file adds what needs a browser: `localStorage` (the per-browser switch, the
 * high-water mark of shown pop-ups, the "unsupported" flag, all keyed by user because two people may share a PC
 * profile), the Notification API and the page's own address. Every storage access is wrapped: a private window or
 * blocked site data just means "not chosen yet". No service worker, no push (research Part A).
 */

/** The part of `localStorage` used here (injectable for tests). */
export type PopupStorage = Pick<Storage, "getItem" | "setItem">;

/** Fired on `window` when this tab changes the pop-up switch or the permission, so the bell and Settings re-read. */
export const POPUPS_CHANGED_EVENT = "pp:popups-changed";

/** `window.localStorage`, or null when there is none or the browser refuses it. */
export function browserStorage(): PopupStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(storage: PopupStorage | null, key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

function write(storage: PopupStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage full or blocked: the switch just isn't remembered in this browser.
  }
}

/** "Pop-ups in this browser": true / false as chosen here, null when never chosen in this browser. */
export function readLocalPopupSwitch(userId: number, storage: PopupStorage | null = browserStorage()): boolean | null {
  return readPopupSwitch(read(storage, popupStorageKeys(userId).on));
}

export function writeLocalPopupSwitch(userId: number, on: boolean, storage: PopupStorage | null = browserStorage()): void {
  write(storage, popupStorageKeys(userId).on, on ? "on" : "off");
}

/** The highest notification id this browser has already dealt with for the user (0 when none). */
export function readPopupMark(userId: number, storage: PopupStorage | null = browserStorage()): number {
  const n = Number(read(storage, popupStorageKeys(userId).last));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Stores `mark` as the high-water mark unless another tab already stored a higher one; returns the stored value. */
export function raisePopupMark(userId: number, mark: number, storage: PopupStorage | null = browserStorage()): number {
  const next = Math.max(readPopupMark(userId, storage), Number.isSafeInteger(mark) && mark > 0 ? mark : 0);
  if (next > 0) write(storage, popupStorageKeys(userId).last, String(next));
  return next;
}

/** Sets the high-water mark to exactly `mark` (the bell's first poll after a page load: the server's latest id). */
export function resetPopupMark(userId: number, mark: number, storage: PopupStorage | null = browserStorage()): void {
  write(storage, popupStorageKeys(userId).last, String(Number.isSafeInteger(mark) && mark > 0 ? mark : 0));
}

/** True once `new Notification()` threw in this browser (an Android-like browser that looks like a computer). */
export function readPopupsUnsupported(userId: number, storage: PopupStorage | null = browserStorage()): boolean {
  return read(storage, popupStorageKeys(userId).unsupported) === "1";
}

export function markPopupsUnsupported(userId: number, storage: PopupStorage | null = browserStorage()): void {
  write(storage, popupStorageKeys(userId).unsupported, "1");
}

/** What `popupPanelState` needs to know about this browser. */
export type BrowserPopupFacts = {
  secure: boolean;
  hasApi: boolean;
  coarsePointerOnly: boolean;
  permission: PopupPermission;
};

/** Reads the browser: secure context, Notification API, a touch-only screen, and the permission. */
export function readBrowserPopupFacts(): BrowserPopupFacts {
  if (typeof window === "undefined") return { secure: false, hasApi: false, coarsePointerOnly: false, permission: "default" };
  const hasApi = "Notification" in window && typeof window.Notification === "function";
  let coarsePointerOnly = false;
  try {
    coarsePointerOnly =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches &&
      !window.matchMedia("(any-pointer: fine)").matches;
  } catch {
    coarsePointerOnly = false;
  }
  let permission: PopupPermission = "default";
  if (hasApi) {
    const p = window.Notification.permission;
    permission = p === "granted" || p === "denied" ? p : "default";
  }
  return { secure: window.isSecureContext === true, hasApi, coarsePointerOnly, permission };
}

/** The Settings panel's state in this browser for one user (M4-DESIGN §5.3, §9.6). */
export function currentPopupState(
  userId: number,
  legacyDesktopReplies: boolean,
  facts: BrowserPopupFacts = readBrowserPopupFacts(),
  storage: PopupStorage | null = browserStorage(),
): PopupPanelState {
  return popupPanelState({
    ...facts,
    localOn: readLocalPopupSwitch(userId, storage),
    legacyDesktopReplies,
    failed: readPopupsUnsupported(userId, storage),
  });
}

/**
 * The address of the app on the office PC itself, from the page's own port (`window.location.port`: 3000 for the app,
 * 3001 for the practice copy): "http://localhost:3001". Never a fixed port.
 */
export function localAppAddress(port: string | null | undefined): string {
  const p = (port ?? "").trim();
  return /^\d{1,5}$/.test(p) && p !== "80" ? `http://localhost:${p}` : "http://localhost";
}

/**
 * The "Pop-ups can't work on this address" text (M4-DESIGN §9.6), naming the secure public address when there is one
 * and the office PC's own address with the port this page was loaded from.
 */
export function insecurePopupText(publicUrl: string | null, localAddress: string): string {
  if (publicUrl) {
    return `Pop-ups can't work on this address. Browsers only allow them on the secure address (${publicUrl}) or on the office PC itself (${localAddress}). Open the secure address and turn them on there.`;
  }
  return `Pop-ups can't work on this address. Browsers only allow them on a secure (https) address or on the office PC itself (${localAddress}).`;
}

/**
 * One pop-up to show: a notification's own title and body (M4-DESIGN §9.2), or the batch pop-up. `id` is the
 * notification's id, so a click can mark it read; null (or missing) for the batch pop-up and Settings' test pop-up.
 */
export type PopupToShow = { id?: number | null; title: string; body: string | null; tag: string; link: string | null };

/** A notification as the summary route returns it (only what a pop-up needs). */
export type PopupItem = { id: number; title: string; body: string | null; link: string | null };

/**
 * What one poll of the bell does with pop-ups (M4-DESIGN §5.2–§5.3), given the summary's `popups` and `latestId`:
 * - the first poll after a page load (`first`) shows nothing and only records `latestId` as the mark;
 * - otherwise `pickPopups` decides against the mark: more than 3 new → one batch pop-up ("30 new notifications"),
 *   else each new one, oldest first; the mark moves to what was dealt with either way;
 * - when pop-ups may not show now (`canShow` false: switched off here, no permission, or the person is looking at the
 *   app) nothing shows, but the mark still moves, so nothing old pops up later.
 */
export function planPopups(
  summary: { latestId: number; popups: { items: readonly PopupItem[]; count: number; latestId: number | null } },
  opts: { first: boolean; mark: number; canShow: boolean },
): { show: PopupToShow[]; mark: number } {
  if (opts.first) return { show: [], mark: Math.max(0, summary.latestId) };
  const pick = pickPopups(summary.popups, opts.mark);
  if (!opts.canShow) return { show: [], mark: pick.newLast };
  if (pick.batch !== null) {
    const b = batchPopupText(pick.batch);
    return { show: [{ id: null, title: b.title, body: b.body, tag: POPUP_BATCH_TAG, link: b.link }], mark: pick.newLast };
  }
  return {
    show: pick.show.map((n) => ({ id: n.id, title: n.title, body: n.body, tag: popupTag(n.id), link: n.link })),
    mark: pick.newLast,
  };
}

/**
 * Shows one desktop pop-up (no icon: the app ships no /icon-192.png; no `renotify`, no `requireInteraction`). A click
 * focuses the window, closes the pop-up and calls `onOpen` with its link and its notification id (null for the batch
 * pop-up), which marks it read and opens the link (`popupOpener`). Returns false when the browser refused to create
 * it; that browser is then remembered as "unsupported" for the user, and Settings shows the phone text.
 */
export function showDesktopPopup(
  p: PopupToShow,
  userId: number,
  onOpen: (link: string | null, id: number | null) => void,
): boolean {
  try {
    const n = new window.Notification(p.title, { body: p.body ?? undefined, tag: p.tag, data: { link: p.link } });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        // Some browsers don't let a page focus itself; the default click behaviour still brings the tab forward.
      }
      n.close();
      onOpen(p.link, p.id ?? null);
    };
    return true;
  } catch {
    markPopupsUnsupported(userId);
    try {
      window.dispatchEvent(new Event(POPUPS_CHANGED_EVENT));
    } catch {
      // No window events (tests).
    }
    return false;
  }
}

/** What marking notifications read answers (the shape of `markNotificationsReadAction`'s result). */
export type MarkReadResult = { ok: true } | { ok: false; error: string };

/**
 * What a click on a desktop pop-up does after `showDesktopPopup` focused the window (M4-DESIGN §5.5: "Opening a
 * notification marks it read", as the bell and the Notifications list do): marks that one notification read (the batch
 * pop-up has no id and marks nothing), lets the bell refresh its count (`onMarked`), then opens the link. The link
 * opens even when marking fails (offline, signed out): `onError` gets the plain sentence to show.
 */
export function popupOpener(deps: {
  markRead: (ids: number[]) => Promise<MarkReadResult>;
  onMarked: () => void;
  onError: (message: string) => void;
  open: (link: string | null) => void;
}): (link: string | null, id: number | null) => Promise<void> {
  return async (link, id) => {
    if (id !== null && Number.isSafeInteger(id) && id > 0) {
      try {
        const res = await deps.markRead([id]);
        if (res.ok) deps.onMarked();
        else deps.onError(res.error);
      } catch {
        // The request itself failed (offline, the app restarting): open the link anyway; the bell still shows it unread.
      }
    }
    deps.open(link);
  };
}

/** The bell menu's line: "3 replies waiting for your answer" / "1 reply waiting …"; null when none are waiting. */
export function waitingRepliesText(count: number): string | null {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n === 0) return null;
  return n === 1 ? "1 reply waiting for your answer" : `${n.toLocaleString("en-US")} replies waiting for your answer`;
}
