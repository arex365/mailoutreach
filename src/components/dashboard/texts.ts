/**
 * Every fixed sentence of the dashboard (M6-DESIGN §4): the page, the replies list, the tiles and "Get started". The
 * attention list's sentences are in `@/core/dashboard/attention` (ATTENTION_TEXTS). One place, so the page, the loader
 * and the tests say the same thing. Pure and browser-safe.
 */

const n = (v: number) => v.toLocaleString("en-US");

export const DASHBOARD_TEXTS = {
  title: "Dashboard",
  description: "What needs your attention first, then how sending is going.",
  /** A tile or list whose data couldn't be read this time. */
  unavailable: "Couldn't load this right now. Refresh the page in a minute.",

  replies: {
    heading: "Replies waiting for an answer",
    description: "Yours, oldest first. The app can't see your inbox: click Answered once you've replied.",
    empty: "No replies are waiting for you.",
    allLink: "All replies",
    /** "All replies (3 more)". */
    allLinkMore: (more: number): string => `All replies (${n(more)} more)`,
  },

  companies: {
    heading: "Companies",
    /** "1,240 companies" / "1 company". */
    total: (count: number): string => (count === 1 ? "1 company" : `${n(count)} companies`),
    empty: "No companies yet. Import a spreadsheet or paste rows from Excel to get started.",
    importLink: "Import companies",
    footer: "Open Contacts",
  },

  today: {
    heading: "Today",
    /** "of 50 today" next to the big number. */
    ofCap: (cap: number): string => `of ${n(cap)} today`,
    barLabel: "Emails sent today against today's limit",
    /** "Send me a test" and the reply test's emails alike (review DASHBOARD-9): both count toward today's limit. */
    testSends: (count: number): string => (count === 1 ? "Includes 1 test email." : `Includes ${n(count)} test emails.`),
    override: "Today's limit was changed by hand.",
    aboveSchedule: " It's above the warm-up schedule.",
    reached: "Today's limit is reached; the rest go out tomorrow.",
    warmupBeforeGoLive: "Warm-up starts when you go live.",
    warmupBeforeGoLiveNote: "Until then, real email only reaches your test list.",
    notConfigured: "Nothing goes through Mailgun yet: new campaigns run as dry runs.",
    connectLink: "Connect Mailgun",
    footer: "Limits & warm-up",
  },

  health: {
    heading: "Domain health",
    emptyReal: "No emails sent through Mailgun yet, so there's nothing to measure.",
    emptyPractice: "No emails sent yet, so there's nothing to measure.",
    /**
     * Nothing sent since counting started again (review DASHBOARD-6): "Nothing sent since you resumed on 27 Sept, so
     * there's nothing to measure yet." `since` is "you resumed on 27 Sept" / "you went live on 27 Sept".
     */
    emptySince: (since: string): string => `Nothing sent since ${since}, so there's nothing to measure yet.`,
    bounceLabel: "Bounces toward the automatic pause",
    complaintLabel: "Spam complaints toward the automatic pause",
    footer: "Deliverability",
  },

  campaigns: {
    heading: "Active campaigns",
    empty: "No campaigns are sending right now.",
    emptyLink: "Go to Campaigns",
    /** "+ 3 more" (links to the tab they are on, `campaignsMoreHref`). */
    more: (count: number): string => `+ ${n(count)} more`,
    footer: "All campaigns",
    barLabel: (name: string): string => `Progress of ${name}`,
  },

  activity: {
    heading: "Recent team activity",
    empty: "Nothing yet. Changes you and your team make will show here.",
    dryRunBadge: "Dry run",
    footer: "All activity",
    /** A company that was deleted since: its name, not a link (as the Activity page). */
    deletedCompany: (name: string): string => `${name} (deleted)`,
    /** A bulk change collapsed into one row (review DASHBOARD-4): "12 companies" / "at least 200 companies". */
    companies: (count: number, atLeast: boolean): string => `${atLeast ? "at least " : ""}${n(count)} ${count === 1 ? "company" : "companies"}`,
    /** The same change repeated, not one company each: "3 times" / "at least 200 times". */
    times: (count: number, atLeast: boolean): string => `${atLeast ? "at least " : ""}${n(count)} ${count === 1 ? "time" : "times"}`,
  },

  dryRun: {
    heading: "Dry runs and test mode",
    description: "Dry runs and Mailgun's test mode don't count as emailed and aren't in Companies, Today or Domain health.",
    footer: "Open the dry-run outbox",
  },

  getStarted: {
    heading: "Get started",
    descriptionOwner: "Five steps to your first real campaign. You can come back to these any time.",
    descriptionMember: "Your first campaign starts with your companies.",
    descriptionPractice: "Three steps to try everything here. Nothing is ever sent from the practice copy.",
    importTitle: "Import companies",
    importDone: "Companies imported",
    importText: "Upload a spreadsheet or paste rows from Excel or Google Sheets.",
    teamTitle: "Invite your team",
    teamDone: "Team invited",
    teamText: "Create invite links for your teammates.",
    protectTitle: "Protect your data",
    protectDone: "Second backup folder set",
    protectText: "Choose a second backup folder and keep a copy of the .env file somewhere safe.",
    goLiveTitle: "Go live",
    goLiveText: "When the checklist is green, switch on Go live. Until then, real email only reaches your test list.",
  },
} as const;
