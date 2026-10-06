import { formatShortDate, formatTime } from "@/core/time/format";
import { FALLBACK_CAP_ZONE, safeZone } from "@/core/sending/capday";
import { pausedWithReason } from "@/core/sending/label";
import {
  notPaused,
  parseHealthBaseline,
  parsePauseState,
  parseRestoreState,
} from "@/core/system-state-parse";
import { STATE_KEYS, type HealthBaseline, type PauseDetail, type PauseKind, type PauseState } from "@/core/system-state";
import { logActivity } from "../../activity";
import { db } from "../../db";
import { notifyOwner } from "../../notifications";
import { casState } from "../../state";
import { readTyped, StateConflictError, updateTyped } from "../../state-typed";

/**
 * The global pause (M3-DESIGN §4.2.6, PLAN B6.6): "Pause all sending" and every automatic pause (health, Mailgun
 * refusing, a restore, a copied database). SystemState "sending.pause" holds the first cause; later causes are kept in
 * `also`, never replacing it. The pause stops every campaign, dry runs included, until someone resumes.
 */

export type PauseInput = {
  kind: PauseKind;
  /** Short, for the top-bar label "Paused: <reason>". */
  reason: string;
  /** What to do, full sentences. */
  fixText: string;
  detail?: PauseDetail | null;
  /** Who paused it; null/undefined = the app did. */
  byUserId?: number | null;
  now?: Date;
};

const HEALTH_KINDS: ReadonlySet<PauseKind> = new Set(["health-bounce", "health-complaint"]);
const CAS_TRIES = 5;

export async function getPauseState(): Promise<PauseState> {
  return (await readTyped(STATE_KEYS.pause, parsePauseState)).value;
}

