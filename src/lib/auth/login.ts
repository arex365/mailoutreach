import "server-only";
import { db } from "@/server/db";
import { logActivity } from "@/server/activity";
import { notifyOwner } from "@/server/notifications";
import { FIELDS_NEED_FIXING, TeamError, changeOwnPassword } from "@/server/services/users";
import { hashPassword, verifyPassword } from "./password";
import { claimLoginAttempt } from "./throttle";
import {
  LOGIN_MISMATCH_MESSAGE,
  MAX_LOGIN_PASSWORD_LENGTH,
  SOURCE_SOFT_LIMIT,
  loginEmailKey,
  tooManyTriesMessage,
} from "./throttle-rules";
import { randomToken } from "./tokens";

// A real Argon2id hash of a random string, so unknown emails take as long as wrong passwords.
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomToken(16));
  return dummyHashPromise;
}

export type SignInCheck = { ok: true; userId: number } | { ok: false; error: string };

/**
 * Checks an email and password for signing in (PLAN.md B10). No cookies here, so it can be tested directly;
 * the login action creates the session afterwards.
 *
 *  - Text that can't be anyone's email, or an absurdly long password, is refused before any database access.
 *  - Every other try goes through claimLoginAttempt(): one check per account at a time, waits enforced by
 *    refusing, and the try recorded before the password is checked.
 *  - An unknown email, a wrong password and a switched-off account all get the same message (and the same
 *    Argon2 work), so the answer never tells anyone whether a guessed password was right.
 */
export async function checkSignIn(input: { email: string; password: string; sourceKey: string }): Promise<SignInCheck> {
  const email = loginEmailKey(input.email);
  if (!email || input.password.length > MAX_LOGIN_PASSWORD_LENGTH) {
    return { ok: false, error: LOGIN_MISMATCH_MESSAGE };
  }

  const claim = await claimLoginAttempt(email, input.sourceKey);
  if (!claim.ok) return { ok: false, error: tooManyTriesMessage(claim.retryInSeconds) };
  const { slot } = claim;
  try {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, name: true, active: true, passwordHash: true },
    });
    const valid = await verifyPassword(user?.passwordHash ?? (await dummyHash()), input.password);
    if (user && user.active && valid) {
      await slot.succeeded();
      return { ok: true, userId: user.id };
    }
    // The try stays recorded as a failure. Tell the Owner once when one place has got it wrong 5 times.
    if (user && slot.sourceFailures === SOURCE_SOFT_LIMIT) await reportRepeatedFailures(user.name, email);
    return { ok: false, error: LOGIN_MISMATCH_MESSAGE };
  } finally {
    slot.release();
  }
}

/**
 * Settings → change password. The current password goes through the same gate as signing in
 * (claimLoginAttempt: one check per account at a time, the try recorded before the check), so parallel
 * guesses from a signed-in browser can't get around the waits either.
 * Returns a refusal while a wait is running; otherwise changeOwnPassword() runs and its TeamError is rethrown.
 */
export async function changeOwnPasswordChecked(
  user: { id: number; email: string; sessionId: number | null },
  input: { current: string; password: string; confirm: string },
  sourceKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const claim = await claimLoginAttempt(user.email, sourceKey);
  if (!claim.ok) return { ok: false, error: tooManyTriesMessage(claim.retryInSeconds) };
  const { slot } = claim;
  try {
    // Signs out the user's other devices (keeps this session) in the same transaction.
    await changeOwnPassword(user.id, input, user.sessionId);
    await slot.succeeded();
    return { ok: true };
  } catch (err) {
    // The current password was right and only the new one needs fixing: that isn't a wrong password.
    if (err instanceof TeamError && err.code !== "wrong-password" && err.message === FIELDS_NEED_FIXING) {
      await slot.succeeded();
    }
    throw err;
  } finally {
    slot.release();
  }
}

async function reportRepeatedFailures(name: string, email: string): Promise<void> {
  await logActivity({
    actorId: null,
    type: "auth.lockout",
    summary: `Sign-in slowed down for ${email} after ${SOURCE_SOFT_LIMIT} wrong passwords`,
  });
  await notifyOwner({
    type: "auth.lockout",
    title: `${SOURCE_SOFT_LIMIT} wrong passwords for ${name}`,
    body: `Someone typed the wrong password for ${name} ${SOURCE_SOFT_LIMIT} times, so sign-in from there now waits a minute between tries. If it wasn't them, keep an eye on it.`,
    link: "/activity",
  });
}
