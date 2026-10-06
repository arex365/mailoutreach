import { GO_LIVE_COPY, goLiveDialogItems, type GoLiveDialogFrom, type GoLiveWarmup } from "@/core/sending/go-live-copy";
import { domainOfAddress } from "@/core/sending/from-address";
import { formatDateTime } from "@/core/time/format";
import type { GoLiveView } from "@/server/services/go-live";
import type { GoLiveCardView } from "../types";

/**
 * The "Go live" card in words (M6-DESIGN §2.5), from the service's view: which of its four states it is in, the title
 * and description (incl. the domain-change case, G8), the blocker and recommendation lists, the live line with who and
 * when (in the viewer's zone), the warm-up line, and the confirmation dialog's list for the warm-up settings in use
 * (the table, and how a step is earned: review SCREENS-10). Pure and browser-safe (the type imports are erased), so
 * every state is unit-tested.
 *
 * Shared From address (SHARED-FROM-DESIGN §3.3, F12, F13, F21): live in shared-From mode, the From line under the live
 * line; not live after a From change on the same domain, "You were live with … as the From address…"; the dialog's
 * From item in both modes (the shared address, or the Owner's own From line as the example); and, while the reply test
 * recorded a spam placement, the dialog's required spam-placement tick. Keys that don't apply are left out, so a
 * per-person card is exactly as before.
 *
 * Own-mailbox mode (`view.ownMailbox`, MAIN-DOMAIN-DESIGN §3.4, O14, O20): live, the own From line under the live line
 * (`liveOwnFromLine`); not live, the own-mailbox guide line, the dialog's own-mailbox item in the From item's place, the
 * required replies tick (`ownMailboxTick`) and, while the https-links row isn't "ok", the http-links tick. The warm-up
 * item names the maximum the caller passes in `ctx.warmup` (the plan's effective maximum, 90 on Free).
 */
export function goLiveCardView(view: GoLiveView, ctx: { timeZone: string; warmup: GoLiveWarmup }): GoLiveCardView {
  const empty = { blockers: [], recommendations: [], guideLine: null, warmupLine: null, cantSwitchOff: null, dialogItems: [] };
  if (view.practiceCopy) {
    return { ...empty, state: "practice", title: GO_LIVE_COPY.title, description: GO_LIVE_COPY.practiceCopy };
  }
  const teamFrom = view.from ?? null;
  const own = view.ownMailbox ?? null;
  const ownFrom = own?.from.trim() || null;
  if (view.live) {
    const at = view.at ? formatDateTime(view.at, ctx.timeZone) : null;
    return {
      ...empty,
      state: "live",
      title: GO_LIVE_COPY.title,
      description: at ? GO_LIVE_COPY.liveLine(at, view.byName, view.domain) : "New live campaigns email everyone eligible.",
      warmupLine: view.warmupLine,
      cantSwitchOff: GO_LIVE_COPY.cantSwitchOff,
      ...(own
        ? ownFrom
          ? { fromLine: GO_LIVE_COPY.liveOwnFromLine(ownFrom) }
          : {}
        : teamFrom
          ? { fromLine: GO_LIVE_COPY.liveFromLine(teamFrom) }
          : {}),
    };
  }
  const changed = view.endedOnDomain && view.domain ? { from: view.endedOnDomain, to: view.domain } : null;
  const fromChanged = !changed && view.endedOnFrom ? view.endedOnFrom : null;
  const ready = view.blockers.length === 0;
  const org = teamFrom ? domainOfAddress(teamFrom) : null;
  const from: GoLiveDialogFrom = own
    ? { team: null, ownExample: null, ownMailbox: ownFrom ? { from: ownFrom, domain: own.domain } : null }
    : {
        team: teamFrom && org ? { from: teamFrom, org } : null,
        ownExample: view.ownFromExample ?? null,
      };
  const spam = (view.spamPlacements ?? []).map((s) => s.trim()).filter(Boolean);
  return {
    ...empty,
    state: ready ? "ready" : "blocked",
    title: changed ? GO_LIVE_COPY.titleOn(changed.to) : GO_LIVE_COPY.title,
    description: changed
      ? GO_LIVE_COPY.descriptionAfterDomainChange(changed.from, changed.to)
      : fromChanged
        ? GO_LIVE_COPY.descriptionAfterFromChange(fromChanged.was, own ? ownFrom : teamFrom)
        : GO_LIVE_COPY.descriptionBefore,
    blockers: view.blockers,
    recommendations: view.recommendations,
    guideLine: own ? GO_LIVE_COPY.guideLineOwn : GO_LIVE_COPY.guideLine,
    dialogItems: ready ? goLiveDialogItems({ capOverrideToday: view.capOverrideToday, drafts: view.drafts, warmup: ctx.warmup, from }) : [],
    ...(ready && own && ownFrom ? { ownMailboxTick: GO_LIVE_COPY.ownMailboxTick(ownFrom) } : {}),
    ...(ready && own?.httpLinksTick ? { httpLinksTick: GO_LIVE_COPY.httpLinksTick } : {}),
    ...(ready && spam.length > 0 ? { spamPlacementTick: GO_LIVE_COPY.spamPlacementTick(spam.join(", ")) } : {}),
  };
}
