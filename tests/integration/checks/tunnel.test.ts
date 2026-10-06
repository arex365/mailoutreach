import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeOwner } from "../mail-events/seed";

const t = await createTestDb("checks-tunnel");
const { db, dbWrite } = await import("@/server/db");
// The checks through a non-loopback public address pass `fetchIsFake`: their fetch is a table of stand-ins.
const { checkTunnel, checkPublicAddress, TEST_RUN_PUBLIC_TEXT } = await import("@/server/services/checks/tunnel");
const { handleEventWebhook, SELF_CHECK_HEADER } = await import("@/server/services/mail-events/webhook");
const { MonitorLoop } = await import("../../../worker/monitor");

const previousPub = process.env.APP_PUBLIC_URL;
const PUB = "https://outreach.example.com";

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch that answers from a table of URL handlers; anything else is a refused connection. */
function fakeFetch(handlers: Record<string, Handler>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(`${init?.method ?? "GET"} ${url}`);
    const h = handlers[url];
    if (!h) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return h(url, init);
  }) as typeof fetch;
}

function ready(port: number, status: number, readyConnections: number): Record<string, Handler> {
  return { [`http://127.0.0.1:${port}/ready`]: () => Response.json({ status, readyConnections, connectorId: "abc-123" }, { status }) };
}

async function tunnelState() {
  return (await db.systemState.findUniqueOrThrow({ where: { key: "tunnel.status" } })).value as Record<string, unknown>;
}

beforeAll(async () => {
  await makeOwner();
});

beforeEach(async () => {
  process.env.APP_PUBLIC_URL = PUB;
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: { in: ["tunnel.status", "notices", "webhooks.stats"] } } });
    await c.notification.deleteMany({});
  });
});

