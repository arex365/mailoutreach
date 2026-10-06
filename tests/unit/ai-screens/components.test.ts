import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DraftCardDisplay } from "@/components/ai-lines/format";
import type { AiSettingsView } from "@/server/services/ai/settings";

/**
 * The AI screens rendered to HTML (docs/dev/M5-DESIGN.md §6.5, §6.7, §6.9): each review card type (snippet highlight,
 * missing snapshot texts, warnings, the line Approve replaces, cost), the tabs and empty states, the paused banner for
 * the Owner and a Member, the run cards, the pager, the classes that keep 390 px screens usable, the sidebar badge, the
 * company panel's personal line section and the Settings › AI forms. Only one orange button per screen.
 */

// Server Actions can't load outside Next (server-only); nothing here calls them.
vi.mock("@/app/(app)/ai-lines/actions", () => ({
  approveDraftAction: vi.fn(),
  rejectDraftAction: vi.fn(),
  undoDraftAction: vi.fn(),
  regenerateDraftAction: vi.fn(),
  retryDraftAction: vi.fn(),
  stopDraftRunAction: vi.fn(),
  resumeAiAction: vi.fn(),
}));
vi.mock("@/app/(app)/contacts/ai-actions", () => ({ estimateDraftLinesAction: vi.fn(), startDraftLinesAction: vi.fn() }));
vi.mock("@/app/(app)/settings/ai/actions", () => ({
  saveAnthropicKeyAction: vi.fn(),
  removeAnthropicKeyAction: vi.fn(),
  saveAiModelAction: vi.fn(),
  saveAiLimitAction: vi.fn(),
  saveAiPricesAction: vi.fn(),
}));
vi.mock("@/components/company-panel/actions", () => ({ setCompanyPersonalLineAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/ai-lines",
}));

