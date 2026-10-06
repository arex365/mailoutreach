import { describe, expect, it } from "vitest";
import { MAIN_NAV, MOBILE_NAV, QUICK_LINKS, SETTINGS_NAV, quickLinkBadge } from "@/components/shell/nav-items";

/**
 * The top bar's search dialog "Go to" list (M5 review SCREENS-01): on a phone the sidebar is hidden and the bottom bar
 * keeps its four items, so this list is how a phone reaches AI lines and the other screens.
 */

describe("the search dialog's Go to list", () => {
  it("has every screen of the sidebar, AI lines included, and Settings", () => {
    const hrefs = QUICK_LINKS.map((l) => l.href);
    for (const item of [...MAIN_NAV, SETTINGS_NAV]) expect(hrefs).toContain(item.href);
    expect(QUICK_LINKS.find((l) => l.href === "/ai-lines")).toMatchObject({ label: "AI lines", count: "aiWaiting" });
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("keeps the sidebar's order, with the extra entries after their screen and Settings last", () => {
    expect(QUICK_LINKS.map((l) => l.label)).toEqual([
      "Dashboard",
      "Contacts",
      "Missing email view",
      "Campaigns",
      "New campaign",
      "Dry-run outbox",
      "Templates",
      "AI lines",
      "Import",
      "Activity",
      "Settings",
    ]);
    // "New campaign" starts a draft with a click; a link never creates one.
    expect(QUICK_LINKS.filter((l) => l.startsCampaign).map((l) => l.href)).toEqual(["/campaigns/new"]);
  });

  it("shows the AI lines waiting for review as a count, hidden at 0", () => {
    const ai = QUICK_LINKS.find((l) => l.href === "/ai-lines")!;
    expect(quickLinkBadge(ai, { aiWaiting: 27 })).toBe("27");
    expect(quickLinkBadge(ai, { aiWaiting: 140 })).toBe("99+");
    expect(quickLinkBadge(ai, { aiWaiting: 0 })).toBeNull();
    const contacts = QUICK_LINKS.find((l) => l.href === "/contacts")!;
    expect(quickLinkBadge(contacts, { aiWaiting: 27 })).toBeNull();
  });

  it("leaves the phone bottom bar at its four items", () => {
    expect(MOBILE_NAV.map((i) => i.label)).toEqual(["Dashboard", "Contacts", "Campaigns", "Notifications"]);
  });
});
