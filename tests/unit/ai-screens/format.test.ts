import { describe, expect, it } from "vitest";
import {
  aiLinesHref,
  checkedLine,
  currentLineText,
  EDIT_TOO_LONG_TEXT,
  editCounterText,
  EMPTY_TABS,
  lowerFirst,
  pagerNoun,
  parseAiTab,
  readLine,
  runText,
  runWhenText,
  safeHttpUrl,
  stopDialogText,
  tabLabel,
  toDraftCardDisplay,
} from "@/components/ai-lines/format";
import { draftCostLine, draftDialogTexts, draftMonthLine, PRACTICE_COST_LINE, type DraftDialogFacts } from "@/components/ai/draft-lines-text";
import { navBadgeText } from "@/components/shell/nav-items";
import type { ActiveRun, DraftCardView } from "@/server/services/ai/queue";

/**
 * The words of the AI screens (docs/dev/M5-DESIGN.md §6.7, §6.8): the queue's tabs, cards, run cards and empty tabs,
 * and the "Draft personal lines" dialog's lines for every case (counts, cost, month, over the limit, no key for the
 * Owner and a Member, too many, the panel's one company, the practice copy).
 */

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-03T12:00:00Z");

describe("the AI lines page's tabs and addresses", () => {
  it("links each tab and page, and reads ?tab= back", () => {
    expect(aiLinesHref("waiting")).toBe("/ai-lines");
    expect(aiLinesHref("approved")).toBe("/ai-lines?tab=approved");
    expect(aiLinesHref("no-line", 3)).toBe("/ai-lines?tab=no-line&page=3");
    expect(aiLinesHref("waiting", 2)).toBe("/ai-lines?page=2");
    expect(parseAiTab("failed")).toBe("failed");
    expect(parseAiTab("nonsense")).toBe("waiting");
    expect(parseAiTab(undefined)).toBe("waiting");
  });

  it("labels tabs with their counts and names the pager's items", () => {
    expect(tabLabel("waiting", 27)).toBe("Waiting (27)");
    expect(tabLabel("approved", 1400)).toBe("Approved (1,400)");
    expect(tabLabel("no-line", 9)).toBe("No line (9)");
    expect(pagerNoun("waiting")).toEqual(["line", "lines"]);
    expect(pagerNoun("failed")).toEqual(["company", "companies"]);
  });

  it("has the design's empty state for every tab", () => {
    expect(EMPTY_TABS.waiting).toEqual({
      title: "Nothing to review.",
      description: "On Contacts, select companies and choose Draft personal lines.",
      next: "contacts",
    });
    expect(EMPTY_TABS.approved.title + " " + EMPTY_TABS.approved.description).toBe(
      "No approved lines yet. Approve lines on the Waiting tab.",
    );
    expect(EMPTY_TABS.rejected.title).toBe("No rejected lines.");
    expect(EMPTY_TABS["no-line"].title).toBe("Every drafted company got a line.");
    expect(EMPTY_TABS.failed.title).toBe("Nothing failed.");
  });
});

function card(over: Partial<DraftCardView> = {}): DraftCardView {
  return {
    id: 7,
    status: "READY",
    company: { id: 42, name: "Firma GmbH", website: "https://www.firma.de/", host: "firma.de" },
    line: "You sell 32mm fantasy wargame miniatures in resin.",
    finalLine: null,
    words: 8,
    snippet: { before: "Welcome. ", match: "32mm fantasy wargame miniatures", after: " in resin." },
    snippetNote: null,
    quote: "32mm fantasy wargame miniatures",
    evidenceUrl: "https://www.firma.de/galerie",
    evidenceHost: "firma.de",
    pageLang: "de",
    readAt: "2026-10-03T08:00:00.000Z",
    flags: [],
    noLineText: null,
    error: null,
    requestId: null,
    currentLine: null,
    reviewedText: null,
    canUndoUntil: null,
    costText: "$0.006",
    ...over,
  };
}