const { DraftCard } = await import("@/components/ai-lines/draft-card");
const { AiLinesQueue } = await import("@/components/ai-lines/ai-lines-queue");
const { RunCard } = await import("@/components/ai-lines/run-card");
const { AiPausedCard } = await import("@/components/ai/ai-paused-card");
const { DraftLinesButton } = await import("@/components/ai/draft-lines-dialog");
const { PHONE_FULL_SCREEN_DIALOG } = await import("@/components/ai/phone-dialog");
const { Sidebar } = await import("@/components/shell/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { PersonalLineSection, DRAFTING_TEXT, WAITING_TEXT } = await import("@/components/company-panel/personal-line");
const { AnthropicKeyForm } = await import("@/components/settings/ai/anthropic-key-form");
const { AiModelForm } = await import("@/components/settings/ai/ai-model-form");
const { AiLimitForm } = await import("@/components/settings/ai/ai-limit-form");
const { AiPricesForm } = await import("@/components/settings/ai/ai-prices-form");

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
/** Orange buttons (PLAN A6: only the screen's primary action is orange; lists never are). */
const ORANGE = /data-variant="default"/g;

function card(over: Partial<DraftCardDisplay> = {}): DraftCardDisplay {
  return {
    id: 7,
    status: "READY",
    companyId: 42,
    companyName: "Firma GmbH",
    host: "firma.de",
    websiteHref: "https://www.firma.de/",
    metaLine: "German website · read 3 Oct",
    line: "You sell 32mm fantasy wargame miniatures in resin.",
    wordsText: "8 words",
    snippet: { before: "Willkommen. ", match: "Handbemalte 32mm Miniaturen", after: " aus Resin." },
    snippetNote: null,
    quote: "Handbemalte 32mm Miniaturen",
    pageHref: "https://www.firma.de/galerie",
    flags: [],
    noLineText: null,
    error: null,
    requestId: null,
    currentLineText: null,
    reviewedText: null,
    canUndoUntil: null,
    costText: "$0.006",
    ...over,
  };
}

describe("review cards", () => {
  it("waiting: the line, words, the quote marked in its snippet, the page link, warnings, the line it replaces, the cost", () => {
    const out = html(
      createElement(DraftCard, {
        card: card({
          flags: [
            { code: "name-not-found", text: "Mentions “Leipzig”, which isn't on the website.", note: false },
            { code: "metadata-only", text: "Only the website's description could be read.", note: true },
          ],
          currentLineText: "Replaces the current line: “Old line.” (written by Ali on 3 Mar)",
        }),
      }),
    );
    const t = text(out);
    expect(out).toContain('href="/contacts?company=42"');
    expect(t).toContain("Firma GmbH");
    expect(t).toContain("· firma.de");
    expect(t).toContain("German website · read 3 Oct");
    expect(t).toContain("You sell 32mm fantasy wargame miniatures in resin.");
    expect(t).toContain("8 words");
    expect(t).toContain("Based on this on their website:");
    expect(out).toContain("<mark");
    expect(out).toMatch(/<mark[^>]*>Handbemalte 32mm Miniaturen<\/mark>/);
    expect(out).toContain('href="https://www.firma.de/galerie"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
    expect(t).toContain("Open the page");
    expect(t).toContain("Mentions “Leipzig”, which isn't on the website.");
    expect(t).toContain("Only the website's description could be read.");
    expect(t).toContain("Replaces the current line: “Old line.” (written by Ali on 3 Mar)");
    expect(t).toContain("$0.006");
    for (const b of ["Approve", "Edit then approve", "Reject", "Regenerate"]) expect(t).toContain(b);
    expect(out.match(ORANGE)).toBeNull();
    // The button row wraps on a phone.
    expect(out).toContain("flex flex-wrap items-center gap-2");
  });

  it("missing snapshot texts: the quote with the note instead of a snippet", () => {
    const cleared = text(
      html(
        createElement(DraftCard, {
          card: card({ snippet: null, snippetNote: "The saved page text was cleared; open the page to check the quote." }),
        }),
      ),
    );
    expect(cleared).toContain("The saved page text was cleared; open the page to check the quote.");
    expect(cleared).toContain("“Handbemalte 32mm Miniaturen”");
    const notFound = text(html(createElement(DraftCard, { card: card({ snippet: null, snippetNote: "The exact words weren't found on the saved page." }) })));
    expect(notFound).toContain("The exact words weren't found on the saved page.");
  });

  it("never links a page address that isn't http(s)", () => {
    const out = html(createElement(DraftCard, { card: card({ pageHref: null }) }));
    expect(out).not.toContain("Open the page");
    expect(out).not.toContain("javascript:");
  });

  it("approved: the final line, who approved it, Regenerate, and Undo only while it may be undone", () => {
    const until = new Date(Date.now() + 8_000).toISOString();
    const withUndo = text(
      html(createElement(DraftCard, { card: card({ status: "APPROVED", reviewedText: "Approved by Ali on 3 Oct · edited", canUndoUntil: until }) })),
    );
    expect(withUndo).toContain("Approved by Ali on 3 Oct · edited");
    expect(withUndo).toContain("Regenerate");
    expect(withUndo).toContain("Undo");
    expect(withUndo).not.toContain("Edit then approve");
    const later = text(html(createElement(DraftCard, { card: card({ status: "APPROVED", reviewedText: "Approved by Ali on 3 Oct" }) })));
    expect(later).not.toContain("Undo");
  });

  it("rejected: who rejected it, Approve and Regenerate", () => {
    const t = text(html(createElement(DraftCard, { card: card({ status: "REJECTED", reviewedText: "Rejected by Sara on 3 Oct" }) })));
    expect(t).toContain("Rejected by Sara on 3 Oct");
    expect(t).toContain("Approve");
    expect(t).toContain("Regenerate");
    expect(t).not.toContain("Reject ");
  });

  it("no line: the reason, when it was checked, Try again and Write one yourself", () => {
    const out = html(
      createElement(DraftCard, {
        card: card({
          status: "NO_LINE",
          line: null,
          wordsText: null,
          snippet: null,
          quote: null,
          pageHref: null,
          metaLine: "Checked 3 Oct",
          noLineText: "Domain is parked or for sale",
        }),
      }),
    );
    const t = text(out);
    expect(t).toContain("Domain is parked or for sale");
    expect(t).toContain("Checked 3 Oct");
    expect(t).toContain("Try again");
    expect(t).toContain("Write one yourself");
    expect(out).toContain('href="/contacts?company=42#company-panel-line"');
    expect(out).toContain('href="https://www.firma.de/"');
    expect(t).not.toContain("Based on this on their website:");
  });

  it("failed: the sentence and the request id behind Details", () => {
    const out = html(
      createElement(DraftCard, {
        card: card({
          status: "FAILED",
          line: null,
          wordsText: null,
          snippet: null,
          quote: null,
          metaLine: "Checked 3 Oct",
          error: "Claude couldn't write a line for this company. Click Try again later.",
          requestId: "req_fake_12",
        }),
      }),
    );
    const t = text(out);
    expect(t).toContain("Claude couldn't write a line for this company. Click Try again later.");
    expect(out).toContain("<details");
    expect(t).toContain("Details");
    expect(t).toContain("Request id req_fake_12");
    expect(t).toContain("Try again");
  });
});

const COUNTS = { waiting: 0, approved: 140, rejected: 12, "no-line": 9, failed: 1 };

describe("the review queue", () => {
  it("tabs with counts, the active one underlined in orange, scrolling sideways on a phone", () => {
    const out = html(createElement(AiLinesQueue, { tab: "approved", counts: COUNTS, cards: [], page: 1, pageCount: 1, emptyPrimary: true }));
    const t = text(out);
    for (const label of ["Waiting (0)", "Approved (140)", "Rejected (12)", "No line (9)", "Failed (1)"]) expect(t).toContain(label);
    expect(out).toContain("overflow-x-auto");
    expect(out).toMatch(/aria-current="page"[^>]*>Approved \(140\)/);
    expect(out).toContain('href="/ai-lines?tab=failed"');
    expect(out).toContain("bg-brand");
  });

  it("each tab's empty state; Go to Contacts is the page's primary unless Resume is", () => {
    const waiting = html(createElement(AiLinesQueue, { tab: "waiting", counts: COUNTS, cards: [], page: 1, pageCount: 1, emptyPrimary: true }));
    expect(text(waiting)).toContain("Nothing to review.");
    expect(text(waiting)).toContain("On Contacts, select companies and choose Draft personal lines.");
    expect(waiting).toMatch(/data-variant="default"[^>]*href="\/contacts"|href="\/contacts"[^>]*data-variant="default"/);
    const paused = html(createElement(AiLinesQueue, { tab: "waiting", counts: COUNTS, cards: [], page: 1, pageCount: 1, emptyPrimary: false }));
    expect(paused.match(ORANGE)).toBeNull();
    const cases: Array<[Parameters<typeof AiLinesQueue>[0]["tab"], string]> = [
      ["approved", "No approved lines yet.Approve lines on the Waiting tab."],
      ["rejected", "No rejected lines."],
      ["no-line", "Every drafted company got a line."],
      ["failed", "Nothing failed."],
    ];
    for (const [tab, words] of cases) {
      const out = html(createElement(AiLinesQueue, { tab, counts: { ...COUNTS, [tab]: 0 }, cards: [], page: 1, pageCount: 1, emptyPrimary: true }));
      expect(text(out)).toContain(words);
      expect(text(out)).toContain("Open the Waiting tab");
      expect(out.match(ORANGE)).toBeNull();
    }
  });

  it("cards and the pager (20 per page)", () => {
    const out = html(
      createElement(AiLinesQueue, {
        tab: "waiting",
        counts: { ...COUNTS, waiting: 45 },
        cards: [card(), card({ id: 8, companyId: 43, companyName: "Butikk AS" })],
        page: 2,
        pageCount: 3,
        emptyPrimary: true,
      }),
    );
    const t = text(out);
    expect(t).toContain("Firma GmbH");
    expect(t).toContain("Butikk AS");
    expect(t).toContain("Page 2 of 3 · 45 lines");
    expect(out).toContain('href="/ai-lines?page=3"');
    expect(out).toContain('href="/ai-lines"');
    expect(out.match(ORANGE)).toBeNull();
  });
});

describe("the paused banner", () => {
  const PAUSE = "AI drafting paused: Anthropic didn't accept the API key. Paste a new key in Settings › AI, then click Resume drafting.";

  it("the Owner resumes (the page's primary action)", () => {
    const out = html(createElement(AiPausedCard, { text: PAUSE, isOwner: true }));
    expect(text(out)).toContain(PAUSE);
    expect(text(out)).toContain("Resume drafting");
    expect(out.match(ORANGE)?.length).toBe(1);
    expect(out).toContain("border-warning/40");
  });

  it("a Member reads who can fix it", () => {
    const out = html(createElement(AiPausedCard, { text: PAUSE, isOwner: false }));
    expect(text(out)).toContain("The Owner can fix this in Settings › AI.");
    expect(out).not.toContain("<button");
    expect(out.match(ORANGE)).toBeNull();
  });
});

describe("run cards", () => {
  it("running: the sentence, a neutral progress bar and Stop", () => {
    const out = html(
      createElement(RunCard, {
        run: {
          jobId: 5,
          status: "RUNNING",
          total: 30,
          done: 12,
          text: "Drafting lines for 30 companies: 12 done, $0.07 so far. Started by Ali.",
          stopText: "The 18 companies not drafted yet are taken off the list. Lines already drafted stay.",
        },
      }),
    );
    expect(text(out)).toContain("Drafting lines for 30 companies: 12 done, $0.07 so far. Started by Ali.");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="40"');
    expect(out).not.toContain("bg-brand");
    expect(text(out)).toContain("Stop");
    expect(out.match(ORANGE)).toBeNull();
    expect(out).toContain("flex flex-wrap items-start justify-between gap-3");
  });

  it("queued and deferred: the sentence and Stop, no bar before anything was drafted", () => {
    const queued = html(
      createElement(RunCard, {
        run: { jobId: 6, status: "QUEUED", total: 20, done: 0, text: "Waiting to start: 20 companies, after the current run.", stopText: "x" },
      }),
    );
    expect(text(queued)).toContain("Waiting to start: 20 companies, after the current run.");
    expect(queued).not.toContain('role="progressbar"');
    const deferred = html(
      createElement(RunCard, {
        run: { jobId: 7, status: "QUEUED", total: 20, done: 4, text: "Waiting: Claude asked us to slow down. Drafting goes on at 14:05.", stopText: "x" },
      }),
    );
    expect(text(deferred)).toContain("Waiting: Claude asked us to slow down. Drafting goes on at 14:05.");
    expect(deferred).toContain('role="progressbar"');
  });
});

describe("the start dialog's pieces", () => {
  it("opens full screen on a phone", () => {
    for (const c of ["max-sm:h-dvh", "max-sm:inset-0", "max-sm:max-w-none", "overflow-y-auto"]) expect(PHONE_FULL_SCREEN_DIALOG).toContain(c);
  });

  it("the bulk bar's button: outline, disabled without ticked companies", () => {
    const out = html(createElement(DraftLinesButton, { companyIds: [1, 2, 3] }));
    expect(text(out)).toContain("Draft personal lines");
    expect(out).toContain('data-variant="outline"');
    expect(out).not.toContain('disabled=""');
    expect(html(createElement(DraftLinesButton, { companyIds: [] }))).toContain('disabled=""');
  });
});

describe("the sidebar's AI lines badge", () => {
  const render = (aiWaiting: number) => html(createElement(TooltipProvider, null, createElement(Sidebar, { counts: { aiWaiting } })));

  it("is hidden at 0", () => {
    const out = render(0);
    expect(out).toContain("AI lines");
    expect(out).not.toContain("data-nav-badge");
    expect(out).not.toContain("waiting for review");
  });

  it("shows the Waiting count, neutral, with words for screen readers", () => {
    const out = render(27);
    expect(out).toContain("data-nav-badge");
    expect(text(out)).toContain(", 27 waiting for review");
    expect(out).toMatch(/data-nav-badge[^>]*class="[^"]*bg-muted/);
    expect(out).not.toMatch(/data-nav-badge[^>]*class="[^"]*bg-(brand|primary)/);
  });
});

