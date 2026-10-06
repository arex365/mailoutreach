import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GO_LIVE_COPY, goLiveDialogItems, goLiveDraftsItem, goLiveWarmupItem } from "@/core/sending/go-live-copy";
import { formatDateTime } from "@/core/time/format";
import { goLiveCardView } from "@/components/settings/sending/go-live-view";
import type { GoLiveView } from "@/server/services/go-live";

// The card's dialog calls a Server Action; nothing here calls it while rendering.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/(app)/settings/sending/actions", () => ({ goLiveAction: vi.fn() }));

const { GoLiveCard } = await import("@/components/settings/sending/go-live-card");

/**
 * The "Go live" card (M6-DESIGN §2.5) in each of its states: the practice copy, not live with blockers, not live and
 * ready (with drafts and today's hand-set limit in the dialog), live (who, when and the warm-up line), and not live
 * after a domain change ended go-live (G8). The words come from GO_LIVE_COPY; the card only draws them.
 */

const TZ = "Asia/Karachi";
const WARMUP = { startCap: 50, maxCap: 1000, steps: 20 };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

function view(over: Partial<GoLiveView> = {}): GoLiveView {
  return {
    practiceCopy: false,
    live: false,
    at: null,
    byName: null,
    domain: "send.example.com",
    endedOnDomain: null,
    blockers: [],
    recommendations: [],
    drafts: { items: [], more: 0 },
    capOverrideToday: null,
    warmupLine: null,
    from: null,
    ownFromExample: null,
    spamPlacements: [],
    endedOnFrom: null,
    ...over,
  };
}

describe("the dialog's words", () => {
  it("lists what going live does, in order, the conditional items only when they apply", () => {
    expect(goLiveDialogItems({ capOverrideToday: null, drafts: { items: [], more: 0 }, warmup: WARMUP })).toEqual([
      "New campaigns send real email to everyone eligible, not only your test list. Sending mode switches to Live.",
      "Warm-up starts today: the daily limit starts at 50 and goes up one step after each weekday with at least half the limit used and healthy numbers, to 1,000 in about 4 weeks.",
      "Bounces and complaints are counted from now on; your test emails don't count.",
      "Campaigns already running keep the mode they were launched with.",
      "Your test mailboxes become normal companies: emailing them in a live campaign from now on counts as emailed.",
      "This can't be switched off. To stop sending at any time, use Pause all sending.",
    ]);
    const full = goLiveDialogItems({
      capOverrideToday: 400,
      drafts: { items: [{ name: "Germany Q4", people: 412 }, { name: "Spain", people: 80 }], more: 0 },
      warmup: WARMUP,
    });
    expect(full.slice(3, 5)).toEqual([
      "Today's limit you set by hand (400) is removed: today sends at most 50.",
      'These drafts will send real email when launched: "Germany Q4" (412 people), "Spain" (80 people). Check them before launching.',
    ]);
    expect(full).toHaveLength(8);
    // The fixed items are the design's, as GO_LIVE_COPY keeps them.
    expect(GO_LIVE_COPY.dialogItems[1]).toBe(goLiveWarmupItem(WARMUP));
  });

  it("names at most five drafts, then 'and 2 more'; one person reads 'person'", () => {
    const items = ["A", "B", "C", "D", "E"].map((name, i) => ({ name, people: i + 1 }));
    expect(goLiveDraftsItem({ items, more: 2 })).toBe(
      'These drafts will send real email when launched: "A" (1 person), "B" (2 people), "C" (3 people), "D" (4 people), "E" (5 people) and 2 more. Check them before launching.',
    );
    expect(goLiveDraftsItem({ items: [], more: 0 })).toBeNull();
  });

  it("follows the warm-up settings in use", () => {
    expect(goLiveWarmupItem({ startCap: 30, maxCap: 2000, steps: 11 })).toBe(
      "Warm-up starts today: the daily limit starts at 30 and goes up one step after each weekday with at least half the limit used and healthy numbers, to 2,000 in about 2 weeks.",
    );
    expect(goLiveWarmupItem({ startCap: 50, maxCap: 100, steps: 3 })).toMatch(/in about 1 week\.$/);
  });

  it("has the notification, activity, toast and refusal sentences", () => {
    expect(GO_LIVE_COPY.notificationTitle).toBe("The app is live");
    expect(GO_LIVE_COPY.notificationBody("Arslan")).toBe(
      "Arslan switched on Go live. Sending mode is now Live: the next campaign anyone launches sends real email to everyone eligible. Warm-up has started at 50 a day.",
    );
    expect(GO_LIVE_COPY.activity("Arslan", "send.example.com")).toBe("Arslan went live on send.example.com");
    expect(GO_LIVE_COPY.toast).toBe("You're live. New campaigns now email everyone eligible, and warm-up has started.");
    expect(GO_LIVE_COPY.alreadyLive).toBe("You're already live.");
    expect(GO_LIVE_COPY.changed).toBe("Something changed while going live. Check the list again.");
    expect(GO_LIVE_COPY.endedByDomainChange("mail.example.com", "send2.example.com")).toBe(
      "You were live on mail.example.com: go live again on send2.example.com when its checklist is green (Settings › Sending & Mailgun › Go live).",
    );
  });
});

