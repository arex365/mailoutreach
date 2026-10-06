import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TEAM_FROM_TEXTS } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import type { FromAddressView } from "@/components/settings/types";
import { phoneWidthProblems } from "../shell/truncate-chain";

// The card's form calls a Server Action; nothing here calls it while rendering.
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/(app)/settings/sending/actions", () => ({ saveFromAddressAction: vi.fn() }));

const { FromAddressCard, fromAddressFormState } = await import("@/components/settings/sending/from-address-card");

/**
 * Settings › Sending & Mailgun › From address (SHARED-FROM-DESIGN §3.1) in each of its states: the practice copy, not
 * connected, empty, saved (with "Good to know"), and saved but no longer fitting the sending domain. The words come from
 * TEAM_FROM_TEXTS; the order is field → hint → Save → risk note → "Good to know"; the Save button stays outline.
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

function view(over: Partial<FromAddressView> = {}): FromAddressView {
  return {
    practiceCopy: false,
    connected: true,
    sendingDomain: "mail.polygonparadise.com",
    mainDomain: "polygonparadise.com",
    saved: null,
    problem: null,
    goLive: false,
    ownerDisplayName: "Arslan from Polygon Paradise",
    testList: ["tess@outlook.com", "gina.test@gmail.com"],
    ...over,
  };
}

const render = (v: FromAddressView) => renderToStaticMarkup(createElement(FromAddressCard, { view: v }));

/** Positions of the parts in the markup (the order people see them in). */
function order(html: string): string[] {
  return [...html.matchAll(/data-part="([a-z-]+)"/g)].map((m) => m[1]!);
}

describe("the From address card's states", () => {
  it("the practice copy: its sentence instead of the form", () => {
    const html = render(view({ practiceCopy: true }));
    expect(text(html)).toContain(TEAM_FROM_TEXTS.cardTitle);
    expect(text(html)).toContain(TEAM_FROM_TEXTS.cardDescription);
    expect(text(html)).toContain("The practice copy never talks to Mailgun, so there is no From address to set here.");
    expect(html).not.toContain("<form");
  });

  it("not connected: connect Mailgun first", () => {
    const html = render(view({ connected: false, sendingDomain: null, mainDomain: null }));
    expect(text(html)).toContain("Connect Mailgun first: the From address must fit your sending domain.");
    expect(html).not.toContain("<form");
  });

  it("empty: the field with its placeholder and hint, an outline Save, no risk note, no Good to know", () => {
    const html = render(view());
    expect(text(html)).toContain("From address (optional)");
    expect(html).toContain('placeholder="contact@polygonparadise.com"');
    expect(text(html)).toContain(
      `People see "Arslan from Polygon Paradise <contact@polygonparadise.com>": each person's display name with this address. Replies go to each person's own address on mail.polygonparadise.com, and from there to their reply inbox. It must end in @polygonparadise.com.`,
    );
    expect(html).toMatch(/<button[^>]*data-variant="outline"[^>]*>Save From address<\/button>/);
    expect(html).not.toMatch(/data-variant="default"/);
    expect(order(html)).toEqual(["field", "hint", "save"]);
    expect(text(html)).not.toContain("Good to know");
  });

  it("saved: field → hint → Save → risk note → a closed Good to know", () => {
    const html = render(view({ saved: "contact@polygonparadise.com" }));
    expect(order(html)).toEqual(["field", "hint", "save", "risk", "good-to-know"]);
    expect(html).toContain('value="contact@polygonparadise.com"');
    expect(text(html)).toContain(TEAM_FROM_TEXTS.riskNote("polygonparadise.com"));
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>Good to know<\/summary>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    for (const line of TEAM_FROM_TEXTS.goodToKnow("contact@polygonparadise.com", "polygonparadise.com", "mail.polygonparadise.com")) {
      expect(text(html)).toContain(line);
    }
    expect(text(html)).toContain("Never point polygonparadise.com's mail servers (MX) to Mailgun, and never forward contact@polygonparadise.com to an address on mail.polygonparadise.com.");
    expect(text(html)).not.toContain(TEAM_FROM_TEXTS.misfitHere("contact@polygonparadise.com", "mail.polygonparadise.com"));
  });

  it("saved but no longer fitting: the misfit line above the field, in the destructive colour", () => {
    const problem = TEAM_FROM_TEXTS.misfitHere("contact@polygonparadise.com", "send.other.test");
    const html = render(
      view({ sendingDomain: "send.other.test", mainDomain: "other.test", saved: "contact@polygonparadise.com", problem }),
    );
    expect(order(html)).toEqual(["misfit", "field", "hint", "save", "risk", "good-to-know"]);
    expect(html).toMatch(/<p class="[^"]*text-destructive[^"]*"[^>]*data-part="misfit"/);
    expect(text(html)).toContain(
      "The saved From address contact@polygonparadise.com doesn't fit your sending domain send.other.test, so test and live campaigns can't start. Change it or clear it below.",
    );
  });

  it("fits a phone: one grid-cols-1 column, long addresses wrap anywhere", () => {
    for (const v of [view(), view({ saved: "a.very.long.shared.address.for.outreach@polygonparadise.com" })]) {
      const html = render(v);
      expect(phoneWidthProblems(html)).toEqual([]);
      expect(html).toMatch(/<form[^>]*class="grid grid-cols-1 gap-4"/);
      expect(html).toContain("[overflow-wrap:anywhere]");
    }
  });
});

