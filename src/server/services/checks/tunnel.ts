import { randomBytes } from "node:crypto";
import { safeZone } from "@/core/sending/capday";
import { parseTunnelState } from "@/core/system-state-parse";
import { STATE_KEYS, type TunnelState } from "@/core/system-state";
import { formatShortDate, formatTime } from "@/core/time/format";
import { publicUrl } from "@/server/env";
import { isTestRun } from "@/server/mailgun/base-url";
import { notifyOwner } from "@/server/notifications";
import { getSetting } from "@/server/settings";
import { readTyped, shouldSendNotice, updateTyped } from "@/server/state-typed";
import { SELF_CHECK_HEADER } from "@/server/services/mail-events/webhook";
import { parseBuildVersion, versionWarning } from "./tunnel-text";

/**
 * Remote access checks (PLAN B8, B11, M3-DESIGN §4.4.7): is cloudflared running and connected on this PC, does the
 * public address reach the app through Cloudflare, do Mailgun's POSTs get through without a login page, and is the
 * app itself behind Cloudflare Access. Results go to SystemState "tunnel.status" (the System card, the checklist's
 * "Remote access works" row, the reply test's "public address works"). No secrets, no cookies, never follows redirects.
 */

/** cloudflared's metrics server takes the first free port of these (literal IP: "localhost" can be redirected). */
export const TUNNEL_PORTS: readonly number[] = [20241, 20242, 20243, 20244, 20245];
export const READY_TIMEOUT_MS = 1_000;
export const PUBLIC_TIMEOUT_MS = 10_000;
/** Down (or not running) this long while a public address is set → Owner notice "tunnel-down". */
export const TUNNEL_DOWN_NOTICE_MS = 15 * 60_000;
/** Healthy cloudflared keeps 4 connections to Cloudflare; fewer is "degraded". */
export const HEALTHY_CONNECTIONS = 4;

export { parseBuildVersion, versionWarning } from "./tunnel-text";

function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

async function ownerZone(): Promise<string> {
  try {
    return safeZone(await getSetting("sending.capDayTimeZone"));
  } catch {
    return safeZone(null);
  }
}

function sinceText(since: Date, now: Date, zone: string): string {
  return now.getTime() - since.getTime() < 20 * 3_600_000
    ? formatTime(since, zone)
    : `${formatShortDate(since, zone, now)} ${formatTime(since, zone)}`;
}

type Ready = { port: number; status: number; ready: number; connectorId: string };

/** GET http://127.0.0.1:<port>/ready on each port; a port counts only when its JSON has `connectorId`. */
async function findCloudflared(fetchImpl: typeof fetch, ports: readonly number[]): Promise<Ready | null> {
  for (const port of ports) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/ready`, {
        redirect: "manual",
        signal: AbortSignal.timeout(READY_TIMEOUT_MS),
      });
      const json = (await res.json().catch(() => null)) as { readyConnections?: unknown; connectorId?: unknown } | null;
      if (!json || typeof json.connectorId !== "string") continue;
      const ready = Number(json.readyConnections);
      return { port, status: res.status, ready: Number.isFinite(ready) ? Math.max(0, Math.floor(ready)) : 0, connectorId: json.connectorId };
    } catch {
      // Nothing listening, or something else answered: try the next port.
    }
  }
  return null;
}

async function readVersion(fetchImpl: typeof fetch, port: number): Promise<string | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/metrics`, { redirect: "manual", signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
    return res.ok ? parseBuildVersion(await res.text()) : null;
  } catch {
    return null;
  }
}

/**
 * Checks cloudflared on this PC (every 5 minutes, from the monitor loop): 200 with ≥ 4 connections → connected,
 * 1–3 → degraded, 503 → down, no metrics port → not running. With `metrics` (hourly) it also reads the version for
 * the known-bad/too-old warning. Down or not running for 15 minutes while a public address is set → Owner notice
 * "tunnel-down" (at most once a day). Writes and returns SystemState "tunnel.status".
 */
