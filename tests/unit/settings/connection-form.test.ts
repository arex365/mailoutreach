import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MAILGUN_PLAN_FACTS, PLAN_TEXTS } from "@/core/mailgun/plan";
import { SENDING_DOMAIN_TEXTS } from "@/core/sender-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import type { ConnectionView } from "@/components/settings/types";
import { phoneWidthProblems } from "../shell/truncate-chain";

// The form calls Server Actions; nothing here calls them while rendering.
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/(app)/settings/sending/actions", () => ({
  connectMailgunAction: vi.fn(),
  forgetMailgunKeysAction: vi.fn(),
  removeSendingKeyAction: vi.fn(),
  saveRetentionAction: vi.fn(),
}));

const { ConnectionForm, connectionDomainState, advancedShown, advancedSavedKey } = await import("@/components/settings/sending/connection-form");

/**
 * Settings › Sending & Mailgun › Mailgun connection (MAIN-DOMAIN-DESIGN §3.1): the "How the app sends" choice with its
 * two options and hints, the domain hint and placeholder of the chosen mode, the one-click switch under the website
 * sentence, "Your Mailgun plan" (first line of Advanced) with the assumed-Free line, and the new retention hint. In app
 * mode everything else reads exactly as before (§0.2 rule 4).
 */

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** Orange buttons (only the page's primary action is orange). */
const ORANGE = /data-variant="default"/g;

function view(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    connected: true,
    statusLine: "Connected to mail.polygonparadise.com (US) · key ending …1a2b · checked 2 minutes ago",
    region: "US",
    domain: "mail.polygonparadise.com",
    keyLast4: "1a2b",
    hasSendingKey: false,
    logRetentionDays: 5,
    messageRetentionDays: 1,
    primary: false,
    ...over,
  };
}

const render = (v: ConnectionView) => renderToStaticMarkup(createElement(ConnectionForm, { view: v }));

/** The radio items' ids and whether each is checked. */
function radios(html: string): Array<{ id: string; checked: boolean }> {
  return [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => ({
    id: /id="([^"]+)"/.exec(m[0])?.[1] ?? "",
    checked: /aria-checked="true"/.test(m[0]),
  }));
}

