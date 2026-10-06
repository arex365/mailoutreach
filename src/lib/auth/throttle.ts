import "server-only";
import { db, dbTx, dbWrite, type DbOrTx } from "@/server/db";
import { LOGIN_WINDOW_MS, nextLoginAllowedAt, secondsUntil, type RecentFailure } from "./throttle-rules";

/**
 * Login throttling without Redis (PLAN.md B10); the rules are in ./throttle-rules.
 *
 * claimLoginAttempt() is the gate every password check goes through:
 *  1. only one check per account runs at a time in this process (the web app is one Next.js process);
 *  2. inside a write transaction it reads the account's recent failures, refuses when the next try isn't
 *     allowed yet, and otherwise records this try as a failure BEFORE the password is checked, so any
 *     parallel request already sees it;
 *  3. when the password turns out right, slot.succeeded() turns that row into a success and clears the
 *     account's failures.
 */

export { loginDelayMs } from "./throttle-rules";

const FAILURES_READ_LIMIT = 500;

async function recentFailures(reader: DbOrTx, emailNorm: string, now: Date): Promise<RecentFailure[]> {
  return reader.loginAttempt.findMany({
    where: { emailNorm, success: false, at: { gte: new Date(now.getTime() - LOGIN_WINDOW_MS) } },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: FAILURES_READ_LIMIT,
    select: { at: true, sourceKey: true },
  });
}

// Accounts with a password check in progress. On globalThis so every bundle of this process shares one set.
const globalForLogin = globalThis as unknown as { __outreachLoginInFlight?: Set<string> };
const inFlight = (globalForLogin.__outreachLoginInFlight ??= new Set<string>());

export type LoginSlot = {
  /** The account's failed tries in the window, counting this one. */
  accountFailures: number;
  /** Failed tries from this source in the window, counting this one. */
  sourceFailures: number;
  /** The password was right: this try becomes a success and the account's failures are cleared. */
  succeeded(): Promise<void>;
  /** Lets the next try for this account start. Always call it (in `finally`); calling twice is fine. */
  release(): void;
};

export type LoginClaim = { ok: true; slot: LoginSlot } | { ok: false; retryInSeconds: number };

export async function claimLoginAttempt(emailNorm: string, sourceKey: string): Promise<LoginClaim> {
  // Synchronous check-and-add: nothing can run between these two lines.
  if (inFlight.has(emailNorm)) return { ok: false, retryInSeconds: 1 };
  inFlight.add(emailNorm);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inFlight.delete(emailNorm);
  };
  try {
    const claim = await dbTx(async (tx) => {
      const now = new Date();
      const failures = await recentFailures(tx, emailNorm, now);
      const allowedAt = nextLoginAllowedAt(failures, sourceKey);
      if (now.getTime() < allowedAt) {
        return { ok: false as const, retryInSeconds: secondsUntil(allowedAt, now.getTime()) };
      }
      const row = await tx.loginAttempt.create({
        data: { emailNorm, sourceKey, success: false, at: now },
        select: { id: true },
      });
      return {
        ok: true as const,
        attemptId: row.id,
        accountFailures: failures.length + 1,
        sourceFailures: failures.filter((f) => f.sourceKey === sourceKey).length + 1,
      };
    });
    if (!claim.ok) {
      release();
      return claim;
    }
    return {
      ok: true,
      slot: {
        accountFailures: claim.accountFailures,
        sourceFailures: claim.sourceFailures,
        succeeded: () =>
          dbTx(async (tx) => {
            await tx.loginAttempt.updateMany({ where: { id: claim.attemptId }, data: { success: true } });
            await tx.loginAttempt.deleteMany({ where: { emailNorm, success: false } });
          }),
        release,
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}

export type ThrottleVerdict =
  | { allowed: true; delayMs: number }
  | { allowed: false; retryInMinutes: number; retryInSeconds: number };

/**
 * Read-only check for other password prompts (Settings → change password), which record a wrong password
 * with recordLoginAttempt(). Never asks anyone to sleep (delayMs is always 0): a try that isn't allowed yet
 * is refused. New code should use claimLoginAttempt(), which also records the try before checking it.
 */
export async function checkLoginThrottle(emailNorm: string, sourceKey: string, now = new Date()): Promise<ThrottleVerdict> {
  const allowedAt = inFlight.has(emailNorm)
    ? now.getTime() + 1000
    : nextLoginAllowedAt(await recentFailures(db, emailNorm, now), sourceKey);
  if (now.getTime() < allowedAt) {
    const seconds = secondsUntil(allowedAt, now.getTime());
    return { allowed: false, retryInSeconds: seconds, retryInMinutes: Math.max(1, Math.ceil(seconds / 60)) };
  }
  return { allowed: true, delayMs: 0 };
}

export async function recordLoginAttempt(emailNorm: string, sourceKey: string, success: boolean): Promise<void> {
  await dbWrite((c) => c.loginAttempt.create({ data: { emailNorm, sourceKey, success } }));
}

export async function clearLoginFailures(emailNorm: string): Promise<void> {
  await dbWrite((c) => c.loginAttempt.deleteMany({ where: { emailNorm, success: false } }));
}

// ───────────────────────────── first-run setup code ─────────────────────────────

/**
 * Wrong setup codes are stored as LoginAttempt rows with this pseudo-address, counted per source
 * (10 an hour). setup.bat deletes every row with emailNorm = "__setup__" when it prints a new code,
 * so a fresh code always starts with a clean slate.
 */
export const SETUP_THROTTLE_KEY = "__setup__";
const SETUP_WINDOW_MS = 60 * 60_000;
const SETUP_MAX_PER_SOURCE = 10;

export async function setupAttemptsBlocked(sourceKey: string, now = new Date()): Promise<boolean> {
  const tries = await db.loginAttempt.count({
    where: {
      emailNorm: SETUP_THROTTLE_KEY,
      sourceKey,
      success: false,
      at: { gte: new Date(now.getTime() - SETUP_WINDOW_MS) },
    },
  });
  return tries >= SETUP_MAX_PER_SOURCE;
}

export async function recordSetupFailure(sourceKey: string, now = new Date()): Promise<void> {
  await dbWrite((c) => c.loginAttempt.create({ data: { emailNorm: SETUP_THROTTLE_KEY, sourceKey, success: false, at: now } }));
}
