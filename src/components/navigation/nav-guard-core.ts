/**
 * The one place that decides whether leaving the current page needs a question first (unsaved
 * text in the template editor, a Message step whose latest changes aren't saved, a per-person
 * email being edited). Pages register a guard while they have something to lose; everything that
 * navigates inside the app asks here first: plain links (a capturing click listener), the Ctrl+K
 * search menu, the notification bell and the Notifications list.
 *
 * The browser's Back button can't be cancelled, so a guard that protects Back gets one extra
 * history entry for the same address (a "sentinel") while it's active. Back then only removes
 * that entry: the page stays, the guard is asked, and the entry is put back at once (so a second
 * Back while the question is open is caught too). When the guard has nothing to lose any more,
 * the extra entry is removed again without the router noticing.
 *
 * No React and no `window` in here (the browser bindings are in nav-guard.tsx), so it is
 * unit-tested with a fake history.
 */

export type NavMode = "push" | "replace";

export type LeaveRequest = {
  /** Where the person wants to go ("/contacts?company=4"), or null for the browser's Back button. */
  href: string | null;
  /** Go there (after saving, or because the person chose to leave anyway). Only the first call counts. */
  proceed(): void;
  /** Stay on this page. Only the first call counts. */
  cancel(): void;
};

export type GuardEntry = {
  /** True while leaving would lose something. */
  isActive(): boolean;
  /** Also catch the browser's Back button (adds one history entry while active). */
  protectsBack(): boolean;
  /** Decide what happens: save then proceed, or ask. Must end with proceed() or cancel(). */
  onLeave(request: LeaveRequest): void;
  /** Opens an in-app address with the page's router. */
  navigate(href: string, mode: NavMode): void;
  /** Set once the person chose to leave: nothing is asked any more. */
  leaving: boolean;
};

/** What the guards need from the browser's history (window.history / location in the app). */
export interface HistoryPort {
  href(): string;
  state(): unknown;
  length(): number;
  push(state: unknown, url: string): void;
  go(delta: number): void;
  setScrollRestoration(mode: "auto" | "manual"): void;
  now(): number;
  later(fn: () => void): void;
}

/** How long a popstate may take to arrive after the guards removed their own history entry. */
export const SWALLOW_MS = 1_000;

type Sentinel = { url: string; state: unknown };
type BackRequest = { entry: GuardEntry; landedOnPage: boolean };

/**
 * The address a click on this link opens inside the app, or null when the guards should leave the
 * click alone: another site or window, a download, a link marked `data-leave-guard="skip"`, or the
 * page that's already open (a #hash only scrolls).
 */