describe("the review cards' lines", () => {
  it("says the website's language and when it was read", () => {
    expect(readLine({ pageLang: "de", readAt: "2026-10-03T08:00:00.000Z" }, TZ, NOW)).toBe("German website · read 3 Oct");
    expect(readLine({ pageLang: "nb", readAt: null }, TZ, NOW)).toBe("Norwegian website");
    expect(readLine({ pageLang: null, readAt: "2026-10-03T08:00:00.000Z" }, TZ, NOW)).toBe("Read 3 Oct");
    expect(readLine({ pageLang: "xx", readAt: null }, TZ, NOW)).toBeNull();
    expect(checkedLine("2026-10-03T08:00:00.000Z", TZ, NOW)).toBe("Checked 3 Oct");
    expect(checkedLine(null, TZ, NOW)).toBeNull();
  });

  it("words the line an approval replaces, keeping AI in capitals", () => {
    expect(currentLineText({ line: "Your busts are great.", sourceText: "Written by Ali on 3 Mar" })).toBe(
      "Replaces the current line: “Your busts are great.” (written by Ali on 3 Mar)",
    );
    expect(currentLineText({ line: "L", sourceText: "AI, approved by Sara on 3 Mar" })).toBe(
      "Replaces the current line: “L” (AI, approved by Sara on 3 Mar)",
    );
    expect(currentLineText({ line: "L", sourceText: "" })).toBe("Replaces the current line: “L”");
    expect(currentLineText(null)).toBeNull();
    expect(lowerFirst("Imported")).toBe("imported");
    expect(lowerFirst("AI")).toBe("AI");
  });

  it("counts words for the edit box and says the 300-character rule", () => {
    expect(editCounterText(22)).toBe("22 words (aim for 25 or fewer)");
    expect(editCounterText(1)).toBe("1 word (aim for 25 or fewer)");
    expect(EDIT_TOO_LONG_TEXT).toBe("Keep the personal line under 300 characters. Shorter lines read better.");
  });

  it("links only plain web addresses (website text is untrusted)", () => {
    expect(safeHttpUrl("https://firma.de/galerie")).toBe("https://firma.de/galerie");
    expect(safeHttpUrl("http://firma.de")).toBe("http://firma.de/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it("builds the card the client shows: meta line, words, safe links and which flags are notes", () => {
    const shown = toDraftCardDisplay(
      card({
        evidenceUrl: "javascript:alert(1)",
        flags: [
          { code: "name-not-found", text: "Mentions “Leipzig”, which isn't on the website." },
          { code: "metadata-only", text: "Only the website's description could be read." },
        ],
        currentLine: { line: "Old line.", sourceText: "Written by Ali on 3 Mar" },
      }),
      TZ,
      NOW,
    );
    expect(shown.metaLine).toBe("German website · read 3 Oct");
    expect(shown.wordsText).toBe("8 words");
    expect(shown.pageHref).toBeNull();
    expect(shown.websiteHref).toBe("https://www.firma.de/");
    expect(shown.flags.map((f) => f.note)).toEqual([false, true]);
    expect(shown.currentLineText).toBe("Replaces the current line: “Old line.” (written by Ali on 3 Mar)");

    const approved = toDraftCardDisplay(card({ status: "APPROVED", finalLine: "An edited line.", words: 3 }), TZ, NOW);
    expect(approved.line).toBe("An edited line.");
    const noLine = toDraftCardDisplay(
      card({ status: "NO_LINE", line: null, snippet: null, quote: null, noLineText: "Domain is parked or for sale", words: 0 }),
      TZ,
      NOW,
    );
    expect(noLine.metaLine).toBe("Checked 3 Oct");
    expect(noLine.wordsText).toBeNull();
  });
});

function run(over: Partial<ActiveRun> = {}): ActiveRun {
  return {
    jobId: 5,
    total: 30,
    done: 12,
    spentUsd: 0.07,
    status: "RUNNING",
    waitingUntil: null,
    requestedByName: "Ali",
    deferred: null,
    ...over,
  };
}

describe("the run cards", () => {
  const ctx = { timeZone: TZ, now: NOW, anotherRunning: false };

  it("running", () => {
    expect(runText(run(), ctx)).toBe("Drafting lines for 30 companies: 12 done, $0.07 so far. Started by Ali.");
    expect(runText(run({ total: 1, done: 0, spentUsd: 0, requestedByName: null }), ctx)).toBe("Drafting a line for 1 company: 0 done, $0 so far.");
  });

  it("queued, behind the current run or not", () => {
    expect(runText(run({ status: "QUEUED", total: 20, done: 0, requestedByName: null }), { ...ctx, anotherRunning: true })).toBe(
      "Waiting to start: 20 companies, after the current run.",
    );
    expect(runText(run({ status: "QUEUED", total: 20, done: 0, requestedByName: null }), ctx)).toBe("Waiting to start: 20 companies.");
  });

  it("deferred: the reason and the time in the viewer's zone", () => {
    const waitingUntil = "2026-10-03T12:05:00.000Z"; // 14:05 in Berlin
    const deferred = (d: ActiveRun["deferred"]) => runText(run({ status: "QUEUED", waitingUntil, deferred: d, requestedByName: null }), ctx);
    expect(deferred("rate-limited")).toBe("Waiting: Claude asked us to slow down. Drafting goes on at 14:05.");
    expect(deferred("paused")).toBe("Waiting: AI drafting is paused. The app checks again at 14:05.");
    expect(deferred("yield")).toBe("Waiting: a smaller drafting run goes first. Drafting goes on at 14:05.");
    expect(deferred("retry-later")).toBe("Waiting: Claude couldn't be reached. Drafting goes on at 14:05.");
    expect(deferred(null)).toBe("Waiting: drafting goes on at 14:05.");
    expect(runWhenText("2026-10-04T07:30:00.000Z", TZ, NOW)).toBe("4 Oct at 09:30");
  });

  it("the Stop dialog says how many companies are taken off", () => {
    expect(stopDialogText({ total: 30, done: 12 })).toBe(
      "The 18 companies not drafted yet are taken off the list. Lines already drafted stay.",
    );
    expect(stopDialogText({ total: 1, done: 0 })).toBe("The 1 company not drafted yet is taken off the list. Lines already drafted stay.");
  });
});

function facts(over: Partial<DraftDialogFacts> = {}, estimate: Partial<DraftDialogFacts["estimate"]> = {}): DraftDialogFacts {
  return {
    single: false,
    companyName: null,
    companies: 40,
    toDraft: 30,
    skipped: { deleted: 0, noWebsite: 4, socialOnly: 2, hasLine: 1, waiting: 3 },
    redraftable: 1,
    redraft: false,
    estimate: {
      aboutUsd: 0.168,
      atMostUsd: 0.315,
      modelLabel: "Claude Haiku 4.5",
      practiceCopy: false,
      priceMissing: false,
      overLimit: false,
      mayReachLimit: false,
      monthly: { limitUsd: 20, spentUsd: 3.1, monthLabel: "October", resetLabel: "1 November" },
      ...estimate,
    },
    blocker: null,
    isOwner: true,
    hasKey: true,
    ...over,
  };
}

describe("the Draft personal lines dialog", () => {
  it("counts, skip lines, the redraft checkbox, cost and month", () => {
    const t = draftDialogTexts(facts());
    expect(t.title).toBe("Draft personal lines");
    expect(t.intro).toBe(
      "Claude reads each company's website and suggests one sentence about their work. You review every line before it's used in an email.",
    );
    expect(t.countLine).toBe("30 companies will be drafted.");
    expect(t.skipLines).toEqual([
      "4 have no website",
      "2 only have an Instagram or other social link",
      "3 already have a line being drafted or waiting for review",
    ]);
    expect(t.hasLineLine).toBe("1 already has a personal line");
    expect(t.redraftLabel).toBe("Draft new lines for these too (1)");
    expect(t.costLine).toBe("About $0.17, at most $0.32 with Claude Haiku 4.5.");
    expect(t.monthLine).toBe("This month: $3.10 of your $20 limit used.");
    expect(t.warning).toBeNull();
    expect(t.buttonLabel).toBe("Draft 30 lines");
    expect(t.canStart).toBe(true);
  });

  it("singular words, deleted companies, and the may-reach-the-limit warning", () => {
    const t = draftDialogTexts(
      facts({ toDraft: 1, skipped: { deleted: 2, noWebsite: 1, socialOnly: 1, hasLine: 0, waiting: 1 }, redraftable: 2 }, { mayReachLimit: true }),
    );
    expect(t.countLine).toBe("1 company will be drafted.");
    expect(t.skipLines).toEqual([
      "2 were deleted",
      "1 has no website",
      "1 only has an Instagram or other social link",
      "1 already has a line being drafted or waiting for review",
    ]);
    expect(t.hasLineLine).toBe("2 already have a personal line");
    expect(t.warning).toBe("This may reach your monthly limit. Drafting stops when it's reached.");
    expect(t.buttonLabel).toBe("Draft 1 line");
  });

  it("over the monthly limit: the A6 error, the start disabled", () => {
    const blocker = "AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until 1 November.";
    const t = draftDialogTexts(facts({ blocker }, { overLimit: true, mayReachLimit: true, monthly: { limitUsd: 20, spentUsd: 20.4, monthLabel: "October", resetLabel: "1 November" } }));
    expect(t.blocker).toBe(blocker);
    expect(t.warning).toBeNull();
    expect(t.monthLine).toBe("This month: $20.40 of your $20 limit used.");
    expect(t.canStart).toBe(false);
  });

  it("no key: the Owner gets a link to Settings › AI, a Member doesn't", () => {
    const owner = draftDialogTexts(facts({ hasKey: false, blocker: "Add your Anthropic API key in Settings › AI first." }));
    expect(owner.blocker).toBe("Add your Anthropic API key in Settings › AI first.");
    expect(owner.showSettingsLink).toBe(true);
    const member = draftDialogTexts(facts({ hasKey: false, isOwner: false, blocker: "Ask the Owner to add an Anthropic API key in Settings › AI." }));
    expect(member.blocker).toBe("Ask the Owner to add an Anthropic API key in Settings › AI.");
    expect(member.showSettingsLink).toBe(false);
  });

  it("too many and nothing to draft", () => {
    const many = draftDialogTexts(facts({ toDraft: 1240, blocker: "That's 1,240 companies. Draft at most 1,000 at a time." }));
    expect(many.blocker).toBe("That's 1,240 companies. Draft at most 1,000 at a time.");
    expect(many.canStart).toBe(false);
    const none = draftDialogTexts(facts({ toDraft: 0, blocker: "None of these companies can be drafted." }));
    expect(none.countLine).toBeNull();
    expect(none.costLine).toBeNull();
    expect(none.skipLines.length).toBeGreaterThan(0);
    expect(none.canStart).toBe(false);
  });

  it("the panel's one company: its own title, no counts, the skip sentence as the refusal", () => {
    const t = draftDialogTexts(facts({ single: true, companyName: "Firma GmbH", toDraft: 1, redraftable: 1, redraft: true }));
    expect(t.title).toBe("Draft a personal line for Firma GmbH");
    expect(t.countLine).toBeNull();
    expect(t.skipLines).toEqual([]);
    expect(t.redraftLabel).toBeNull();
    expect(t.buttonLabel).toBe("Draft line");
    const skipped = draftDialogTexts(
      facts({ single: true, companyName: "Firma GmbH", toDraft: 0, blocker: "Firma GmbH has no website, so there's nothing to read." }),
    );
    expect(skipped.blocker).toBe("Firma GmbH has no website, so there's nothing to read.");
    expect(skipped.canStart).toBe(false);
  });

  it("the practice copy: made-up lines for free, no month line, no key needed", () => {
    const t = draftDialogTexts(facts({ hasKey: false }, { practiceCopy: true, aboutUsd: 0, atMostUsd: 0 }));
    expect(t.costLine).toBe(PRACTICE_COST_LINE);
    expect(PRACTICE_COST_LINE).toBe("The practice copy writes made-up lines for free. No website is read.");
    expect(t.monthLine).toBeNull();
    expect(t.showSettingsLink).toBe(false);
  });

  it("a model without a price shows no cost line (the refusal says why)", () => {
    const t = draftDialogTexts(facts({ blocker: "No price is saved for the model “claude-x”. Enter its prices in Settings › AI." }, { priceMissing: true }));
    expect(t.costLine).toBeNull();
    expect(t.canStart).toBe(false);
  });

  it("cost and month lines on their own", () => {
    expect(draftCostLine({ aboutUsd: 5.91, atMostUsd: 12.77, modelLabel: "Claude Sonnet 5" })).toBe("About $5.91, at most $12.77 with Claude Sonnet 5.");
    expect(draftCostLine({ aboutUsd: 0.001, atMostUsd: 0.002, modelLabel: "X" })).toBe("Less than $0.01, at most less than $0.01 with X.");
    expect(draftMonthLine({ limitUsd: 12.5, spentUsd: 0 })).toBe("This month: $0 of your $12.50 limit used.");
  });
});

describe("the sidebar badge", () => {
  it("is hidden at 0 and caps at 99+", () => {
    expect(navBadgeText(0)).toBeNull();
    expect(navBadgeText(undefined)).toBeNull();
    expect(navBadgeText(Number.NaN)).toBeNull();
    expect(navBadgeText(27)).toBe("27");
    expect(navBadgeText(120)).toBe("99+");
  });
});