describe("what the form shows for what is typed", () => {
  it("the hint names a valid typed address (not contact@), else the saved one, else the placeholder", () => {
    expect(fromAddressFormState(view(), "hello@polygonparadise.com").hint).toContain('"Arslan from Polygon Paradise <hello@polygonparadise.com>"');
    expect(fromAddressFormState(view({ saved: "info@polygonparadise.com" }), "hel").hint).toContain("<info@polygonparadise.com>");
    expect(fromAddressFormState(view(), "").hint).toContain("<contact@polygonparadise.com>");
    // The example.com shape of the tests, with a typed address.
    const ex = view({ sendingDomain: "send.example.com", mainDomain: "example.com" });
    const s = fromAddressFormState(ex, "Hello@Example.com");
    expect(s).toMatchObject({ next: "hello@example.com", error: null, showRisk: true, riskOrg: "example.com" });
    expect(s.hint).toContain("<hello@example.com>");
    expect(s.hint).not.toContain("contact@");
  });

  it("checks with the server's rules as you type, and refuses a test-list mailbox", () => {
    expect(fromAddressFormState(view(), "arslan@mail.polygonparadise.com").error).toBe(
      TEAM_FROM_TEXTS.onSendingDomain("mail.polygonparadise.com", "polygonparadise.com"),
    );
    expect(fromAddressFormState(view(), "noreply@polygonparadise.com").error).toBe(TEAM_FROM_TEXTS.reserved("noreply", "contact@polygonparadise.com"));
    expect(fromAddressFormState(view({ testList: ["contact@polygonparadise.com"] }), "contact@polygonparadise.com").error).toBe(
      TEAM_FROM_TEXTS.onTestList("contact@polygonparadise.com"),
    );
    expect(fromAddressFormState(view(), "")).toMatchObject({ next: null, error: null, showRisk: false });
    expect(fromAddressFormState(view({ saved: "contact@polygonparadise.com" }), "").showRisk).toBe(true);
  });

  it("a sending domain that isn't a subdomain: the hint says what to do instead", () => {
    const s = fromAddressFormState(view({ sendingDomain: "send-studio.com", mainDomain: null }), "");
    expect(s.hint).toBe(TEAM_FROM_TEXTS.noSubdomain("send-studio.com"));
  });
});

/**
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.2): the own From on the sending domain itself. Same order and layout as the
 * shared-From card; its own description, label (no "(optional)"), hint, "nothing saved" line and "Good to know" list.
 */
