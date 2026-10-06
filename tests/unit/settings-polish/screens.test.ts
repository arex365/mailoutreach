import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChecklistRow } from "@/core/system-state";
import type { TunnelState } from "@/core/system-state";
import type { TeamRow } from "@/components/settings/types";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/settings/limits/actions", () => ({
  saveLimitsAction: vi.fn(),
  setTodayCapAction: vi.fn(),
  clearTodayCapAction: vi.fn(),
  saveSenderCapsAction: vi.fn(),
  saveRulesAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/system/actions", () => ({ checkRemoteAccessAction: vi.fn(), saveAccessChoiceAction: vi.fn() }));
vi.mock("@/app/(app)/settings/team/actions", () => ({
  inviteTeammateAction: vi.fn(),
  makeOwnerAction: vi.fn(),
  newInviteLinkAction: vi.fn(),
  resetPasswordLinkAction: vi.fn(),
  switchOffAction: vi.fn(),
  switchOnAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/domain/actions", () => ({
  applyRecommendedSettingsAction: vi.fn(),
  checkDomainAgainAction: vi.fn(),
  sendReplyTestAction: vi.fn(),
  saveReplyTestAnswersAction: vi.fn(),
  decideReplyTestAction: vi.fn(),
  switchUnsubscribeSetupAction: vi.fn(),
  saveDomainAgeAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/deliverability/actions", () => ({
  saveHealthThresholdsAction: vi.fn(),
  addSuppressionAction: vi.fn(),
  removeOwnSuppressionAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/deliverability/check-actions", () => ({
  resumeChecksAction: vi.fn(),
  saveCheckSettingsAction: vi.fn(),
  saveVerificationKeyAction: vi.fn(),
  removeVerificationKeyAction: vi.fn(),
  testCheckAction: vi.fn(),
}));

const { LimitsForm } = await import("@/components/settings/limits/limits-form");
const { TodayCapForm } = await import("@/components/settings/limits/today-cap-form");
const { SenderCapsForm } = await import("@/components/settings/limits/sender-caps-form");
const { RulesForm } = await import("@/components/settings/limits/rules-form");
const { AccessOffSwitch, ACCESS_OFF_TEXT } = await import("@/components/settings/access-off-switch");
const { RemoteAccessCard } = await import("@/components/settings/remote-access-card");
const { HealthCard } = await import("@/components/settings/deliverability/health-card");
const { CountedTable } = await import("@/components/settings/deliverability/counted-table");
const { SuppressionList } = await import("@/components/settings/deliverability/suppression-list");
const { CheckSettingsForm } = await import("@/components/settings/checks/check-settings-form");
const { checkSettingsValuesFrom } = await import("@/components/settings/checks/check-settings");
const { ApplyButton } = await import("@/components/settings/domain/apply-button");
const { APPLY_FIXES_ROWS, applyIsPrimary } = await import("@/components/settings/domain/apply-rule");
const { Checklist } = await import("@/components/settings/domain/checklist");
const { TeamManager } = await import("@/components/settings/team-manager");
const { TEAM_PAGE_TEXT } = await import("@/components/settings/team-text");

/**
 * Settings polish (M6-DESIGN §5.1, §5.2): one orange button per page and where it goes, the new cards' words, the
 * compact health rows for the dashboard, the Access switch, the Team card, and the empty states of R8.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
/** Visible text, with React's escaping undone. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** The orange (default variant) buttons in some markup, by their text. */
function orangeButtons(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<(?:button|a)[^>]*data-variant="default"[^>]*>([\s\S]*?)<\/(?:button|a)>/g)) {
    out.push(m[1]!.replace(/<[^>]+>/g, "").trim());
  }
  return out;
}

const RULES_VIEW = {
  teamRuleDays: 21,
  pausedExpiryDays: 14,
  sharedDomains: ["firma.example", "studio.example"],
  builtIn: ["gmail.com", "googlemail.com", "outlook.com", "instagram.com"],
};