export async function checkTunnel(
  opts: { now?: Date; fetchImpl?: typeof fetch; ports?: readonly number[]; metrics?: boolean } = {},
): Promise<TunnelState> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const found = await findCloudflared(fetchImpl, opts.ports ?? TUNNEL_PORTS);
  const state: TunnelState["state"] = !found
    ? "not-running"
    : found.status === 200 && found.ready >= HEALTHY_CONNECTIONS
      ? "connected"
      : found.status === 200 && found.ready > 0
        ? "degraded"
        : "down";
  const prev = (await readTyped(STATE_KEYS.tunnel, parseTunnelState)).value;
  const version = found && opts.metrics ? ((await readVersion(fetchImpl, found.port)) ?? prev.version) : found ? prev.version : null;
  const isDown = state === "down" || state === "not-running";
  const downSince = isDown ? (prev.downSince ?? now.toISOString()) : null;

  let notifiedAt = isDown ? prev.notifiedAt : null;
  const pub = publicUrl();
  if (isDown && downSince && !notifiedAt && pub && !isLoopbackUrl(pub) && now.getTime() - Date.parse(downSince) >= TUNNEL_DOWN_NOTICE_MS) {
    if (await shouldSendNotice("tunnel-down", now)) {
      const zone = await ownerZone();
      await notifyOwner({
        type: "system.tunnel",
        title: "Remote access is down",
        body: `Remote access has been down since ${sinceText(new Date(downSince), now, zone)}, so remote staff and Mailgun can't reach the app. Check that this PC is on and connected, and that the Cloudflared service is running (status.bat shows it).`,
        link: "/settings/system",
      });
    }
    notifiedAt = now.toISOString();
  }

  const res = await updateTyped(STATE_KEYS.tunnel, parseTunnelState, (cur) => ({
    ...cur,
    checkedAt: now.toISOString(),
    state,
    readyConnections: found?.ready ?? 0,
    port: found?.port ?? null,
    connectorId: found?.connectorId ?? null,
    version,
    versionWarning: versionWarning(version, now),
    downSince,
    notifiedAt,
  }));
  return res.value;
}

type HttpCheck = { at: string; ok: boolean; status: number | null; error: string | null };

/** The public check's answer in a test run whose public address isn't loopback (nothing is fetched). */
export const TEST_RUN_PUBLIC_TEXT = "Test run: the public address isn't checked.";

function redirectTarget(res: Response, base: string): URL | null {
  const loc = res.headers.get("location");
  if (!loc) return null;
  try {
    return new URL(loc, base);
  } catch {
    return null;
  }
}

function isAccessHost(u: URL | null): boolean {
  return Boolean(u && u.hostname.toLowerCase().endsWith(".cloudflareaccess.com"));
}

function failure(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "No answer within 10 seconds.";
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof cause === "string") return `Couldn't connect (${cause}).`;
  return "Couldn't connect.";
}

/**
 * The checks through the public address (every 30 minutes, and "Check now" on Settings › System), only when
 * APP_PUBLIC_URL is set; 10 s timeouts, no cookies, redirects never followed:
 *  - GET <pub>/api/health must be the app's health JSON;
 *  - POST <pub>/api/webhooks/mailgun/events with `{}` and a fresh self-check nonce (stored first, so the webhook
 *    handler leaves it out of its stats) must be answered by the app itself (JSON, 406), not a Cloudflare login page;
 *  - GET <pub>/contacts must redirect to *.cloudflareaccess.com (Cloudflare Access protects the app). Skipped for a
 *    loopback public address (the fake-server setup).
 * A test run (OUTREACH_TEST_RUN=1, Vitest) never fetches a public address that isn't loopback (M6-DESIGN §0.2 rule 13,
 * §3.9): the public check says so and nothing is fetched. Only a test whose `fetchImpl` is a stand-in that can't reach
 * the network passes `fetchIsFake`.
 */
