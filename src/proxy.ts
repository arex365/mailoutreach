import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_FRESH_COOKIE,
  isHttpsForwardedProto,
  sessionCookieOptions,
  sessionFreshCookieOptions,
  shouldRefreshSessionCookie,
} from "@/lib/auth/cookie";

/**
 * Optimistic check only (PLAN.md B7): pages without a session cookie go to /login.
 * Real permission checks happen inside every page, action and route (src/lib/auth/dal.ts).
 * API routes, webhooks, uploads and static files are excluded by the matcher.
 *
 * Sliding sessions (PLAN.md B10): session.ts extends the session in the database while it's used, but a
 * server component can't set cookies, so about once a day this proxy re-issues the browser's cookie with a
 * fresh 30-day expiry (same value and flags). The database expiry stays the one that counts.
 */
const PUBLIC_PATHS = ["/login", "/setup", "/invite", "/reset"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  const response = NextResponse.next();
  const refresh = shouldRefreshSessionCookie({
    method: request.method,
    hasSession: true,
    hasFreshMarker: request.cookies.has(SESSION_FRESH_COOKIE),
  });
  if (refresh) {
    const secure = isHttpsForwardedProto(request.headers.get("x-forwarded-proto"));
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(secure));
    response.cookies.set(SESSION_FRESH_COOKIE, "1", sessionFreshCookieOptions(secure));
  }
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
