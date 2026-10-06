/**
 * Session cookie names and flags (PLAN.md B10), shared by session.ts and src/proxy.ts.
 * No `server-only` import and no Node-only APIs: the proxy loads this file too.
 */

export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * The practice copy (start-demo.bat sets OUTREACH_PRACTICE=1) runs at localhost:3001 next to the real app at
 * localhost:3000. Browsers share cookies between the ports of one host, so each copy needs its own cookie name,
 * or signing in to one signs you out of the other.
 */
export function sessionCookieNameFor(env: Readonly<Record<string, string | undefined>>): string {
  return env.OUTREACH_PRACTICE === "1" ? "pp_session_demo" : "pp_session";
}

/** Read when the server process starts (the practice copy and the real app are separate processes). */
export const SESSION_COOKIE = sessionCookieNameFor(process.env);

/**
 * A small marker cookie that lives one day. While it's there the session cookie was re-issued recently;
 * when it's gone, the proxy re-issues the session cookie with a fresh 30-day expiry (sliding sessions).
 */
export const SESSION_FRESH_COOKIE = `${SESSION_COOKIE}_fresh`;
export const SESSION_REFRESH_SECONDS = 24 * 60 * 60;

/** True when the browser reached us over https (Cloudflare Tunnel). Secure cookies are refused on plain http. */
export function isHttpsForwardedProto(value: string | null | undefined): boolean {
  return (value ?? "").split(",")[0]!.trim().toLowerCase() === "https";
}

/** httpOnly, SameSite=Lax, Secure over https; expires 30 days from now. The database expiry stays authoritative. */
export function sessionCookieOptions(secure: boolean, now = Date.now()) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
    expires: new Date(now + SESSION_DAYS * DAY_MS),
  };
}

export function sessionFreshCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, path: "/", secure, maxAge: SESSION_REFRESH_SECONDS };
}

/**
 * Should the proxy re-issue the session cookie on this request? Only on page loads (GET/HEAD) — Server Actions
 * (POST) set their own cookies when signing in or out, and must never have them overwritten — and only when
 * the session cookie is present and wasn't re-issued in the last day.
 */
export function shouldRefreshSessionCookie(req: { method: string; hasSession: boolean; hasFreshMarker: boolean }): boolean {
  return (req.method === "GET" || req.method === "HEAD") && req.hasSession && !req.hasFreshMarker;
}