describe("Limits & warm-up", () => {
  const LIMITS = {
    window: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
    defaultTimeZone: "Europe/Berlin",
    maxDailyCap: 1000,
    minGapSeconds: 20,
    capDayTimeZone: "Asia/Karachi",
    warmupStartCap: 50,
    warmupSteps: 20,
    warmupMinUsePercent: 50,
  };

  it("has one orange button, Save limits; Save rules and the others are outline", () => {
    const out = html(
      createElement(
        Fragment,
        null,
        createElement(TodayCapForm, { current: 50, warmupCap: 50, maxCap: 1000 }),
        createElement(LimitsForm, { initial: LIMITS, zones: ["Europe/Berlin", "Asia/Karachi"] }),
        createElement(RulesForm, { view: RULES_VIEW }),
        createElement(SenderCapsForm, { senders: [{ userId: 1, name: "Arslan", address: "arslan@send.example.com", dailyCap: null }] }),
      ),
    );
    expect(orangeButtons(out)).toEqual(["Save limits"]);
    expect(out).toMatch(/<button[^>]*data-variant="outline"[^>]*>Save rules<\/button>/);
  });

  it("The 30-day rule card: the three fields with their help, the saved values and the built-in list collapsed", () => {
    const out = html(createElement(RulesForm, { view: RULES_VIEW }));
    const t = text(out);
    expect(t).toContain("Days a company stays with whoever emailed it");
    expect(t).toContain("Nobody else can add the company to a campaign during these days. It's checked at launch and before every email.");
    expect(t).toContain("Days a paused campaign keeps its companies");
    expect(t).toContain(
      "After that, other campaigns may email those companies; whoever launched the paused campaign and the Owner are told.",
    );
    expect(t).toContain("Shared email domains");
    expect(t).toContain(
      "Domains many unrelated companies use, like gmail.com. The app never groups companies, applies the 30-day rule or links replies by these domains.",
    );
    expect(t).toContain("Built in: gmail.com, outlook.com, … (4).");
    expect(out).toContain('value="21"');
    expect(out).toContain('value="14"');
    expect(out).toContain("firma.example\nstudio.example");
    // The full list sits inside a closed <details>.
    expect(out).toMatch(/<details[^>]*><summary[^>]*>Built in: [\s\S]*gmail\.com, googlemail\.com, outlook\.com, instagram\.com/);
  });
});

describe("Settings › System: the Access switch", () => {
  const NOW = new Date("2026-09-23T10:00:00Z");
  const tunnel: TunnelState = {
    checkedAt: NOW.toISOString(),
    state: "connected",
    readyConnections: 4,
    port: 20241,
    connectorId: "c",
    version: "2026.9.1",
    versionWarning: null,
    downSince: null,
    notifiedAt: null,
    publicCheck: { at: NOW.toISOString(), ok: true, status: 200, error: null },
    webhookPathCheck: { at: NOW.toISOString(), ok: true, status: 406, error: null },
    appProtectedCheck: { at: NOW.toISOString(), ok: false, status: 200, location: null, error: null },
    selfCheckNonce: null,
  };

  it("labels the switch, gives the recommendation and stays neutral", () => {
    const off = html(createElement(AccessOffSwitch, { accessOff: false }));
    expect(text(off)).toContain("We don't use Cloudflare Access");
    expect(text(off)).toContain(
      "Recommended: keep Access on. Without it, anyone who finds the address sees the app's sign-in page; the app's own sign-in still protects your data.",
    );
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/);
    expect(off).toContain("data-checked:bg-foreground");
    expect(orangeButtons(off)).toEqual([]);
    expect(html(createElement(AccessOffSwitch, { accessOff: true }))).toMatch(/aria-checked="true"/);
    expect(ACCESS_OFF_TEXT.confirmTitle).toBe("Turn off the Access check?");
    expect(ACCESS_OFF_TEXT.confirmButton).toBe("Turn it off");
  });

  it("the Remote access card shows the Access-off sentence and the switch, and no orange", () => {
    const on = text(html(createElement(RemoteAccessCard, { tunnel, publicUrl: "https://o.example.com", timeZone: "UTC", now: NOW })));
    expect(on).toContain("Only your team gets past Cloudflare's login;");
    expect(on).toContain("Anyone on the internet can reach your app's sign-in page.");
    const out = html(
      createElement(RemoteAccessCard, {
        tunnel,
        publicUrl: "https://o.example.com",
        timeZone: "UTC",
        now: NOW,
        accessOff: true,
        accessControl: createElement(AccessOffSwitch, { accessOff: true }),
      }),
    );
    const t = text(out);
    expect(t).toContain("Remote access works. Cloudflare Access is off (Settings › System), so the app's own sign-in is the only login.");
    expect(t).not.toContain("Only your team gets past Cloudflare's login");
    expect(t).not.toContain("Anyone on the internet");
    expect(t).toContain("We don't use Cloudflare Access");
    expect(orangeButtons(out)).toEqual([]);
  });
});