describe("goLiveCardView and the card", () => {
  it("the practice copy: its sentence alone", () => {
    const card = goLiveCardView(view({ practiceCopy: true, blockers: ["The practice copy never sends real email."] }), { timeZone: TZ, warmup: WARMUP });
    expect(card).toMatchObject({ state: "practice", title: "Go live", description: "The practice copy never sends real email, so it can't go live." });
    expect(card.blockers).toEqual([]);
    const out = text(renderToStaticMarkup(createElement(GoLiveCard, { view: card })));
    expect(out).toContain("The practice copy never sends real email, so it can't go live.");
    expect(out).not.toContain("Before going live:");
    expect(out).not.toContain('role="switch"');
  });

  it("not live with blockers: a disabled switch, both lists and the guide line", () => {
    const card = goLiveCardView(
      view({ blockers: ["Sending is paused."], recommendations: ["Test the AI model once (Settings › AI)."] }),
      { timeZone: TZ, warmup: WARMUP },
    );
    expect(card).toMatchObject({
      state: "blocked",
      title: "Go live",
      description: "When you go live, new live campaigns email everyone eligible, not only your test list, and warm-up starts.",
      guideLine: "Step by step: Going-live guide (docs\\setup\\4-going-live.md).",
      dialogItems: [],
    });
    const html = renderToStaticMarkup(createElement(GoLiveCard, { view: card }));
    const out = text(html);
    expect(out).toContain("Before going live: Sending is paused.");
    expect(out).toContain("Recommended first: Test the AI model once (Settings › AI).");
    expect(out).toContain("Step by step: Going-live guide (docs\\setup\\4-going-live.md).");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*disabled=""/);
    expect(html).toContain('id="go-live"');
    // No orange button on the card itself (the dialog's Go live is the only one, and only while it is open).
    expect(html).not.toContain('data-variant="default"');
  });

  it("not live and ready: an enabled switch, the dialog's list with the drafts and today's limit", () => {
    const card = goLiveCardView(
      view({ capOverrideToday: 400, drafts: { items: [{ id: 3, name: "Made early", people: 1 }], more: 0 } }),
      { timeZone: TZ, warmup: WARMUP },
    );
    expect(card.state).toBe("ready");
    expect(card.dialogItems).toContain("Today's limit you set by hand (400) is removed: today sends at most 50.");
    expect(card.dialogItems).toContain('These drafts will send real email when launched: "Made early" (1 person). Check them before launching.');
    const html = renderToStaticMarkup(createElement(GoLiveCard, { view: card }));
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(html).not.toMatch(/role="switch"[^>]*disabled=""/);
    expect(text(html)).not.toContain("Before going live:");
  });

  it("the dialog's warm-up item follows the Owner's warm-up settings (review SCREENS-10)", () => {
    const card = goLiveCardView(view(), { timeZone: TZ, warmup: { ...WARMUP, minUsePercent: 80, weekdaysOnly: false } });
    expect(card.dialogItems[1]).toBe(
      "Warm-up starts today: the daily limit starts at 50 and goes up one step after each sending day with at least 80% of the limit used and healthy numbers, to 1,000 in about 4 weeks.",
    );
    // The defaults read exactly as the design's sentence.
    const defaults = goLiveCardView(view(), { timeZone: TZ, warmup: { ...WARMUP, minUsePercent: 50, weekdaysOnly: true } });
    expect(defaults.dialogItems[1]).toBe(GO_LIVE_COPY.dialogItems[1]);
  });

  it("live: who, when and where, the warm-up line and the one-way sentence, a checked disabled switch", () => {
    const at = new Date("2026-09-27T09:05:00Z");
    const line = "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a weekday with at least half the limit used and healthy numbers.";
    const card = goLiveCardView(view({ live: true, at, byName: "Arslan", warmupLine: line }), { timeZone: TZ, warmup: WARMUP });
    expect(card).toMatchObject({
      state: "live",
      description: `Live on send.example.com since ${formatDateTime(at, TZ)} (switched on by Arslan). New live campaigns email everyone eligible.`,
      warmupLine: line,
      cantSwitchOff: "This can't be switched off. To stop sending at any time, use Pause all sending.",
      guideLine: null,
      dialogItems: [],
    });
    const html = renderToStaticMarkup(createElement(GoLiveCard, { view: card }));
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*disabled=""/);
    expect(text(html)).toContain(line);
    // Without who, it leaves the name out.
    expect(goLiveCardView(view({ live: true, at, byName: null }), { timeZone: TZ, warmup: WARMUP }).description).toBe(
      `Live on send.example.com since ${formatDateTime(at, TZ)}. New live campaigns email everyone eligible.`,
    );
  });

  it("after a domain change ended go-live: 'Go live on <new domain>' and 'You were live on …'", () => {
    const card = goLiveCardView(
      view({ domain: "send2.example.com", endedOnDomain: "mail.example.com", blockers: ["The reply test hasn't passed yet."] }),
      { timeZone: TZ, warmup: WARMUP },
    );
    expect(card).toMatchObject({
      state: "blocked",
      title: "Go live on send2.example.com",
      description:
        "You were live on mail.example.com. After the change to send2.example.com, live campaigns only reach your test list until you go live on it.",
    });
  });
});

