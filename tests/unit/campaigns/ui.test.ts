import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CampaignStatusBadge, EmailStatusBadge, ModeBadge } from "@/components/campaigns/badges";
import { CampaignList } from "@/components/campaigns/campaign-list";
import { CampaignProgressCard, CampaignResultsGrid } from "@/components/campaigns/campaign-progress";
import { CampaignTabs } from "@/components/campaigns/campaign-tabs";
import { emptyTabCounts, type CampaignListView, type RecipientRowView } from "@/components/campaigns/format";
import { EmailHtmlFrame, OutboxEmailView } from "@/components/campaigns/outbox-email";
import { OutboxList } from "@/components/campaigns/outbox-list";
import { ListPager } from "@/components/campaigns/pager";
import { ProgressBar } from "@/components/campaigns/progress-bar";
import { RecipientTable } from "@/components/campaigns/recipient-table";
import { CompaniesTable } from "@/components/contacts/companies-table";
import type { ContactRow } from "@/components/contacts/types";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
/** Orange classes (PLAN.md A6: only the primary button and "selected" markers may be orange). */
const ORANGE = /\b(bg|text|border|fill)-(primary|brand)\b/;

describe("badges and the progress bar", () => {
  it("always shows the word, in neutral colours", () => {
    expect(html(createElement(CampaignStatusBadge, { status: "RUNNING" }))).toContain("Running");
    expect(html(createElement(CampaignStatusBadge, { status: "PAUSED" }))).toContain("Paused");
    const dry = html(createElement(ModeBadge, { mode: "DRY_RUN" }));
    expect(dry).toContain("Dry run");
    expect(dry).toContain("bg-muted");
    expect(dry).not.toMatch(ORANGE);
    expect(html(createElement(EmailStatusBadge, { status: "QUEUED" }))).toContain("Waiting to send");
    expect(html(createElement(EmailStatusBadge, { status: "FAILED" }))).toContain("Didn&#x27;t send");
    expect(html(createElement(EmailStatusBadge, { status: "UNCONFIRMED" }))).toContain("Not sure it was sent");
    expect(html(createElement(EmailStatusBadge, { status: null }))).toContain("Not sent yet");
  });

  it("draws a neutral, accessible progress bar", () => {
    const out = html(createElement(ProgressBar, { percent: 42.4, label: "Germany Q4: 42% done" }));
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="42"');
    expect(out).toContain("width:42%");
    expect(out).not.toMatch(ORANGE);
    expect(html(createElement(ProgressBar, { percent: 180, label: "x" }))).toContain('aria-valuenow="100"');
  });
});

describe("the Campaigns list", () => {
  const running: CampaignListView = {
    id: 3,
    name: "Germany Q4",
    href: "/campaigns/3",
    status: "RUNNING",
    statusLabel: "Running",
    mode: "DRY_RUN",
    modeLabel: "Dry run",
    isDraft: false,
    sender: "Sent by Ali",
    audience: "150 people",
    percent: 26,
    progressText: "First email 120 of 150 sent · 2 follow-ups",
    progressTitle: "120 of 450 emails dealt with",
    dates: ["Started 3 Oct 2026, 14:05"],
    pauseReason: null,
  };
  const draft: CampaignListView = {
    ...running,
    id: 4,
    name: "Norway prints",
    href: "/campaigns/4/setup/sender",
    status: "DRAFT",
    statusLabel: "Draft",
    mode: null,
    modeLabel: null,
    isDraft: true,
    sender: "No sender chosen yet",
    audience: "12 people ticked",
    percent: null,
    progressText: null,
    progressTitle: null,
    dates: ["Last changed 2 hours ago"],
  };

  it("shows name, status, mode, sender, audience, progress and dates", () => {
    const out = html(createElement(CampaignList, { items: [running, draft] }));
    expect(out).toContain('href="/campaigns/3"');
    expect(out).toContain("Germany Q4");
    expect(out).toContain("Dry run");
    expect(out).toContain("Sent by Ali");
    expect(out).toContain("150 people");
    expect(out).toContain("First email 120 of 150 sent · 2 follow-ups");
    expect(out).toContain("Started 3 Oct 2026, 14:05");
    expect(out).toContain('role="progressbar"');
    // Drafts continue in the wizard.
    expect(out).toContain('href="/campaigns/4/setup/sender"');
    expect(out).toContain("Continue setting up");
    expect((out.match(/role="progressbar"/g) ?? []).length).toBe(1);
  });

  it("has tabs with counts, the active one underlined, Cancelled only when needed", () => {
    const counts = { ...emptyTabCounts(), drafts: 2, running: 1 };
    const out = html(createElement(CampaignTabs, { active: "running", counts }));
    const labels = [...out.matchAll(/<a[^>]*>(.*?)<\/a>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "|").replace(/\|+/g, " ").trim());
    expect(labels).toEqual(["Drafts 2", "Scheduled 0", "Running 1", "Paused 0", "Finished 0"]);
    expect(out).toMatch(/aria-current="page"[^>]*>Running/);
    expect(out).toContain('href="/campaigns?tab=drafts"');
    expect(html(createElement(CampaignTabs, { active: "cancelled", counts }))).toContain("Cancelled");
  });

  it("pages with Previous and Next, and hides for a single page", () => {
    expect(html(createElement(ListPager, { page: 1, pageCount: 1, total: 3, noun: ["person", "people"], hrefFor: () => "/" }))).toBe("");
    const out = html(createElement(ListPager, { page: 2, pageCount: 3, total: 120, noun: ["person", "people"], hrefFor: (p: number) => `/x?page=${p}` }));
    expect(out).toContain("Page 2 of 3 · 120 people");
    expect(out).toContain('href="/x?page=1"');
    expect(out).toContain('href="/x?page=3"');
  });
});

