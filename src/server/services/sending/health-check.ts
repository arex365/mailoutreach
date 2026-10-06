import { evaluateHealth, type HealthSettings, type HealthVerdict } from "@/core/sending/health";
import { healthCountingSince, healthGoLiveAt } from "@/core/sending/health-since";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { parseHealthBaseline } from "@/core/system-state-parse";
import { STATE_KEYS, type HealthBaseline } from "@/core/system-state";
import { notifyOwner } from "@/server/notifications";
import { getSettings } from "@/server/settings";
import { readTyped, updateTyped } from "@/server/state-typed";
import { loadTeamFrom } from "../mailgun/team-from";
import { pauseSending } from "./pause";
import { loadHealthCounts } from "./usage";

/**
 * The health check (PLAN B6.6, M3-DESIGN §4.3.8): pauses all sending when too many recent counted
 * emails bounced or were marked as spam, and warns the Owner at half the limit. Runs after the event
 * lane found problems (wired by P6), at worker start-up, and after each successful catch-up.
 *
 * Only emails sent after the health baseline count (set when a health pause is resumed), so after a
 * resume it never trips again without new events, whichever pause kind was the main one. On real data only emails
 * sent after go-live count too (M6-DESIGN G12, `healthCountingSince`): bounces to test mailboxes during the rehearsal
 * never push real sending towards the pause. That is the first go-live on the sending domain (`healthGoLiveAt`, review
 * REPLIES-02): a From change and a new go-live on the same domain never wipe the earlier bounces and complaints.
 * A warning is sent once per rise: it is forgotten again when the count falls below the warning
 * level, or when it is more than 7 days old, so a later rise warns again.
 *
 * Thresholds are the same in both modes (SHARED-FROM-DESIGN F20). In shared-From mode the complaint warning adds
 * `teamFromComplaintNote`: the complaints also count against the everyday email of the From address's domain, and
 * Gmail's never reach this count. Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.9) uses the same complaint note with the own
 * From (`evidenceFrom`), and bounce warnings add `OWN_MAILBOX_TEXTS.healthBounceNote`: bounces that come later go to
 * that mailbox, not the app.
 */

export const WARNING_FORGET_MS = 7 * 86_400_000;

/** Shared-From mode (§3.8): appended to the half-limit complaint warning's body (bounce warnings are unchanged). */
export function teamFromComplaintNote(from: string): string {
  return ` Your emails come from ${from}, so these complaints also count against your everyday email. Gmail's complaints aren't in this count: check Google Postmaster Tools.`;
}

/**
 * What a warning adds to its body: the complaint note with the evidence From (the shared From, or the own From), and in
 * own-mailbox mode the late-bounce note on bounce warnings; "" in per-person mode.
 */
export function healthWarningNote(rule: "bounce" | "complaint", team: { replies: string; evidenceFrom: string | null }): string {
  const from = team.evidenceFrom;
  if (!from) return "";
  if (rule === "complaint") return teamFromComplaintNote(from);
  return team.replies === "own-mailbox" ? OWN_MAILBOX_TEXTS.healthBounceNote(from) : "";
}

/** The From settings for the notes, or null. A failed read only drops the note (the warning still goes). */
async function teamFromForWarning(): Promise<{ replies: string; evidenceFrom: string | null } | null> {
  try {
    const team = await loadTeamFrom();
    return { replies: team.replies, evidenceFrom: team.evidenceFrom };
  } catch (err) {
    console.error("[health] couldn't read the From address", err);
    return null;
  }
}

function numberSetting(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The count at which a warning is due: half the limit, at least 1 (as @/core/sending/health). */
function warnLevel(limit: number): number {
  return Math.max(1, Math.ceil(limit / 2));
}

function isStale(at: string | null, now: Date): boolean {
  const t = at ? Date.parse(at) : Number.NaN;
  return !Number.isFinite(t) || now.getTime() - t > WARNING_FORGET_MS;
}

export async function runHealthCheck(
  opts: { now?: Date } = {},
): Promise<{ verdict: HealthVerdict; paused: boolean; warned: Array<"bounce" | "complaint"> }> {
  const now = opts.now ?? new Date();
  const s = await getSettings([
    "health.bounceWindow",
    "health.bouncePercent",
    "health.complaintWindow",
    "health.complaintPercent",
    "practice.copy",
    "sending.goLiveAt",
    "sending.healthSinceGoLiveAt",
  ] as const);
  const practiceCopy = s["practice.copy"] === true;
  const settings: HealthSettings = {
    bounceWindow: numberSetting(s["health.bounceWindow"], 200),
    bouncePercent: numberSetting(s["health.bouncePercent"], 3),
    complaintWindow: numberSetting(s["health.complaintWindow"], 1000),
    complaintPercent: numberSetting(s["health.complaintPercent"], 0.1),
  };
  const baseline = (await readTyped(STATE_KEYS.healthBaseline, parseHealthBaseline)).value;
  const counts = await loadHealthCounts({
    // After the baseline and, on real data, after the first go-live on this sending domain (M6-DESIGN G12, review
    // REPLIES-02): rehearsal bounces never count, and going live again after a From change keeps the earlier ones.
    since: healthCountingSince(baseline.since, healthGoLiveAt(s["sending.goLiveAt"], s["sending.healthSinceGoLiveAt"]), practiceCopy),
    bounceWindow: settings.bounceWindow,
    complaintWindow: settings.complaintWindow,
    practiceCopy,
  });

  // Forget a warning when the count fell below the warning level again, or when it is a week old.
  const limits = evaluateHealth(counts, settings, { bounce: true, complaint: true });
  const clearBounce = baseline.warnedBounceAt !== null && (counts.bounces < warnLevel(limits.bounceLimit) || isStale(baseline.warnedBounceAt, now));
  const clearComplaint =
    baseline.warnedComplaintAt !== null && (counts.complaints < warnLevel(limits.complaintLimit) || isStale(baseline.warnedComplaintAt, now));
  let current: HealthBaseline = baseline;
  if (clearBounce || clearComplaint) {
    const res = await updateTyped(STATE_KEYS.healthBaseline, parseHealthBaseline, (cur) => ({
      ...cur,
      warnedBounceAt: clearBounce ? null : cur.warnedBounceAt,
      warnedComplaintAt: clearComplaint ? null : cur.warnedComplaintAt,
    }));
    current = res.value;
  }

  const verdict = evaluateHealth(counts, settings, {
    bounce: current.warnedBounceAt !== null,
    complaint: current.warnedComplaintAt !== null,
  });
  if (verdict.pause) {
    await pauseSending({
      kind: verdict.pause.kind,
      reason: verdict.pause.reason,
      fixText: verdict.pause.fixText,
      detail: verdict.pause.detail,
      now,
    });
    return { verdict, paused: true, warned: [] };
  }

  const warned: Array<"bounce" | "complaint"> = [];
  for (const w of verdict.warn) {
    const field = w.rule === "bounce" ? "warnedBounceAt" : "warnedComplaintAt";
    const res = await updateTyped(STATE_KEYS.healthBaseline, parseHealthBaseline, (cur) =>
      cur[field] ? null : { ...cur, [field]: now.toISOString() },
    );
    if (!res.written) continue;
    warned.push(w.rule);
    const team = await teamFromForWarning();
    const body = `${w.body}${team ? healthWarningNote(w.rule, team) : ""}`;
    try {
      await notifyOwner({ type: "sending.warning", title: w.title, body, link: "/settings/deliverability" });
    } catch (err) {
      console.error("[health] couldn't send the warning", err);
    }
  }
  return { verdict, paused: false, warned };
}
