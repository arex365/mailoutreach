import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GO_LIVE_COPY, goLiveDialogItems, goLiveWarmupItem } from "@/core/sending/go-live-copy";
import { formatDateTime } from "@/core/time/format";
import { goLiveCardView } from "@/components/settings/sending/go-live-view";
import type { GoLiveView } from "@/server/services/go-live";

// The card's dialog calls a Server Action; nothing here calls it while rendering.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/(app)/settings/sending/actions", () => ({ goLiveAction: vi.fn() }));

const { GoLiveCard } = await import("@/components/settings/sending/go-live-card");
const { DialogTick } = await import("@/components/settings/sending/go-live-dialog");

/**
 * The go-live card, view and dialog in own-mailbox mode (MAIN-DOMAIN-DESIGN §3.4, O14, O20, O23): the dialog's
 * own-mailbox item in the From item's place, the required replies tick (naming the inbox check and the Spam folder), the
 * http-links tick while the https-links row isn't "ok", the own-mailbox guide line, the live line with the own From, and
 * the warm-up item with the plan's effective maximum (90 on Free). App mode is pinned by card.test.ts; checked once more
 * here with the new field absent.
 */

const TZ = "Asia/Karachi";
const FROM = "contact@example.com";
const D = "example.com";
/** On Free the effective maximum is 90 (100 − the 10 kept for tests): the caller's warm-up table ends there. */
const FREE_WARMUP = { startCap: 50, maxCap: 90, steps: 20 };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

function view(over: Partial<GoLiveView> = {}): GoLiveView {
  return {
    practiceCopy: false,
    live: false,
    at: null,
    byName: null,
    domain: D,
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
    ownMailbox: { from: FROM, domain: D, httpLinksTick: true },
    ...over,
  };
}

describe("the go-live copy of own-mailbox mode", () => {
  it("the dialog item, the ticks, the live line and the guide line", () => {
    expect(GO_LIVE_COPY.dialogOwnMailboxItem(FROM, D)).toBe(
      "Every email shows From contact@example.com and goes out through example.com itself. Replies come only to contact@example.com: the app never sees them.",
    );
    const tick = GO_LIVE_COPY.ownMailboxTick(FROM);
    expect(tick).toBe(
      'I read contact@example.com every working day, its inbox and its Spam folder. When someone answers there, I click They replied on their company, I handle removal requests and "couldn\'t be delivered" notices with Mark unsubscribed, and then I click I\'ve read contact@example.com: live follow-ups wait for that each day.',
    );
    // The replies tick names the inbox check and the Spam folder (O33).
    expect(tick).toContain("its Spam folder");
    expect(tick).toContain("I've read contact@example.com");
    expect(GO_LIVE_COPY.ownMailboxRequired).toBe("Tick the box about replies in your own mailbox first.");
    expect(GO_LIVE_COPY.httpLinksTick).toBe(
      "I know unsubscribe links use http on my Mailgun plan, so Gmail's and Yahoo's one-click unsubscribe button may not show.",
    );
    expect(GO_LIVE_COPY.httpLinksRequired).toBe("Tick the box about unsubscribe links first.");
    expect(GO_LIVE_COPY.liveOwnFromLine(FROM)).toBe("Emails show From contact@example.com; replies go straight to that mailbox.");
    expect(GO_LIVE_COPY.guideLineOwn).toBe("Step by step: Own-mailbox guide, step 11.");
  });

  it("goLiveDialogItems: the own-mailbox item takes the From item's place", () => {
    const base = { capOverrideToday: null, drafts: { items: [], more: 0 }, warmup: FREE_WARMUP };
    const plain = goLiveDialogItems(base);
    const own = goLiveDialogItems({ ...base, from: { team: { from: FROM, org: D }, ownExample: "x <a@b.example>", ownMailbox: { from: FROM, domain: D } } });
    expect(own).toEqual([...plain.slice(0, 2), GO_LIVE_COPY.dialogOwnMailboxItem(FROM, D), ...plain.slice(2)]);
    expect(goLiveDialogItems({ ...base, from: { team: null, ownExample: null, ownMailbox: null } })).toEqual(plain);
  });
});

