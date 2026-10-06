import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The groups form saves through a Server Action; the render tests never call it.
vi.mock("@/app/(app)/settings/notifications/actions", () => ({
  savePopupGroupsAction: async () => ({ ok: true, data: { groups: [] }, message: "Saved." }),
}));

const {
  POPUP_AFTER_TEST,
  POPUP_ASK_HINT,
  POPUP_BLOCKED_TEXT,
  POPUP_GROUP_LABELS,
  POPUP_GROUPS_HINT,
  POPUP_PHONE_TEXT,
  POPUP_PIN_TIP,
  PopupGroupsForm,
  PopupPanelView,
  popupGroupsFor,
} = await import("@/components/settings/popups-settings");

/** React escapes apostrophes and quotes in text; compare against the same escaping. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function panel(state: Parameters<typeof PopupPanelView>[0]["state"], extra: Partial<Parameters<typeof PopupPanelView>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(PopupPanelView, {
      state,
      publicUrl: "https://outreach.example.com",
      localAddress: "http://localhost:3001",
      testSent: false,
      ...extra,
    }),
  );
}

describe("Pop-ups on this computer: exactly one state (M4-DESIGN §9.6)", () => {
  it("insecure: names the secure address and the office PC with this page's port", () => {
    const html = panel("insecure");
    expect(html).toContain(esc("Pop-ups can't work on this address."));
    expect(html).toContain("https://outreach.example.com");
    expect(html).toContain("http://localhost:3001");
    expect(html).not.toContain("Turn on pop-ups");
    const noPublic = panel("insecure", { publicUrl: null, localAddress: "http://localhost:3000" });
    expect(noPublic).toContain(esc("on a secure (https) address or on the office PC itself (http://localhost:3000)."));
    expect(noPublic).not.toContain("Open the secure address");
  });

  it("phone and unsupported: point to the bell", () => {
    expect(panel("phone")).toContain(POPUP_PHONE_TEXT);
    expect(panel("unsupported")).toContain(POPUP_PHONE_TEXT);
    expect(panel("phone")).not.toContain("Switch");
  });

  it("ask: an outline Turn on pop-ups button with the hint", () => {
    const html = panel("ask");
    expect(html).toMatch(/<button[^>]*data-variant="outline"[^>]*>Turn on pop-ups<\/button>/);
    expect(html).toContain(POPUP_ASK_HINT);
  });

  it("blocked: says how to allow them again", () => {
    expect(panel("blocked")).toContain(POPUP_BLOCKED_TEXT);
  });

  it("on and off: the neutral switch, the test button and the pin tip", () => {
    const on = panel("on");
    expect(on).toContain("Pop-ups in this browser");
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(on).toContain("data-checked:bg-foreground"); // never orange
    expect(on).toContain("Send a test pop-up");
    expect(on).toContain(esc(POPUP_PIN_TIP));
    expect(on).not.toContain("Did you see it?");
    expect(panel("off")).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(panel("on", { testSent: true })).toContain(esc(POPUP_AFTER_TEST));
  });

  it("says it is checking before the browser has been read", () => {
    expect(panel("loading")).toContain("Checking this browser…");
  });
});

describe("What pops up", () => {
  it("offers Sending paused… to the Owner only", () => {
    expect(popupGroupsFor("OWNER")).toEqual(["reply", "outage", "campaign", "sending"]);
    expect(popupGroupsFor("MEMBER")).toEqual(["reply", "outage", "campaign"]);
    const owner = renderToStaticMarkup(createElement(PopupGroupsForm, { role: "OWNER", initialGroups: ["reply", "sending"] }));
    const member = renderToStaticMarkup(createElement(PopupGroupsForm, { role: "MEMBER", initialGroups: ["reply"] }));
    for (const g of ["reply", "outage", "campaign", "sending"] as const) expect(owner).toContain(esc(POPUP_GROUP_LABELS[g]));
    expect(member).not.toContain(POPUP_GROUP_LABELS.sending);
    expect(member).toContain(esc(POPUP_GROUP_LABELS.reply));
    expect(owner).toContain(esc(POPUP_GROUPS_HINT));
  });

  it("ticks the saved groups", () => {
    const html = renderToStaticMarkup(createElement(PopupGroupsForm, { role: "OWNER", initialGroups: ["outage"] }));
    expect(html).toMatch(/id="popup-group-outage"[^>]*aria-checked="true"|aria-checked="true"[^>]*id="popup-group-outage"/);
    expect(html).toMatch(/id="popup-group-reply"[^>]*aria-checked="false"|aria-checked="false"[^>]*id="popup-group-reply"/);
  });
});