describe("the company panel's personal line section", () => {
  const base = { companyId: 42, readOnly: false, line: "Your busts are hand-painted.", sourceText: "Written by Ali on 3 Mar" };

  it("Draft with AI is enabled; the section says when a line is being drafted or waits for review", () => {
    const plain = html(createElement(PersonalLineSection, { view: base }));
    expect(text(plain)).toContain("Draft with AI");
    expect(plain).not.toContain("aria-disabled");
    expect(plain).not.toContain("Milestone 5");
    const drafting = text(html(createElement(PersonalLineSection, { view: { ...base, draftState: "drafting" } })));
    expect(drafting).toContain(DRAFTING_TEXT);
    expect(DRAFTING_TEXT).toBe("Drafting a line…");
    const waitingOut = html(createElement(PersonalLineSection, { view: { ...base, draftState: "waiting" } }));
    expect(text(waitingOut)).toContain(WAITING_TEXT);
    expect(WAITING_TEXT).toBe("A drafted line is waiting for review.");
    expect(waitingOut).toContain('href="/ai-lines"');
    expect(text(waitingOut)).toContain("Open AI lines");
  });

  it("read-only (a deleted company): no Draft with AI, no draft state", () => {
    const out = text(html(createElement(PersonalLineSection, { view: { ...base, readOnly: true, draftState: "waiting" } })));
    expect(out).not.toContain("Draft with AI");
    expect(out).not.toContain(WAITING_TEXT);
  });
});

