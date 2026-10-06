import "server-only";
import { cookies } from "next/headers";
import { db, dbWrite } from "@/server/db";
import { isHttpsRequest, requestSourceKey, requestUserAgent } from "@/lib/request";
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  SESSION_FRESH_COOKIE,
  sessionCookieOptions,
  sessionFreshCookieOptions,
} from "./cookie";
import { randomToken, sha256 } from "./tokens";

/**
 * Database sessions (PLAN.md B10). The cookie holds a random token; the database
 * holds only its SHA-256. The cookie is Secure whenever the visit is over https
 * (the tunnel); on the plain-http office address browsers would refuse it.
 * The cookie name and flags live in ./cookie (shared with src/proxy.ts, which re-issues the
 * cookie about daily so the 30-day expiry slides in the browser too).
 */

export { SESSION_COOKIE } from "./cookie";
const TOUCH_AFTER_MS = 60 * 60 * 1000; // refresh lastSeen/expiry at most hourly

export async function createSession(userId: number): Promise<void> {
  const token = randomToken(32);
  const [source, userAgent, secure] = await Promise.all([
    requestSourceKey(),
    requestUserAgent(),
    isHttpsRequest(),
  ]);
  const options = sessionCookieOptions(secure);
  await dbWrite((c) =>
    c.session.create({
      data: { tokenHash: sha256(token), userId, expiresAt: options.expires, source, userAgent },
    }),
  );
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, options);
  jar.set(SESSION_FRESH_COOKIE, "1", sessionFreshCookieOptions(secure));
}

export type SessionUser = {
  id: number;
  email: string;
  name: string;
  role: "OWNER" | "MEMBER";
  timeZone: string;
  sessionId: number;
};

/** Reads the cookie and returns the signed-in, active user — or null. */
export async function readSession(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, name: true, role: true, timeZone: true, active: true } } },
  });
  if (!session || !session.user.active) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) return null;
  if (now - session.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
    // Sliding expiry. Best-effort: never fail a page render because of this.
    const expiresAt = new Date(now + SESSION_DAYS * 86_400_000);
    void dbWrite((c) =>
      c.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt } }),
    ).catch(() => undefined);
  }
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    timeZone: session.user.timeZone,
    sessionId: session.id,
  };
}

/** Signs out this browser. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await dbWrite((c) => c.session.deleteMany({ where: { tokenHash: sha256(token) } }));
  }
  jar.delete(SESSION_COOKIE);
  jar.delete(SESSION_FRESH_COOKIE);
}

/** Signs a user out everywhere (deactivation, password reset), optionally keeping one session. */
export async function revokeUserSessions(userId: number, keepSessionId?: number): Promise<void> {
  await dbWrite((c) =>
    c.session.deleteMany({
      where: { userId, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    }),
  );
}
