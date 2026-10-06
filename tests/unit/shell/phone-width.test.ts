import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { renderEmail } from "@/core/templates/email";
import { mergeVariables } from "@/core/templates/variables";
import type { CampaignListView } from "@/components/campaigns/format";
import type { ContactRow } from "@/components/contacts/types";
import type { AiQueueTab } from "@/core/ai/types";
import type { DraftCardDisplay } from "@/components/ai-lines/format";
import type { TeamRow } from "@/components/settings/types";
import type { TemplateListItem } from "@/components/templates/format";
import type { ReviewDetail, ReviewPage } from "@/server/services/campaigns/draft";
import { parseMarkup, phoneWidthProblems } from "./truncate-chain";

// Server Actions can't load outside Next; nothing here calls them while rendering.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/templates/actions", () => ({
  createTemplateAction: vi.fn(),
  duplicateTemplateAction: vi.fn(),
  renameTemplateAction: vi.fn(),
  deleteTemplateAction: vi.fn(),
  starTemplateAction: vi.fn(),
  saveTemplateAction: vi.fn(),
  previewTemplateAction: vi.fn(),
  searchPreviewPeopleAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/sending/actions", () => ({
  switchToDryRunAction: vi.fn(),
  connectMailgunAction: vi.fn(),
  forgetMailgunKeysAction: vi.fn(),
  setSendingModeAction: vi.fn(),
  saveTestListAction: vi.fn(),
  pauseAllAction: vi.fn(),
  resumeSendingAction: vi.fn(),
  saveRetentionAction: vi.fn(),
  continueFollowUpsAction: vi.fn(),
  goLiveAction: vi.fn(),
  checkWithMailgunAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/team/actions", () => ({
  inviteTeammateAction: vi.fn(),
  newInviteLinkAction: vi.fn(),
  resetPasswordLinkAction: vi.fn(),
  switchOffAction: vi.fn(),
  switchOnAction: vi.fn(),
  makeOwnerAction: vi.fn(),
}));
vi.mock("@/app/(app)/ai-lines/actions", () => ({
  approveDraftAction: vi.fn(),
  rejectDraftAction: vi.fn(),
  undoDraftAction: vi.fn(),
  regenerateDraftAction: vi.fn(),
  retryDraftAction: vi.fn(),
  stopDraftRunAction: vi.fn(),
  resumeAiAction: vi.fn(),
}));
vi.mock("@/app/(app)/campaigns/[id]/setup/actions", () => ({
  renameDraftAction: vi.fn(),
  deleteDraftAction: vi.fn(),
  continueAction: vi.fn(),
  reviewDetailAction: vi.fn(),
  setIncludedAction: vi.fn(),
  editRecipientEmailAction: vi.fn(),
  resetRecipientEmailAction: vi.fn(),
  setCompanyLineAction: vi.fn(),
  setPersonLineAction: vi.fn(),
}));
vi.mock("@/app/(app)/campaigns/[id]/setup/test-send-actions", () => ({ testSendInfoAction: vi.fn(), sendMeATestAction: vi.fn() }));

const { TemplateList } = await import("@/components/templates/template-list");
const { CompaniesTable } = await import("@/components/contacts/companies-table");
const { CampaignList } = await import("@/components/campaigns/campaign-list");
const { TestListEditor } = await import("@/components/settings/sending/test-list-editor");
const { TeamManager } = await import("@/components/settings/team-manager");
const { AiLinesQueue } = await import("@/components/ai-lines/ai-lines-queue");
const { ReviewStep, ReviewPersonView } = await import("@/components/campaign-wizard/review-step");

/**
 * Phone width (M6-DESIGN §4.1, §5.1 R10; review SCREENS-04…08, SCREENS-12, the AI lines tab row and the wizard's Review
 * step): long values end in "…" (or scroll inside their own box) instead of making the page wider than the screen.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

/**
 * Nothing in the markup can widen a phone's page, and the check isn't empty-handed: with `grid-cols-1` and `min-w-0`
 * taken out again, the same markup is flagged.
 */
function expectFits(out: string, { unfixedIsFlagged = true } = {}) {
  expect(phoneWidthProblems(out)).toEqual([]);
  if (!unfixedIsFlagged) return;
  const unfixed = out.replace(
    / class="([^"]*)"/g,
    (_, c: string) => ` class="${c.split(/\s+/).filter((x) => x !== "grid-cols-1" && x !== "min-w-0").join(" ")}"`,
  );
  expect(phoneWidthProblems(unfixed).length).toBeGreaterThan(0);
}

