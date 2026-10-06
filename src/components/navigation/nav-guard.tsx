"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { NavigationGuards, inAppHref, type GuardEntry, type HistoryPort, type LeaveRequest, type NavMode } from "./nav-guard-core";

export type { LeaveRequest, NavMode } from "./nav-guard-core";

/**
 * Browser bindings for the shared navigation guard (see nav-guard-core.ts):
 * - `NavigationGuardRoot`, rendered once by the signed-in app shell ((app)/layout.tsx);
 * - `useNavigationGuard` for pages with something to lose (template editor, Message step…);
 * - `useGuardedNavigate` for code that navigates with router.push (search menu, bell, Notifications),
 *   and `useGuardedRun` for a click that does something first and then navigates (Ctrl+K › New campaign).
 * Plain links are covered by one capturing click listener, and Back by one capturing "popstate"
 * listener. Both are added once per tab when this module loads, which is before the app router adds
 * its own popstate listener, so the guards always hear Back first.
 */

function browserPort(): HistoryPort {
  return {
    href: () => window.location.href,
    state: () => window.history.state,
    length: () => window.history.length,
    push: (state, url) => window.history.pushState(state, "", url),
    go: (delta) => window.history.go(delta),
    setScrollRestoration: (mode) => {
      try {
        window.history.scrollRestoration = mode;
      } catch {
        // Not supported: Back may scroll a little, nothing worse.
      }
    },
    now: () => Date.now(),
    later: (fn) => {
      window.setTimeout(fn, 0);
    },
  };
}

type GuardWindow = Window & { __ppNavigationGuards?: NavigationGuards };

function createGuards(): NavigationGuards {
  if (typeof window === "undefined") return new NavigationGuards(null);
  const w = window as GuardWindow;
  // One instance per tab, also when this module is reloaded while developing.
  if (w.__ppNavigationGuards) return w.__ppNavigationGuards;
  const guards = new NavigationGuards(browserPort());
  w.__ppNavigationGuards = guards;
  window.addEventListener("popstate", (e) => guards.handlePopState(e), true);
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const entry = guards.current();
      if (!entry) return;
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link) return;
      const href = inAppHref(
        {
          href: link.href,
          target: link.target,
          download: link.hasAttribute("download"),
          skip: link.dataset.leaveGuard === "skip",
        },
        window.location.href,
      );
      if (!href) return;
      if (!guards.request(href)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  return guards;
}

/** The tab's guards. */
export const navigationGuards = createGuards();

/**
 * Mounted once, in the signed-in app shell. It renders nothing: loading this module is what adds
 * the tab's link and Back listeners (once per tab, see createGuards), and rendering it in the shell
 * makes sure that happens on every signed-in page, whichever components use the guards.
 */
export function NavigationGuardRoot(): null {
  return null;
}

/**
 * Registers this page's guard while it's mounted. While `active`, in-app links, the search menu,
 * the bell (and, with `protectBack`, the browser's Back button) call `onLeave` instead of leaving,
 * and closing or reloading the tab asks the browser's own "Leave site?" question.
 * `leaveTo(href)` goes somewhere without asking (for a guard's own dialog).
 */
export function useNavigationGuard(options: {
  active: boolean;
  protectBack?: boolean;
  onLeave: (request: LeaveRequest) => void;
}): { leaveTo: (href: string) => void } {
  const router = useRouter();
  const latest = useRef(options);
  const entryRef = useRef<GuardEntry | null>(null);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const entry: GuardEntry = {
      isActive: () => latest.current.active,
      protectsBack: () => latest.current.protectBack ?? false,
      onLeave: (request) => latest.current.onLeave(request),
      navigate: (href, mode) => (mode === "replace" ? router.replace(href) : router.push(href)),
      leaving: false,
    };
    entryRef.current = entry;
    const remove = navigationGuards.add(entry);
    return () => {
      remove();
      if (entryRef.current === entry) entryRef.current = null;
    };
  }, [router]);

  const { active, protectBack = false } = options;
  useEffect(() => {
    // Nothing to lose any more: a "leave" chosen earlier that didn't take the page away is forgotten.
    if (!active && entryRef.current) entryRef.current.leaving = false;
    navigationGuards.changed();
  }, [active, protectBack]);

  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (entryRef.current?.leaving) return;
      e.preventDefault();
      // Older browsers need a returnValue to show their "Leave site?" question.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);

  const leaveTo = useCallback(
    (href: string) => {
      navigationGuards.leave(entryRef.current, (mode: NavMode) => (mode === "replace" ? router.replace(href) : router.push(href)));
    },
    [router],
  );
  return { leaveTo };
}

/**
 * router.push for the search menu, the bell and the Notifications list: when the page has
 * something to lose, its guard is asked first (it saves, or asks "Leave without saving?").
 */
export function useGuardedNavigate(): (href: string) => void {
  const router = useRouter();
  return useCallback(
    (href: string) => {
      const navigate = (mode: NavMode) => (mode === "replace" ? router.replace(href) : router.push(href));
      if (!navigationGuards.request(href, navigate)) router.push(href);
    },
    [router],
  );
}

/**
 * For a click that does something and then opens another page (Ctrl+K › New campaign starts a
 * draft, then opens it): when the page has something to lose, its guard is asked first, and `run`
 * only goes ahead if and when it's fine to leave. `href` is where the click leads (for the guard).
 * `mode` is "replace" when the page it opens should take the place of the current history entry.
 */
export function useGuardedRun(): (href: string, run: (mode: NavMode) => void) => void {
  return useCallback((href: string, run: (mode: NavMode) => void) => {
    if (!navigationGuards.request(href, run)) run("push");
  }, []);
}
