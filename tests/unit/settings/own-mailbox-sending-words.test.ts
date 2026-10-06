import { describe, expect, it } from "vitest";
import { GO_LIVE_RECOMMENDATION_TEXTS, MODE_GATE_TEXTS, goLiveRecommendations } from "@/core/sending/mode-gates";
import { OWN_MX_WAITING_TEXT, waitingText } from "@/components/campaigns/format";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import {
  liveConfirmText,
  TEST_LIST_TEXTS,
  TEST_LIST_TEXTS_AFTER_GO_LIVE,
  TEST_LIST_TEXTS_OWN,
  testListTexts,
} from "@/components/settings/sending/texts";

/**
 * Own-mailbox wording on Settings › Sending & Mailgun (review SCREENS-11): no "reply inbox" in this mode (replies go to
 * the From mailbox; "Send me a test" goes to the inbox for test emails, as My profile calls it), app mode unchanged. And
 * the go-live card's Free-plan address-check advice (review SCREENS-01): no checker to "choose", plainly optional and
 * paid, with the real way forward.
 */

describe("the Live confirmation and the Test list card in own-mailbox mode (review SCREENS-11)", () => {
  it("names the inbox for test emails, never a reply inbox; app mode reads exactly as before", () => {
    const own = liveConfirmText(["tess@test-mailbox.example"], false, true);
    expect(own).toBe(
      "Real emails will go to your test-list addresses only: tess@test-mailbox.example, and to your inbox for test emails (My profile) when you click Send me a test. Everyone else is left out until you go live. Switch to live?",
    );
    expect(own).not.toMatch(/reply inbox/i);
    expect(OWN_MAILBOX_TEXTS.testInboxLabel.toLowerCase()).toBe("inbox for your test emails");
    // App mode (the default, and false) is unchanged.
    const app = "Real emails will go to your test-list addresses only: tess@test-mailbox.example, and to your own reply inbox when you click Send me a test. Everyone else is left out until you go live. Switch to live?";
    expect(liveConfirmText(["tess@test-mailbox.example"])).toBe(app);
    expect(liveConfirmText(["tess@test-mailbox.example"], false, false)).toBe(app);
    // After go-live the sentence names nobody's inbox, in both modes.
    expect(liveConfirmText(["a@b.example"], true, true)).toBe(liveConfirmText(["a@b.example"], true));
  });

  it("the test-list hint and empty state: own-mailbox words before go-live, today's after; app mode unchanged", () => {
    const own = testListTexts(false, { ownMailbox: true });
    expect(own).toBe(TEST_LIST_TEXTS_OWN);
    expect(own.hint).toBe(
      "Until you go live, real email only reaches these addresses, and your inbox for test emails (My profile) when you click Send me a test. Until then they also count as checked, so test campaigns don't need address checks. Emails to them don't count as 'emailed', so you can test again at any time.",
    );
    expect(own.empty).toBe("No test addresses yet. Add two or three mailboxes that aren't your inbox for test emails, ideally one Gmail and one Outlook.com.");
    expect(own.description).toBe(TEST_LIST_TEXTS.description);
    for (const s of [own.hint, own.empty, own.description]) expect(s).not.toMatch(/reply inbox/i);
    const ownAfter = testListTexts(true, { ownMailbox: true });
    expect(ownAfter).toEqual({ ...TEST_LIST_TEXTS_AFTER_GO_LIVE, empty: own.empty });
    expect(testListTexts(false)).toBe(TEST_LIST_TEXTS);
    expect(testListTexts(true)).toBe(TEST_LIST_TEXTS_AFTER_GO_LIVE);
    expect(testListTexts(false, { ownMailbox: false })).toBe(TEST_LIST_TEXTS);
  });
});

describe("the other own-mailbox words the integrator wired (review SCREENS-11, DOMAIN-8)", () => {
  it("the main-domain-mx waiting line names all three causes and forwards nothing; app mode unchanged", () => {
    const own = waitingText({ reason: "main-domain-mx", until: null }, { timeZone: "Europe/Berlin", ownMailbox: true });
    expect(own).toBe(OWN_MX_WAITING_TEXT);
    expect(own).toContain("Cloudflare Email Routing");
    expect(own).not.toMatch(/forwarded/);
    const app = waitingText({ reason: "main-domain-mx", until: null }, { timeZone: "Europe/Berlin" });
    expect(app).toBe(
      "Waiting: mail for your main domain points to Mailgun or is missing, so replies forwarded to your inbox would be lost. The Owner can see how to fix it in Settings › Domain checklist.",
    );
    expect(waitingText({ reason: "main-domain-mx", until: null }, { timeZone: "Europe/Berlin", ownMailbox: false })).toBe(app);
    // Other reasons don't depend on the mode.
    expect(waitingText({ reason: "inbox-check", until: null }, { timeZone: "Europe/Berlin", ownMailbox: true })).toBe(
      waitingText({ reason: "inbox-check", until: null }, { timeZone: "Europe/Berlin" }),
    );
  });

  it("the gate sentences: fromMxOwn and liveTestNoneOwn only in own-mailbox mode", () => {
    expect(MODE_GATE_TEXTS.fromMxOwn).toContain("Cloudflare Email Routing");
    expect(MODE_GATE_TEXTS.liveTestNoneOwn).toContain("(Own-mailbox guide, step 10)");
    expect(MODE_GATE_TEXTS.liveTestNone).toContain("(Going-live guide, step 3)");
  });
});

describe("the Free plan's address-check advice (review SCREENS-01)", () => {
  const T = GO_LIVE_RECOMMENDATION_TEXTS;

  it("points at no checker that doesn't exist, says plainly that checks are optional and paid, and gives the way forward", () => {
    expect(T.checksFree).not.toMatch(/another checker|choose .*checker/i);
    expect(T.checksFree).toContain("optional but paid");
    expect(T.checksFree).toContain("Free plan doesn't include them");
    // Going live needs nothing bought ("There is nothing to buy" stays true for going live) ...
    expect(T.checksFree).toContain("Going live doesn't need them");
    // ... but live campaigns after it only reach checked addresses, so the real way forward is named.
    expect(T.checksFree).toContain("live campaigns only email checked addresses");
    expect(T.checksFree).toContain("Settings › Deliverability › Test address checks");
    expect(T.checksFree).toContain("add Email Validations in Mailgun (Account › Billing)");
    // The app-mode line is unchanged.
    expect(T.checks).toBe("Try address checks once (Settings › Deliverability): after going live, live campaigns only email checked addresses.");
  });

  it("is the checks line in own-mailbox mode on Free, and only there", () => {
    const base = {
      rows: [],
      checksTried: false,
      secondFolder: "D:\\Backup",
      newestBackupAt: new Date("2026-09-28T09:00:00Z"),
      accessOff: false,
      riskyFolder: null,
      restoreDone: true,
      now: new Date("2026-09-28T10:00:00Z"),
    };
    expect(goLiveRecommendations({ ...base, ownMailbox: true, teamFrom: "contact@example.com", planDailyLimit: 100 })).toContain(T.checksFree);
    expect(goLiveRecommendations(base)).toContain(T.checks);
    expect(goLiveRecommendations(base)).not.toContain(T.checksFree);
  });
});