function sameDetail(a: PauseDetail | null, b: PauseDetail | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Pauses all sending (compare-and-set, 5 tries). When not paused yet: writes the new state, then logs activity
 * `sending.paused` and notifies the Owner (type `sending.paused`), except when the Owner paused it by hand. When
 * already paused: a new kind is added to `also` (no new notification); a health kind already in `also` gets its
 * numbers refreshed; the main kind again changes nothing. Returns whether this call started the pause.
 */
export async function pauseSending(input: PauseInput): Promise<{ newlyPaused: boolean; state: PauseState }> {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const detail = input.detail ?? null;
  let newlyPaused = false;
  const res = await updateTyped(
    STATE_KEYS.pause,
    parsePauseState,
    (cur): PauseState | null => {
      newlyPaused = false;
      if (!cur.paused) {
        newlyPaused = true;
        return {
          paused: true,
          reason: input.reason,
          kind: input.kind,
          fixText: input.fixText,
          since: at,
          byUserId: input.byUserId ?? null,
          detail,
          also: [],
        };
      }
      if (cur.kind === input.kind) return null;
      const i = cur.also.findIndex((a) => a.kind === input.kind);
      if (i < 0) return { ...cur, also: [...cur.also, { kind: input.kind, reason: input.reason, at, detail }] };
      const existing = cur.also[i]!;
      if (!HEALTH_KINDS.has(input.kind) || (sameDetail(existing.detail, detail) && existing.reason === input.reason)) {
        return null;
      }
      const also = [...cur.also];
      also[i] = { ...existing, reason: input.reason, detail };
      return { ...cur, also };
    },
    CAS_TRIES,
  );

  if (newlyPaused && res.written) {
    const actorId = input.byUserId ?? null;
    try {
      await logActivity({
        actorId,
        type: "sending.paused",
        summary: pausedWithReason("Sending paused", input.reason),
        data: { kind: input.kind, ...(detail ? { detail: detail as Record<string, string | number> } : {}) },
      });
    } catch (err) {
      console.error("[pause] couldn't log the pause", err);
    }
    try {
      const byOwner =
        actorId !== null &&
        (await db.user.findUnique({ where: { id: actorId }, select: { role: true } }))?.role === "OWNER";
      if (!byOwner) {
        await notifyOwner({
          type: "sending.paused",
          title: pausedWithReason("Sending paused", input.reason),
          body: input.fixText,
          link: "/settings/sending",
        });
      }
    } catch (err) {
      console.error("[pause] couldn't notify the Owner", err);
    }
  }
  return { newlyPaused: newlyPaused && res.written, state: res.value };
}

/** Every cause of the current pause: the main kind first, then `also`. */
function kindsOf(state: PauseState): PauseKind[] {
  return [...(state.kind ? [state.kind] : []), ...state.also.map((a) => a.kind)];
}

/** The health numbers the person acknowledges by resuming: the main health kind's, else the first health `also`. */
function healthAcknowledged(state: PauseState): HealthBaseline["acknowledged"] {
  const pick = (kind: PauseKind | null, detail: PauseDetail | null) =>
    kind && HEALTH_KINDS.has(kind) && detail && (detail.count !== undefined || detail.sample !== undefined)
      ? { kind: kind as "health-bounce" | "health-complaint", count: detail.count ?? 0, sample: detail.sample ?? 0 }
      : null;
  const main = pick(state.kind, state.detail);
  if (main) return main;
  for (const a of state.also) {
    const p = pick(a.kind, a.detail);
    if (p) return p;
  }
  return null;
}

/**
 * Resumes sending, in this order, so a crash between steps can only leave it still paused, never resumed with the old
 * health baseline:
 *  1. restore guard: a restore whose Mailgun check failed or couldn't run needs `confirmRestoreRisk`
 *     (then `restore.acknowledgedAt/By` is recorded); a check still running doesn't block (the restore gate holds
 *     Mailgun sends until it finishes, and a check that then fails or can't reach Mailgun pauses again with kind
 *     "restore", so this confirmation is always reachable: restore.ts pauseUntilAcknowledged);
 *  2. a health cause (main or `also`) resets the health baseline: only emails sent after now count;
 *  3. the pause is cleared (compare-and-set against the exact state checked above);
 *  4. a pause with a "restore" cause records who resumed and when (`restore.resumedAt/resumedById`, M6-DESIGN §3.7:
 *     Settings › Backups' "Last restore" card keeps saying it after the pause card is gone); a failed write is logged
 *     and never undoes the resume;
 *  5. activity `sending.resumed`: "Resumed by Arslan with 7 of 200 acknowledged" (health) or "Resumed by Arslan".
 * Mailgun isn't tested first: if the cause is still there, the next send pauses again.
 * `resumed: false` with a plain `summary` when it wasn't paused or the restore risk wasn't confirmed.
 */
export async function resumeSending(input: {
  actorId: number;
  actorName: string;
  now?: Date;
  confirmRestoreRisk?: boolean;
}): Promise<{ resumed: boolean; summary: string; state: PauseState }> {
  const now = input.now ?? new Date();
  for (let attempt = 0; attempt < CAS_TRIES; attempt++) {
    const { value: cur, version } = await readTyped(STATE_KEYS.pause, parsePauseState);
    if (!cur.paused || version === null) return { resumed: false, summary: "Sending isn't paused.", state: cur };
    const kinds = kindsOf(cur);

    // 1. Restore guard.
    if (kinds.includes("restore")) {
      const restore = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
      const unchecked = restore.status === "failed" || (restore.status === "done" && restore.report?.mailgunChecked === false);
      if (unchecked) {
        if (!input.confirmRestoreRisk) {
          const zone = await actorZone(input.actorId);
          const from = restore.restoredFrom;
          const when = from ? `${formatShortDate(from, zone, now)} ${formatTime(from, zone)}` : "the backup was made";
          return {
            resumed: false,
            summary: `Tick the box to confirm that emails sent after ${when} may go out a second time.`,
            state: cur,
          };
        }
        await updateTyped(STATE_KEYS.restore, parseRestoreState, (r) => ({
          ...r,
          acknowledgedAt: now.toISOString(),
          acknowledgedById: input.actorId,
        }));
      }
    }

    // 2. Health baseline first.
    const acknowledged = healthAcknowledged(cur);
    if (kinds.some((k) => HEALTH_KINDS.has(k))) {
      await updateTyped(STATE_KEYS.healthBaseline, parseHealthBaseline, () => ({
        since: now.toISOString(),
        resumedById: input.actorId,
        acknowledged,
        warnedBounceAt: null,
        warnedComplaintAt: null,
      }));
    }

    // 3. Then the pause, only if nothing changed since the checks above.
    const cleared = notPaused();
    if (!(await casState(STATE_KEYS.pause, version, cleared))) continue;

    // 4. Who resumed after the restore (the "Last restore" card).
    if (kinds.includes("restore")) {
      try {
        await updateTyped(STATE_KEYS.restore, parseRestoreState, (r) =>
          r.status === "none" ? null : { ...r, resumedAt: now.toISOString(), resumedById: input.actorId },
        );
      } catch (err) {
        console.error("[pause] couldn't record who resumed after the restore", err);
      }
    }

    // 5. Activity.
    const summary = acknowledged
      ? `Resumed by ${input.actorName} with ${acknowledged.count} of ${acknowledged.sample} acknowledged`
      : `Resumed by ${input.actorName}`;
    try {
      await logActivity({ actorId: input.actorId, type: "sending.resumed", summary, data: { kinds } });
    } catch (err) {
      console.error("[pause] couldn't log the resume", err);
    }
    return { resumed: true, summary, state: cleared };
  }
  throw new StateConflictError(STATE_KEYS.pause, CAS_TRIES);
}

async function actorZone(userId: number): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { timeZone: true } });
  return safeZone(user?.timeZone, FALLBACK_CAP_ZONE);
}
