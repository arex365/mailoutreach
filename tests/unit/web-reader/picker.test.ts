import { describe, expect, it } from "vitest";
import {
  PICKER_MAX_ROBOTS_CHECKS,
  PICKER_MAX_SEGMENTS,
  PICKER_MAX_URL_CHARS,
  canonicalWord,
  pickSecondPage,
  type PickerLink,
} from "@/core/ai/picker";

/** M5-DESIGN §3.4.7 and §8 P3 "Picker table" (research B7 scores, bonuses, exclusions, ties, robots). */

const nav = (href: string, text: string): PickerLink => ({ href, text, inNav: true });
const body = (href: string, text: string): PickerLink => ({ href, text, inNav: false });

function pick(homepage: string, links: PickerLink[], lang: string | null = null, isAllowed?: (url: string) => boolean | undefined) {
  return pickSecondPage({ homepage: new URL(homepage), homepageLang: lang, links, isAllowed });
}

describe("pickSecondPage", () => {
  it("English: a portfolio beats about and services", () => {
    const home = "https://studio.example/";
    const r = pick(home, [nav(`${home}about-us`, "About us"), nav(`${home}services`, "Services"), nav(`${home}portfolio`, "Portfolio")], "en");
    expect(r).toEqual({ url: "https://studio.example/portfolio", score: 7.5 });
  });

  it.each([
    ["über-uns", "https://figuren.example/%C3%BCber-uns"],
    ["percent-encoded über-uns", "https://figuren.example/%C3%BCber-uns"],
    ["ueber-uns", "https://figuren.example/ueber-uns"],
    ["uber-uns", "https://figuren.example/uber-uns"],
  ])("German: %s scores as about", (_label, href) => {
    const r = pick("https://figuren.example/", [nav(href, "Mehr erfahren")], "de");
    expect(r?.url).toBe(href);
    expect(r?.score).toBe(5.5);
  });

  it("German: the anchor text 'Über uns' counts even when the path says nothing", () => {
    const r = pick("https://figuren.example/", [body("https://figuren.example/seite-7", "Über uns")], "de");
    expect(r).toEqual({ url: "https://figuren.example/seite-7", score: 4.5 });
  });

  it("German: Galerie beats Über uns; Impressum and Kontakt are never picked", () => {
    const home = "https://www.figuren.example/";
    const links = [
      nav(`${home}impressum`, "Impressum"),
      nav(`${home}kontakt`, "Kontakt"),
      nav(`${home}ueber-uns`, "Über uns"),
      nav(`${home}galerie`, "Galerie"),
    ];
    expect(pick(home, links, "de")?.url).toBe(`${home}galerie`);
    expect(pick(home, links.slice(0, 2), "de")).toBeNull();
  });

  it("Norwegian: prosjekter (portfolio) and om-oss (about)", () => {
    const home = "https://verksted.example/";
    expect(pick(home, [nav(`${home}om-oss`, "Om oss"), nav(`${home}prosjekter`, "Prosjekter")], "nb")?.url).toBe(`${home}prosjekter`);
    expect(pick(home, [nav(`${home}om-oss`, "Om oss")], "nb")).toEqual({ url: `${home}om-oss`, score: 5.5 });
    expect(pick(home, [nav(`${home}portef%C3%B8lje`, "Portefølje")], "nb")).toEqual({ url: `${home}portef%C3%B8lje`, score: 7.5 });
  });

  it("Norwegian: produkter wins over the excluded handlekurv", () => {
    const home = "https://butikk.example/";
    const links = [nav(`${home}handlekurv`, "Handlekurv"), nav(`${home}produkter`, "Produkter"), nav(`${home}om-oss`, "Om oss")];
    expect(pick(home, links, "nb")).toEqual({ url: `${home}produkter`, score: 6.5 });
  });

  it("Shopify: /collections/all in the header beats /pages/about and product pages", () => {
    const home = "https://www.gridshop.example/";
    const links = [
      nav(`${home}`, "Home"),
      nav(`${home}collections/all`, "Catalog"),
      nav(`${home}pages/about`, "About"),
      nav(`${home}cart`, "Cart"),
      nav(`${home}account/login`, "Log in"),
      body(`${home}products/wyvern-bust`, "Wyvern bust kit"),
    ];
    expect(pick(home, links, "en")).toEqual({ url: `${home}collections/all`, score: 5.5 });
  });

  it.each([
    ["https://figuren.example/impressum", "Impressum"],
    ["https://figuren.example/warenkorb", "Warenkorb"],
    ["https://butikk.example/handlekurv", "Handlekurv"],
    ["https://figuren.example/galerie/katalog.pdf", "Galerie (PDF)"],
    ["https://figuren.example/galerie/drache.JPG", "Galerie"],
    ["mailto:info@figuren.example", "Galerie"],
    ["tel:+490000000", "Portfolio"],
    ["javascript:void(0)", "Gallery"],
    ["https://figuren.example/wp-admin/", "Gallery"],
    ["https://figuren.example/tag/galerie", "Galerie"],
    ["https://figuren.example/datenschutz", "Datenschutz"],
    ["https://figuren.example/portfolio", "Contact us"],
  ])("never picks %s (%s)", (href, text) => {
    expect(pick("https://figuren.example/", [nav(href, text)], "de")).toBeNull();
  });

  it("keeps links on the same registrable domain only (hosted subdomains stay distinct)", () => {
    expect(pick("https://figuren.example/", [nav("https://other.example/galerie", "Galerie")])).toBeNull();
    expect(pick("https://www.figuren.example/", [nav("https://shop.figuren.example/produkte", "Shop")])?.url).toBe(
      "https://shop.figuren.example/produkte",
    );
    expect(pick("https://anna.wixsite.com/figuren", [nav("https://bob.wixsite.com/galerie", "Galerie")])).toBeNull();
  });

  it("drops fragments and query strings, and the homepage itself", () => {
    const r = pick("https://figuren.example/start", [
      nav("https://figuren.example/start#galerie", "Galerie"),
      nav("https://figuren.example/galerie?utm_source=nav#top", "Galerie"),
    ]);
    expect(r?.url).toBe("https://figuren.example/galerie");
  });

  it("finds multi-word keywords anywhere in a segment or anchor, and excluded ones too", () => {
    const home = "https://figuren.example/";
    expect(pick(home, [body(`${home}seite/mehr-wir-ueber-uns`, "Mehr")])).toEqual({ url: `${home}seite/mehr-wir-ueber-uns`, score: 3.5 });
    expect(pick(home, [body(`${home}seite-7`, "Mehr über uns erfahren")])).toEqual({ url: `${home}seite-7`, score: 4.5 });
    expect(pick(home, [body(`${home}galerie/wp-admin`, "Galerie")])).toBeNull();
    expect(pick(home, [body(`${home}galerie`, "Galerie und Kontakt")])).toBeNull();
  });

  it("no scored link means homepage only", () => {
    expect(pick("https://figuren.example/", [nav("https://figuren.example/neuigkeiten", "Neuigkeiten")])).toBeNull();
    expect(pick("https://figuren.example/", [])).toBeNull();
  });

  it("ties go to the shorter path, then to the first link", () => {
    const home = "https://studio.example/";
    const tie = pick(home, [nav(`${home}gallery-page`, "Gallery"), nav(`${home}gallery`, "Gallery")]);
    expect(tie).toEqual({ url: `${home}gallery`, score: 7.5 });
    expect(pick(home, [nav(`${home}werke`, "Werke"), nav(`${home}works`, "Works")])?.url).toBe(`${home}werke`);
  });

  it("uses the best score of a URL linked several times", () => {
    const home = "https://studio.example/";
    const r = pick(home, [body(`${home}shop`, "Shop"), nav(`${home}shop`, "Shop")], "en");
    expect(r).toEqual({ url: `${home}shop`, score: 6.5 });
  });

  it("gives +0.5 for the homepage's language or an /en/ variant, and none for another language", () => {
    const home = "https://figuren.example/de/";
    const r = pick(home, [body(`${home.replace("/de/", "/fr/")}galerie`, "Galerie"), body("https://figuren.example/de/galerie", "Galerie")], "de");
    expect(r).toEqual({ url: "https://figuren.example/de/galerie", score: 6.5 });
    const en = pick(home, [body("https://figuren.example/en/gallery", "Gallery")], "de");
    expect(en).toEqual({ url: "https://figuren.example/en/gallery", score: 6.5 });
  });

  it("passes over a candidate the cached robots rules disallow; undefined counts as allowed", () => {
    const home = "https://studio.example/";
    const links = [nav(`${home}portfolio`, "Portfolio"), nav(`${home}about`, "About")];
    const disallowPortfolio = (url: string) => (url.endsWith("/portfolio") ? false : true);
    expect(pick(home, links, "en", disallowPortfolio)?.url).toBe(`${home}about`);
    expect(pick(home, links, "en", () => undefined)?.url).toBe(`${home}portfolio`);
    expect(pick(home, links, "en", () => false)).toBeNull();
  });

  it(`asks robots.txt about the best ${PICKER_MAX_ROBOTS_CHECKS} candidates at most`, () => {
    const home = "https://studio.example/";
    const links = Array.from({ length: 50 }, (_, i) => nav(`${home}gallery-${i}`, "Gallery"));
    const asked: string[] = [];
    const refuseAll = (url: string) => {
      asked.push(url);
      return false;
    };
    expect(pick(home, links, "en", refuseAll)).toBeNull();
    expect(asked).toHaveLength(PICKER_MAX_ROBOTS_CHECKS);
    const allowEleventh = (url: string) => url.endsWith("gallery-10");
    expect(pick(home, links, "en", allowEleventh)).toBeNull();
    const allowTenth = (url: string) => url.endsWith("gallery-9");
    expect(pick(home, links, "en", allowTenth)?.url).toBe(`${home}gallery-9`);
  });

  it("only picks links the reader's URL rules accept: another port is never picked", () => {
    const home = "https://studio.example/";
    const links = [nav("https://studio.example:8443/portfolio", "Portfolio"), nav(`${home}about`, "About")];
    expect(pick(home, links, "en")).toEqual({ url: `${home}about`, score: 5.5 });
    // A test server's own port is the homepage's, so its links stay candidates.
    expect(pick("http://127.0.0.1:4567/", [nav("http://127.0.0.1:4567/galerie", "Galerie")])?.url).toBe("http://127.0.0.1:4567/galerie");
    const isFetchable = (u: URL) => !u.pathname.startsWith("/portfolio");
    const both = [nav(`${home}portfolio`, "Portfolio"), nav(`${home}about`, "About")];
    expect(pickSecondPage({ homepage: new URL(home), homepageLang: "en", links: both, isFetchable })?.url).toBe(`${home}about`);
  });

  it("drops overlong and deep links before any keyword or robots work", () => {
    const home = "https://studio.example/";
    const long = nav(`${home}portfolio/${"a".repeat(PICKER_MAX_URL_CHARS)}`, "Portfolio");
    const deep = nav(`${home}${"x/".repeat(PICKER_MAX_SEGMENTS)}portfolio`, "Portfolio");
    const withQuery = nav(`${home}about?${"utm=x&".repeat(100)}`, "About");
    expect(pick(home, [long, deep])).toBeNull();
    expect(pick(home, [long, deep, withQuery])?.url).toBe(`${home}about`);
  });

  it.each([
    // 500 path segments each: the old per-keyword string search took 3.6 to 5.5 s for these.
    ["deep", Array.from({ length: 2_000 }, (_, i) => nav(`https://studio.example/${"x/".repeat(500)}${i}`, "x ".repeat(100)))],
    // As many tokens as fit under the length cap, and long anchor texts.
    ["wordy", Array.from({ length: 2_000 }, (_, i) => nav(`https://studio.example/${"a-b-c-d-e-".repeat(25)}${i}`, "word ".repeat(40)))],
  ])("scores 2,000 hostile %s links in milliseconds (keywords are looked up per token run)", (_label, links) => {
    const t0 = performance.now();
    expect(pick("https://studio.example/", links)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("keeps a site builder's own site distinct (anna.wordpress.com is not bob.wordpress.com)", () => {
    expect(pick("https://anna.wordpress.com/", [nav("https://bob.wordpress.com/gallery", "Gallery")])).toBeNull();
    expect(pick("https://anna.wordpress.com/", [nav("https://wordpress.com/about", "About")])).toBeNull();
    expect(pick("https://anna.wordpress.com/", [nav("https://anna.wordpress.com/gallery", "Gallery")])?.url).toBe("https://anna.wordpress.com/gallery");
  });
});

describe("canonicalWord", () => {
  it("folds diacritics and the digraph spellings together", () => {
    expect(canonicalWord("%C3%BCber-uns")).toBe(canonicalWord("ueber-uns"));
    expect(canonicalWord("Über uns")).toBe(canonicalWord("uber uns"));
    expect(canonicalWord("Portefølje")).toBe("portefolje");
    expect(canonicalWord("vilkår")).toBe("vilkar");
    expect(canonicalWord("%E0%A4%A")).toBe("%e0%a4%a");
  });
});
