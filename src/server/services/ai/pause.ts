import { AI_NOTIFICATION } from "@/core/notification-types";
import { NOT_PAUSED_AI, parseAiPause } from "@/core/system-state-parse";
import { STATE_KEYS, type AiPauseKind, type AiPauseState } from "@/core/system-state";
import { logActivity } from "@/server/activity";
import { dbWrite } from "@/server/db";
import { notifyOwner } from "@/server/notifications";
import { ServiceError } from "@/server/services/companies/mutations";
import { readTyped, shouldSendNotice, updateTyped } from "@/server/state-typed";
import type { AiActor } from "./review";

/**
 * The AI queue's pause (docs/dev/M5-DESIGN.md §3.7, SystemState "ai.pause"). The drafting job (P8) pauses it when
 * Anthropic refuses the key, the model or the money, when the office month's limit is reached, or when the chosen model
 * has no price; starts are refused while it is paused (§3.2); the Owner resumes it (Resume drafting, or saving a key,
 * a model, prices or a higher limit in Settings › AI, which lift only their own kinds).
 *
 * The first cause wins: while paused, another pauseAi changes nothing. A pause with `until` (the monthly limit, and
 * Anthropic's own monthly cap) lifts by itself at that instant: getAiPause reads it as not paused from then on, and a
 * new pause may replace it. The Owner is notified (type "ai.paused", link Settings › AI) when a pause starts, at most
 * once per notice key per 24 hours.
 */

/** The throttled Owner notice key of each pause kind (M5-DESIGN §5.3). */
export const AI_PAUSE_NOTICE_KEYS: Readonly<Record<AiPauseKind, string>> = {
  key_rejected: "ai-key",
  no_permission: "ai-permission",
  model_not_found: "ai-model",
  tier_spend_cap: "ai-spend-cap",
  own_spend_limit: "ai-own-limit",
  billing: "ai-billing",
  monthly_limit: "ai-monthly-limit",
  no_price: "ai-no-price",
};

/** The notification's title: the monthly limit "stops" drafting, everything else "pauses" it (§3.10). */
export function aiPauseTitle(kind: AiPauseKind): string {
  return kind === "monthly_limit" ? "AI drafting stopped" : "AI drafting paused";
}

/** True when a stored pause with `until` has reached it. */
function expired(state: AiPauseState, now: Date): boolean {
  if (!state.paused || !state.until) return false;
  const until = Date.parse(state.until);
  return Number.isFinite(until) && until <= now.getTime();
}

/** The pause as it applies now: a pause whose `until` has passed reads as not paused. */
function current(state: AiPauseState, now: Date): AiPauseState {
  return state.paused && !expired(state, now) ? state : { ...NOT_PAUSED_AI };
}

/** The AI queue's pause right now (a fresh copy; `until` in the past reads as not paused). */
export async function getAiPause(now: Date = new Date()): Promise<AiPauseState> {
  const { value } = await readTyped(STATE_KEYS.aiPause, parseAiPause);
  return current(value, now);
}

/**
 * Pauses the AI queue with `kind` and its full sentence (`text`, the Owner's words from P2's aiPauseText), compare-and-
 * set. Nothing changes while another pause is in force (the first cause wins). When this call started the pause, the
 * Owner gets an "ai.paused" notification (throttled per notice key). `detail` must already be scrubbed (§0.2 rule 13).
 */
export async function pauseAi(
  kind: AiPauseKind,
  input: { text: string; until: Date | null; model?: string | null; detail?: string | null; now?: Date },
): Promise<{ newlyPaused: boolean }> {
  const now = input.now ?? new Date();
  const res = await updateTyped(STATE_KEYS.aiPause, parseAiPause, (stored): AiPauseState | null => {
    if (current(stored, now).paused) return null;
    return {
      paused: true,
      kind,
      text: input.text,
      since: now.toISOString(),
      until: input.until ? input.until.toISOString() : null,
      model: input.model ?? null,
      detail: input.detail ?? null,
    };
  });
  if (!res.written) return { newlyPaused: false };
  try {
    if (await shouldSendNotice(AI_PAUSE_NOTICE_KEYS[kind], now)) {
      await notifyOwner({ type: AI_NOTIFICATION.paused, title: aiPauseTitle(kind), body: input.text, link: "/settings/ai" });
    }
  } catch (err) {
    console.error("[ai] couldn't notify the Owner about the pause", err);
  }
  return { newlyPaused: true };
}

/**
 * Lifts the pause (Owner only): clears it (compare-and-set), lets every waiting drafting run go on at once (`runAt =
 * now` for queued "ai.draftLines" jobs) and logs `settings.updated`. With `onlyKinds`, a pause of another kind stays
 * (saving a key lifts key_rejected and no_permission, saving a model model_not_found, prices no_price, a higher limit
 * monthly_limit). `resumed` says whether a pause was lifted.
 */
export async function resumeAi(
  actor: AiActor,
  opts: { onlyKinds?: readonly AiPauseKind[]; now?: Date } = {},
): Promise<{ message: string; resumed: boolean }> {
  if (actor.role !== "OWNER") throw new ServiceError("Only the Owner can resume AI drafting.");
  const now = opts.now ?? new Date();
  let liftedKind: AiPauseKind | null = null;
  const res = await updateTyped(STATE_KEYS.aiPause, parseAiPause, (stored): AiPauseState | null => {
    liftedKind = null;
    if (!stored.paused) return null;
    // An expired pause is cleared too (nothing to lift, but it tidies the row); only a live one of another kind stays.
    if (!expired(stored, now) && opts.onlyKinds && (!stored.kind || !opts.onlyKinds.includes(stored.kind))) return null;
    liftedKind = expired(stored, now) ? null : stored.kind;
    return { ...NOT_PAUSED_AI };
  });
  const kind = liftedKind as AiPauseKind | null;
  if (!res.written || kind === null) return { message: "AI drafting isn't paused.", resumed: false };
  await dbWrite((c) =>
    c.job.updateMany({ where: { type: "ai.draftLines", status: "QUEUED", runAt: { gt: now } }, data: { runAt: now } }),
  );
  try {
    await logActivity({
      actorId: actor.id,
      type: "settings.updated",
      summary: `${actor.name} resumed AI drafting`,
      data: { key: STATE_KEYS.aiPause, kind },
    });
  } catch (err) {
    console.error("[ai] couldn't log the resume", err);
  }
  return { message: "AI drafting resumed.", resumed: true };
}