describe("Settings › AI forms", () => {
  const keyView: AiSettingsView["key"] = { set: true, line: "Key ending …a1b2, saved 3 Oct by Arslan.", problem: null };

  it("the key card: the saved key's line, Save key as the primary, Remove key only when a key is saved", () => {
    const out = html(createElement(AnthropicKeyForm, { keyView, practiceLine: null, primary: true }));
    const t = text(out);
    expect(t).toContain("Key ending …a1b2, saved 3 Oct by Arslan.");
    expect(out).toContain('placeholder="sk-ant-…"');
    expect(out).toContain('type="password"');
    expect(t).toContain("Remove key");
    expect(out.match(ORANGE)?.length).toBe(1);
    const none = html(
      createElement(AnthropicKeyForm, {
        keyView: { set: false, line: "No key saved yet. In the Anthropic Console, open API keys, create a key and paste it here.", problem: null },
        practiceLine: null,
        primary: false,
      }),
    );
    expect(text(none)).toContain("No key saved yet. In the Anthropic Console, open API keys, create a key and paste it here.");
    expect(text(none)).not.toContain("Remove key");
    expect(none.match(ORANGE)).toBeNull();
    expect(text(html(createElement(AnthropicKeyForm, { keyView, practiceLine: "The practice copy never talks to Anthropic.", primary: true })))).toContain(
      "The practice copy never talks to Anthropic.",
    );
  });

  it("the model card: the radios with their amounts, the custom fields when chosen, Save model in outline", () => {
    const radios = {
      haiku: "Claude Haiku 4.5 (recommended): low cost, about $1.69 per 300 companies",
      sonnet: "Claude Sonnet 5: better at spotting specific details, about $5.91 per 300 companies",
    };
    const out = html(createElement(AiModelForm, { choice: "haiku", radios, custom: null }));
    const t = text(out);
    expect(t).toContain(radios.haiku);
    expect(t).toContain(radios.sonnet);
    expect(t).toContain("Another Claude model");
    expect(t).not.toContain("Model ID");
    expect(t).toContain("Anthropic retires older models from time to time. If drafting stops with “model not found”, pick another model here.");
    expect(out.match(ORANGE)).toBeNull();
    const custom = text(
      html(createElement(AiModelForm, { choice: "custom", radios, custom: { id: "claude-test-custom", label: "Claude Test Custom", inputPerMTok: 3, outputPerMTok: 15 } })),
    );
    expect(custom).toContain("Model ID");
    expect(custom).toContain("Input price ($ per million tokens)");
    expect(custom).toContain("Output price ($ per million tokens)");
  });

  it("the limit and price cards", () => {
    const limit = text(html(createElement(AiLimitForm, { usd: 20, spentLine: "Spent in September: $3.10 of $20 (27 drafts)." })));
    expect(limit).toContain("per month");
    expect(limit).toContain("AI drafting stops when this month's drafts have cost this much, and starts again on the 1st.");
    expect(limit).toContain("Spent in September: $3.10 of $20 (27 drafts).");
    expect(limit).toContain("Save limit");
    const prices = html(
      createElement(AiPricesForm, {
        rows: [
          { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", inputPerMTok: 1, outputPerMTok: 5 },
          { id: "claude-sonnet-5", label: "Claude Sonnet 5", inputPerMTok: 2, outputPerMTok: 10 },
        ],
      }),
    );
    const t = text(prices);
    expect(t).toContain("Claude Haiku 4.5· input $· output $");
    expect(prices).toContain('value="1"');
    expect(prices).toContain('value="10"');
    expect(t).toContain(
      "Dollars per million tokens, used for estimates and the monthly limit. Correct on 26 Sep 2026; update them if Anthropic changes its prices.",
    );
    expect(prices.match(ORANGE)).toBeNull();
    expect(prices).toContain("flex flex-wrap");
  });
});