afterEach(() => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("checkTunnel (cloudflared on this PC)", () => {
  it("connected, degraded, down and not running", async () => {
    // Something else answers on 20241 without a connectorId: not cloudflared, skipped.
    const other: Record<string, Handler> = { "http://127.0.0.1:20241/ready": () => Response.json({ ok: true }) };
    expect(await checkTunnel({ fetchImpl: fakeFetch({ ...other, ...ready(20242, 200, 4) }) })).toMatchObject({
      state: "connected",
      port: 20242,
      readyConnections: 4,
      connectorId: "abc-123",
      downSince: null,
    });
    expect((await checkTunnel({ fetchImpl: fakeFetch(ready(20241, 200, 2)) })).state).toBe("degraded");
    const down = await checkTunnel({ fetchImpl: fakeFetch(ready(20241, 503, 0)) });
    expect(down).toMatchObject({ state: "down", downSince: expect.any(String) });
    expect(await checkTunnel({ fetchImpl: fakeFetch({}) })).toMatchObject({ state: "not-running", port: null, downSince: down.downSince });
  });

  it("reads the version hourly and warns about a known-bad or old cloudflared", async () => {
    const metrics = (v: string): Record<string, Handler> => ({
      ...ready(20241, 200, 4),
      "http://127.0.0.1:20241/metrics": () => new Response(`# HELP build_info\nbuild_info{goversion="go1.24",revision="x",type="",version="${v}"} 1\n`),
    });
    const now = new Date("2026-09-23T10:00:00Z");
    expect(await checkTunnel({ now, metrics: true, fetchImpl: fakeFetch(metrics("2026.8.0")) })).toMatchObject({
      version: "2026.8.0",
      versionWarning:
        "cloudflared 2026.8.0 has a known problem. Update it: open PowerShell as Administrator and run cloudflared update, then net start cloudflared.",
    });
    expect((await checkTunnel({ now, metrics: true, fetchImpl: fakeFetch(metrics("2025.6.1")) })).versionWarning).toMatch(
      /^cloudflared 2025\.6\.1 is more than a year old and no longer supported\./,
    );
    expect((await checkTunnel({ now, metrics: true, fetchImpl: fakeFetch(metrics("2026.9.1")) })).versionWarning).toBeNull();
    // Without `metrics` the stored version is kept.
    expect((await checkTunnel({ now, fetchImpl: fakeFetch(ready(20241, 200, 4)) })).version).toBe("2026.9.1");
  });

  it("tells the Owner once when remote access has been down for 15 minutes", async () => {
    const t0 = new Date("2026-09-23T09:00:00Z");
    const downFetch = fakeFetch(ready(20241, 503, 0));
    await checkTunnel({ now: t0, fetchImpl: downFetch });
    await checkTunnel({ now: new Date(t0.getTime() + 10 * 60_000), fetchImpl: downFetch });
    expect(await db.notification.count({ where: { type: "system.tunnel" } })).toBe(0);
    await checkTunnel({ now: new Date(t0.getTime() + 16 * 60_000), fetchImpl: downFetch });
    await checkTunnel({ now: new Date(t0.getTime() + 21 * 60_000), fetchImpl: downFetch });
    const notes = await db.notification.findMany({ where: { type: "system.tunnel" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: "Remote access is down", link: "/settings/system" });
    expect(notes[0]!.body).toMatch(
      /^Remote access has been down since \d{2}:\d{2}, so remote staff and Mailgun can't reach the app\. Check that this PC is on and connected, and that the Cloudflared service is running \(status\.bat shows it\)\.$/,
    );
    const back = await checkTunnel({ now: new Date(t0.getTime() + 30 * 60_000), fetchImpl: fakeFetch(ready(20241, 200, 4)) });
    expect(back).toMatchObject({ state: "connected", downSince: null, notifiedAt: null });
  });

  it("never sends the notice without a public address", async () => {
    delete process.env.APP_PUBLIC_URL;
    const t0 = new Date("2026-09-23T09:00:00Z");
    await checkTunnel({ now: t0, fetchImpl: fakeFetch({}) });
    await checkTunnel({ now: new Date(t0.getTime() + 60 * 60_000), fetchImpl: fakeFetch({}) });
    expect(await db.notification.count({ where: { type: "system.tunnel" } })).toBe(0);
  });
});

describe("checkPublicAddress", () => {
  const health: Handler = () => Response.json({ ok: true, database: "ok", workerLastSeen: null, time: "x" });
  const accessRedirect = (): Response => new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });

  it("passes when the app answers the health and webhook paths and Access guards the app", async () => {
    const seen: string[] = [];
    let sentNonce: string | null = null;
    let storedNonce: unknown = null;
    const fetchImpl = fakeFetch(
      {
        [`${PUB}/api/health`]: health,
        [`${PUB}/api/webhooks/mailgun/events`]: async (url, init) => {
          sentNonce = new Headers(init?.headers).get(SELF_CHECK_HEADER);
          storedNonce = ((await tunnelState()).selfCheckNonce as string) ?? null;
          return handleEventWebhook(new Request(url, init));
        },
        [`${PUB}/contacts`]: accessRedirect,
      },
      seen,
    );
    const res = await checkPublicAddress({ fetchImpl, fetchIsFake: true });
    expect(res.publicCheck).toMatchObject({ ok: true, status: 200 });
    expect(res.webhookPathCheck).toMatchObject({ ok: true, status: 406, error: null });
    expect(res.appProtectedCheck).toMatchObject({ ok: true, status: 302, location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" });
    // The nonce was stored before the POST, so the handler recognised its own check and recorded nothing.
    expect(sentNonce).toBe(res.selfCheckNonce);
    expect(storedNonce).toBe(res.selfCheckNonce);
    expect(await db.systemState.findUnique({ where: { key: "webhooks.stats" } })).toBeNull();
    expect(seen).toEqual([`GET ${PUB}/api/health`, `POST ${PUB}/api/webhooks/mailgun/events`, `GET ${PUB}/contacts`]);
  });

  it("flags a webhook path behind Cloudflare's login, and an app that isn't protected", async () => {
    const res = await checkPublicAddress({
      fetchIsFake: true,
      fetchImpl: fakeFetch({
        [`${PUB}/api/health`]: health,
        [`${PUB}/api/webhooks/mailgun/events`]: accessRedirect,
        [`${PUB}/contacts`]: () => new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } }),
      }),
    });
    expect(res.webhookPathCheck).toMatchObject({ ok: false, status: 302, error: "Cloudflare's login page answered instead of the app." });
    expect(res.appProtectedCheck).toMatchObject({ ok: false, status: 200 });

    const toLogin = await checkPublicAddress({
      fetchIsFake: true,
      fetchImpl: fakeFetch({
        [`${PUB}/api/health`]: health,
        [`${PUB}/api/webhooks/mailgun/events`]: () => Response.json({ error: "unreadable" }, { status: 406 }),
        [`${PUB}/contacts`]: () => new Response(null, { status: 307, headers: { location: "/login" } }),
      }),
    });
    expect(toLogin.appProtectedCheck).toMatchObject({ ok: false, status: 307, location: `${PUB}/login` });
    expect(toLogin.webhookPathCheck?.ok).toBe(true);
  });

  it("reports a public address that doesn't answer", async () => {
    const res = await checkPublicAddress({ fetchImpl: fakeFetch({}), fetchIsFake: true });
    expect(res.publicCheck).toMatchObject({ ok: false, status: null, error: "Couldn't connect (ECONNREFUSED)." });
    expect(res.webhookPathCheck?.ok).toBe(false);
  });

  it("skips the Access check for a loopback public address (the fake-server setup), and does nothing without one", async () => {
    process.env.APP_PUBLIC_URL = "http://127.0.0.1:3100";
    // A loopback address is checked in a test run without any opt-in: it can only reach this PC.
    const res = await checkPublicAddress({
      fetchImpl: fakeFetch({
        "http://127.0.0.1:3100/api/health": health,
        "http://127.0.0.1:3100/api/webhooks/mailgun/events": (url, init) => handleEventWebhook(new Request(url, init)),
      }),
    });
    expect(res.appProtectedCheck).toBeNull();
    expect(res.publicCheck?.ok).toBe(true);
    delete process.env.APP_PUBLIC_URL;
    const none = await checkPublicAddress({ fetchImpl: fakeFetch({}) });
    expect(none).toMatchObject({ publicCheck: null, webhookPathCheck: null, appProtectedCheck: null });
  });

  it("a test run never fetches a public address that isn't loopback (M6-DESIGN §0.2 rule 13)", async () => {
    // PUB (https://outreach.example.com) is set; this is a test run (Vitest, OUTREACH_TEST_RUN=1).
    const spy = vi.fn(async () => Response.json({ ok: true, database: "ok" }));
    const res = await checkPublicAddress({ now: new Date("2026-09-23T10:00:00Z"), fetchImpl: spy as unknown as typeof fetch });
    expect(spy).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      publicCheck: { at: "2026-09-23T10:00:00.000Z", ok: false, status: null, error: "Test run: the public address isn't checked." },
      webhookPathCheck: null,
      appProtectedCheck: null,
    });
    expect((await tunnelState()).publicCheck).toMatchObject({ ok: false, error: TEST_RUN_PUBLIC_TEXT });
    // Also through the monitor loop, which passes no opt-in.
    const loop = new MonitorLoop({ ownsLease: async () => true, now: () => new Date("2026-09-23T10:00:00Z"), fetchImpl: spy as unknown as typeof fetch, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
    await loop.tick();
    expect(spy.mock.calls.map((c) => String((c as unknown[])[0]))).not.toContain(`${PUB}/api/health`);
  });
});

describe("MonitorLoop", () => {
  it("runs each check when it is due, and nothing without the lease", async () => {
    let now = new Date("2026-09-23T10:00:00Z");
    const fetchImpl = fakeFetch({ ...ready(20241, 200, 4), [`${PUB}/api/health`]: () => Response.json({ ok: true, database: "ok" }) });
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const loop = new MonitorLoop({ ownsLease: async () => true, now: () => now, fetchImpl, logger: quiet });
    expect(await loop.tick()).toEqual({ tunnel: true, publicAddress: true, catchUpAge: true });
    expect(await loop.tick()).toEqual({ tunnel: false, publicAddress: false, catchUpAge: false });
    now = new Date(now.getTime() + 5 * 60_000);
    expect(await loop.tick()).toEqual({ tunnel: true, publicAddress: false, catchUpAge: false });
    now = new Date(now.getTime() + 25 * 60_000);
    expect(await loop.tick()).toEqual({ tunnel: true, publicAddress: true, catchUpAge: true });
    expect((await tunnelState()).state).toBe("connected");
    const idle = new MonitorLoop({ ownsLease: async () => false, fetchImpl, logger: quiet });
    expect(await idle.tick()).toBeNull();
  });
});