describe("the From address card in own-mailbox mode", () => {
  const own = (over: Partial<FromAddressView> = {}) =>
    view({ replies: "own-mailbox", sendingDomain: "polygonparadise.com", mainDomain: null, ...over });

  it("nothing saved: the description, the missing line above the field, the own hint and placeholder, no (optional)", () => {
    const html = render(own());
    const t = text(html);
    expect(t).toContain("From address");
    expect(t).toContain(OWN_MAILBOX_TEXTS.cardDescription);
    expect(t).toContain("The address every campaign email comes from. Replies go straight to this mailbox.");
    expect(t).not.toContain(TEAM_FROM_TEXTS.cardDescription);
    expect(t).not.toContain("(optional)");
    expect(html).toContain('placeholder="contact@polygonparadise.com"');
    expect(t).toContain(
      "Type the address your emails come from, for example contact@polygonparadise.com. Test and live campaigns can't start without it.",
    );
    expect(html).toMatch(/<p class="[^"]*text-destructive[^"]*"[^>]*data-part="missing"/);
    expect(t).toContain(
      `People see "Arslan from Polygon Paradise <contact@polygonparadise.com>": each person's display name with this address. Replies go straight to this mailbox, not through the app. It must end in @polygonparadise.com.`,
    );
    expect(order(html)).toEqual(["missing", "field", "hint", "save"]);
    expect(html).toMatch(/<button[^>]*data-variant="outline"[^>]*>Save From address<\/button>/);
    expect(html).not.toMatch(/data-variant="default"/);
    expect(t).not.toContain("Good to know");
  });

  it("saved: field → hint → Save → risk note (the sending domain) → the own Good to know list", () => {
    const html = render(own({ saved: "contact@polygonparadise.com" }));
    const t = text(html);
    expect(order(html)).toEqual(["field", "hint", "save", "risk", "good-to-know"]);
    expect(t).toContain(TEAM_FROM_TEXTS.riskNote("polygonparadise.com"));
    expect(html).not.toMatch(/<details[^>]* open/);
    for (const line of OWN_MAILBOX_TEXTS.goodToKnow("contact@polygonparadise.com", "polygonparadise.com")) {
      expect(t).toContain(line);
    }
    expect(t).toContain(
      "Never add Mailgun's MX records to polygonparadise.com and never point its mail servers (MX) to Mailgun: your everyday email and every reply would stop arriving.",
    );
    expect(t).toContain("click I've read contact@polygonparadise.com on the Notifications page");
    // Nothing of the shared-From card's reply wording.
    expect(t).not.toContain("reply address");
    expect(t).not.toContain("each person's own address on");
  });

  it("saved but no longer on the sending domain: the own misfit line", () => {
    const problem = OWN_MAILBOX_TEXTS.misfitHere("contact@other.test", "polygonparadise.com");
    const html = render(own({ saved: "contact@other.test", problem }));
    expect(order(html)).toEqual(["misfit", "field", "hint", "save", "risk", "good-to-know"]);
    expect(text(html)).toContain(
      "The saved From address contact@other.test isn't on your sending domain polygonparadise.com, so test and live campaigns can't start. Change it below.",
    );
  });

  it("checks as you type with the own-mailbox rules", () => {
    const v = own();
    expect(fromAddressFormState(v, "Contact@PolygonParadise.com")).toMatchObject({
      next: "contact@polygonparadise.com",
      error: null,
      showRisk: true,
      riskOrg: "polygonparadise.com",
    });
    expect(fromAddressFormState(v, "info@polygonparadise.com").hint).toContain("<info@polygonparadise.com>");
    expect(fromAddressFormState(v, "contact@mail.polygonparadise.com").error).toBe(OWN_MAILBOX_TEXTS.fromWrongDomain("polygonparadise.com"));
    expect(fromAddressFormState(v, "contact@gmail.com").error).toBe(OWN_MAILBOX_TEXTS.fromWrongDomain("polygonparadise.com"));
    expect(fromAddressFormState(v, "noreply@polygonparadise.com").error).toBe(
      TEAM_FROM_TEXTS.reserved("noreply", "contact@polygonparadise.com"),
    );
    expect(fromAddressFormState(own({ testList: ["contact@polygonparadise.com"] }), "contact@polygonparadise.com").error).toBe(
      TEAM_FROM_TEXTS.onTestList("contact@polygonparadise.com"),
    );
    expect(fromAddressFormState(v, "")).toMatchObject({ next: null, error: null, showRisk: false });
    expect(fromAddressFormState(v, "").hint).toContain("<contact@polygonparadise.com>");
  });

  it("an app view with replies set to app reads exactly like one without it", () => {
    for (const v of [view(), view({ saved: "contact@polygonparadise.com" })]) {
      expect(render({ ...v, replies: "app" })).toBe(render(v));
    }
  });

  it("fits a phone", () => {
    for (const v of [own(), own({ saved: "a.very.long.own.from.address.for.outreach@polygonparadise.com" })]) {
      const html = render(v);
      expect(phoneWidthProblems(html)).toEqual([]);
      expect(html).toMatch(/<form[^>]*class="grid grid-cols-1 gap-4"/);
      expect(html).toContain("[overflow-wrap:anywhere]");
    }
  });
});