export async function checkPublicAddress(
  opts: { now?: Date; fetchImpl?: typeof fetch; fetchIsFake?: boolean } = {},
): Promise<Pick<TunnelState, "publicCheck" | "webhookPathCheck" | "appProtectedCheck" | "selfCheckNonce">> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const pub = publicUrl();
  if (!pub) {
    const res = await updateTyped(STATE_KEYS.tunnel, parseTunnelState, (cur) => ({
      ...cur,
      publicCheck: null,
      webhookPathCheck: null,
      appProtectedCheck: null,
    }));
    return { publicCheck: null, webhookPathCheck: null, appProtectedCheck: null, selfCheckNonce: res.value.selfCheckNonce };
  }
  if (isTestRun() && !isLoopbackUrl(pub) && opts.fetchIsFake !== true) {
    const publicCheck: HttpCheck = { at, ok: false, status: null, error: TEST_RUN_PUBLIC_TEXT };
    const res = await updateTyped(STATE_KEYS.tunnel, parseTunnelState, (cur) => ({
      ...cur,
      publicCheck,
      webhookPathCheck: null,
      appProtectedCheck: null,
    }));
    return { publicCheck, webhookPathCheck: null, appProtectedCheck: null, selfCheckNonce: res.value.selfCheckNonce };
  }
  const base = pub.replace(/\/+$/, "");
  const init = (extra: RequestInit = {}): RequestInit => ({
    redirect: "manual",
    credentials: "omit",
    signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
    ...extra,
  });

  // 1. The health route through the public address.
  let publicCheck: HttpCheck;
  try {
    const res = await fetchImpl(`${base}/api/health`, init({ headers: { accept: "application/json" } }));
    const json = (await res.json().catch(() => null)) as { ok?: unknown; database?: unknown } | null;
    const isApp = json !== null && typeof json === "object" && "ok" in json && "database" in json;
    const target = res.status >= 300 && res.status < 400 ? redirectTarget(res, base) : null;
    publicCheck = {
      at,
      ok: res.status === 200 && isApp,
      status: res.status,
      error:
        res.status === 200 && isApp
          ? null
          : isAccessHost(target)
            ? "Cloudflare's login page answered instead of the app."
            : isApp
              ? "The app answered, but its database didn't."
              : `The address answered ${res.status}, not the app.`,
    };
  } catch (err) {
    publicCheck = { at, ok: false, status: null, error: failure(err) };
  }

  // 2. The webhook path, answered by the app itself (the nonce is stored first so the handler recognises it).
  const nonce = randomBytes(16).toString("hex");
  await updateTyped(STATE_KEYS.tunnel, parseTunnelState, (cur) => ({ ...cur, selfCheckNonce: nonce }));
  let webhookPathCheck: HttpCheck;
  try {
    const res = await fetchImpl(
      `${base}/api/webhooks/mailgun/events`,
      init({ method: "POST", body: "{}", headers: { "content-type": "application/json", [SELF_CHECK_HEADER]: nonce } }),
    );
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const target = res.status >= 300 && res.status < 400 ? redirectTarget(res, base) : null;
    const json = type.includes("application/json") ? ((await res.json().catch(() => null)) as { error?: unknown } | null) : null;
    const ok = res.status === 406 && json !== null && typeof json === "object" && "error" in json;
    webhookPathCheck = {
      at,
      ok,
      status: res.status,
      error: ok
        ? null
        : isAccessHost(target)
          ? "Cloudflare's login page answered instead of the app."
          : target
            ? `Redirected to ${target.origin}${target.pathname}.`
            : type.includes("text/html")
              ? "A web page answered instead of the app."
              : `The address answered ${res.status}, not the app.`,
    };
  } catch (err) {
    webhookPathCheck = { at, ok: false, status: null, error: failure(err) };
  }

  // 3. The app's own pages must be behind Cloudflare Access.
  let appProtectedCheck: TunnelState["appProtectedCheck"] = null;
  if (!isLoopbackUrl(base)) {
    try {
      const res = await fetchImpl(`${base}/contacts`, init({ headers: { accept: "text/html" } }));
      const target = res.status >= 300 && res.status < 400 ? redirectTarget(res, base) : null;
      const ok = isAccessHost(target);
      appProtectedCheck = {
        at,
        ok,
        status: res.status,
        location: target ? target.href : null,
        error: ok
          ? null
          : target
            ? `Redirected to ${target.origin}${target.pathname} instead of Cloudflare's login page.`
            : `The page answered ${res.status} without asking anyone to sign in with Cloudflare.`,
      };
    } catch (err) {
      appProtectedCheck = { at, ok: false, status: null, location: null, error: failure(err) };
    }
  }

  await updateTyped(STATE_KEYS.tunnel, parseTunnelState, (cur) => ({
    ...cur,
    publicCheck,
    webhookPathCheck,
    appProtectedCheck,
    selfCheckNonce: nonce,
  }));
  return { publicCheck, webhookPathCheck, appProtectedCheck, selfCheckNonce: nonce };
}
