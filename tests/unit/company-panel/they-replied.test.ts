import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeaderView } from "@/components/company-panel/types";
import type { RecipientDetail } from "@/server/services/campaigns/queries";
import type { MarkRepliedFacts } from "@/server/services/companies/replied-by-hand";
import type { TeamFromState } from "@/server/services/mailgun/team-from";

/**
 * "They replied" on screen (MAIN-DOMAIN-DESIGN O17, §3.8, §8 P6), static markup: the company panel's header button only
 * when the panel sets `markReplied` (never in real per-person mode), with `MailCheck` and the accessible name; the
 * confirm texts for each case; the campaign person panel's button and, in own-mailbox mode, no "Simulate a reply" link.
 */

// Server Actions and server loaders can't load outside Next; nothing here calls them.
vi.mock("@/components/company-panel/actions", () => ({
  deleteCompanyAction: vi.fn(),
  markRepliedAction: vi.fn(),
  renameCompanyAction: vi.fn(),
  restoreCompanyAction: vi.fn(),
  setCompanyPriorityAction: vi.fn(),
  setCompanyStatusAction: vi.fn(),
}));
vi.mock("@/app/(app)/campaigns/[id]/actions", () => ({
  discardUnsentEditAction: vi.fn(),
  editUnsentEmailAction: vi.fn(),
  retryEmailAction: vi.fn(),
  skipRecipientAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/campaigns/4",
}));
const loaders = vi.hoisted(() => ({
  detail: null as unknown,
  team: null as unknown,
  facts: null as unknown,
}));
vi.mock("@/server/services/campaigns/queries", () => ({ getRecipientDetail: async () => loaders.detail }));
vi.mock("@/server/services/mailgun/team-from", () => ({ loadTeamFrom: async () => loaders.team }));
vi.mock("@/server/services/companies/replied-by-hand", () => ({ loadMarkRepliedFacts: async () => loaders.facts }));
vi.mock("@/server/services/render", () => ({ RenderError: class RenderError extends Error {}, renderCampaignEmails: async () => [] }));
vi.mock("@/server/services/templates", () => ({ templateVariables: async () => [] }));

const { CompanyHeader } = await import("@/components/company-panel/company-header");
const { theyRepliedConfirm } = await import("@/components/company-panel/types");
const { MarkRepliedButton } = await import("@/components/campaigns/recipient-actions");
const { RecipientPanel } = await import("@/components/campaigns/recipient-panel");
const { THEY_REPLIED_TEXTS } = await import("@/core/sending/own-mailbox");

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

function header(overrides: Partial<HeaderView> = {}): HeaderView {
  return {
    companyId: 3,
    code: "C-3",
    name: "Acme Studio",
    website: null,
    countryName: "Germany",
    localTime: null,
    status: "CONTACTED",
    priority: "NORMAL",
    deleted: false,
    markReplied: null,
    ...overrides,
  };
}

function team(overrides: Partial<TeamFromState> = {}): TeamFromState {
  return {
    address: null,
    saved: "contact@example.com",
    domain: "example.com",
    problem: null,
    changedAt: null,
    replies: "own-mailbox",
    ownFrom: "contact@example.com",
    evidenceFrom: "contact@example.com",
    ...overrides,
  };
}

function detail(mode: "DRY_RUN" | "TEST" | "LIVE"): RecipientDetail {
  const at = new Date("2026-09-25T10:00:00.000Z");
  return {
    id: 12,
    campaignId: 4,
    state: "FINISHED",
    included: true,
    currentStep: 0,
    nextDueAt: null,
    stopReason: null,
    holdReason: null,
    recheckAt: null,
    exclusionReason: null,
    hasEdits: false,
    person: { id: 7, name: "Anna Berg", displayName: "Anna Berg", email: "anna@acme.example", isGeneric: false, deleted: false },
    company: { id: 3, name: "Acme Studio", deleted: false },
    emails: [
      {
        id: 50,
        step: 0,
        status: "SENT",
        dueAt: at,
        sentAt: at,
        lastError: null,
        subject: "Hi",
        text: "Hello",
        toEmail: "anna@acme.example",
        fromAddress: "contact@example.com",
        mode,
        messageId: "pp.x@example.com",
        attempts: 1,
        providerId: null,
        failureDetail: null,
      },
    ],
    steps: [{ step: 0, enabled: true, delayDays: 0, subject: "Hi", body: "Hello", edit: null }],
    activity: [],
  };
}