describe("Deliverability", () => {
  const bounce = {
    label: "Bounces toward the automatic pause",
    line: "3 of the last 200 emails bounced · sending pauses above 6 (3%) · Mailgun's own limit is 5%.",
    count: 3,
    limit: 6,
    note: null,
    href: "#bounces",
  };
  const complaint = {
    label: "Spam complaints toward the automatic pause",
    line: "0 of the last 1,000 emails were marked as spam · sending pauses above 1 (0.1%) · Mailgun's own limit is 0.3%.",
    count: 0,
    limit: 1,
    note: "Too few emails yet to judge.",
    href: "#complaints",
  };

  it("HealthCard compact: the two rows and the note without the card, its title or links", () => {
    const out = html(
      createElement(HealthCard, {
        bounce: { ...bounce, href: null },
        complaint: { ...complaint, href: undefined },
        sinceNote: "Counting since you went live on 27 Sept.",
        compact: true,
      }),
    );
    const t = text(out);
    expect(out).not.toContain('data-slot="card"');
    expect(t).not.toContain("Health");
    expect(t).toContain(bounce.line);
    expect(t).toContain(complaint.line);
    expect(t).toContain("Too few emails yet to judge.");
    expect(t).toContain("Counting since you went live on 27 Sept.");
    expect(t).not.toContain("See which emails count");
    expect((out.match(/role="meter"/g) ?? []).length).toBe(2);
  });

  it("HealthCard on the page: the card with its title and the links to the lists", () => {
    const out = html(createElement(HealthCard, { bounce, complaint, sinceNote: null }));
    expect(out).toContain('data-slot="card"');
    expect(text(out)).toContain("Health");
    expect((out.match(/See which emails count/g) ?? []).length).toBe(2);
    expect(out).toContain('href="#bounces"');
  });

  it("the counted tables and the do-not-email list are cards with a description; the list's empty state", () => {
    const counted = text(
      html(
        createElement(CountedTable, {
          id: "bounces",
          title: "Bounces counted now",
          description: "Each bounced email that counts toward the automatic pause, with the list it came from.",
          rows: [],
          emptyText: "No bounces count toward the limit right now.",
          timeZone: "UTC",
        }),
      ),
    );
    expect(counted).toContain("Bounces counted now");
    expect(counted).toContain("Each bounced email that counts toward the automatic pause, with the list it came from.");
    expect(counted).toContain("No bounces count toward the limit right now.");
    const list = html(createElement(SuppressionList, { rows: [], total: 0, page: 1, pageCount: 1, q: "", filter: "all", timeZone: "UTC" }));
    expect(list).toContain('data-slot="card"');
    expect(text(list)).toContain("Nobody is on the do-not-email list.");
    expect(text(list)).toContain("Add an address");
    expect(orangeButtons(list)).toEqual([]);
  });

  it("Address checks names the provider, read-only", () => {
    const values = checkSettingsValuesFrom({
      "verification.policy": null,
      "verification.pricePerCheck": 0.012,
      "verification.includedPerMonth": 0,
      "verification.maxAgeDays": 90,
      "verification.monthlyLimitUsd": 100,
      "verification.concurrency": 2,
    });
    const t = text(html(createElement(CheckSettingsForm, { view: { values, thisMonth: "This month: 0 checks." } })));
    expect(t).toContain("Address checks by Mailgun.");
    expect(t).not.toContain("Checked by Mailgun");
  });
});

const row = (r: Partial<ChecklistRow> & Pick<ChecklistRow, "key" | "group" | "status" | "title">): ChecklistRow => ({
  text: "",
  fix: null,
  records: [],
  detail: null,
  ...r,
});

