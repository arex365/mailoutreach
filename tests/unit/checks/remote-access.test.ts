import { describe, expect, it } from "vitest";
import { remoteAccessView } from "@/components/settings/remote-access-card";
import { parseBuildVersion, versionWarning } from "@/server/services/checks/tunnel-text";
import type { TunnelState } from "@/core/system-state";

const NOW = new Date("2026-09-23T10:00:00Z");
const PUB = "https://outreach.example.com";

function state(over: Partial<TunnelState> = {}): TunnelState {
  const at = new Date(NOW.getTime() - 2 * 60_000).toISOString();
  return {
    checkedAt: at,
    state: "connected",
    readyConnections: 4,
    port: 20241,
    connectorId: "c",
    version: "2026.9.1",
    versionWarning: null,
    downSince: null,
    notifiedAt: null,
    publicCheck: { at: new Date(NOW.getTime() - 10 * 60_000).toISOString(), ok: true, status: 200, error: null },
    webhookPathCheck: { at, ok: true, status: 406, error: null },
    appProtectedCheck: { at, ok: true, status: 302, location: "https://t.cloudflareaccess.com/x", error: null },
    selfCheckNonce: null,
    ...over,
  };
}

describe("cloudflared version", () => {
  it("reads build_info from the metrics", () => {
    expect(parseBuildVersion('build_info{goversion="go1.24.4",revision="abc",type="",version="2026.9.1"} 1')).toBe("2026.9.1");
    expect(parseBuildVersion("nothing here")).toBeNull();
  });

  it("warns about 2026.8.0/2026.8.1 and versions more than a year old", () => {
    expect(versionWarning("2026.8.1", NOW)).toMatch(/^cloudflared 2026\.8\.1 has a known problem\. Update it:/);
    expect(versionWarning("2025.8.0", NOW)).toMatch(/is more than a year old and no longer supported/);
    expect(versionWarning("2025.9.0", NOW)).toBeNull();
    expect(versionWarning("2026.9.1", NOW)).toBeNull();
    expect(versionWarning(null, NOW)).toBeNull();
    expect(versionWarning("dev", NOW)).toBeNull();
  });
});

describe("the System page's Remote access card", () => {
  it("works: status with the check time, the public check and the Access line", () => {
    const v = remoteAccessView(state(), PUB, NOW, "Asia/Karachi");
    expect(v.status).toEqual({ tone: "ok", text: "Remote access works · checked 2 minutes ago" });
    expect(v.lines).toEqual([
      { tone: "ok", text: `Public address check: ${PUB}/api/health answered · 10 minutes ago` },
      { tone: "ok", text: "Only your team gets past Cloudflare's login." },
    ]);
    expect(v.details).toContain("Connections to Cloudflare: 4 (4 is healthy)");
    expect(v.details).toContain("cloudflared version: 2026.9.1");
  });

  it("weak, down, not running, not protected, webhook blocked, version warning", () => {
    expect(remoteAccessView(state({ state: "degraded", readyConnections: 2 }), PUB, NOW, "UTC").status).toEqual({
      tone: "warn",
      text: "Remote access works, but the connection to Cloudflare is weak · checked 2 minutes ago",
    });
    expect(remoteAccessView(state({ state: "down", downSince: "2026-09-23T09:02:00Z" }), PUB, NOW, "Asia/Karachi").status).toEqual({
      tone: "bad",
      text: "Not connected since 14:02. Remote staff and Mailgun can't reach the app. Check that this PC is on and the Cloudflared service is running.",
    });
    expect(remoteAccessView(state({ state: "not-running" }), PUB, NOW, "UTC").status).toEqual({
      tone: "bad",
      text: "cloudflared isn't running on this PC. If you haven't set up remote access yet, follow docs\\setup\\3-cloudflare.md.",
    });
    const blocked = remoteAccessView(
      state({
        webhookPathCheck: { at: NOW.toISOString(), ok: false, status: 302, error: "Cloudflare's login page answered instead of the app." },
        appProtectedCheck: { at: NOW.toISOString(), ok: false, status: 200, location: null, error: "no redirect" },
        versionWarning: "cloudflared 2026.8.0 has a known problem.",
      }),
      PUB,
      NOW,
      "UTC",
    );
    expect(blocked.lines).toEqual([
      { tone: "warn", text: "cloudflared 2026.8.0 has a known problem." },
      { tone: "ok", text: `Public address check: ${PUB}/api/health answered · 10 minutes ago` },
      {
        tone: "bad",
        text: "The webhook address shows Cloudflare's login page. In Cloudflare, check that the 'Outreach public endpoints' app covers api/webhooks/* (Cloudflare guide, step 6).",
      },
      {
        tone: "bad",
        text: "Anyone on the internet can reach your app's sign-in page. In Cloudflare, check the 'Outreach' application (Cloudflare guide, step 5).",
      },
    ]);
  });

  it("no public address, never checked, and the fake-server setup", () => {
    expect(remoteAccessView(state(), null, NOW, "UTC")).toEqual({
      status: {
        tone: "muted",
        text: "Public address: Not set yet. Follow the Cloudflare guide (docs\\setup\\3-cloudflare.md), then run setup.bat again (and update.bat if the app runs as a Windows service).",
      },
      lines: [],
      details: [],
    });
    expect(remoteAccessView(state({ checkedAt: null, state: "unknown", publicCheck: null, webhookPathCheck: null, appProtectedCheck: null }), PUB, NOW, "UTC")).toMatchObject({
      status: { tone: "muted", text: "Not checked yet. Click Check now." },
      lines: [],
    });
    expect(remoteAccessView(state({ state: "not-running" }), "http://127.0.0.1:3100", NOW, "UTC", true).status.tone).toBe("muted");
  });
});

