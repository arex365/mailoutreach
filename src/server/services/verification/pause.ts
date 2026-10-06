import { VERIFY_NOTIFICATION } from "@/core/notification-types";
import { NOT_PAUSED_CHECKS, parseCheckPause } from "@/core/system-state-parse";
import { STATE_KEYS, type CheckPauseKind, type CheckPauseState } from "@/core/system-state";
import { checkPauseTitle } from "@/core/verification/words";
import { logActivity } from "@/server/activity";
import { dbWrite } from "@/server/db";
import { notifyOwner } from "@/server/notifications";
import { casState } from "@/server/state";
import { readTyped, shouldSendNotice, StateConflictError, updateTyped } from "@/server/state-typed";

/**
 * The address check pause (M5-DESIGN §2.12), SystemState "checks.pause". The check job pauses every run when Mailgun
 * refuses the key or the account, when its answers can't be read, or before a call that would pass this office
 * month's check limit; starts refuse while it lasts. The first cause wins. A pause with `until` (the monthly limit)
 * lifts by itself at that instant; the others until someone resumes (or saves a new address check key, P7).
 */

/** The throttled Owner notice key per pause kind (at most one notice per key per 24 hours). */
export const CHECK_PAUSE_NOTICE_KEYS: Readonly<Record<CheckPauseKind, string>> = {
  auth: "verify-auth",
  payment: "verify-payment",
  "not-allowed": "verify-refused",
  "business-verification": "verify-refused",
  "not-found": "verify-refused",
  unreadable: "verify-unreadable",
  monthly_limit: "verify-monthly-limit",
};

/** Where the pause notice leads: the Address checks card. */
const CHECKS_SETTINGS_LINK = "/settings/deliverability#checks";
const CAS_TRIES = 5;

/** True when a stored pause has an `until` that has come (it no longer holds anything). */
function lapsed(state: CheckPauseState, now: Date): boolean {
  return state.paused && state.until !== null && Date.parse(state.until) <= now.getTime();
}

/** The current pause; a pause whose `until` has passed (the monthly limit in a new month) reads as not paused. */
export async function getChecksPause(now: Date = new Date()): Promise<CheckPauseState> {
  const { value } = await readTyped(STATE_KEYS.checksPause, parseCheckPause);
  return lapsed(value, now) ? { ...NOT_PAUSED_CHECKS } : value;
}

/**
 * Pauses address checks (compare-and-set; the first cause wins, a lapsed pause is replaced). `detail` is Mailgun's
 * text, already scrubbed (scrubProviderText), shown only behind "Details". When this call started the pause, the
 * Owner gets a `verify.paused` notice, at most one per notice key per 24 hours.
 */
export async function pauseChecks(
  kind: CheckPauseKind,
  text: string,
  detail: string | null,
  opts: { until?: Date | null; now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const res = await updateTyped(
    STATE_KEYS.checksPause,
    parseCheckPause,
    (cur): CheckPauseState | null => {
      if (cur.paused && !lapsed(cur, now)) return null;
      return {
        paused: true,
        kind,
        text,
        since: now.toISOString(),
        until: opts.until ? opts.until.toISOString() : null,
        detail: detail ? detail.slice(0, 1000) : null,
      };
    },
    CAS_TRIES,
  );
  if (!res.written) return;
  try {
    if (await shouldSendNotice(CHECK_PAUSE_NOTICE_KEYS[kind], now)) {
      await notifyOwner({ type: VERIFY_NOTIFICATION.paused, title: checkPauseTitle(kind), body: text, link: CHECKS_SETTINGS_LINK });
    }
  } catch (err) {
    console.error("[checks] couldn't notify the Owner about the pause", err);
  }
}

/**
 * Resumes address checks (the Owner's "Resume checks"; P7 also calls it after saving an address check key with
 * `onlyKinds: ["auth"]` and after raising the monthly limit with `onlyKinds: ["monthly_limit"]`). Clears the pause,
 * lets the waiting check runs go at once (`runAt = now`) and logs `settings.updated` "Arslan resumed address checks".
 * The check job pauses again if the cause is still there.
 */
export async function resumeChecks(
  actor: { id: number; name: string },
  opts: { onlyKinds?: CheckPauseKind[]; now?: Date } = {},
): Promise<{ message: string }> {
  const now = opts.now ?? new Date();
  for (let attempt = 0; attempt < CAS_TRIES; attempt++) {
    const { value: cur, version } = await readTyped(STATE_KEYS.checksPause, parseCheckPause);
    if (!cur.paused || version === null) return { message: "Address checks aren't paused." };
    if (opts.onlyKinds && (!cur.kind || !opts.onlyKinds.includes(cur.kind))) {
      return { message: "Address checks stay paused for another reason." };
    }
    if (!(await casState(STATE_KEYS.checksPause, version, { ...NOT_PAUSED_CHECKS }))) continue;

    await dbWrite((c) =>
      c.job.updateMany({ where: { type: "verify.addresses", status: "QUEUED", runAt: { gt: now } }, data: { runAt: now } }),
    );
    try {
      await logActivity({
        actorId: actor.id,
        type: "settings.updated",
        summary: `${actor.name} resumed address checks`,
        data: { key: STATE_KEYS.checksPause, kind: cur.kind },
      });
    } catch (err) {
      console.error("[checks] couldn't log the resume", err);
    }
    return { message: "Address checks resumed." };
  }
  throw new StateConflictError(STATE_KEYS.checksPause, CAS_TRIES);
}
