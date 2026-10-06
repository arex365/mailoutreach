import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { readSession, type SessionUser } from "./session";

/**
 * Data Access Layer checks (PLAN.md B7). EVERY page, Server Action and Route Handler
 * starts with one of these. proxy.ts only does an optimistic redirect.
 *
 *  Pages:          const user = await requireUser();          // redirects to /login
 *  Server Actions: const user = await requireUser();          // throws AuthError → caller returns message
 *  Route Handlers: const user = await getUserOrNull(); if (!user) return 401
 */

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Cached per request. */
export const getUserOrNull = cache(async (): Promise<SessionUser | null> => readSession());

/** For pages and layouts: redirects to /login when not signed in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUserOrNull();
  if (!user) redirect("/login");
  return user;
}

/**
 * For pages: Owner-only. Members are sent home (the dashboard, M6-DESIGN §4.5) with nothing leaked; the dashboard shows
 * "Only the Owner can open that page." (NoticeToast).
 */
export async function requireOwner(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "OWNER") redirect("/dashboard?notice=owner-only");
  return user;
}

/** For Server Actions and Route Handlers: throws instead of redirecting. */
export async function requireUserAction(): Promise<SessionUser> {
  const user = await getUserOrNull();
  if (!user) throw new AuthError("Your session has ended. Please sign in again.", 401);
  return user;
}

export async function requireOwnerAction(): Promise<SessionUser> {
  const user = await requireUserAction();
  if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
  return user;
}
