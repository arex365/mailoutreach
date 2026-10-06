import type { HealthSinceGoLive } from "@/core/setting-types";

/**
 * Since when bounces and complaints count (M6-DESIGN §2.6, G12): the health check, Domain health and the warm-up's
 * health judgement only look at emails sent after this moment. On real data it is the later of the health baseline
 * (set when a health pause is resumed) and go-live, so rehearsal bounces to test mailboxes before go-live never count
 * toward real sending. The practice copy never goes live: there only the baseline counts. Pure; nothing is written
 * (read-side, so nothing can be half-written).
 *
 * Go-live here is the FIRST go-live on the sending domain (review REPLIES-02, `healthGoLiveAt`): a From address change
 * ends go-live on the same Mailgun domain (SHARED-FROM-DESIGN F13), and going live again must not drop the earlier live
 * period's bounces and complaints from the automatic pause. Only a go-live on another sending domain starts again.
 * The warm-up's restart still follows Setting "sending.goLiveAt" (every go-live restarts the ramp).
 */

function instant(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Setting "sending.healthSinceGoLiveAt" read defensively: null unless `since` and `goLiveAt` are readable times and
 * `domain` is a name. The times come back as ISO strings.
 */
export function parseHealthSinceGoLive(v: unknown): HealthSinceGoLive | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const since = instant(o.since);
  const goLiveAt = instant(o.goLiveAt);
  const domain = typeof o.domain === "string" ? o.domain.trim().toLowerCase() : "";
  if (!since || !goLiveAt || !domain) return null;
  return { since: since.toISOString(), goLiveAt: goLiveAt.toISOString(), domain };
}

/**
 * The go-live moment health counts from (review REPLIES-02): the `goLiveAt` argument of `healthCountingSince` and
 * `countsFromGoLive`. It is Setting "sending.healthSinceGoLiveAt"'s `since` while that value belongs to today's
 * "sending.goLiveAt" (the first go-live on this sending domain, kept when a From change ended go-live and the Owner went
 * live again), else "sending.goLiveAt" itself: never live, an install from before this setting, a seed or test that
 * wrote go-live directly, or a value another go-live wrote. Null when there is no readable go-live time.
 */
export function healthGoLiveAt(goLiveAt: unknown, healthSince: unknown): string | null {
  const live = instant(goLiveAt);
  if (!live) return null;
  const h = parseHealthSinceGoLive(healthSince);
  if (h && Date.parse(h.goLiveAt) === live.getTime() && Date.parse(h.since) <= live.getTime()) return h.since;
  return live.toISOString();
}

/**
 * What goLive() writes to Setting "sending.healthSinceGoLiveAt" when it switches go-live on for `domain` at `at` (ISO),
 * from the settings as they were just before (review REPLIES-02): the previous go-live's health start when that go-live
 * was on the same sending domain (a From change ended it), else `at` (the first go-live, or another domain: a new
 * sending reputation starts counting afresh).
 */
export function nextHealthSince(
  before: { goLiveAt: unknown; goLiveDomain: unknown; healthSince: unknown },
  domain: string,
  at: string,
): HealthSinceGoLive {
  const d = domain.trim().toLowerCase();
  const prevDomain = typeof before.goLiveDomain === "string" ? before.goLiveDomain.trim().toLowerCase() : "";
  const kept = prevDomain !== "" && prevDomain === d ? healthGoLiveAt(before.goLiveAt, before.healthSince) : null;
  const since = kept !== null && Date.parse(kept) <= Date.parse(at) ? kept : at;
  return { since, goLiveAt: at, domain: d };
}

/**
 * The later of `baselineSince` and `goLiveAt` on real data, the baseline alone in the practice copy; null when neither
 * is set (everything counts). Unreadable values are ignored. Pass `healthGoLiveAt(<sending.goLiveAt>,
 * <sending.healthSinceGoLiveAt>)` as `goLiveAt`, never "sending.goLiveAt" alone (review REPLIES-02).
 */
export function healthCountingSince(baselineSince: string | null, goLiveAt: string | null, practiceCopy: boolean): Date | null {
  const base = instant(baselineSince);
  const live = practiceCopy ? null : instant(goLiveAt);
  if (!base) return live;
  if (!live) return base;
  return live.getTime() > base.getTime() ? live : base;
}

/** True when `since` is the go-live moment (so Domain health says "Counting since you went live on …"). */
export function countsFromGoLive(since: Date | null, goLiveAt: string | null, practiceCopy: boolean): boolean {
  const live = practiceCopy ? null : instant(goLiveAt);
  return since !== null && live !== null && since.getTime() === live.getTime();
}
