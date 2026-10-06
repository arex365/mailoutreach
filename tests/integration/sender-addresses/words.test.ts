import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * SHARED-FROM-DESIGN §3.6 (F19): the per-person address is the "Sending address" in per-person mode (unchanged) and the
 * "Reply address" in shared-From mode, on Settings › Limits & warm-up (the per-sender column and its missing-address
 * cell) and in Settings › Team's switch-off dialog. No database: the words only.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/settings/limits",
}));
// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("@/app/(app)/settings/limits/actions", () => ({
  saveLimitsAction: vi.fn(),
  setTodayCapAction: vi.fn(),
  clearTodayCapAction: vi.fn(),
  saveSenderCapsAction: vi.fn(),
  saveRulesAction: vi.fn(),
}));

const { SenderCapsForm } = await import("@/components/settings/limits/sender-caps-form");
const { switchOffDialogText } = await import("@/app/(app)/settings/team/switch-off-text");

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const senders = [
  { userId: 1, name: "Arslan", address: "arslan@mail.example.com", dailyCap: null },
  { userId: 2, name: "Ali", address: null, dailyCap: 40 },
];

describe("Settings › Limits & warm-up, per-sender limits", () => {
  it("per-person mode (the default): 'Sending address' and 'No sending address yet'", () => {
    for (const props of [{ senders }, { senders, teamFrom: false }]) {
      const t = text(renderToStaticMarkup(createElement(SenderCapsForm, props)));
      expect(t).toContain("Sending address");
      expect(t).toContain("No sending address yet");
      expect(t).not.toMatch(/reply address/i);
      expect(t).toContain("arslan@mail.example.com");
    }
  });

  it("shared-From mode: 'Reply address' and 'No reply address yet'", () => {
    const t = text(renderToStaticMarkup(createElement(SenderCapsForm, { senders, teamFrom: true })));
    expect(t).toContain("Reply address");
    expect(t).toContain("No reply address yet");
    expect(t).not.toMatch(/sending address/i);
  });
});

describe("Settings › Team, the switch-off dialog", () => {
  const target = { name: "Ali", activeCampaigns: [], waitingReplies: 0 };

  it("per-person mode (absent or false): the sending address, as before", () => {
    const intro = "Ali will be signed out everywhere and can't sign in. Their history stays. Replies to Ali's sending address will come to your inbox from now on.";
    expect(switchOffDialogText(target).intro).toBe(intro);
    expect(switchOffDialogText({ ...target, teamFrom: false }).intro).toBe(intro);
  });

  it("shared-From mode: the reply address", () => {
    const text = switchOffDialogText({ ...target, teamFrom: true });
    expect(text.intro).toBe(
      "Ali will be signed out everywhere and can't sign in. Their history stays. Replies to Ali's reply address will come to your inbox from now on.",
    );
    expect(JSON.stringify(text)).not.toMatch(/sending address/i);
  });
});