describe("How the app sends", () => {
  it("both options with their hints, the subdomain one chosen for an app view", () => {
    const html = render(view());
    const t = text(html);
    expect(t).toContain("How the app sends");
    expect(t).toContain(
      "Through a sending subdomain (replies come through the app) For example mail.polygonparadise.com. Replies are recorded, stop follow-ups by themselves and are forwarded to your inbox. Needs Mailgun's Foundation plan (Mailgun guide).",
    );
    expect(t).toContain(
      "From polygonparadise.com itself (replies come to your own inbox) Every email comes from your own address, such as contact@polygonparadise.com. Replies land in that inbox, and you mark them in the app with They replied. Works on Mailgun's Free plan (Own-mailbox guide).",
    );
    expect(radios(html).filter((r) => r.id.startsWith("replies-"))).toEqual([
      { id: "replies-app", checked: true },
      { id: "replies-own-mailbox", checked: false },
    ]);
    // Keyboard reachable: each option has its label and its hint.
    expect(html).toContain('for="replies-app"');
    expect(html).toContain('for="replies-own-mailbox"');
    expect(html).toContain('aria-describedby="replies-own-mailbox-hint"');
    // Region, then How the app sends, then the sending domain.
    expect(t.indexOf("Region")).toBeLessThan(t.indexOf("How the app sends"));
    expect(t.indexOf("How the app sends")).toBeLessThan(t.indexOf("Sending domain"));
    expect(t).not.toContain(OWN_MAILBOX_TEXTS.switchNote);
  });

  it("an own-mailbox view: that option chosen, the own domain hint and placeholder", () => {
    const html = render(
      view({ replies: "own-mailbox", domain: "polygonparadise.com", statusLine: "Connected to polygonparadise.com (US) · replies go to your own mailbox" }),
    );
    expect(radios(html).filter((r) => r.id.startsWith("replies-"))).toEqual([
      { id: "replies-app", checked: false },
      { id: "replies-own-mailbox", checked: true },
    ]);
    const t = text(html);
    expect(t).toContain("Your own domain, exactly as Mailgun shows it, for example polygonparadise.com.");
    expect(html).toContain('placeholder="polygonparadise.com"');
    expect(html).toContain('value="polygonparadise.com"');
    expect(t).not.toContain(SENDING_DOMAIN_TEXTS.website);
    expect(html).not.toContain('data-part="website-switch"');
    expect(t).toContain("Connected to polygonparadise.com (US) · replies go to your own mailbox");
  });

  it("the website domain typed under the subdomain option: its sentence and the one-click switch, never for mail.", () => {
    const html = render(view({ domain: "polygonparadise.com", connected: false, keyLast4: null, primary: true, statusLine: "Not connected yet." }));
    const t = text(html);
    expect(t).toContain(SENDING_DOMAIN_TEXTS.website);
    const button = /<button[^>]*data-part="website-switch"[^>]*>([^<]*)<\/button>/.exec(html);
    expect(button?.[1]).toBe("Use From polygonparadise.com itself");
    expect(button?.[0]).toContain('data-variant="outline"');
    expect(button?.[0]).toContain('type="button"');
    // "Save and connect" stays the one orange button.
    expect(html.match(ORANGE)?.length).toBe(1);
    expect(render(view()).includes('data-part="website-switch"')).toBe(false);
    expect(render(view({ domain: "www.polygonparadise.com" })).includes('data-part="website-switch"')).toBe(false);
  });

  it("the domain check follows the chosen mode, and only speaks up once the field was left (the website at once)", () => {
    expect(connectionDomainState("polygonparadise.com", "app", false)).toMatchObject({
      valid: false,
      error: SENDING_DOMAIN_TEXTS.website,
      websiteSwitch: true,
    });
    expect(connectionDomainState("https://PolygonParadise.com/", "app", false).websiteSwitch).toBe(true);
    expect(connectionDomainState("polygonparadise.com", "own-mailbox", false)).toMatchObject({ valid: true, error: null, websiteSwitch: false });
    expect(connectionDomainState("", "own-mailbox", false)).toMatchObject({ valid: false, error: null });
    expect(connectionDomainState("", "own-mailbox", true).error).toBe(SENDING_DOMAIN_TEXTS.emptyOwn);
    expect(connectionDomainState("", "app", true).error).toBe(SENDING_DOMAIN_TEXTS.empty);
    expect(connectionDomainState("sandbox1.mailgun.org", "own-mailbox", true).error).toBe(SENDING_DOMAIN_TEXTS.sandboxOwn);
    expect(connectionDomainState("www.polygonparadise.com", "own-mailbox", true).error).toBe(SENDING_DOMAIN_TEXTS.www);
    expect(connectionDomainState("mail.polygonparadise.com", "app", true)).toMatchObject({
      valid: true,
      error: null,
      hint: "Exactly as Mailgun shows it, for example mail.polygonparadise.com.",
      placeholder: "mail.polygonparadise.com",
    });
  });
});