describe("goLiveCardView in own-mailbox mode", () => {
  it("ready: the own-mailbox item, both ticks, the own guide line; the warm-up item ends at 90 on Free", () => {
    const card = goLiveCardView(view(), { timeZone: TZ, warmup: FREE_WARMUP });
    expect(card.state).toBe("ready");
    expect(card.guideLine).toBe(GO_LIVE_COPY.guideLineOwn);
    expect(card.dialogItems[1]).toBe(goLiveWarmupItem(FREE_WARMUP));
    expect(card.dialogItems[1]).toBe(
      "Warm-up starts today: the daily limit starts at 50 and goes up one step after each weekday with at least half the limit used and healthy numbers, to 90 in about 4 weeks.",
    );
    expect(card.dialogItems.join(" ")).not.toContain("1,000");
    expect(card.dialogItems[2]).toBe(GO_LIVE_COPY.dialogOwnMailboxItem(FROM, D));
    expect(card.dialogItems).toHaveLength(7);
    expect(card.ownMailboxTick).toBe(GO_LIVE_COPY.ownMailboxTick(FROM));
    expect(card.httpLinksTick).toBe(GO_LIVE_COPY.httpLinksTick);
    expect(card).not.toHaveProperty("spamPlacementTick");
    expect(card).not.toHaveProperty("fromLine");
  });

  it("the http-links tick only while the https-links row isn't ok; the spam tick as today", () => {
    const https = goLiveCardView(view({ ownMailbox: { from: FROM, domain: D, httpLinksTick: false } }), { timeZone: TZ, warmup: FREE_WARMUP });
    expect(https).not.toHaveProperty("httpLinksTick");
    expect(https.ownMailboxTick).toBe(GO_LIVE_COPY.ownMailboxTick(FROM));
    const spam = goLiveCardView(view({ spamPlacements: ["Outlook.com (t.outlook@outlook.com)"] }), { timeZone: TZ, warmup: FREE_WARMUP });
    expect(spam.spamPlacementTick).toBe(GO_LIVE_COPY.spamPlacementTick("Outlook.com (t.outlook@outlook.com)"));
  });

  it("blocked: no dialog items and no ticks, the own guide line", () => {
    const card = goLiveCardView(view({ blockers: ["The reply test hasn't passed yet."] }), { timeZone: TZ, warmup: FREE_WARMUP });
    expect(card).toMatchObject({ state: "blocked", guideLine: GO_LIVE_COPY.guideLineOwn, dialogItems: [] });
    expect(card).not.toHaveProperty("ownMailboxTick");
    expect(card).not.toHaveProperty("httpLinksTick");
    const out = text(renderToStaticMarkup(createElement(GoLiveCard, { view: card })));
    expect(out).toContain("Step by step: Own-mailbox guide, step 11.");
    expect(out).not.toContain("Going-live guide");
  });

  it("live: the own From line under the live line, drawn by the card", () => {
    const at = new Date("2026-09-28T09:05:00Z");
    const card = goLiveCardView(view({ live: true, at, byName: "Arslan" }), { timeZone: TZ, warmup: FREE_WARMUP });
    expect(card).toMatchObject({
      state: "live",
      description: `Live on example.com since ${formatDateTime(at, TZ)} (switched on by Arslan). New live campaigns email everyone eligible.`,
      fromLine: "Emails show From contact@example.com; replies go straight to that mailbox.",
      guideLine: null,
    });
    const out = text(renderToStaticMarkup(createElement(GoLiveCard, { view: card })));
    expect(out).toContain("Emails show From contact@example.com; replies go straight to that mailbox.");
    expect(out.indexOf("Emails show From")).toBeLessThan(out.indexOf("This can't be switched off."));
    expect(out).not.toContain("each sender's own address");
  });

  it("not live after the own From changed on the same domain: 'You were live with …'", () => {
    const card = goLiveCardView(view({ endedOnFrom: { was: "info@example.com" }, blockers: ["x"] }), { timeZone: TZ, warmup: FREE_WARMUP });
    expect(card.description).toBe(GO_LIVE_COPY.descriptionAfterFromChange("info@example.com", FROM));
  });

  it("the dialog's tick boxes draw both ticks", () => {
    for (const label of [GO_LIVE_COPY.ownMailboxTick(FROM), GO_LIVE_COPY.httpLinksTick]) {
      const out = renderToStaticMarkup(createElement(DialogTick, { id: "t", label, checked: false, onChange: () => undefined }));
      expect(out).toContain('role="checkbox"');
      expect(out).toContain('aria-checked="false"');
      expect(text(out)).toContain(label);
    }
  });
});

describe("app mode is unchanged (no ownMailbox field)", () => {
  it("the same card as before", () => {
    const app = view({ ownMailbox: undefined, domain: "send.example.com", ownFromExample: "Arslan <arslan@send.example.com>" });
    const card = goLiveCardView(app, { timeZone: TZ, warmup: { startCap: 50, maxCap: 1000, steps: 20 } });
    expect(card.guideLine).toBe(GO_LIVE_COPY.guideLine);
    expect(card.dialogItems[2]).toBe(GO_LIVE_COPY.dialogOwnFromItem("Arslan <arslan@send.example.com>"));
    expect(card).not.toHaveProperty("ownMailboxTick");
    expect(card).not.toHaveProperty("httpLinksTick");
    const live = goLiveCardView({ ...app, live: true, from: FROM }, { timeZone: TZ, warmup: FREE_WARMUP });
    expect(live.fromLine).toBe(GO_LIVE_COPY.liveFromLine(FROM));
    const nullField = goLiveCardView(view({ ownMailbox: null }), { timeZone: TZ, warmup: FREE_WARMUP });
    expect(nullField.guideLine).toBe(GO_LIVE_COPY.guideLine);
  });
});
