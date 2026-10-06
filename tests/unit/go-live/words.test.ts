import { describe, expect, it, vi } from "vitest";
import {
  MODE_OPTION_TEXTS,
  MODE_WORDS,
  liveConfirmText,
  modeOptionTexts,
  modeWords,
  testListTexts,
} from "@/components/settings/sending/texts";
import { madeBeforeGoLiveText, modeLine, needsGoLiveTick } from "@/components/campaign-wizard/format";

// The wizard frame's title menu calls Server Actions; nothing here calls them.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("@/app/(app)/campaigns/[id]/setup/actions", () => ({ deleteDraftAction: vi.fn(), renameDraftAction: vi.fn() }));

const { wizardModeText } = await import("@/components/campaign-wizard/wizard-frame");

/**
 * Words before and after go-live (M6-DESIGN §2.7): the Sending mode choices, toasts and activity words, the Live
 * confirmation, the Test list card, the wizard's badge and the Schedule step. Before go-live every text is kept; after it
 * Live emails everyone eligible and Test mode still only emails the test list (G3). No "Milestone" anywhere.
 */

describe("Settings › Sending & Mailgun", () => {
  it("mode words: 'live (test list only)' before go-live, 'live' after it", () => {
    expect(modeWords(false)).toBe(MODE_WORDS);
    expect(modeWords(false)).toEqual({ DRY_RUN: "dry run", TEST: "test mode", LIVE: "live (test list only)" });
    expect(modeWords(true)).toEqual({ DRY_RUN: "dry run", TEST: "test mode", LIVE: "live" });
  });

  it("mode choices: the Live title and text change, Test mode's stays test-list only", () => {
    const before = modeOptionTexts(false);
    const after = modeOptionTexts(true);
    expect(before).toBe(MODE_OPTION_TEXTS);
    expect(before.LIVE.title).toBe("Live (test list only)");
    expect(before.LIVE.text).toBe(
      "Real emails from your sending domain, inside sending hours and under the daily limit, but only to the addresses on your test list until you go live. Live campaigns start once the reply test has passed.",
    );
    expect(after.LIVE).toEqual({
      title: "Live",
      text: "Real emails from your sending domain to everyone eligible, inside sending hours and under the daily limit.",
    });
    const testText =
      "Emails go to Mailgun's test mode, only to your test list: accepted, never delivered, and billed like normal emails. Use it only to check the connection.";
    expect(before.TEST.text).toBe(testText);
    expect(after.TEST.text).toBe(testText);
    expect(after.DRY_RUN).toEqual(before.DRY_RUN);
  });

  it("the Live confirmation names the test list before go-live and everyone eligible after it", () => {
    expect(liveConfirmText(["tess@test-mailbox.example"])).toBe(
      "Real emails will go to your test-list addresses only: tess@test-mailbox.example, and to your own reply inbox when you click Send me a test. Everyone else is left out until you go live. Switch to live?",
    );
    expect(liveConfirmText([], false)).toContain("(you haven't added any yet)");
    expect(liveConfirmText(["tess@test-mailbox.example"], true)).toBe(
      "New campaigns will send real email to everyone eligible, inside sending hours and under the daily limit. Switch to live?",
    );
    for (const goLive of [false, true]) expect(liveConfirmText(["a@b.example"], goLive)).not.toMatch(/Milestone/);
  });

  it("the Test list card: what it's for, before and after go-live", () => {
    expect(testListTexts(false).description).toBe("The mailboxes that can receive real email before you go live.");
    expect(testListTexts(false).hint).toMatch(/^Until you go live, real email only reaches these addresses/);
    expect(testListTexts(true).description).toBe("The mailboxes Test mode and the reply test use.");
    expect(testListTexts(true).hint).toBe(
      "Test mode only emails these addresses, and the reply test uses them. Emails to them in a live campaign now count as emailed.",
    );
    expect(testListTexts(true).empty).toBe(testListTexts(false).empty);
  });
});

describe("the campaign wizard", () => {
  it("the badge reads 'Live' after go-live", () => {
    expect(wizardModeText("LIVE", false)).toBe("Live (test list only)");
    expect(wizardModeText("LIVE", true)).toBe("Live");
    expect(wizardModeText("LIVE")).toBe("Live (test list only)");
    expect(wizardModeText("TEST", true)).toBe("Test mode");
    expect(wizardModeText("DRY_RUN", true)).toBe("Dry run");
  });

  it("the Schedule step's Live line changes with go-live; Test mode and dry runs don't", () => {
    expect(modeLine({ mode: "LIVE", practiceCopy: false, goLive: false })).toBe(
      "It sends real email, but only to the addresses on your test list until you go live. Emails to test mailboxes don't count as emailed, so you can test again at any time.",
    );
    expect(modeLine({ mode: "LIVE", practiceCopy: false })).toBe(modeLine({ mode: "LIVE", practiceCopy: false, goLive: false }));
    expect(modeLine({ mode: "LIVE", practiceCopy: false, goLive: true })).toBe(
      "It sends real email to everyone in this campaign, inside their working hours and under the daily limit.",
    );
    expect(modeLine({ mode: "TEST", practiceCopy: false, goLive: true })).toBe(modeLine({ mode: "TEST", practiceCopy: false, goLive: false }));
    expect(modeLine({ mode: "DRY_RUN", practiceCopy: false, goLive: true })).toBe(modeLine({ mode: "DRY_RUN", practiceCopy: false }));
  });

  it("a LIVE draft made before go-live asks for a tick, with how many people it now emails", () => {
    expect(madeBeforeGoLiveText(412)).toBe("This draft was made before you went live. It now sends real email to 412 people.");
    expect(madeBeforeGoLiveText(1)).toBe("This draft was made before you went live. It now sends real email to 1 person.");
    expect(madeBeforeGoLiveText(1200)).toBe("This draft was made before you went live. It now sends real email to 1,200 people.");
    expect(needsGoLiveTick({ mode: "LIVE", madeBeforeGoLive: true })).toBe(true);
    expect(needsGoLiveTick({ mode: "LIVE", madeBeforeGoLive: false })).toBe(false);
    expect(needsGoLiveTick({ mode: "LIVE" })).toBe(false);
    expect(needsGoLiveTick({ mode: "TEST", madeBeforeGoLive: true })).toBe(false);
    expect(needsGoLiveTick({ mode: "DRY_RUN", madeBeforeGoLive: true })).toBe(false);
  });
});
