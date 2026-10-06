import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WaitingReplyView } from "@/server/services/replies/waiting";

// The Server Actions modules can't load outside Next (server-only); the reply cards never call them while rendering.
vi.mock("@/app/(app)/notifications/reply-actions", () => ({
  addReplySenderAction: vi.fn(),
  confirmReplyAction: vi.fn(),
  continueMyFollowUpsAction: vi.fn(),
  linkReplyAction: vi.fn(),
  markReplyAnsweredAction: vi.fn(),
  markReplyNotNeededAction: vi.fn(),
  reopenReplyAction: vi.fn(),
  replyLinkCompanyAction: vi.fn(),
}));
vi.mock("@/app/(app)/contacts/actions", () => ({ searchCompaniesAction: vi.fn() }));
vi.mock("@/app/(app)/notifications/actions", () => ({ markAllNotificationsReadAction: vi.fn(), markNotificationsReadAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

const { DashboardScreen } = await import("@/components/dashboard/dashboard-screen");
const { attentionItems, capAttention } = await import("@/core/dashboard/attention");
const { getStartedView } = await import("@/components/dashboard/get-started");
const { healthTileView, todayView } = await import("@/components/dashboard/format");
type DashboardView = import("@/components/dashboard/types").DashboardView;
type AttentionFacts = import("@/core/dashboard/attention").AttentionFacts;

/**
 * The dashboard screen (M6-DESIGN §4.1–§4.4) rendered from plain views in its states: empty (Owner and Member), busy
 * (every attention item and the replies list with its actions), before go-live, live, after a domain change, and the
 * practice copy. Headings, empty texts, Owner links vs Member texts, the one orange link and no "Milestone".
 */

const NOW = new Date("2026-09-23T10:00:00.000Z");
const OWNER = { id: 1, role: "OWNER" as const, timeZone: "Asia/Karachi" };
const MEMBER = { id: 2, role: "MEMBER" as const, timeZone: "Asia/Karachi" };

const html = (view: DashboardView, viewer: { id: number; role: "OWNER" | "MEMBER"; timeZone: string } = OWNER) =>
  renderToStaticMarkup(createElement(DashboardScreen, { view, viewer, now: NOW }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** Every visible Button (link-buttons included) with the default (orange) variant. */
function primaryButtons(out: string): string[] {
  return (out.match(/<(a|button)\b[^>]*data-slot="button"[^>]*>/g) ?? []).filter((tag) => tag.includes('data-variant="default"'));
}

const WARMUP_LIVE = "Warm-up step 3 of 20: 69 a day. It goes up to 80 after a weekday with at least half the limit used and healthy numbers.";

function quietFacts(over: Partial<AttentionFacts> = {}): AttentionFacts {
  return {
    practiceCopy: false,
    goLive: { live: false, currentDomain: null, liveDomain: null },
    pause: { paused: false, reason: "", fixText: "" },
    workerDown: null,
    restoreChecking: false,
    backup: { age: "ok", newestDay: "23 Sept", lastCopyFailed: false, secondFolder: null, diskLowText: null },
    secondFolderSet: false,
    waitingLine: null,
    aiWaiting: 0,
    pausedCampaigns: { items: [], total: 0 },
    unconfirmed: { count: 0, firstCampaignId: null },
    outage: { detected: false, applied: false, people: 0 },
    missingEmails: 0,
    tunnel: { down: false, since: null },
    mailgunConfigured: false,
    catchUp: null,
    oldDomainLines: [],
    checklistRows: [],
    checksPause: null,
    aiPause: null,
    ...over,
  };
}

const zeroPipeline = {
  counts: { all: 0, byStatus: { NOT_CONTACTED: 0, CONTACTED: 0, REPLIED: 0, CLIENT: 0, NOT_INTERESTED: 0, DO_NOT_CONTACT: 0 } },
  replyRate: { replied: 0, emailed: 0, last30: { replied: 0, emailed: 0 } },
};
const healthCounts = { bounces: 0, bounceSample: 0, complaints: 0, complaintSample: 0, bounceEmailIds: [], complaintEmailIds: [] };
const healthBase = {
  practiceCopy: false,
  counts: healthCounts,
  bounceLine: "0 of the last 0 emails bounced",
  complaintLine: "0 of the last 0 emails marked as spam",
  bounceLimit: 6,
  complaintLimit: 1,
  bounceNote: null,
  complaintNote: null,
  sinceNote: null,
};

/** A new install: the Owner right after setup (no companies, no Mailgun). */
function emptyView(viewer: { id: number; role: "OWNER" | "MEMBER" } = OWNER): DashboardView {
  const items = attentionItems(quietFacts({ backup: { age: "never", newestDay: null, lastCopyFailed: false, secondFolder: null, diskLowText: null } }), viewer, NOW);
  const capped = capAttention(items.filter((i) => i.key !== "backup-never"));
  return {
    practiceCopy: false,
    goLive: { live: false, at: null, domain: null, endedOnDomain: null },
    getStarted: getStartedView({
      role: viewer.role,
      practiceCopy: false,
      live: false,
      companies: 0,
      teamInvited: false,
      mailgun: { practiceCopy: false, connected: false, domain: null },
      secondFolderSet: false,
    }),
    attention: capped.items,
    attentionMore: capped.more,
    replies: { rows: [], total: 0 },
    pipeline: zeroPipeline,
    today: todayView({
      cap: { used: 0, cap: 50, left: 50, testSends: 0, override: null, aboveSchedule: false },
      warmupLine: null,
      practiceCopy: false,
      live: false,
      configured: false,
    }),
    health: healthTileView(healthBase),
    campaigns: { items: [], more: 0, moreHref: "/campaigns" },
    activity: [],
    dryRun: null,
  };
}

function reply(id: number, over: Partial<WaitingReplyView> = {}): WaitingReplyView {
  return {
    id,
    kind: "REPLY",
    label: "",
    receivedIso: "2026-09-23T08:00:00.000Z",
    receivedAgo: "2 hours ago",
    receivedExact: "23 Sept 2026, 13:00",
    quietLine: null,
    fromEmail: `anna${id}@firma.example`,
    fromName: `Anna ${id}`,
    fromIsContact: true,
    company: { id: 100 + id, name: `Firma ${id}` },
    person: { id: 200 + id, name: `Anna ${id}` },
    campaign: { id: 5, name: "Germany Q4", step: 0 },
    senderName: "Arslan",
    assigneeName: "Arslan",
    subject: "Re: 3D models",
    firstLines: "Sounds good.",
    whyLines: [],
    hints: [],
    hintCompanyId: null,
    canAddPerson: false,
    ...over,
  };
}

const BUSY_FACTS: AttentionFacts = quietFacts({
  goLive: { live: false, currentDomain: "send.example.com", liveDomain: null },
  pause: { paused: true, reason: "7 of the last 200 emails bounced", fixText: "Open the bounced list, then click Resume." },
  workerDown: "The background sender isn't running, so no emails are going out. Double-click start.bat on the office PC.",
  waitingLine: "Replies waiting for an answer: You 3 · Ali 1",
  aiWaiting: 12,
  pausedCampaigns: {
    items: [
      { id: 7, name: "Germany Q4", pausedLine: "Paused by Arslan on 20 Sept 2026, 09:00. Nothing is sent until you resume it." },
      { id: 8, name: "Spain", pausedLine: "Paused on 21 Sept 2026, 10:00: sender switched off. Nothing is sent until you resume it." },
    ],
    total: 2,
  },
  unconfirmed: { count: 2, firstCampaignId: 9 },
  missingEmails: 8,
  backup: { age: "stale", newestDay: "21 Sept", lastCopyFailed: true, secondFolder: "D:\\Backups", diskLowText: null },
  mailgunConfigured: true,
  catchUp: {
    failing: true,
    line: "The app hasn't been able to check Mailgun since 12:00. Bounces and unsubscribes may be late.",
    lastSuccessAt: "2026-09-23T07:00:00.000Z",
    lastStartedAt: "2026-09-23T09:30:00.000Z",
  },
  oldDomainLines: ["Mailgun's logs for the old domain mail.example.com haven't been checked since 20 Sept. Replies and bounces to its last emails may be missed."],
  checksPause: { paused: true, text: "Address checks are paused: Mailgun refused the key." },
  aiPause: { paused: true, text: "AI drafting is paused: the monthly limit is reached." },
});

/** The busy seed's state (§9.4): not live, 60 companies, every busy item, 3 replies, a dry run today. */
function busyView(viewer: { id: number; role: "OWNER" | "MEMBER" } = OWNER): DashboardView {
  const capped = capAttention(attentionItems(BUSY_FACTS, viewer, NOW));
  return {
    ...emptyView(viewer),
    getStarted: getStartedView({
      role: viewer.role,
      practiceCopy: false,
      live: false,
      companies: 60,
      teamInvited: true,
      mailgun: { practiceCopy: false, connected: true, domain: "send.example.com" },
      secondFolderSet: true,
    }),
    attention: capped.items,
    attentionMore: capped.more,
    replies: { rows: [reply(1), reply(2, { kind: "POSSIBLE_REPLY", whyLines: ["It came from an address we didn't email."] }), reply(3)], total: 3 },
    pipeline: {
      counts: { all: 60, byStatus: { NOT_CONTACTED: 30, CONTACTED: 20, REPLIED: 5, CLIENT: 2, NOT_INTERESTED: 2, DO_NOT_CONTACT: 1 } },
      replyRate: { replied: 5, emailed: 25, last30: { replied: 1, emailed: 5 } },
    },
    today: todayView({
      cap: { used: 4, cap: 50, left: 46, testSends: 1, override: null, aboveSchedule: false },
      warmupLine: null,
      practiceCopy: false,
      live: false,
      configured: true,
    }),
    campaigns: {
      items: [
        {
          id: 3,
          name: "Test run",
          href: "/campaigns/3",
          status: "RUNNING",
          statusLabel: "Running",
          mode: "LIVE",
          modeLabel: "Live",
          isDraft: false,
          sender: "Sent by Arslan",
          audience: "2 people",
          percent: 50,
          progressText: "First email 2 of 2 sent · 1 follow-up",
          progressTitle: "2 of 4 emails dealt with (sent, skipped, or won't be sent)",
          dates: [],
          pauseReason: null,
          senderName: "Arslan",
        },
      ],
      more: 3,
      moreHref: "/campaigns?tab=running",
    },
    activity: [
      {
        id: 1,
        at: "2026-09-23T09:48:00.000Z",
        summary: "Ali set status to Client",
        actorName: "Ali",
        mode: null,
        company: { id: 42, name: "Figuren Werkstatt", deleted: false },
        group: null,
      },
      { id: 2, at: "2026-09-23T09:00:00.000Z", summary: "Arslan launched the dry run Spain", actorName: "Arslan", mode: "DRY_RUN", company: null, group: null },
      {
        id: 3,
        at: "2026-09-23T08:00:00.000Z",
        summary: "Ali set status to Contacted",
        actorName: "Ali",
        mode: null,
        company: null,
        group: { count: 12, companies: true, atLeast: false },
      },
      {
        id: 4,
        at: "2026-09-23T07:00:00.000Z",
        summary: "Arslan added this company",
        actorName: "Arslan",
        mode: null,
        company: { id: 43, name: "Old Studio", deleted: true },
        group: null,
      },
    ],
    dryRun: {
      today: { dryRun: 40, testMode: 0 },
      running: { dryRun: 1, testMode: 0 },
      waitingReplies: 1,
      lines: ["Dry run today: 40 emails in the outbox · 1 campaign running", "Dry-run replies waiting: 1"],
    },
  };
}

/** Live for 3 days: warm-up step 3, health counted from go-live, two running live campaigns. */
function liveView(viewer: { id: number; role: "OWNER" | "MEMBER" } = OWNER): DashboardView {
  const facts = quietFacts({
    goLive: { live: true, currentDomain: "send.example.com", liveDomain: "send.example.com" },
    secondFolderSet: true,
    mailgunConfigured: true,
  });
  const busy = busyView(viewer);
  return {
    ...busy,
    goLive: { live: true, at: "2026-09-20T09:05:00.000Z", domain: "send.example.com", endedOnDomain: null },
    getStarted: getStartedView({
      role: viewer.role,
      practiceCopy: false,
      live: true,
      companies: 60,
      teamInvited: true,
      mailgun: { practiceCopy: false, connected: true, domain: "send.example.com" },
      secondFolderSet: true,
    }),
    attention: attentionItems(facts, viewer, NOW),
    attentionMore: 0,
    replies: { rows: [], total: 0 },
    today: todayView({
      cap: { used: 37, cap: 69, left: 32, testSends: 0, override: null, aboveSchedule: false },
      warmupLine: WARMUP_LIVE,
      practiceCopy: false,
      live: true,
      configured: true,
    }),
    health: healthTileView({
      ...healthBase,
      counts: { ...healthCounts, bounces: 2, bounceSample: 180, complaintSample: 180 },
      bounceLine: "2 of the last 180 emails bounced · sending pauses above 6 (3%) · Mailgun's own limit is 5%.",
      complaintLine: "0 of the last 180 emails marked as spam · sending pauses above 1 (0.1%) · Mailgun's own limit is 0.1%.",
      sinceNote: "Counting since you went live on 20 Sept.",
    }),
    dryRun: null,
  };
}

describe("DashboardScreen: every state", () => {
  it("empty, Owner: the five Get started steps with one orange link, and every empty text", () => {
    const out = html(emptyView());
    expect(out).toContain("<h1");
    expect(out).toContain(">Dashboard<");
    expect(out).toContain("What needs your attention first, then how sending is going.");
    for (const h of ["Get started", "Needs your attention", "Replies waiting for an answer", "Companies", "Today", "Active campaigns", "Domain health", "Recent team activity"]) {
      expect(out).toMatch(new RegExp(`<h2[^>]*>${h}</h2>`));
    }
    expect(out).toContain("Five steps to your first real campaign. You can come back to these any time.");
    expect(out.match(/<li/g)?.length).toBeGreaterThanOrEqual(5);
    expect(out).toContain("Nothing needs your attention right now.");
    expect(out).toContain("No replies are waiting for you.");
    expect(out).toContain("Yours, oldest first. The app can't see your inbox: click Answered once you've replied.");
    expect(out).toContain("No companies yet. Import a spreadsheet or paste rows from Excel to get started.");
    expect(out).toContain("No campaigns are sending right now.");
    expect(out).toContain("No emails sent through Mailgun yet, so there's nothing to measure.");
    expect(out).toContain("Nothing yet. Changes you and your team make will show here.");
    expect(out).toContain("Nothing goes through Mailgun yet: new campaigns run as dry runs.");
    expect(out).toMatch(/<a[^>]*href="\/settings\/sending"[^>]*>Connect Mailgun<\/a>/);
    expect(out).not.toContain("Dry runs and test mode");
    const primary = primaryButtons(out);
    expect(primary).toHaveLength(1);
    expect(primary[0]).toContain('href="/import"');
    expect(out).not.toMatch(/Milestone/);
  });

  it("empty, Member: two steps, no Owner links, still one orange link", () => {
    const out = html(emptyView(MEMBER), MEMBER);
    expect(out).toContain("Your first campaign starts with your companies.");
    expect(out).toContain("Import companies");
    expect(out).toContain("The Owner connects Mailgun in Settings › Sending & Mailgun. Until then, campaigns run as dry runs.");
    expect(out).not.toContain("Invite your team");
    expect(out).not.toContain('href="/settings/limits"');
    expect(out).not.toContain('href="/settings/deliverability"');
    expect(out).not.toMatch(/>Connect Mailgun<\/a>/);
    expect(primaryButtons(out)).toHaveLength(1);
  });

  it("busy, Owner: every busy item's text and link, the replies with their actions, the tiles", () => {
    const view = busyView();
    const out = html(view);
    expect(view.attention.map((i) => i.key)).toEqual([
      "sending-paused",
      "worker-down",
      "replies-waiting",
      "ai-lines",
      "paused-campaigns",
      "paused-campaigns",
      "unconfirmed",
      "missing-emails",
      "backup-old",
      "backup-copy-failed",
      "mailgun-check",
      "old-domain",
      "checks-paused",
      "ai-paused",
    ]);
    for (const item of view.attention) expect(out).toContain(item.text);
    expect(out).toContain("Sending is paused: 7 of the last 200 emails bounced.");
    expect(out).toContain("Open the bounced list, then click Resume.");
    expect(out).toContain("Replies waiting for an answer: You 3 · Ali 1");
    expect(out).toContain("“Germany Q4” is paused.");
    expect(out).toMatch(/<a[^>]*href="\/campaigns\/7"[^>]*>Open<\/a>/);
    expect(out).toMatch(/<a[^>]*href="\/settings\/sending"[^>]*>Open Sending & Mailgun<\/a>/);
    expect(out).toMatch(/<a[^>]*href="\/settings\/backups"[^>]*>Backups<\/a>/);
    expect(out).not.toContain("Ask the Owner to fix this.");
    expect(out).not.toContain(" more</li>");
    // Red for the two items that stop sending (the pause, the background sender).
    expect(out.match(/lucide-circle-alert/g)).toHaveLength(2);
    // The replies: three cards with their actions, oldest first; the footer link.
    expect(out.match(/<article/g)).toHaveLength(3);
    expect((out.match(/>Answered</g) ?? []).length).toBe(2);
    expect(out).toContain(">No answer needed<");
    expect(out).toContain(">Real reply<");
    // Review DASHBOARD-5: the footer opens the viewer's own list, the one "(3 more)" counts.
    expect(out).toMatch(/<a[^>]*href="\/notifications\?scope=mine#replies"[^>]*>All replies<\/a>/);
    // Companies: total, six status rows linking to Contacts, the reply rate.
    expect(out).toContain("60 companies");
    expect(out).toMatch(/href="\/contacts\?status=REPLIED"/);
    expect(out.match(/href="\/contacts\?status=/g)).toHaveLength(6);
    expect(out).toContain("Reply rate: 20% (5 of 25 companies you emailed replied)");
    expect(out).toContain("Last 30 days: 20% (1 of 5)");
    // Today before go-live with Mailgun set up.
    expect(out).toContain("Includes 1 test email.");
    expect(out).toContain("Warm-up starts when you go live.");
    expect(out).toContain("Until then, real email only reaches your test list.");
    // Campaigns, activity, the dry-run tile.
    expect(out).toContain("Arslan · Live");
    expect(out).toContain('role="progressbar"');
    expect(out).toMatch(/<a[^>]*href="\/campaigns\?tab=running"[^>]*>\+ 3 more<\/a>/);
    // Review DASHBOARD-3: each row names and links its company, like the Activity page; a deleted one is plain text.
    expect(out).toMatch(
      /Ali set status to Client · <a[^>]*href="\/contacts\?company=42"[^>]*>Figuren Werkstatt<\/a> · <time dateTime="2026-09-23T09:48:00.000Z">12 minutes ago<\/time>/,
    );
    expect(out).toMatch(/Arslan launched the dry run Spain · <time[^>]*>1 hour ago<\/time>/);
    expect(out).toMatch(/Arslan added this company · Old Studio \(deleted\) · <time[^>]*>3 hours ago<\/time>/);
    expect(out).not.toContain('href="/contacts?company=43"');
    // Review DASHBOARD-4: a bulk change is one row with its count.
    expect(out).toMatch(/Ali set status to Contacted · 12 companies · <time[^>]*>2 hours ago<\/time>/);
    expect(out).toContain(">Dry run<");
    expect(out).toMatch(/<h2[^>]*>Dry runs and test mode<\/h2>/);
    expect(out).toContain("Dry runs and Mailgun's test mode don't count as emailed and aren't in Companies, Today or Domain health.");
    expect(out).toContain("Dry run today: 40 emails in the outbox · 1 campaign running");
    expect(out).toMatch(/<a[^>]*href="\/campaigns\/outbox"[^>]*>Open the dry-run outbox<\/a>/);
    // Get started: the Owner isn't live yet, so it stays with Go live as the one orange link.
    const primary = primaryButtons(out);
    expect(primary).toHaveLength(1);
    expect(primary[0]).toContain('href="/settings/sending#go-live"');
    expect(out).not.toMatch(/Milestone/);
  });

  it("busy, Member: Member texts instead of the Owner's links", () => {
    const view = busyView(MEMBER);
    const out = html(view, MEMBER);
    expect(view.attention.filter((i) => i.note).map((i) => i.key)).toEqual(["sending-paused", "mailgun-check", "old-domain", "checks-paused", "ai-paused"]);
    expect((out.match(/Ask the Owner to fix this\./g) ?? []).length).toBe(5);
    expect(out).not.toMatch(/href="\/settings\/(sending|domain|system|ai|limits|deliverability)/);
    // Everyone may open Settings › Backups, replies, AI lines, campaigns and Contacts.
    expect(out).toMatch(/href="\/settings\/backups"/);
    expect(out).toMatch(/href="\/ai-lines"/);
    // A Member with companies has no Get started card, so no orange link at all.
    expect(view.getStarted).toBeNull();
    expect(primaryButtons(out)).toHaveLength(0);
  });

  it("renders the items the busy state doesn't have (restore, disk, outage, backups, go-live, remote access, checklist)", () => {
    const facts = quietFacts({
      goLive: { live: true, currentDomain: "send.example.com", liveDomain: "send.example.com" },
      restoreChecking: true,
      backup: {
        age: "never",
        newestDay: null,
        lastCopyFailed: false,
        secondFolder: null,
        diskLowText: "The office PC's disk is almost full (1.2 GB free). Backups and sending stop when it's full.",
      },
      secondFolderSet: false,
      outage: { detected: true, applied: true, people: 12 },
      tunnel: { down: true, since: "14:02" },
      checklistRows: [{ key: "dmarc", group: "dns", status: "bad", title: "DMARC policy", text: "", fix: null, records: [], detail: null }],
    });
    const items = attentionItems(facts, OWNER, NOW);
    expect(items.map((i) => i.key)).toEqual([
      "restore-check",
      "disk-low",
      "outage-hold",
      "backup-never",
      "second-folder-missing",
      "tunnel-down",
      "checklist",
    ]);
    const out = html({ ...liveView(), attention: items });
    for (const text of [
      "Emails through Mailgun wait while the app checks Mailgun after the restore (about 35 minutes).",
      "The office PC's disk is almost full (1.2 GB free). Backups and sending stop when it's full.",
      "Follow-ups to 12 people are on hold: the PC was off for more than 5 days, so replies may have been missed. Emails you retried after that wait too.",
      "No backup has been made yet. Click Back up now in Settings › Backups.",
      "No second backup folder yet. Choose one in Settings › Backups so a copy survives if this PC's disk fails.",
      "Remote access is down since 14:02: remote staff and Mailgun can't reach the app. Check the office PC's internet connection, then run status.bat.",
      "Something on the Domain checklist needs fixing: DMARC policy.",
    ]) {
      expect(out).toContain(text);
    }
    expect(out).toMatch(/<a[^>]*href="\/settings\/sending#outage"[^>]*>Continue follow-ups<\/a>/);
    expect(out).toMatch(/<a[^>]*href="\/settings\/system"[^>]*>Open System<\/a>/);
    expect(out).toMatch(/<a[^>]*href="\/settings\/domain"[^>]*>Open the checklist<\/a>/);
    // Tones: red for what stopped sending (none here), amber for warnings, a neutral dot for the second-folder hint.
    expect(out.match(/lucide-triangle-alert/g)).toHaveLength(6);
    expect(out).not.toContain("lucide-circle-alert");
  });

  it("'+ N more' leads to the tab the rest are on (review DASHBOARD-7)", () => {
    const busy = busyView();
    for (const href of ["/campaigns?tab=scheduled", "/campaigns"]) {
      const out = html({ ...busy, campaigns: { ...busy.campaigns!, moreHref: href } });
      const escaped = href.replace(/[?]/g, "\\?");
      expect(out).toMatch(new RegExp(`<a[^>]*href="${escaped}"[^>]*>\\+ 3 more</a>`));
    }
  });

  it("Domain health with nothing sent since a resume says since when, not 'nothing sent yet' (review DASHBOARD-6)", () => {
    const out = html({ ...liveView(), health: healthTileView({ ...healthBase, sinceNote: "Counting since you resumed on 23 Sept." }) });
    expect(out).toContain("Nothing sent since you resumed on 23 Sept, so there's nothing to measure yet.");
    expect(out).not.toContain("No emails sent through Mailgun yet");
  });

  it("shows at most 15 items, then 'and N more'", () => {
    const view = busyView();
    const out = html({ ...view, attention: view.attention.slice(0, 15), attentionMore: 3 });
    expect(out).toContain(">and 3 more</li>");
  });

  it("live: no Get started, the warm-up line, health since go-live, campaign progress, Activity spans the row", () => {
    const out = html(liveView());
    expect(out).not.toContain("Get started");
    expect(out).toContain(WARMUP_LIVE);
    expect(out).toContain("37");
    expect(out).toContain("of 69 today");
    expect(out).toContain("2 of the last 180 emails bounced · sending pauses above 6 (3%) · Mailgun's own limit is 5%.");
    expect(out).toContain("Counting since you went live on 20 Sept.");
    expect(out).toContain('role="meter"');
    expect(out).not.toContain("See which emails count");
    expect(out).toContain("Nothing needs your attention right now.");
    expect(out).toContain("lg:col-span-12");
    expect(out).not.toContain("Dry runs and test mode");
    expect(primaryButtons(out)).toHaveLength(0);
    expect(out).not.toMatch(/Milestone/);
  });

  it("after a domain change: go-live-again, and Get started back with steps 1–4 done", () => {
    const facts = quietFacts({ goLive: { live: false, currentDomain: "send2.example.com", liveDomain: "send.example.com" }, secondFolderSet: true, mailgunConfigured: true });
    const view: DashboardView = {
      ...liveView(),
      goLive: { live: false, at: null, domain: "send2.example.com", endedOnDomain: "send.example.com" },
      getStarted: getStartedView({
        role: "OWNER",
        practiceCopy: false,
        live: false,
        companies: 60,
        teamInvited: true,
        mailgun: { practiceCopy: false, connected: true, domain: "send2.example.com" },
        secondFolderSet: true,
      }),
      attention: attentionItems(facts, OWNER, NOW),
    };
    const out = html(view);
    expect(out).toContain("You changed the sending domain to send2.example.com. Live campaigns only reach your test list until you go live on it.");
    expect(out).toMatch(/<a[^>]*href="\/settings\/sending#go-live"[^>]*>Open Go live<\/a>/);
    expect((out.match(/\(done\)/g) ?? []).length).toBe(4);
    expect(out).toContain("Emails can go out from send2.example.com.");
    expect(primaryButtons(out)).toHaveLength(1);

    const member = html({ ...view, getStarted: null, attention: attentionItems(facts, MEMBER, NOW) }, MEMBER);
    expect(member).toContain("Live campaigns only reach the test list until the Owner goes live on send2.example.com.");
    expect(member).not.toContain("Open Go live");
  });

  it("the practice copy: three steps, its health sentence, the warm-up line", () => {
    const view: DashboardView = {
      ...emptyView(),
      practiceCopy: true,
      getStarted: getStartedView({
        role: "OWNER",
        practiceCopy: true,
        live: false,
        companies: 0,
        teamInvited: false,
        mailgun: { practiceCopy: true, connected: false, domain: null },
        secondFolderSet: false,
      }),
      today: todayView({
        cap: { used: 9, cap: 50, left: 41, testSends: 0, override: null, aboveSchedule: false },
        warmupLine: "Warm-up step 1 of 20: 50 a day. It goes up to 59 after a weekday with at least half the limit used and healthy numbers.",
        practiceCopy: true,
        live: false,
        configured: false,
      }),
      health: healthTileView({ ...healthBase, practiceCopy: true }),
    };
    const out = html(view);
    expect(out).toContain("Three steps to try everything here. Nothing is ever sent from the practice copy.");
    expect(out).toContain("Not needed here: the practice copy never sends real email, so campaigns run as dry runs.");
    expect(out).not.toContain("Protect your data");
    expect(out).toContain("No emails sent yet, so there's nothing to measure.");
    expect(out).toContain("Warm-up step 1 of 20: 50 a day.");
    expect(out).not.toContain("Nothing goes through Mailgun yet");
    expect(primaryButtons(out)).toHaveLength(1);
  });

  it("says a tile couldn't be loaded when its source failed", () => {
    const out = html({ ...busyView(), replies: null, pipeline: null, today: null, health: null, campaigns: null, activity: null });
    // Replies, Companies, Today, Active campaigns, Domain health and Recent team activity.
    expect((out.match(/Couldn't load this right now\. Refresh the page in a minute\./g) ?? []).length).toBe(6);
    // The other sections still render.
    expect(out).toContain("Sending is paused: 7 of the last 200 emails bounced.");
  });

  it("every section is labelled by its heading, and no orange except Get started's link", () => {
    const out = html(busyView());
    // Get started, Needs your attention, Replies and the six tiles.
    const labelled = out.match(/<section aria-labelledby="([^"]+)"/g) ?? [];
    expect(labelled.length).toBe(9);
    for (const tag of labelled) {
      const id = /aria-labelledby="([^"]+)"/.exec(tag)![1];
      expect(out).toContain(`id="${id}"`);
    }
    // The only orange fill on the page is that one link's.
    expect(out.match(/\bbg-primary\b(?!-)/g)).toHaveLength(1);
    expect(out).not.toMatch(/\bbg-brand\b/);
  });
});