describe("Your Mailgun plan (Advanced)", () => {
  it("the first line of Advanced, with its hint; a chosen plan shows its label", () => {
    const html = render(view({ plan: "free" }));
    const t = text(html);
    const advanced = t.slice(t.indexOf("Advanced"));
    expect(advanced.indexOf(PLAN_TEXTS.planLabel)).toBeGreaterThan(0);
    expect(advanced.indexOf(PLAN_TEXTS.planLabel)).toBeLessThan(advanced.indexOf("Domain sending key (optional)"));
    expect(t).toContain("Free (100 emails a day)");
    expect(t).toContain(PLAN_TEXTS.planHint);
    expect(html).toContain('id="mg-plan"');
    expect(html).toContain('for="mg-plan"');
    expect(t).not.toContain(PLAN_TEXTS.assumedFree);
    expect(MAILGUN_PLAN_FACTS.free.label).toBe("Free (100 emails a day)");
  });

  it("Not sure in own-mailbox mode: the assumed Free plan line; Not sure in app mode: no such line", () => {
    const own = text(render(view({ replies: "own-mailbox", plan: null, planAssumed: true })));
    expect(own).toContain("Not sure");
    expect(own).toContain("Not chosen yet: the app keeps to the Free plan's limits (100 emails a day, 1 day of logs).");
    const app = text(render(view({ plan: null })));
    expect(app).toContain("Not sure");
    expect(app).not.toContain(PLAN_TEXTS.assumedFree);
  });

  it("review SCREENS-05: Advanced shows the saved plan and days, also after a connect or a save changed them", () => {
    // Before the first own-mailbox connect: Not sure, 5 and 1 days.
    const before = { plan: null, logRetentionDays: 5, messageRetentionDays: 1 };
    expect(advancedShown(before, null)).toEqual({ plan: null, logDays: "5", messageDays: "1" });
    // The Owner typed in Advanced, then Save and connect wrote the Free plan with 1 and 1 days (O22): the saved values
    // win, because the typing was over values that aren't saved any more.
    const typed = { plan: null, logDays: "3", messageDays: "1", over: advancedSavedKey(before) };
    expect(advancedShown(before, typed)).toEqual({ plan: null, logDays: "3", messageDays: "1" });
    const after = { plan: "free" as const, logRetentionDays: 1, messageRetentionDays: 1 };
    expect(advancedShown(after, typed)).toEqual({ plan: "free", logDays: "1", messageDays: "1" });
    // Typing over the values saved now is shown as typed.
    const retyped = { plan: "foundation" as const, logDays: "5", messageDays: "1", over: advancedSavedKey(after) };
    expect(advancedShown(after, retyped)).toEqual({ plan: "foundation", logDays: "5", messageDays: "1" });
    expect(advancedSavedKey(after)).not.toBe(advancedSavedKey(before));

    // What the page renders right after the first own-mailbox connect: Free, 1 and 1, and no "Not chosen yet" line.
    const html = render(view({ replies: "own-mailbox", domain: "polygonparadise.com", plan: "free", logRetentionDays: 1, messageRetentionDays: 1 }));
    const t = text(html);
    expect(t).toContain("Free (100 emails a day)");
    expect(t).not.toContain(PLAN_TEXTS.assumedFree);
    expect(html).toMatch(/aria-label="Days of event logs"[^>]*value="1"|value="1"[^>]*aria-label="Days of event logs"/);
    expect(html).toMatch(/aria-label="Days of stored replies"[^>]*value="1"|value="1"[^>]*aria-label="Days of stored replies"/);
  });

  it("the retention hint names every plan's numbers (every mode); the numbers and Save these numbers stay", () => {
    for (const v of [view(), view({ replies: "own-mailbox", domain: "polygonparadise.com" })]) {
      const t = text(render(v));
      expect(t).toContain(
        "Mailgun's plans keep event logs for 1 day (Free, Basic), 5 days (Foundation) or 30 days (Scale), and stored replies for 1 day. Choosing your plan fills these in.",
      );
      expect(t).not.toContain("Foundation keeps 5 days of logs and 1 day of stored replies.");
      expect(t).toContain("Your Mailgun plan keeps event logs for");
      expect(t).toContain("Save these numbers");
    }
  });
});

describe("app mode reads as before", () => {
  it("apart from the two new controls and the retention hint, the texts are today's", () => {
    const t = text(render(view({ connected: false, keyLast4: null, primary: true, statusLine: "Not connected yet.", domain: "" })));
    for (const s of [
      "Not connected yet.",
      "Region",
      "The region you chose when you added the domain in Mailgun. It can't be changed there later.",
      "Sending domain",
      "Exactly as Mailgun shows it, for example mail.polygonparadise.com.",
      "API key",
      "A key with the Developer role, from Mailgun › API Security. Stored encrypted and never shown again.",
      "Advanced",
      "Domain sending key (optional)",
      "Only used to send emails. Leave empty to send with the API key above.",
      "Save and connect",
    ]) {
      expect(t).toContain(s);
    }
    // No error shows before anything was typed, and nothing from own-mailbox mode leaks in.
    expect(t).not.toContain(SENDING_DOMAIN_TEXTS.empty);
    expect(t).not.toContain(OWN_MAILBOX_TEXTS.domainHint);
    expect(t).not.toContain(PLAN_TEXTS.assumedFree);
  });

  it("fits a phone", () => {
    for (const v of [view(), view({ replies: "own-mailbox", domain: "polygonparadise.com" }), view({ domain: "polygonparadise.com" })]) {
      const html = render(v);
      expect(phoneWidthProblems(html)).toEqual([]);
      expect(html).toMatch(/<fieldset class="grid grid-cols-1 gap-2" data-part="replies">/);
    }
  });
});
