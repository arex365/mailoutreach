"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Live updates for the campaign page without an extra endpoint (PLAN.md B6.14: polling, no SSE):
 * while `active`, the page's server components are re-rendered every `intervalMs` (router.refresh
 * keeps scroll position and client state). It skips a round while the tab is hidden or while
 * someone is editing (useHoldLiveRefresh), so nothing jumps under their cursor.
 */

let holds = 0;

/** True while a component asked to keep the page still (an open editor, a confirmation…). */
export function liveRefreshHeld(): boolean {
  return holds > 0;
}

/** Keeps the page from refreshing itself while `hold` is true. */
export function useHoldLiveRefresh(hold: boolean): void {
  useEffect(() => {
    if (!hold) return;
    holds += 1;
    return () => {
      holds = Math.max(0, holds - 1);
    };
  }, [hold]);
}

export function LiveRefresh({ active, intervalMs = 10_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (liveRefreshHeld()) return;
      router.refresh();
    }, Math.max(2_000, intervalMs));
    return () => window.clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}