const LONG_COMPANY = "Architekturbüro Müller-Schmidt & Partner Modellbau und Miniaturen GmbH";
const LONG_HOST = "architekturbuero-mueller-schmidt-modellbau.example";
const LONG_EMAIL = "muhammad.ali.hassan-rahman@architekturbuero-mueller-schmidt.example";

describe("the check itself: it finds each pattern the review found", () => {
  it("flags the old Templates, Contacts, Campaigns, test list, AI lines and Review markup", () => {
    // SCREENS-04: li.flex in ul.grid (auto column), no min-w-0.
    expect(
      phoneWidthProblems(
        '<ul class="grid gap-3"><li class="flex flex-wrap items-start gap-3 p-4 sm:flex-nowrap"><div class="min-w-0 flex-1"><p class="mt-1 truncate text-sm">Subject: {Print-ready 3D models|3D models} for {{company}}</p></div></li></ul>',
      ),
    ).toHaveLength(1);
    // SCREENS-05: the phone card list.
    expect(
      phoneWidthProblems(
        '<ul class="grid gap-2 px-4 md:hidden"><li class="flex items-start gap-3 p-3"><button class="grid min-w-0 flex-1 gap-1.5"><span class="flex items-start justify-between gap-2"><span class="min-w-0"><span class="block truncate">x</span></span><span class="shrink-0">Contacted</span></span></button></li></ul>',
      ).length,
    ).toBeGreaterThan(0);
    // SCREENS-06: li.grid and the flex row without min-w-0.
    expect(
      phoneWidthProblems(
        '<ul class="grid gap-3"><li class="grid gap-3 p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div class="grid min-w-0 gap-1"><div class="flex min-w-0 flex-wrap items-center gap-2"><a class="max-w-full truncate">Worldwide Directory</a></div></div></div></li></ul>',
      ),
    ).toHaveLength(1);
    // SCREENS-08.
    expect(
      phoneWidthProblems('<ul class="grid gap-1"><li class="flex items-center justify-between gap-2 px-3"><span class="min-w-0 truncate">polygon.paradise.test@outlook.com</span><button>Remove</button></li></ul>'),
    ).toHaveLength(1);
    // The AI lines tab row: a sideways-scrolling row whose nav sits in an auto column.
    expect(
      phoneWidthProblems('<div class="grid gap-4"><nav aria-label="AI line tabs" class="border-b"><ul class="-mb-px flex gap-1 overflow-x-auto"><li class="shrink-0"><a>Waiting (27)</a></li></ul></nav></div>'),
    ).toHaveLength(1);
    // The Review step: the person card in the section's auto column.
    expect(
      phoneWidthProblems(
        '<section class="grid gap-4"><div class="grid gap-3 p-4"><div class="flex flex-wrap items-start justify-between gap-3"><div class="min-w-0"><p class="truncate text-sm">a@b.example · Alpen</p></div></div></div></section>',
      ),
    ).toHaveLength(1);
  });

  it("accepts grid-cols-1, min-w-0 chains, a clipping box and anything hidden on a phone", () => {
    expect(phoneWidthProblems('<ul class="grid grid-cols-1 gap-3"><li class="flex min-w-0"><p class="truncate">x</p></li></ul>')).toEqual([]);
    expect(phoneWidthProblems('<div class="grid gap-3"><div class="min-w-0"><p class="truncate">x</p></div></div>')).toEqual([]);
    expect(phoneWidthProblems('<div class="grid"><div class="overflow-x-auto"><table><tr><td class="truncate">x</td></tr></table></div></div>')).toEqual([]);
    expect(phoneWidthProblems('<div class="grid"><div class="hidden md:block"><div class="flex"><p class="truncate">x</p></div></div></div>')).toEqual([]);
    expect(phoneWidthProblems('<div class="grid md:grid-cols-2"><div class="flex"><p class="truncate">x</p></div></div>')).toHaveLength(1);
    expect(phoneWidthProblems('<p><span class="truncate">inline</span></p>')).toHaveLength(1);
  });

  it("reads React's markup", () => {
    const root = parseMarkup('<div class="grid md:hidden [overflow-wrap:anywhere]"><img src="x"/><span>a</span></div>');
    const div = root.children[0]!;
    expect([...div.cls]).toEqual(["grid", "[overflow-wrap:anywhere]"]);
    expect(div.children.map((c) => c.tag)).toEqual(["img", "span"]);
  });
});