async function panel(mode: "DRY_RUN" | "TEST" | "LIVE"): Promise<string> {
  loaders.detail = detail(mode);
  const el = await RecipientPanel({
    campaign: { id: 4, name: "Germany Q4", status: "RUNNING", mode, daysAsMinutes: false },
    recipientId: 12,
    timeZone: "Europe/Berlin",
  });
  return html(el);
}

const FACTS: MarkRepliedFacts = { countsAsReply: true, status: "CONTACTED", practiceCopy: false, replies: "own-mailbox" };

beforeEach(() => {
  loaders.team = team();
  loaders.facts = FACTS;
});

describe("the company panel's They replied button", () => {
  it("shows only when the panel sets markReplied, with MailCheck and the accessible name", () => {
    const off = html(createElement(CompanyHeader, { view: header() }));
    expect(off).not.toContain(THEY_REPLIED_TEXTS.button);
    expect(off).not.toContain("lucide-mail-check");

    const on = html(createElement(CompanyHeader, { view: header({ markReplied: { countsAsReply: true } }) }));
    expect(on).toContain(`>${THEY_REPLIED_TEXTS.button}</button>`);
    expect(on).toContain("lucide-mail-check");
    // Never the simulate link's icon.
    expect(on).not.toContain("lucide-message-square-reply");
    // Next to the status picker, before the priority picker.
    expect(on.indexOf('aria-label="Status"')).toBeLessThan(on.indexOf(THEY_REPLIED_TEXTS.button));
    expect(on.indexOf(THEY_REPLIED_TEXTS.button)).toBeLessThan(on.indexOf('aria-label="Priority"'));
  });

  it("its accessible name is its visible label; what it does is the description (WCAG 2.5.3, review SCREENS-09)", () => {
    const on = html(createElement(CompanyHeader, { view: header({ markReplied: { countsAsReply: true } }) }));
    const button = /<button[^>]*>(?:(?!<\/button>)[\s\S])*They replied<\/button>/.exec(on)?.[0];
    expect(button, "the They replied button").toBeDefined();
    // No aria-label replaces the visible text "They replied" as the button's name.
    expect(button).not.toContain("aria-label=");
    const describedBy = /aria-describedby="([^"]+)"/.exec(button!)?.[1];
    expect(describedBy, "the button names its description").toBeTruthy();
    // The description is a visually hidden line with the explanation, outside the button (so the name stays the label).
    const description = new RegExp(`<span id="${describedBy!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" class="sr-only">([^<]*)</span>`).exec(on);
    expect(description?.[1]).toBe(THEY_REPLIED_TEXTS.ariaLabel);
    expect(on.indexOf(description![0])).toBeGreaterThan(on.indexOf(button!));
    // The name contains the visible label (here: is it).
    expect(button!.replace(/<[^>]+>/g, "").trim()).toBe(THEY_REPLIED_TEXTS.button);
  });

  it("is never shown for a deleted company", () => {
    expect(html(createElement(CompanyHeader, { view: header({ deleted: true, markReplied: { countsAsReply: true } }) }))).not.toContain(
      THEY_REPLIED_TEXTS.button,
    );
  });
});

describe("the confirm dialog's texts", () => {
  it("says the status becomes Replied for a real reply to a Not contacted or Contacted company", () => {
    for (const status of ["NOT_CONTACTED", "CONTACTED"] as const) {
      expect(theyRepliedConfirm({ company: "Acme Studio", countsAsReply: true, status })).toEqual({
        title: "Mark Acme Studio as replied?",
        body: "Every follow-up to Acme Studio stops, in every campaign, and its status becomes Replied.",
      });
    }
  });

  it("says only the follow-ups stop when the status stays (Replied, Client, Not interested)", () => {
    for (const status of ["REPLIED", "CLIENT", "NOT_INTERESTED"] as const) {
      expect(theyRepliedConfirm({ company: "Acme Studio", countsAsReply: true, status }).body).toBe(
        "Every follow-up to Acme Studio stops, in every campaign.",
      );
    }
  });

  it("says the status stays when the company has only had test emails", () => {
    expect(theyRepliedConfirm({ company: "Acme Studio", countsAsReply: false, status: "NOT_CONTACTED" }).body).toBe(
      "Every follow-up to Acme Studio stops, in every campaign. Its status stays as it is, because it has only had test emails so far.",
    );
  });

  it("names the person in the person panel's variant", () => {
    expect(theyRepliedConfirm({ company: "Acme Studio", person: "Anna Berg", countsAsReply: true, status: "CONTACTED" })).toEqual({
      title: "Mark Anna Berg as replied?",
      body: "Every follow-up to Acme Studio stops, in every campaign, and its status becomes Replied. Anna Berg is noted as the one who replied.",
    });
  });
});