describe("Domain checklist", () => {
  it("Apply is orange only while a row it fixes isn't done", () => {
    expect(APPLY_FIXES_ROWS).toEqual(["tracking-off", "unsubscribe", "spam-filter", "retention", "signing-key", "webhooks", "reply-routes", "https-links"]);
    const ok = APPLY_FIXES_ROWS.map((key) => row({ key, group: "settings", status: "ok", title: key }));
    expect(applyIsPrimary(ok)).toBe(false);
    for (const status of ["bad", "warn", "unknown"] as const) {
      expect(applyIsPrimary(ok.map((r) => (r.key === "webhooks" ? { ...r, status } : r)))).toBe(true);
    }
    // Rows Apply can't fix don't count, and neither do "for your information" and "off" rows (Setup B's unsubscribe).
    expect(applyIsPrimary([...ok, row({ key: "spf", group: "dns", status: "bad", title: "SPF" })])).toBe(false);
    expect(applyIsPrimary(ok.map((r) => (r.key === "unsubscribe" ? { ...r, status: "info" as const } : r)))).toBe(false);
    expect(applyIsPrimary(ok.map((r) => (r.key === "https-links" ? { ...r, status: "off" as const } : r)))).toBe(false);
    // Never checked yet: Apply is the thing to do.
    expect(applyIsPrimary([])).toBe(true);
  });

  it("the Apply button follows it", () => {
    expect(orangeButtons(html(createElement(ApplyButton, { runningJobId: null, primary: true })))).toEqual(["Apply recommended settings"]);
    const outline = html(createElement(ApplyButton, { runningJobId: null, primary: false }));
    expect(orangeButtons(outline)).toEqual([]);
    expect(outline).toMatch(/data-variant="outline"/);
  });

  it("each checklist group is a card with its title and a sentence", () => {
    const t = text(
      html(
        createElement(Checklist, {
          rows: [
            row({ key: "mailgun-domain", group: "mailgun", status: "ok", title: "Mailgun knows your domain" }),
            row({ key: "spf", group: "dns", status: "ok", title: "SPF" }),
            row({ key: "tracking-off", group: "settings", status: "ok", title: "Tracking off" }),
            row({ key: "remote-access", group: "connection", status: "ok", title: "Remote access" }),
            row({ key: "postmaster", group: "optional", status: "info", title: "Postmaster" }),
          ],
          senders: [],
          domain: "send.example.com",
          domainRegisteredOn: null,
        }),
      ),
    );
    for (const s of [
      "Whether Mailgun has your sending domain.",
      "The records at your domain's DNS host that let inboxes trust your emails.",
      "How Mailgun handles your emails, replies, unsubscribes and limits.",
      "Whether Mailgun and your team can reach the app, and the reply test.",
      "Good to have. Nothing waits for these.",
    ]) {
      expect(t).toContain(s);
    }
  });
});

describe("Team", () => {
  const owner: TeamRow = {
    id: 1,
    name: "Arslan",
    email: "arslan@polygonparadise.test",
    role: "OWNER",
    status: "ACTIVE",
    lastSignIn: "23 Sept 2026, 14:02",
    lastSignInAgo: "just now",
    pendingLink: null,
    isYou: true,
    activeCampaigns: [],
    waitingReplies: 0,
  };
  const ali: TeamRow = { ...owner, id: 2, name: "Ali", email: "ali@polygonparadise.test", role: "MEMBER", isYou: false };

  it("Invite a teammate is the one orange button, in the list's card; the page title comes from the server page", () => {
    const out = html(createElement(TeamManager, { rows: [owner, ali] }));
    expect(orangeButtons(out)).toEqual(["Invite a teammate"]);
    expect(out).toContain('data-slot="card-header"');
    expect(text(out)).toContain(TEAM_PAGE_TEXT.listDescription);
    expect(out).not.toMatch(/<h2[^>]*>Team<\/h2>/);
    expect(text(out)).not.toContain(TEAM_PAGE_TEXT.onlyYou);
  });

  it("with only the Owner, the empty state says what to do next", () => {
    expect(text(html(createElement(TeamManager, { rows: [owner] })))).toContain(
      "Only you so far. Click Invite a teammate to create an invite link.",
    );
  });
});