describe("Templates (SCREENS-04)", () => {
  const master: TemplateListItem = {
    id: 1,
    name: "Master sequence",
    isMaster: true,
    summary: "First email + 3 follow-ups (1 switched off)",
    subject: "{Print-ready 3D models|3D models} for {{company}} and every other studio you run",
    changed: "Changed 3 days ago by you",
    changedTitle: "27 Sept 2026, 10:00",
  };
  it("the master's long subject and a long name end in … on a phone", () => {
    const out = html(createElement(TemplateList, { templates: [master, { ...master, id: 2, isMaster: false, name: LONG_COMPANY }] }));
    expectFits(out);
    expect(out).toMatch(/<ul class="grid grid-cols-1 gap-3" aria-label="Templates">/);
  });
});

describe("Contacts on a phone (SCREENS-05)", () => {
  const row: ContactRow = {
    id: 1,
    code: "C-1042",
    name: LONG_COMPANY,
    subline: LONG_HOST,
    status: "NOT_CONTACTED",
    priority: "NORMAL",
    countryCode: "DE",
    countryName: "Germany",
    niche: "miniatures",
    peopleCount: 2,
    emailCount: 1,
    lastEmailedLabel: "Never",
    lastEmailedTitle: null,
    addedLabel: "5 Jan 2026",
    tags: [],
    custom: {},
  };
  it("a long company name and website host are cut, the status stays in the card", () => {
    const noop = () => undefined;
    const out = html(
      createElement(CompaniesTable, {
        rows: [row],
        total: 1,
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
    expectFits(out);
    expect(out).toContain('<ul class="grid grid-cols-1 gap-2 px-4 md:hidden" aria-label="Companies">');
  });
});

describe("Campaigns (SCREENS-06)", () => {
  const item: CampaignListView = {
    id: 3,
    name: "Worldwide Directory – architects and interior designers (Q4) with a very long list name",
    href: "/campaigns/3",
    status: "RUNNING",
    statusLabel: "Running",
    mode: "LIVE",
    modeLabel: "Live",
    isDraft: false,
    sender: "Sent by Arslan",
    audience: "120 people",
    percent: 40,
    progressText: "First email 48 of 120 sent · 2 follow-ups",
    progressTitle: "40% done",
    dates: ["Started 3 days ago"],
    pauseReason: null,
  };
  it("a long campaign name ends in … and the Open button stays on the screen", () => {
    const out = html(createElement(CampaignList, { items: [item, { ...item, id: 4, status: "DRAFT", isDraft: true, mode: null, modeLabel: null, percent: null }] }));
    expectFits(out);
  });
});

describe("Test list (SCREENS-08)", () => {
  it("a long test address is cut and Remove stays in the card", () => {
    const out = html(createElement(TestListEditor, { addresses: ["polygon.paradise.test.mailbox@outlook.example", "ana@example.com"], warnings: [] }));
    expectFits(out);
    expect(out).toContain('title="polygon.paradise.test.mailbox@outlook.example"');
  });
});

describe("Team (SCREENS-12)", () => {
  const owner: TeamRow = {
    id: 1,
    name: "Arslan",
    email: "arslan.mahmood.polygonparadise@gmail.example",
    role: "OWNER",
    status: "ACTIVE",
    lastSignIn: "23 Sept 2026, 14:02",
    lastSignInAgo: "just now",
    pendingLink: null,
    isYou: true,
    activeCampaigns: [],
    waitingReplies: 0,
  };
  it("the phone's email line breaks anywhere, and the table scrolls inside a named, focusable region", () => {
    const out = html(createElement(TeamManager, { rows: [owner, { ...owner, id: 2, name: "Ali", email: LONG_EMAIL, role: "MEMBER", isYou: false }] }));
    expect(out).toMatch(/<div data-slot="table-container" class="[^"]*overflow-x-auto[^"]*" role="region" aria-label="Team" tabindex="0">/);
    const emailLines = [...out.matchAll(/<div class="([^"]*md:hidden[^"]*)">([^<]*)<\/div>/g)].filter((m) => m[2]!.includes("@"));
    expect(emailLines.map((m) => m[2])).toEqual([owner.email, LONG_EMAIL]);
    for (const m of emailLines) expect(m[1]).toContain("[overflow-wrap:anywhere]");
    // The table's own sideways scroll stays inside its region; nothing else here is cut.
    expectFits(out, { unfixedIsFlagged: false });
  });
});

describe("AI lines (the tab row made the page 505 px wide at 390 px)", () => {
  const card: DraftCardDisplay = {
    id: 7,
    status: "READY",
    companyId: 42,
    companyName: LONG_COMPANY,
    host: LONG_HOST,
    websiteHref: `https://www.${LONG_HOST}/`,
    metaLine: "German website · read 3 Oct",
    line: "You sell 32mm fantasy wargame miniatures in resin.",
    wordsText: "8 words",
    snippet: null,
    snippetNote: null,
    quote: null,
    pageHref: null,
    flags: [],
    noLineText: null,
    error: null,
    requestId: null,
    currentLineText: null,
    reviewedText: null,
    canUndoUntil: null,
    costText: "$0.003",
  };
  const counts: Record<AiQueueTab, number> = { waiting: 27, approved: 140, rejected: 12, "no-line": 9, failed: 1 };
  it("the tabs scroll inside their own named row, in a one-column grid", () => {
    for (const cards of [[], [card]]) {
      const out = html(
        createElement(AiLinesQueue, {
          tab: "waiting",
          counts,
          cards,
          page: 1,
          pageCount: 2,
          emptyPrimary: true,
        }),
      );
      expectFits(out);
      expect(out).toMatch(/^<div class="grid grid-cols-1 gap-4"><nav aria-label="AI line tabs" class="min-w-0 border-b border-border"><ul class="[^"]*overflow-x-auto/);
    }
  });

  it("a long website host breaks instead of pushing the card wider", () => {
    const out = html(createElement(AiLinesQueue, { tab: "waiting", counts, cards: [card], page: 1, pageCount: 1, emptyPrimary: true }));
    const hostSpan = out.match(/<span class="([^"]*)">· <!-- -->architekturbuero/)?.[1] ?? out.match(/<span class="([^"]*)">· architekturbuero/)?.[1];
    expect(hostSpan).toContain("[overflow-wrap:anywhere]");
  });
});

describe("the wizard's Review step (401 px at 390 px)", () => {
  const variables = mergeVariables([]);
  const page = {
    filter: "all",
    q: "",
    page: 1,
    pageCount: 1,
    total: 1,
    items: [
      {
        personId: 1,
        recipientId: 11,
        companyId: 5,
        companyName: LONG_COMPANY,
        name: "Muhammad Ali Hassan-Rahman",
        email: LONG_EMAIL,
        willGet: true,
        edited: true,
        missing: 2,
        textProblems: 1,
        reason: null,
        canInclude: true,
      },
    ],
    counts: { all: 1, missing: 1, text: 1, edited: 1, excluded: 0 },
    steps: [0, 1],
    missingEmails: 2,
    textProblems: [],
    editedTextProblems: 0,
    renderError: null,
    totals: {},
  } as unknown as ReviewPage;

  it("the list of people: long names, companies and addresses are cut", () => {
    const out = html(createElement(ReviewStep, { campaignId: 7, page, variables, initialPersonId: 1 }));
    expectFits(out);
    expect(out).toContain('class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"');
  });

  it("one person's card and emails stay inside the screen", () => {
    const email = renderEmail({
      step: 0,
      subject: "3D models for {{company}}",
      body: "Hello {{first_name}},\n\nhttps://www.polygonparadise.example/portfolio/character-figurines-and-creatures-for-printing",
      personId: 1,
      values: { first_name: "Muhammad", company: LONG_COMPANY },
      footer: { companyName: "Polygon Paradise", address: "55th Avenue, Lahore", unsubscribeText: "Unsubscribe here:" },
      purpose: "preview",
    });
    const detail = {
      personId: 1,
      recipientId: 11,
      companyId: 5,
      companyCode: "C-5",
      companyName: LONG_COMPANY,
      name: "Muhammad Ali Hassan-Rahman",
      email: LONG_EMAIL,
      willGet: true,
      ticked: true,
      canInclude: true,
      reason: null,
      companyCanPutBack: false,
      personalLine: null,
      personalLineOverride: null,
      emails: [
        {
          step: 0,
          title: "First email",
          delayDays: 0,
          email,
          edited: true,
          editedBy: "Ali",
          editedAt: null,
          source: { subject: "3D models for {{company}}", body: "Hello" },
          campaignSource: { subject: "3D models for {{company}}", body: "Hello" },
        },
      ],
      renderError: null,
    } satisfies ReviewDetail;
    const noop = () => undefined;
    const out = html(
      createElement(ReviewPersonView, {
        campaignId: 7,
        detail,
        busy: false,
        loading: false,
        onSetIncluded: noop,
        onEditLine: noop,
        onEdit: noop,
        onReset: noop,
      }),
    );
    expectFits(out);
    expect(out).toMatch(/^<section aria-label="Emails for Muhammad Ali Hassan-Rahman" class="grid grid-cols-1 gap-4">/);
    expect(out).toContain("Edit this person&#x27;s email");
    expect(out).toContain("Reset to campaign text");
  });
});
