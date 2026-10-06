import { parseEmail } from "@/core/email-address";

/**
 * Sign-in throttling rules (PLAN.md B10). Pure, so they can be unit-tested; the database side is ./throttle.
 *
 *  - Per account, across all sources: after each wrong password the next try must wait 1 s, 2 s, 4 s … up to
 *    30 s after the last one. This is the real protection: no header changes it, and it's never a lock.
 *  - Per (account, source): after 5 wrong passwords in 15 minutes, that source also waits a minute between
 *    tries. Soft on purpose: source keys can be faked on the office network, so a hard lock there would let
 *    anyone lock someone else out.
 *  - Waits are enforced by refusing ("Wait N seconds"), never by sleeping, and each try is recorded before the
 *    password is checked, so parallel requests can't slip through together.
 */

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const MAX_ACCOUNT_DELAY_MS = 30_000;
export const SOURCE_SOFT_LIMIT = 5;
export const SOURCE_EXTRA_WAIT_MS = 60_000;

/** Longest sign-in email we look up (RFC 5321 path limit). */
export const MAX_LOGIN_EMAIL_LENGTH = 254;
/** Passwords are at most 200 characters when chosen; anything much longer is refused before hashing. */
export const MAX_LOGIN_PASSWORD_LENGTH = 1024;

/** The one message for an unknown email, a wrong password and a switched-off account alike. */
export const LOGIN_MISMATCH_MESSAGE = "That email and password don't match. Check them and try again.";

/** 0 failures → 0 s, then 1 s, 2 s, 4 s … capped at 30 s. */
export function loginDelayMs(recentFailures: number): number {
  if (recentFailures <= 0) return 0;
  return Math.min(MAX_ACCOUNT_DELAY_MS, 1000 * 2 ** (recentFailures - 1));
}

export type RecentFailure = { at: Date; sourceKey: string };

/**
 * The time (epoch ms) from which this account may be tried again from `sourceKey`; 0 means right away.
 * `failures` are the account's failed tries inside the 15-minute window, in any order.
 */
export function nextLoginAllowedAt(failures: readonly RecentFailure[], sourceKey: string): number {
  if (failures.length === 0) return 0;
  let last = 0;
  let lastFromSource = 0;
  let fromSource = 0;
  for (const f of failures) {
    const t = f.at.getTime();
    if (t > last) last = t;
    if (f.sourceKey === sourceKey) {
      fromSource++;
      if (t > lastFromSource) lastFromSource = t;
    }
  }
  let allowedAt = last + loginDelayMs(failures.length);
  if (fromSource >= SOURCE_SOFT_LIMIT) allowedAt = Math.max(allowedAt, lastFromSource + SOURCE_EXTRA_WAIT_MS);
  return allowedAt;
}

/** Whole seconds to wait (at least 1). */
export function secondsUntil(allowedAt: number, now: number): number {
  return Math.max(1, Math.ceil((allowedAt - now) / 1000));
}

export function tooManyTriesMessage(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  return `Too many tries. Wait ${s} second${s === 1 ? "" : "s"} and try again.`;
}

/**
 * The key a sign-in email is looked up and throttled by (the stored, lowercased address), or null when the
 * text can't be anyone's address. Checked before any database access, so junk is never stored.
 */
export function loginEmailKey(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > MAX_LOGIN_EMAIL_LENGTH) return null;
  const parsed = parseEmail(s);
  if (!parsed || parsed.norm.length > MAX_LOGIN_EMAIL_LENGTH) return null;
  return parsed.norm;
}