/** "We don't use Cloudflare Access" (M6-DESIGN §2.8, G7): the card says the same as the checklist's remote-access row. */
describe("the Remote access card with the Access check off", () => {
  const open = { at: NOW.toISOString(), ok: false, status: 200, location: null, error: "no redirect" };
  const ACCESS_OFF = "Remote access works. Cloudflare Access is off (Settings › System), so the app's own sign-in is the only login.";

  it("an open sign-in page is ok with the note instead of the problem", () => {
    const v = remoteAccessView(state({ appProtectedCheck: open }), PUB, NOW, "UTC", false, true);
    expect(v.lines).toEqual([
      { tone: "ok", text: `Public address check: ${PUB}/api/health answered · 10 minutes ago` },
      { tone: "ok", text: ACCESS_OFF },
    ]);
    // The check's own words stay behind Details.
    expect(v.details).toContain("Sign-in page: no redirect");
  });

  it("a sign-in page Cloudflare does protect still says so", () => {
    expect(remoteAccessView(state(), PUB, NOW, "UTC", false, true).lines).toContainEqual({
      tone: "ok",
      text: "Only your team gets past Cloudflare's login.",
    });
  });

  it("the other problems still show: a weak connection, a blocked webhook address and an old cloudflared", () => {
    const v = remoteAccessView(
      state({
        state: "degraded",
        appProtectedCheck: open,
        webhookPathCheck: { at: NOW.toISOString(), ok: false, status: 302, error: "login page" },
        versionWarning: "cloudflared 2026.8.0 has a known problem.",
      }),
      PUB,
      NOW,
      "UTC",
      false,
      true,
    );
    expect(v.status.tone).toBe("warn");
    expect(v.lines.map((l) => l.tone)).toEqual(["warn", "ok", "bad", "ok"]);
    expect(v.lines[3]!.text).toBe(ACCESS_OFF);
  });

  it("says nothing about the sign-in page while the public address doesn't answer (SCREENS-07)", () => {
    // cloudflared stopped or the office internet is down: the sign-in check only saw Cloudflare's error page.
    const failed = { at: new Date(NOW.getTime() - 10 * 60_000).toISOString(), ok: false, status: 530, error: "Cloudflare answered 530 (error 1033)." };
    const down = state({ state: "down", downSince: "2026-09-23T09:02:00Z", publicCheck: failed, appProtectedCheck: open });
    for (const accessOff of [true, false]) {
      const v = remoteAccessView(down, PUB, NOW, "Asia/Karachi", false, accessOff);
      expect(v.status.tone).toBe("bad");
      expect(v.lines).toEqual([
        { tone: "bad", text: `Public address check: ${PUB}/api/health didn't answer · 10 minutes ago. Cloudflare answered 530 (error 1033).` },
      ]);
      expect(v.lines.map((l) => l.text).join(" ")).not.toContain("Remote access works");
      // The check's own words stay behind Details.
      expect(v.details).toContain("Sign-in page: no redirect");
    }
    // A protected sign-in page isn't claimed either while the address is down.
    const protectedButDown = remoteAccessView(state({ publicCheck: failed }), PUB, NOW, "UTC", false, true);
    expect(protectedButDown.lines.map((l) => l.text)).not.toContain("Only your team gets past Cloudflare's login.");
    // No public check yet: no Access line.
    expect(remoteAccessView(state({ publicCheck: null, appProtectedCheck: open }), PUB, NOW, "UTC", false, true).lines).toEqual([]);
  });

  it("the Access line comes back once the public address answers again", () => {
    const v = remoteAccessView(state({ state: "connected", appProtectedCheck: open }), PUB, NOW, "UTC", false, true);
    expect(v.lines.at(-1)).toEqual({ tone: "ok", text: ACCESS_OFF });
  });

  it("with the Access check on, nothing changes", () => {
    expect(remoteAccessView(state({ appProtectedCheck: open }), PUB, NOW, "UTC", false, false).lines).toContainEqual({
      tone: "bad",
      text: "Anyone on the internet can reach your app's sign-in page. In Cloudflare, check the 'Outreach' application (Cloudflare guide, step 5).",
    });
    expect(remoteAccessView(state({ appProtectedCheck: open }), PUB, NOW, "UTC")).toEqual(
      remoteAccessView(state({ appProtectedCheck: open }), PUB, NOW, "UTC", false, false),
    );
  });
});
