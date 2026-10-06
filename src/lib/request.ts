import "server-only";
import { headers } from "next/headers";
import { isHttpsForwardedProto } from "@/lib/auth/cookie";

/**
 * Request helpers. Remember (PLAN.md B10): X-Forwarded-* and CF-Connecting-IP can be
 * faked by anyone on the office network, so use them only for low-stakes decisions
 * (sign-in throttling uses them only for a soft extra wait, never for a lock).
 */

/** True when the browser reached us over https (i.e. through Cloudflare Tunnel). */
export async function isHttpsRequest(): Promise<boolean> {
  const h = await headers();
  return isHttpsForwardedProto(h.get("x-forwarded-proto"));
}

/** An address from a header, kept short and to address characters, so it can't bloat the database. */
function cleanAddress(value: string | null | undefined): string {
  const first = (value ?? "").split(",")[0]!.trim();
  return first.replace(/[^0-9A-Za-z:.%[\]-]/g, "").slice(0, 64);
}

/** Best-effort key for throttling and audit: "tunnel:<ip>" or "lan:<ip>". */
export async function requestSourceKey(): Promise<string> {
  const h = await headers();
  const cf = cleanAddress(h.get("cf-connecting-ip"));
  if (cf) return `tunnel:${cf}`;
  return `lan:${cleanAddress(h.get("x-forwarded-for")) || "unknown"}`;
}

/** True if the request came through Cloudflare (tunnel), used to refuse first-run setup remotely. */
export async function cameThroughTunnel(): Promise<boolean> {
  const h = await headers();
  return Boolean(h.get("cf-connecting-ip") || h.get("cf-ray"));
}

export async function requestUserAgent(): Promise<string | null> {
  const h = await headers();
  return h.get("user-agent")?.slice(0, 300) ?? null;
}

/**
 * For state-changing Route Handlers (Server Actions already get Next's own Origin check).
 * The Origin header's host must equal x-forwarded-host ?? host.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return Boolean(host) && originHost === host;
}