describe("the campaign page", () => {
  it("shows progress per step and the counts, with the dry-run note", () => {
    const card = html(
      createElement(CampaignProgressCard, {
        percent: 26,
        doneText: "26% done · 120 emails of 450",
        steps: [
          { step: 0, title: "First email", text: "First email 120 of 150 sent", timing: null },
          { step: 1, title: "Follow-up 1", text: "Follow-up 1: 40 waiting, next on 14 Oct", timing: "Sent 3 days after the first email if there's no reply" },
        ],
      }),
    );
    expect(card).toContain("First email 120 of 150 sent");
    expect(card).toContain("Follow-up 1: 40 waiting, next on 14 Oct");
    expect(card).not.toMatch(ORANGE);
    const grid = html(
      createElement(CampaignResultsGrid, {
        results: { sent: 120, delivered: 0, bounced: 0, replied: 0, unsubscribed: 0, complained: 0 },
        note: "Dry run: delivery results appear only when you simulate them in the dry-run outbox.",
      }),
    );
    for (const label of ["Sent", "Delivered", "Bounced", "Replied", "Unsubscribed", "Complained"]) expect(grid).toContain(label);
    expect(grid).toContain(">120<");
    expect(grid).toContain("Dry run: delivery results appear only when you simulate them in the dry-run outbox.");
  });

  it("lists people with their state, company and flags; each opens the side panel", () => {
    const rows: RecipientRowView[] = [
      {
        id: 21,
        href: "/campaigns/3?recipient=21",
        name: "Anna Berg",
        email: "anna@acme.de",
        companyName: "Acme",
        companyHref: "/contacts?company=5",
        stateText: "Waiting for follow-up 1 on 14 Oct",
        lastSent: "First email sent 3 Oct",
        edited: true,
        problem: false,
        leftOut: false,
      },
      {
        id: 22,
        href: "/campaigns/3?recipient=22",
        name: "General inbox",
        email: "info@gone.de",
        companyName: "Gone GmbH (deleted)",
        companyHref: null,
        stateText: "Stopped: didn't send",
        lastSent: null,
        edited: false,
        problem: true,
        leftOut: false,
      },
    ];
    const out = html(createElement(RecipientTable, { rows, selectedId: 21 }));
    expect(out).toContain('href="/campaigns/3?recipient=21"');
    expect(out).toContain('href="/contacts?company=5"');
    expect(out).toContain("Waiting for follow-up 1 on 14 Oct");
    expect(out).toContain("Stopped: didn&#x27;t send");
    expect(out).toContain("Edited");
    expect(out).toContain("Needs a look");
    expect(out).toContain('data-state="selected"');
    expect(out).toContain("Gone GmbH (deleted)");
  });
});

