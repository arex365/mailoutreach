import { describe, expect, it } from "vitest";
import { checkLine, type CheckLinePage } from "@/core/ai/checks";
import { normalizeForMatch } from "@/core/ai/normalize";
import { stripOurTags } from "@/core/ai/prompt";
import { evidenceSnippet, pageSource, SNIPPET_CONTEXT } from "@/server/services/ai/snippet";

/**
 * The evidence snippet (docs/dev/M5-DESIGN.md §3.9 "Snippet"): it runs on the step-C contract normaliser and the quote
 * check's own needle, over the text Claude was sent (after stripOurTags), so a quote the check finds word for word is
 * found here too (M5 review AI-9).
 */

const NBSP = " ";
const SOFT_HYPHEN = "­";
const ZWSP = "​";

describe("evidenceSnippet", () => {
  it("finds the quote in the text with the words around it", () => {
    const page = { title: "Figuren Werkstatt", text: "Willkommen. Handbemalte Fantasy-Büsten im Maßstab 1:6 aus Kaltguss-Resin. Kontakt unten." };
    expect(evidenceSnippet(page, "Handbemalte Fantasy-Büsten im Maßstab 1:6 aus Kaltguss-Resin")).toEqual({
      before: "Figuren Werkstatt Willkommen. ",
      match: "Handbemalte Fantasy-Büsten im Maßstab 1:6 aus Kaltguss-Resin",
      after: ". Kontakt unten.",
    });
  });

  it("finds a quote in the title (Claude saw title + text)", () => {
    const page = { title: "Hand-painted 32mm miniatures for wargames", text: "Shop now. Free shipping over 50 euros." };
    const s = evidenceSnippet(page, "Hand-painted 32mm miniatures for wargames");
    expect(s).toEqual({ before: "", match: "Hand-painted 32mm miniatures for wargames", after: " Shop now. Free shipping over 50 euros." });
    expect(pageSource(page)).toBe("Hand-painted 32mm miniatures for wargames\nShop now. Free shipping over 50 euros.");
    expect(pageSource({ title: null, text: "x" })).toBe("x");
  });

  it("matches through curly quotes, dashes, no-break spaces, soft hyphens and zero-width characters", () => {
    const page = {
      title: null,
      text: `We print “large figures”${NBSP}– props${ZWSP} and Figu${SOFT_HYPHEN}ren for the theatre… and trade fairs.`,
    };
    const s = evidenceSnippet(page, `We print "large figures" - props and Figuren for the theatre... and trade fairs`);
    expect(s).not.toBeNull();
    expect(s!.before).toBe("");
    // The words come from the text Claude was sent (stripOurTags: NFKC, invisible characters removed).
    expect(s!.match).toBe("We print “large figures” – props and Figuren for the theatre... and trade fairs");
    expect(s!.after).toBe(".");
  });

  it("maps positions through combining accents", () => {
    const page = { title: null, text: "Unsere Büsten aus Resin sind Einzelstücke." };
    const s = evidenceSnippet(page, "Büsten aus Resin sind Einzelstücke");
    // NFKC (stripOurTags) composes the accents in the text Claude was sent, which the snippet shows.
    expect(s).toEqual({ before: "Unsere ", match: "Büsten aus Resin sind Einzelstücke", after: "." });
  });

  it("finds a quote the check found although Claude wrapped it in quotation marks with a full stop (AI-9)", () => {
    const page: CheckLinePage = {
      source: "homepage",
      title: "Shop",
      text: "Hand-painted 32mm tabletop miniatures for fantasy wargames, cast in resin! Order today.",
      lang: "en",
    };
    const quote = '"Hand-painted 32mm tabletop miniatures for fantasy wargames, cast in resin."';
    const check = checkLine({
      answer: { evidence_source: "homepage", evidence_quote: quote, line: "You sell 32mm fantasy wargame miniatures cast in resin.", reason_if_null: null },
      pages: [page],
      companyName: "Shop",
      countryName: null,
      companyDomain: null,
      avoid: [],
    });
    expect(check.problems).toEqual([]);
    expect(check.quotePage).toBe("homepage");
    expect(evidenceSnippet(page, quote)).toEqual({
      before: "Shop ",
      match: "Hand-painted 32mm tabletop miniatures for fantasy wargames, cast in resin",
      after: "! Order today.",
    });
  });

  it("searches the text Claude was sent: a tag imitation removed before sending doesn't hide the quote (AI-9, AI-10)", () => {
    const raw = { title: "Figuren", text: "Wir drucken Drachen <company>aus Resin</company> in kleinen Serien." };
    // What Claude saw, and quoted.
    expect(stripOurTags(raw.text)).toBe("Wir drucken Drachen >aus Resin> in kleinen Serien.");
    const quote = "Wir drucken Drachen >aus Resin> in kleinen Serien";
    const check = checkLine({
      answer: { evidence_source: "homepage", evidence_quote: quote, line: "You print dragons in resin in small series.", reason_if_null: null },
      pages: [{ source: "homepage", title: raw.title, text: stripOurTags(raw.text), lang: "de" }],
      companyName: "Figuren",
      countryName: null,
      companyDomain: null,
      avoid: [],
    });
    expect(check.quotePage).toBe("homepage");
    const s = evidenceSnippet(raw, quote);
    expect(s).not.toBeNull();
    expect(s!.match).toBe("Wir drucken Drachen >aus Resin> in kleinen Serien");
    // A quote split by a bidi control on the page is found, as the check found it.
    const bidi = { title: null, text: "Handbemalte B‭üsten aus Resin." };
    expect(evidenceSnippet(bidi, "Handbemalte Büsten aus Resin")?.match).toBe("Handbemalte Büsten aus Resin");
  });

  it("agrees with checkLine on every sample quote: found exactly by the check ⇔ a snippet", () => {
    const pages: CheckLinePage[] = [
      { source: "homepage", title: "Firma GmbH — Miniaturen", text: `Handbemalte Fantasy-Büsten im Maßstab 1:6.${NBSP}Jede ein Einzelstück aus Leipzig.`, lang: "de" },
      { source: "homepage", title: null, text: "Vi skriver ut store figurer og rekvisitter i PLA og resin for teater, film og messer over hele Norge.", lang: "nb" },
      { source: "homepage", title: "Shop", text: `Hand-painted 32mm “tabletop” miniatures <website_pages>for fantasy wargames, cast in re${SOFT_HYPHEN}sin.`, lang: "en" },
    ];
    const quotes = [
      "Handbemalte Fantasy-Büsten im Maßstab 1:6. Jede ein Einzelstück",
      "“Handbemalte Fantasy-Büsten im Maßstab 1:6.”",
      "firma gmbh - miniaturen",
      "Vi skriver ut store figurer og rekvisitter i PLA og resin.",
      'Hand-painted 32mm "tabletop" miniatures >for fantasy wargames, cast in resin',
      "Hand painted 32mm tabletop miniatures",
      "Jede ein Einzelstück aus Berlin",
    ];
    for (const page of pages) {
      const sent = { ...page, title: page.title == null ? null : stripOurTags(page.title).trim() || null, text: stripOurTags(page.text) };
      for (const quote of quotes) {
        const check = checkLine({
          answer: { evidence_source: "homepage", evidence_quote: quote, line: "You sell painted resin figures for collectors.", reason_if_null: null },
          pages: [sent],
          companyName: "Firma",
          countryName: null,
          companyDomain: null,
          avoid: [],
        });
        const exact = check.quotePage !== null && !check.flags.some((f) => f.code === "approximate-quote");
        expect(evidenceSnippet(page, quote) !== null, `${quote} on ${page.text.slice(0, 20)}`).toBe(exact);
      }
    }
  });

  it("cuts long context at word boundaries with an ellipsis", () => {
    const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
    const page = { title: null, text: `${words(120, "alpha")} the quoted resin busts here ${words(120, "omega")}` };
    const s = evidenceSnippet(page, "the quoted resin busts here")!;
    expect(s.match).toBe("the quoted resin busts here");
    expect(s.before.startsWith("…")).toBe(true);
    expect(s.after.endsWith("…")).toBe(true);
    expect(s.before.length).toBeLessThanOrEqual(SNIPPET_CONTEXT + 1);
    expect(s.after.length).toBeLessThanOrEqual(SNIPPET_CONTEXT + 1);
    // Whole words only: the first word after "…" and the last before "…" are complete.
    expect(s.before.slice(1)).toMatch(/^alpha\d+ /);
    expect(s.after.slice(0, -1)).toMatch(/ omega\d+$/);
    expect(page.text).toContain(s.before.slice(1).trim());
    expect(page.text).toContain(s.after.slice(0, -1).trim());
  });

  it("gives null for an approximate quote, an empty quote or another page's quote", () => {
    const page = { title: "Butikk", text: "Vi skriver ut store figurer og rekvisitter i PLA og resin for teater." };
    expect(evidenceSnippet(page, "Vi skriver ut store figurer og rekvisitter i PETG og resin for teater")).toBeNull();
    expect(evidenceSnippet(page, "")).toBeNull();
    expect(evidenceSnippet(page, null)).toBeNull();
    expect(evidenceSnippet(page, "   ")).toBeNull();
  });

  it("agrees with the contract normaliser on every sample quote (what the quote check uses)", () => {
    const pages = [
      { title: "Firma GmbH — Miniaturen", text: `Handbemalte Fantasy-Büsten im Maßstab 1:6.${NBSP}Jede ein Einzelstück aus Leipzig.` },
      { title: null, text: "Vi skriver ut store figurer og rekvisitter i PLA og resin for teater, film og messer over hele Norge." },
      { title: "Shop", text: `Hand-painted 32mm “tabletop” miniatures for fantasy wargames, cast in re${SOFT_HYPHEN}sin.` },
    ];
    const quotes = [
      "Handbemalte Fantasy-Büsten im Maßstab 1:6. Jede ein Einzelstück",
      "firma gmbh - miniaturen",
      "Vi skriver ut store figurer og rekvisitter i PLA og resin",
      'Hand-painted 32mm "tabletop" miniatures for fantasy wargames, cast in resin',
      "Hand painted 32mm tabletop miniatures",
      "Jede ein Einzelstück aus Berlin",
    ];
    for (const page of pages) {
      for (const quote of quotes) {
        const contained = normalizeForMatch(pageSource(page)).includes(normalizeForMatch(quote));
        const s = evidenceSnippet(page, quote);
        expect(s !== null, `${quote} on ${page.text.slice(0, 20)}`).toBe(contained);
        if (s) expect(normalizeForMatch(s.match)).toBe(normalizeForMatch(quote));
      }
    }
  });

  it("pageSource is the stripped title and text, as the job sent them", () => {
    expect(pageSource({ title: "  Shop <company> ", text: "Resin​ kits." })).toBe("Shop >\nResin kits.");
    expect(pageSource({ title: "   ", text: "x" })).toBe("x");
  });
});