describe("the Owner's display name in the card", () => {
  it("falls back to the suggested sender name when the profile has none", async () => {
    const { fromAddressView } = await import("@/app/(app)/settings/sending/load");
    const app = { replies: "app" as const, ownFrom: null, evidenceFrom: null };
    const team = { address: null, saved: null, domain: "mail.polygonparadise.com", problem: null, changedAt: null, ...app };
    const ctx = { practiceCopy: false, goLive: false, testList: [] as string[] };
    expect(fromAddressView(team, { ...ctx, owner: { name: "Arslan Mahmood", senderDisplayName: null } }).ownerDisplayName).toBe(
      "Arslan from Polygon Paradise",
    );
    expect(fromAddressView(team, { ...ctx, owner: { name: "Arslan Mahmood", senderDisplayName: "Arslan at PP" } }).ownerDisplayName).toBe("Arslan at PP");
    expect(fromAddressView(team, { ...ctx, owner: { name: "Arslan", senderDisplayName: null } })).toMatchObject({
      connected: true,
      sendingDomain: "mail.polygonparadise.com",
      mainDomain: "polygonparadise.com",
      saved: null,
      problem: null,
    });
    const misfit = fromAddressView(
      { address: null, saved: "contact@polygonparadise.com", domain: "send.other.test", problem: "x", changedAt: null, ...app },
      { ...ctx, owner: null },
    );
    expect(misfit.problem).toBe(TEAM_FROM_TEXTS.misfitHere("contact@polygonparadise.com", "send.other.test"));
    expect(fromAddressView({ address: null, saved: null, domain: null, problem: null, changedAt: null, ...app }, { ...ctx, owner: null }).connected).toBe(false);
    expect(fromAddressView(team, { ...ctx, owner: null }).replies).toBe("app");
  });

  it("own-mailbox mode: the view carries the mode and the own misfit sentence (MAIN-DOMAIN-DESIGN §3.2)", async () => {
    const { fromAddressView } = await import("@/app/(app)/settings/sending/load");
    const ctx = { practiceCopy: false, goLive: false, testList: [] as string[], owner: null };
    const base = { address: null, domain: "polygonparadise.com", changedAt: null, replies: "own-mailbox" as const, evidenceFrom: null };
    const fits = fromAddressView({ ...base, saved: "contact@polygonparadise.com", problem: null, ownFrom: "contact@polygonparadise.com" }, ctx);
    expect(fits).toMatchObject({ replies: "own-mailbox", sendingDomain: "polygonparadise.com", mainDomain: null, problem: null });
    const misfit = fromAddressView(
      { ...base, saved: "contact@other.test", problem: OWN_MAILBOX_TEXTS.misfit("contact@other.test", "polygonparadise.com"), ownFrom: null },
      ctx,
    );
    expect(misfit.problem).toBe(OWN_MAILBOX_TEXTS.misfitHere("contact@other.test", "polygonparadise.com"));
    // Nothing saved: no misfit sentence (the card says what to type instead).
    const missing = fromAddressView({ ...base, saved: null, problem: OWN_MAILBOX_TEXTS.fromMissing("polygonparadise.com"), ownFrom: null }, ctx);
    expect(missing.problem).toBeNull();
  });
});