describe("the dry-run outbox", () => {
  it("lists emails newest first with who, which campaign and when", () => {
    const out = html(
      createElement(OutboxList, {
        openId: 7,
        rows: [
          {
            id: 7,
            href: "/campaigns/outbox?open=7",
            subject: "3D models for Acme",
            to: "anna@acme.de",
            companyName: "Acme",
            campaignName: "Germany Q4",
            stepTitle: "First email",
            sentAt: "3 Oct 2026, 14:05",
            sentAtIso: "2026-10-03T12:05:00.000Z",
            sentAgo: "7 days ago",
          },
        ],
      }),
    );
    expect(out).toContain('href="/campaigns/outbox?open=7"');
    expect(out).toContain("3D models for Acme");
    expect(out).toContain("To anna@acme.de · Acme · Germany Q4, first email");
    expect(out).toContain('aria-current="true"');
  });

  it("shows one email with From, To, Subject, the text and a fully sandboxed HTML version", () => {
    const out = html(
      createElement(OutboxEmailView, {
        timeZone: "Europe/Berlin",
        email: {
          id: 7,
          campaignId: 3,
          campaignName: "Germany Q4",
          step: 0,
          toEmail: "anna@acme.de",
          companyName: "Acme",
          subject: "3D models for Acme",
          fromAddress: "Ali from Polygon Paradise <ali@your-sending-domain>",
          senderName: "Ali",
          sentAt: new Date("2026-10-03T12:05:00Z"),
          text: "Hi Anna,\n\nHello.\n\n--\nPolygon Paradise\nIf you'd rather not hear from us, unsubscribe here: %unsubscribe_url%",
          html: '<p>Hi Anna,</p><script>alert(1)</script><p><a href="%unsubscribe_url%">unsubscribe</a></p>',
          messageId: "pp.abc@dry-run.invalid",
          inReplyTo: null,
          references: null,
          recipientId: 21,
          companyId: 5,
          personId: 9,
        },
      }),
    );
    expect(out).toContain("Ali from Polygon Paradise &lt;ali@your-sending-domain&gt;");
    expect(out).toContain("anna@acme.de");
    expect(out).toContain("3D models for Acme");
    expect(out).toContain("3 Oct 2026, 14:05");
    expect(out).toContain("&lt;pp.abc@dry-run.invalid&gt;");
    expect(out).toContain("Plain text");
    expect(out).toContain("HTML version");
    expect(out).toContain('href="/campaigns/3?recipient=21"');
    expect(out).toContain("Mailgun turns %unsubscribe_url% into");
  });

  it("renders the stored HTML only inside a fully sandboxed frame", () => {
    const out = html(createElement(EmailHtmlFrame, { html: '<p>Hi</p><script>alert(1)</script>' }));
    expect(out).toMatch(/^<iframe /);
    expect(out).toContain('sandbox=""');
    expect(out).toMatch(/srcdoc="&lt;p&gt;Hi&lt;\/p&gt;&lt;script&gt;/i);
    expect(out).not.toContain("<script>");
    expect(html(createElement(EmailHtmlFrame, { html: "" }))).toContain("No HTML version was stored.");
  });
});

describe("the Contacts Sequence column", () => {
  function row(id: number, over: Partial<ContactRow> = {}): ContactRow {
    return {
      id,
      code: `C-${id}`,
      name: `Company ${id}`,
      subline: null,
      status: "CONTACTED",
      priority: "NORMAL",
      countryCode: null,
      countryName: null,
      niche: null,
      peopleCount: 1,
      emailCount: 1,
      lastEmailedLabel: "Never",
      lastEmailedTitle: null,
      addedLabel: "5 Jan 2026",
      tags: [],
      custom: {},
      ...over,
    };
  }
  const noop = () => undefined;

  it("shows the sequence text, or a dash when there's none", () => {
    const out = html(
      createElement(CompaniesTable, {
        rows: [row(1, { sequenceLabel: "Waiting for follow-up 1 on 14 Oct (dry run)", sequenceTitle: "Germany Q4" }), row(2)],
        total: 2,
        page: 1,
        pageCount: 1,
        pageSize: 50,
        sort: "lastEmailed",
        dir: "desc",
        customColumns: [],
        columnVisibility: {},
        onColumnVisibilityChange: noop,
        onSortChange: noop,
        onPageChange: noop,
        selected: new Set<number>(),
        onToggleRow: noop,
        onTogglePage: noop,
        onOpen: noop,
        companyHref: (id: number) => `/contacts?company=${id}`,
        loading: false,
      }),
    );
    expect(out).toContain("Waiting for follow-up 1 on 14 Oct (dry run)");
    expect(out).toContain('title="Waiting for follow-up 1 on 14 Oct (dry run) · Germany Q4"');
    expect(out).toContain('title="Not in a campaign yet"');
  });
});