export function inAppHref(
  link: { href: string; target?: string | null; download?: boolean; skip?: boolean },
  currentHref: string,
): string | null {
  if (link.skip || link.download || (link.target && link.target !== "_self")) return null;
  let url: URL;
  let here: URL;
  try {
    here = new URL(currentHref);
    url = new URL(link.href, here);
  } catch {
    return null;
  }
  if (url.origin !== here.origin) return null; // the browser asks on its own (beforeunload)
  if (url.pathname === here.pathname && url.search === here.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** True when `href` is the page that's open now (same path and query). */
export function isSamePage(href: string, currentHref: string): boolean {
  try {
    const here = new URL(currentHref);
    const url = new URL(href, here);
    return url.origin === here.origin && url.pathname === here.pathname && url.search === here.search;
  } catch {
    return false;
  }
}

export class NavigationGuards {
  private readonly entries: GuardEntry[] = [];
  private sentinel: Sentinel | null = null;
  private backRequest: BackRequest | null = null;
  private swallow: { url: string; until: number } | null = null;
  private syncQueued = false;

  constructor(private readonly port: HistoryPort | null) {}

  /** Registers a page's guard; returns the function that removes it. */
  add(entry: GuardEntry): () => void {
    this.entries.push(entry);
    this.changed();
    return () => {
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
      if (this.backRequest?.entry === entry) this.backRequest = null;
      this.changed();
    };
  }

  /** Call after a guard's active/protect-Back state changed. */
  changed(): void {
    if (!this.port || this.syncQueued) return;
    this.syncQueued = true;
    // Later, so a guard that unmounts and mounts again at once (React's strict mode) doesn't churn history.
    this.port.later(() => {
      this.syncQueued = false;
      this.sync();
    });
  }

  /** The guard that answers for the page now: the newest one with something to lose. */
  current(): GuardEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (!e.leaving && e.isActive()) return e;
    }
    return null;
  }

  private backGuard(): GuardEntry | null {
    const e = this.current();
    return e && e.protectsBack() ? e : null;
  }

  /**
   * Someone wants to open `href` inside the app. Returns false when nothing needs asking (the
   * caller navigates as usual); otherwise the page's guard decides and `navigate` (default: the
   * guard's own router) runs if and when it's fine to go.
   */
  request(href: string, navigate?: (mode: NavMode) => void): boolean {
    const entry = this.current();
    if (!entry) return false;
    if (this.port && isSamePage(href, this.port.href())) return false;
    const go = navigate ?? ((mode: NavMode) => entry.navigate(href, mode));
    entry.onLeave(
      once({
        href,
        proceed: () => this.leave(entry, go),
        cancel: () => undefined,
      }),
    );
    return true;
  }

  /** Goes without asking (the person chose to leave, or a guard's own dialog offers another page). */
  leave(entry: GuardEntry | null, navigate: (mode: NavMode) => void): void {
    if (entry) entry.leaving = true;
    this.backRequest = null;
    const onSentinel = this.sentinel !== null && this.port !== null && this.port.href() === this.sentinel.url;
    this.sentinel = null;
    if (onSentinel) this.port!.setScrollRestoration("auto");
    // Replacing the extra entry keeps Back from showing this page twice later.
    navigate(onSentinel ? "replace" : "push");
  }

  /**
   * The browser's Back/Forward. Registered as a capturing "popstate" listener before the app
   * router's own, so stopping it keeps the router from moving.
   */
  handlePopState(event: { stopImmediatePropagation(): void }): void {
    const port = this.port;
    if (!port) return;
    const swallow = this.swallow;
    this.swallow = null;
    if (swallow && port.now() <= swallow.until && port.href() === swallow.url) {
      // Our own step off the extra entry (nothing to protect any more): the router needn't know.
      event.stopImmediatePropagation();
      port.setScrollRestoration("auto");
      return;
    }
    const sentinel = this.sentinel;
    if (!sentinel) return;
    this.sentinel = null;
    const entry = this.backGuard();
    if (!entry) return; // nothing to lose any more: let the router go back
    event.stopImmediatePropagation();
    // Usually Back lands on this same page (the entry under ours); a long jump from the browser's
    // history list lands further back.
    const landedOnPage = port.href() === sentinel.url;
    port.push(sentinel.state, sentinel.url);
    this.sentinel = sentinel;
    if (this.backRequest) {
      this.backRequest.landedOnPage = landedOnPage; // already asking: the latest Back decides where to go
      return;
    }
    const request: BackRequest = { entry, landedOnPage };
    this.backRequest = request;
    entry.onLeave(
      once({
        href: null,
        proceed: () => {
          if (this.backRequest !== request) return;
          this.backRequest = null;
          entry.leaving = true;
          this.sentinel = null;
          port.setScrollRestoration("auto");
          port.go(request.landedOnPage ? -2 : -1);
        },
        cancel: () => {
          if (this.backRequest !== request) return;
          this.backRequest = null;
          this.changed();
        },
      }),
    );
  }

  /** Adds or removes the extra history entry to match the guards. */
  private sync(): void {
    const port = this.port;
    if (!port) return;
    const wanted = this.backGuard() !== null;
    if (this.sentinel && port.href() === this.sentinel.url) this.sentinel.state = port.state();
    if (wanted && !this.sentinel) {
      // With nothing before this page, Back can't leave it: no extra entry needed.
      if (port.length() <= 1) return;
      const sentinel = { url: port.href(), state: port.state() };
      // No scroll jumps when Back only moves between the two entries of this page.
      port.setScrollRestoration("manual");
      port.push(sentinel.state, sentinel.url);
      this.sentinel = sentinel;
    } else if (!wanted && this.sentinel && !this.backRequest) {
      const sentinel = this.sentinel;
      this.sentinel = null;
      if (port.href() !== sentinel.url) return; // already on another page: nothing to tidy
      this.swallow = { url: sentinel.url, until: port.now() + SWALLOW_MS };
      port.go(-1);
    }
  }
}

/** proceed()/cancel() act only once, whichever comes first. */
function once(request: LeaveRequest): LeaveRequest {
  let settled = false;
  return {
    href: request.href,
    proceed: () => {
      if (settled) return;
      settled = true;
      request.proceed();
    },
    cancel: () => {
      if (settled) return;
      settled = true;
      request.cancel();
    },
  };
}
