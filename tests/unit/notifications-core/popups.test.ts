import { describe, expect, it } from "vitest";
import {
  POPUP_BATCH_TAG,
  batchPopupText,
  pickPopups,
  pollDelayMs,
  popupPanelState,
  popupStorageKeys,
  popupTag,
  readPopupSwitch,
  shouldPopUp,
} from "@/core/notifications/popups";

const desktop = {
  secure: true,
  hasApi: true,
  coarsePointerOnly: false,
  permission: "granted" as const,
  localOn: true as boolean | null,
  legacyDesktopReplies: false,
  failed: false,
};

describe("popupPanelState (M4-DESIGN §5.3, §9.6)", () => {
  it("each state", () => {
    expect(popupPanelState({ ...desktop, coarsePointerOnly: true })).toBe("phone");
    expect(popupPanelState({ ...desktop, secure: false })).toBe("insecure");
    expect(popupPanelState({ ...desktop, hasApi: false })).toBe("unsupported");
    expect(popupPanelState({ ...desktop, failed: true })).toBe("unsupported");
    expect(popupPanelState({ ...desktop, permission: "denied" })).toBe("blocked");
    expect(popupPanelState({ ...desktop, permission: "default" })).toBe("ask");
    expect(popupPanelState(desktop)).toBe("on");
    expect(popupPanelState({ ...desktop, localOn: false })).toBe("off");
  });

  it("without a choice in this browser, the old account switch decides", () => {
    expect(popupPanelState({ ...desktop, localOn: null, legacyDesktopReplies: true })).toBe("on");
    expect(popupPanelState({ ...desktop, localOn: null, legacyDesktopReplies: false })).toBe("off");
    expect(popupPanelState({ ...desktop, localOn: false, legacyDesktopReplies: true })).toBe("off");
  });

  it("a phone is a phone on any address; an insecure address wins over a missing API and the permission", () => {
    expect(popupPanelState({ ...desktop, coarsePointerOnly: true, secure: false, hasApi: false })).toBe("phone");
    expect(popupPanelState({ ...desktop, secure: false, hasApi: false, permission: "denied" })).toBe("insecure");
    expect(popupPanelState({ ...desktop, failed: true, permission: "denied" })).toBe("unsupported");
  });
});

describe("pollDelayMs", () => {
  it("20 s ± 2 s while visible, whatever random() gives", () => {
    expect(pollDelayMs({ hidden: false, popupsOn: false, random: () => 0 })).toBe(18_000);
    expect(pollDelayMs({ hidden: false, popupsOn: true, random: () => 0.5 })).toBe(20_000);
    expect(pollDelayMs({ hidden: false, popupsOn: false, random: () => 0.999999 })).toBe(22_000);
    expect(pollDelayMs({ hidden: false, popupsOn: false, random: () => 7 })).toBe(22_000);
    expect(pollDelayMs({ hidden: false, popupsOn: false, random: () => -1 })).toBe(18_000);
    expect(pollDelayMs({ hidden: false, popupsOn: false, random: () => Number.NaN })).toBe(20_000);
  });

  it("stays inside the bounds with a seeded random", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const d = pollDelayMs({ hidden: false, popupsOn: false, random })!;
      expect(d).toBeGreaterThanOrEqual(18_000);
      expect(d).toBeLessThanOrEqual(22_000);
      seen.add(d);
    }
    expect(seen.size).toBeGreaterThan(50);
  });

  it("60 s while hidden with pop-ups on, no polling while hidden with them off", () => {
    expect(pollDelayMs({ hidden: true, popupsOn: true, random: () => 0.5 })).toBe(60_000);
    expect(pollDelayMs({ hidden: true, popupsOn: false, random: () => 0.5 })).toBeNull();
  });
});

describe("shouldPopUp", () => {
  it("only when the tab is hidden or the window has no focus", () => {
    expect(shouldPopUp({ hidden: true, focused: true })).toBe(true);
    expect(shouldPopUp({ hidden: false, focused: false })).toBe(true);
    expect(shouldPopUp({ hidden: true, focused: false })).toBe(true);
    expect(shouldPopUp({ hidden: false, focused: true })).toBe(false);
  });
});

describe("pickPopups", () => {
  const n = (id: number) => ({ id, title: `N${id}` });

  it("shows the items above the high-water mark, oldest first, and moves the mark", () => {
    expect(pickPopups({ items: [n(12), n(11)], count: 2, latestId: 12 }, 10)).toEqual({ show: [n(11), n(12)], batch: null, newLast: 12 });
  });

  it("never shows an item at or below the mark again", () => {
    expect(pickPopups({ items: [n(9), n(10), n(11)], count: 3, latestId: 11 }, 10)).toEqual({ show: [n(11)], batch: null, newLast: 11 });
    expect(pickPopups({ items: [n(9), n(10)], count: 2, latestId: 10 }, 10)).toEqual({ show: [], batch: null, newLast: 10 });
  });

  it("more than 3 new → one batch pop-up of the total, and the mark jumps to latestId", () => {
    const items = [n(11), n(12), n(13), n(14), n(15)];
    expect(pickPopups({ items, count: 30, latestId: 40 }, 10)).toEqual({ show: [], batch: 30, newLast: 40 });
    expect(pickPopups({ items: items.slice(0, 4), count: 4, latestId: 14 }, 10)).toEqual({ show: [], batch: 4, newLast: 14 });
    expect(pickPopups({ items: items.slice(0, 3), count: 3, latestId: 13 }, 10).batch).toBeNull();
  });

  it("does nothing on an empty poll", () => {
    expect(pickPopups({ items: [], count: 0, latestId: null }, 10)).toEqual({ show: [], batch: null, newLast: 10 });
    expect(pickPopups({ items: [], count: 0, latestId: null }, Number.NaN)).toEqual({ show: [], batch: null, newLast: 0 });
  });
});

describe("pop-up helpers", () => {
  it("tags, batch text, storage keys and the local switch", () => {
    expect(popupTag(42)).toBe("pp-n-42");
    expect(POPUP_BATCH_TAG).toBe("pp-n-batch");
    expect(batchPopupText(30)).toEqual({ title: "30 new notifications", body: "Open the app to see them.", link: "/notifications" });
    expect(popupStorageKeys(7)).toEqual({ on: "pp.popups.on.7", last: "pp.popups.last.7", unsupported: "pp.popups.unsupported.7" });
    expect(readPopupSwitch("on")).toBe(true);
    expect(readPopupSwitch("off")).toBe(false);
    expect(readPopupSwitch(null)).toBeNull();
    expect(readPopupSwitch("yes")).toBeNull();
  });
});
