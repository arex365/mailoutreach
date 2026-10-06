import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The pill loads the full label from the database; each test decides what that load does.
const load = vi.hoisted(() => ({ fn: (async () => {
  throw new Error("database is locked");
}) as () => Promise<unknown> }));
vi.mock("@/server/sending-state", () => ({ getSendingLabel: () => load.fn() }));

const { SendingPill, fallbackLabel, STATUS_UNAVAILABLE } = await import("@/components/shell/sending-pill");

/**
 * The top-bar pill when its label can't be loaded (M6-DESIGN §2.7, D3): a pause is still shown in red with its reason;
 * everything else reads "Status unavailable" (neutral), never a guess such as "Test list only" after go-live.
 */

describe("the pill's fallback", () => {
  it("shows 'Status unavailable' for every state that isn't a pause", () => {
    for (const kind of ["dry-run", "test-list", "live"] as const) {
      expect(fallbackLabel({ kind })).toEqual({
        kind,
        text: "Status unavailable",
        title: "The sending status couldn't be loaded. Refresh the page.",
        tone: "neutral",
      });
    }
  });

  it("still shows a pause with its reason", () => {
    expect(fallbackLabel({ kind: "paused", reason: "7 of the last 200 emails bounced" })).toMatchObject({
      kind: "paused",
      text: "Paused: 7 of the last 200 emails bounced",
      tone: "danger",
    });
    expect(fallbackLabel({ kind: "paused", reason: "by Arslan" }).text).toBe("Paused by Arslan");
  });

  it("renders the fallback when the full label fails to load, as a link for the Owner and plain text for Members", async () => {
    load.fn = async () => {
      throw new Error("database is locked");
    };
    const owner = renderToStaticMarkup(await SendingPill({ state: { kind: "live" }, isOwner: true }));
    expect(owner).toContain(STATUS_UNAVAILABLE.text);
    expect(owner).toContain(`title="${STATUS_UNAVAILABLE.title.replace(/'/g, "&#x27;")}"`);
    expect(owner).toContain('href="/settings/sending"');
    expect(owner).not.toContain("Sending live");
    const member = renderToStaticMarkup(await SendingPill({ state: { kind: "test-list" }, isOwner: false }));
    expect(member).toContain("Status unavailable");
    expect(member).not.toContain("href=");
  });

  it("uses the full label when it loads", async () => {
    load.fn = async () => ({
      state: { kind: "live" },
      label: { kind: "live", text: "Sending live", title: "Campaigns send real email.", tone: "success" },
      activeRealCampaigns: { live: 1, test: 0 },
    });
    const out = renderToStaticMarkup(await SendingPill({ state: { kind: "dry-run" }, isOwner: true }));
    expect(out).toContain("Sending live");
    expect(out).not.toContain("Status unavailable");
  });
});
