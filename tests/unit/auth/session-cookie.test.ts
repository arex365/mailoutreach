import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  SESSION_REFRESH_SECONDS,
  isHttpsForwardedProto,
  sessionCookieNameFor,
  sessionCookieOptions,
  shouldRefreshSessionCookie,
} from "@/lib/auth/cookie";

const DAY = 86_400_000;

async function loadProxy(practice: boolean) {
  vi.resetModules();
  if (practice) vi.stubEnv("OUTREACH_PRACTICE", "1");
  else vi.stubEnv("OUTREACH_PRACTICE", "");
  const cookie = await import("@/lib/auth/cookie");
  const { proxy } = await import("@/proxy");
  return { proxy, cookie };
}

function request(path: string, init: { method?: string; cookie?: string; proto?: string } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.proto) headers.set("x-forwarded-proto", init.proto);
  return new NextRequest(`http://localhost:3000${path}`, { method: init.method ?? "GET", headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session cookie name (SPEC-1 / OPS-6)", () => {
  it("gives the practice copy its own cookie, so the two apps on localhost don't sign each other out", () => {
    expect(sessionCookieNameFor({})).toBe("pp_session");
    expect(sessionCookieNameFor({ OUTREACH_PRACTICE: "0" })).toBe("pp_session");
    expect(sessionCookieNameFor({ OUTREACH_PRACTICE: "1" })).toBe("pp_session_demo");
  });

  it("the proxy checks the same name as session.ts", async () => {
    const real = await loadProxy(false);
    expect(real.cookie.SESSION_COOKIE).toBe("pp_session");
    expect(real.proxy(request("/contacts", { cookie: "pp_session=abc; pp_session_fresh=1" })).status).toBe(200);
    // A practice-copy cookie doesn't sign you in to the real app.
    expect(real.proxy(request("/contacts", { cookie: "pp_session_demo=abc" })).headers.get("location")).toContain("/login");

    const demo = await loadProxy(true);
    expect(demo.cookie.SESSION_COOKIE).toBe("pp_session_demo");
    expect(demo.cookie.SESSION_FRESH_COOKIE).toBe("pp_session_demo_fresh");
    expect(demo.proxy(request("/contacts", { cookie: "pp_session_demo=abc; pp_session_demo_fresh=1" })).status).toBe(200);
    expect(demo.proxy(request("/contacts", { cookie: "pp_session=abc" })).headers.get("location")).toContain("/login");
  });
});

describe("sliding session cookie (SECURITY-10 / SPEC-2)", () => {
  it("re-issues the cookie with a fresh 30-day expiry about once a day, keeping its flags", async () => {
    const { proxy } = await loadProxy(false);
    const before = Date.now();
    const res = proxy(request("/contacts?view=all", { cookie: "pp_session=tok123" }));
    expect(res.status).toBe(200);
    const session = res.cookies.get("pp_session");
    expect(session?.value).toBe("tok123");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("lax");
    expect(session?.path).toBe("/");
    expect(session?.secure).toBe(false); // plain-http office address
    const expires = new Date(session!.expires as Date | number).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 30 * DAY - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 30 * DAY + 1000);
    const marker = res.cookies.get("pp_session_fresh");
    expect(marker?.maxAge).toBe(SESSION_REFRESH_SECONDS);
    expect(marker?.httpOnly).toBe(true);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/pp_session=tok123/);
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("is Secure through the tunnel (https)", async () => {
    const { proxy } = await loadProxy(false);
    const res = proxy(request("/contacts", { cookie: "pp_session=tok", proto: "https" }));
    expect(res.cookies.get("pp_session")?.secure).toBe(true);
    expect(res.cookies.get("pp_session_fresh")?.secure).toBe(true);
  });

  it("leaves the cookie alone when it was re-issued in the last day, on Server Action posts and on public pages", async () => {
    const { proxy } = await loadProxy(false);
    expect(proxy(request("/contacts", { cookie: "pp_session=tok; pp_session_fresh=1" })).cookies.get("pp_session")).toBeUndefined();
    expect(proxy(request("/contacts", { method: "POST", cookie: "pp_session=tok" })).cookies.get("pp_session")).toBeUndefined();
    expect(proxy(request("/login", { cookie: "pp_session=tok" })).cookies.get("pp_session")).toBeUndefined();
  });

  it("still sends people without a cookie to sign in, keeping where they were going", async () => {
    const { proxy } = await loadProxy(false);
    const res = proxy(request("/contacts?company=12"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/contacts?company=12");
    expect(proxy(request("/", { cookie: "pp_session=" })).headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("helpers", () => {
    expect(isHttpsForwardedProto("https")).toBe(true);
    expect(isHttpsForwardedProto("https, http")).toBe(true);
    expect(isHttpsForwardedProto("http")).toBe(false);
    expect(isHttpsForwardedProto(null)).toBe(false);
    expect(shouldRefreshSessionCookie({ method: "GET", hasSession: true, hasFreshMarker: false })).toBe(true);
    expect(shouldRefreshSessionCookie({ method: "HEAD", hasSession: true, hasFreshMarker: false })).toBe(true);
    expect(shouldRefreshSessionCookie({ method: "POST", hasSession: true, hasFreshMarker: false })).toBe(false);
    expect(shouldRefreshSessionCookie({ method: "GET", hasSession: false, hasFreshMarker: false })).toBe(false);
    expect(shouldRefreshSessionCookie({ method: "GET", hasSession: true, hasFreshMarker: true })).toBe(false);
    const opts = sessionCookieOptions(true, 1_000);
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: true });
    expect(opts.expires.getTime()).toBe(1_000 + 30 * DAY);
  });
});