describe("the campaign person panel", () => {
  it("renders the person's They replied button with MailCheck", () => {
    const out = html(
      createElement(MarkRepliedButton, {
        companyId: 3,
        companyName: "Acme Studio",
        personId: 7,
        personName: "Anna Berg",
        status: "CONTACTED",
        countsAsReply: true,
        markReplied: vi.fn(),
      }),
    );
    expect(out).toContain(`>${THEY_REPLIED_TEXTS.button}</button>`);
    expect(out).toContain("lucide-mail-check");
    // Review SCREENS-09 (WCAG 2.5.3), as on the company panel: the name is the visible label, the explanation is the
    // description (a visually hidden line outside the button).
    const button = /<button[^>]*>(?:(?!<\/button>)[\s\S])*They replied<\/button>/.exec(out)?.[0];
    expect(button, "the They replied button").toBeDefined();
    expect(button).not.toContain("aria-label=");
    const describedBy = /aria-describedby="([^"]+)"/.exec(button!)?.[1];
    expect(describedBy, "the button names its description").toBeTruthy();
    const description = new RegExp(`<span id="${describedBy!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" class="sr-only">([^<]*)</span>`).exec(out);
    expect(description?.[1]).toBe(THEY_REPLIED_TEXTS.ariaLabel);
    expect(out.indexOf(description![0])).toBeGreaterThan(out.indexOf(button!));
  });

  it("own-mailbox mode: a live campaign shows They replied; a dry run shows neither They replied nor the simulate link", async () => {
    const live = await panel("LIVE");
    expect(live).toContain(THEY_REPLIED_TEXTS.button);
    expect(live).toContain("lucide-mail-check");

    const dry = await panel("DRY_RUN");
    expect(dry).not.toContain("Simulate a reply in the dry-run outbox");
    expect(dry).not.toContain(THEY_REPLIED_TEXTS.button);
  });

  it("the practice copy: a dry run shows They replied", async () => {
    loaders.team = team({ replies: "app", saved: null, ownFrom: null, evidenceFrom: null });
    loaders.facts = { ...FACTS, practiceCopy: true, replies: "app" };
    const out = await panel("DRY_RUN");
    expect(out).toContain(THEY_REPLIED_TEXTS.button);
    expect(out).toContain("Simulate a reply in the dry-run outbox");
  });

  it("real per-person mode: no They replied (the panel's facts are null), and the dry run's simulate link stays", async () => {
    loaders.team = team({ replies: "app", saved: null, ownFrom: null, evidenceFrom: null });
    loaders.facts = null;
    const dry = await panel("DRY_RUN");
    expect(dry).toContain("Simulate a reply in the dry-run outbox");
    expect(dry).toContain("lucide-message-square-reply");
    expect(dry).not.toContain(THEY_REPLIED_TEXTS.button);
    expect(await panel("LIVE")).not.toContain(THEY_REPLIED_TEXTS.button);
  });
});

describe("who is shown the button (the service's rule)", () => {
  it("own-mailbox mode, shared-From mode and the practice copy; never real per-person mode", async () => {
    const { theyRepliedShown } = await vi.importActual<typeof import("@/server/services/companies/replied-by-hand")>(
      "@/server/services/companies/replied-by-hand",
    );
    expect(theyRepliedShown({ replies: "own-mailbox", address: null }, false)).toBe(true);
    expect(theyRepliedShown({ replies: "app", address: "contact@example.com" }, false)).toBe(true);
    expect(theyRepliedShown({ replies: "app", address: null }, true)).toBe(true);
    expect(theyRepliedShown({ replies: "app", address: null }, false)).toBe(false);
  });
});