describe("the card with a shared From address (SHARED-FROM-DESIGN §3.3, F12, F13, F21)", () => {
  const OWN = "Arslan from Polygon Paradise <arslan@send.example.com>";

  it("goLiveDialogItems: the From item third, team first, the own example otherwise; without `from` unchanged", () => {
    const base = { capOverrideToday: null, drafts: { items: [], more: 0 }, warmup: WARMUP };
    const plain = goLiveDialogItems(base);
    expect(goLiveDialogItems({ ...base, from: null })).toEqual(plain);
    expect(goLiveDialogItems({ ...base, from: { team: null, ownExample: null } })).toEqual(plain);
    const team = goLiveDialogItems({ ...base, from: { team: { from: "contact@example.com", org: "example.com" }, ownExample: OWN } });
    expect(team).toEqual([...plain.slice(0, 2), GO_LIVE_COPY.dialogTeamFromItem("contact@example.com", "example.com"), ...plain.slice(2)]);
    const own = goLiveDialogItems({ ...base, from: { team: null, ownExample: OWN } });
    expect(own).toEqual([...plain.slice(0, 2), GO_LIVE_COPY.dialogOwnFromItem(OWN), ...plain.slice(2)]);
  });

  it("per-person mode keeps today's card: no From line, no tick; the dialog names the sender's own address (F21)", () => {
    const card = goLiveCardView(view({ ownFromExample: OWN }), { timeZone: TZ, warmup: WARMUP });
    expect(card).not.toHaveProperty("fromLine");
    expect(card).not.toHaveProperty("spamPlacementTick");
    expect(card.dialogItems[2]).toBe(GO_LIVE_COPY.dialogOwnFromItem(OWN));
    expect(card.dialogItems[2]).toBe(
      "Every email shows From the sender's own address, for example Arslan from Polygon Paradise <arslan@send.example.com>.",
    );
    expect(card.dialogItems).toHaveLength(7);
    // Without an Owner address the list is exactly today's six items.
    expect(goLiveCardView(view(), { timeZone: TZ, warmup: WARMUP }).dialogItems).toHaveLength(6);
  });

  it("ready in shared-From mode: the team From item right after the warm-up item", () => {
    const card = goLiveCardView(view({ from: "contact@example.com", ownFromExample: OWN }), { timeZone: TZ, warmup: WARMUP });
    expect(card.dialogItems[1]).toBe(goLiveWarmupItem(WARMUP));
    expect(card.dialogItems[2]).toBe(
      "Every email shows From contact@example.com. Complaints about them count against example.com, the domain your everyday email uses.",
    );
    expect(card.dialogItems).not.toContain(GO_LIVE_COPY.dialogOwnFromItem(OWN));
  });

  it("a spam placement adds the required tick (ready only)", () => {
    const spam = ["Outlook.com (tess@outlook.com)"];
    const ready = goLiveCardView(view({ from: "contact@example.com", spamPlacements: spam }), { timeZone: TZ, warmup: WARMUP });
    expect(ready.spamPlacementTick).toBe(
      "I know the reply test's email landed in spam at Outlook.com (tess@outlook.com). Go live anyway: fewer people there may see our emails at first.",
    );
    const blocked = goLiveCardView(view({ from: "contact@example.com", spamPlacements: spam, blockers: ["Sending is paused."] }), {
      timeZone: TZ,
      warmup: WARMUP,
    });
    expect(blocked).not.toHaveProperty("spamPlacementTick");
  });

  it("live in shared-From mode: the From line under the live line, drawn by the card", () => {
    const at = new Date("2026-09-27T09:05:00Z");
    const card = goLiveCardView(view({ live: true, at, byName: "Arslan", from: "contact@example.com" }), { timeZone: TZ, warmup: WARMUP });
    expect(card.fromLine).toBe("Emails show From contact@example.com; replies go to each sender's own address.");
    const out = text(renderToStaticMarkup(createElement(GoLiveCard, { view: card })));
    expect(out).toContain("Emails show From contact@example.com; replies go to each sender's own address.");
    expect(out.indexOf("Emails show From")).toBeLessThan(out.indexOf("This can't be switched off."));
  });

  it("not live after a From change on the same domain: 'You were live with …' in both directions", () => {
    const toTeam = goLiveCardView(view({ from: "contact@example.com", endedOnFrom: { was: null }, blockers: ["The reply test hasn't passed yet."] }), {
      timeZone: TZ,
      warmup: WARMUP,
    });
    expect(toTeam).toMatchObject({
      state: "blocked",
      title: "Go live",
      description:
        "You were live with each person's own address as the From address. After the change to contact@example.com, live campaigns only reach your test list until you run the reply test and go live again.",
    });
    const toOwn = goLiveCardView(view({ from: null, endedOnFrom: { was: "contact@example.com" } }), { timeZone: TZ, warmup: WARMUP });
    expect(toOwn.description).toBe(GO_LIVE_COPY.descriptionAfterFromChange("contact@example.com", null));
    // A domain change says so first.
    const both = goLiveCardView(view({ domain: "send2.example.com", endedOnDomain: "mail.example.com", endedOnFrom: { was: null } }), {
      timeZone: TZ,
      warmup: WARMUP,
    });
    expect(both.title).toBe("Go live on send2.example.com");
  });
});
