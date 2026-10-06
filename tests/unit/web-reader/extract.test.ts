import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { PAGE_TEXT_CAP } from "@/core/ai/types";
import {
  HIDDEN_TEXT_NOTE_CHARS,
  MAX_DEPTH,
  MAX_ELEMENTS,
  REFRESH_CONTENT_CAP,
  cleanLine,
  decodePage,
  extractPage,
  guessLanguage,
  jsonLdTexts,
  parseCapped,
  parseRefresh,
} from "@/server/web/extract";

/** M5-DESIGN §3.4.6: metadata, links, the iterative text walker, hidden text, consent layers, language, caps. */

const URL_ = "https://studio.example/start";
const extract = (html: string | Buffer, opts: { charset?: string | null; contentLanguage?: string | null } = {}) =>
  extractPage(typeof html === "string" ? Buffer.from(html, "utf8") : html, { finalUrl: URL_, ...opts });
const doc = (body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Studio</title>${head}</head><body>${body}</body></html>`;
const LONG = "We sculpt resin dragons and griffins for tabletop players, collectors and painting clubs across Europe.";

const TWO_MB = 2 * 1024 * 1024;
/** `prefix` + `unit` repeated to fill 2 MB (the reader's page cap). */
const fill2mb = (unit: string, prefix = "") => prefix + unit.repeat(Math.floor((TWO_MB - prefix.length) / unit.length));
/**
 * Hostile pages must not hold the worker's thread (the sending loop shares it). The old code took seconds to minutes
 * for each of these 2 MB pages; linear code needs a few milliseconds, so this bound is generous.
 */
const HOSTILE_PAGE_MS = 300;

type DomLike = { type: string; children?: DomLike[] };
const isElementNode = (n: DomLike) => n.type === "tag" || n.type === "script" || n.type === "style";

/** The deepest element nesting of a parsed document (an explicit stack, like the extractor). */
function domDepth(root: DomLike): number {
  let deepest = 0;
  const stack: Array<[DomLike, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    deepest = Math.max(deepest, depth);
    for (const child of node.children ?? []) if (isElementNode(child)) stack.push([child, depth + 1]);
  }
  return deepest;
}

/** Elements in a parsed document. */
function elementCount(root: DomLike): number {
  let n = 0;
  const stack: DomLike[] = [root];
  while (stack.length > 0) {
    for (const child of stack.pop()!.children ?? []) {
      if (isElementNode(child)) n++;
      stack.push(child);
    }
  }
  return n;
}

describe("text", () => {
  it("puts line breaks around block elements and keeps inline text together", () => {
    const r = extract(doc("<p>First <b>bold</b> line</p><div>Second line</div><ul><li>Third</li><li>Fourth item</li></ul>line<br>after"));
    expect(r.text).toBe("First bold line\nSecond line\nThird\nFourth item\nline\nafter");
  });

  it("drops lines under 3 characters and repeated lines, and collapses whitespace", () => {
    const r = extract(doc("<p>ok</p><p>  Same   line </p><p>Same line</p><p>\tNew\n line</p>"));
    expect(r.text).toBe("Same line\nNew line");
  });

  it("leaves out scripts, styles, navigation, footers, forms and controls", () => {
    const r = extract(
      doc(
        `<script>var secret = "SCRIPT";</script><style>.x{}</style><nav>NAVTEXT links</nav><div role="navigation">ROLENAV</div>
         <p>Kept paragraph</p><footer>FOOTER text</footer><div role="contentinfo">CONTENTINFO</div><button>BUTTON</button>
         <select><option>OPTION</option></select><textarea>TEXTAREA</textarea><iframe>IFRAME</iframe><svg><text>SVGTEXT</text></svg>
         <template>TEMPLATE</template><noscript>NOSCRIPT</noscript><form><label>Your name FORM</label></form>
         <div hidden>HIDDENATTR</div><div aria-hidden="true">ARIAHIDDEN</div><canvas>CANVAS</canvas>`,
      ),
    );
    expect(r.text).toBe("Kept paragraph");
  });

  it("removes CSS-hidden text and notes it when there is more than 500 characters of it", () => {
    const hidden = "Keyword stuffing for search engines only. ".repeat(14);
    const r = extract(
      doc(`<p>${LONG}</p><div style="display: none">${hidden}</div><span class="sr-only">Skip to content</span>
        <p style="opacity:0.5">Half visible text</p><p style="font-size:0.8em">Small print text</p>`),
    );
    expect(r.text).toBe(`${LONG}\nHalf visible text\nSmall print text`);
    expect(r.notes).toEqual(["hidden-text"]);
    expect(r.hiddenChars).toBeGreaterThan(500);
    for (const style of ["visibility:hidden", "font-size: 0", "opacity:0", "DISPLAY:NONE"]) {
      const s = extract(doc(`<p>${LONG}</p><p style="${style}">Invisible words here</p>`));
      expect(s.text).toBe(LONG);
      expect(s.notes).toEqual([]);
    }
    for (const cls of ["visually-hidden", "screen-reader-text", "sr-only"]) {
      expect(extract(doc(`<p>${LONG}</p><p class="a ${cls}">Reader only</p>`)).text).toBe(LONG);
    }
  });

  it("removes a small cookie layer but keeps a large element whose class happens to match", () => {
    const small = extract(doc(`<div id="usercentrics-root"><p>Wir verwenden Cookies. Alle akzeptieren?</p></div><p>${LONG}</p>`));
    expect(small.text).toBe(LONG);
    const bigText = `${LONG} `.repeat(40);
    const big = extract(doc(`<div class="cookie-wrapper"><p>${bigText}</p></div>`));
    expect(big.text).toContain("We sculpt resin dragons");
    const onBody = extract(`<html><body class="home cookies-not-set"><p>${LONG}</p></body></html>`);
    expect(onBody.text).toBe(LONG);
  });

  it("removes a small form but keeps a form wrapping the whole page (ASP.NET)", () => {
    const wrapped = `${LONG} `.repeat(40);
    expect(extract(doc(`<form id="form1"><p>${wrapped}</p></form>`)).text).toContain("We sculpt resin dragons");
    expect(extract(doc(`<p>${LONG}</p><form><p>Subscribe to our newsletter</p></form>`)).text).toBe(LONG);
  });

  it("prefers main (or role=main, or the articles) when it holds at least 300 characters", () => {
    const main = `${LONG} ${LONG} ${LONG}`;
    const r = extract(doc(`<div class="sidebar">Sidebar words</div><main><p>${main}</p></main>`));
    expect(r.text).toBe(main);
    const role = extract(doc(`<div class="sidebar">Sidebar words</div><div role="main"><p>${main}</p></div>`));
    expect(role.text).toBe(main);
    const short = extract(doc(`<div class="intro">Intro words here</div><main><p>Short main</p></main>`));
    expect(short.text).toBe("Intro words here\nShort main");
    const articles = extract(doc(`<div>Teaser text</div><article><p>${LONG}</p></article><article><p>${LONG} Again ${LONG}</p></article>`));
    expect(articles.text).toBe(`${LONG}\n${LONG} Again ${LONG}`);
  });

  describe("a main or article the visitor never sees doesn't stand for the page", () => {
    const CLAIMS = "Award-winning studio trusted by NASA and every museum in Europe, with forty sculptors on staff. ".repeat(7);
    const VISIBLE = `<div><p>${LONG}</p></div>`;

    it.each([
      ["display:none", `<div style="display:none"><main><p>${CLAIMS}</p></main></div>`],
      ["hidden", `<div hidden><main><p>${CLAIMS}</p></main></div>`],
      ["aria-hidden", `<div aria-hidden="true"><main><p>${CLAIMS}</p></main></div>`],
      ["template", `<template><main><p>${CLAIMS}</p></main></template>`],
      ["noscript", `<noscript><main><p>${CLAIMS}</p></main></noscript>`],
      ["nav", `<nav><div role="main"><p>${CLAIMS}</p></div></nav>`],
      ["footer", `<footer><main><p>${CLAIMS}</p></main></footer>`],
      ["role=contentinfo", `<div role="contentinfo"><main><p>${CLAIMS}</p></main></div>`],
      ["a hidden main itself", `<main style="visibility:hidden"><p>${CLAIMS}</p></main>`],
      ["a small cookie layer", `<div id="cookie-consent"><main><p>${CLAIMS}</p></main></div>`],
      ["a small form", `<form><main><p>${CLAIMS}</p></main></form>`],
      ["a hidden article on a page without main", `<div class="sr-only"><article><p>${CLAIMS}</p></article></div>`],
    ])("%s", (_label, hidden) => {
      const r = extract(doc(hidden + VISIBLE));
      expect(r.text).toBe(LONG);
      expect(r.text).not.toContain("NASA");
    });

    it("more than 500 characters of CSS-hidden main give the page the hidden-text note", () => {
      const r = extract(doc(`<div style="display:none"><main><p>${CLAIMS}</p></main></div>${VISIBLE}`));
      expect(CLAIMS.trim().length).toBeGreaterThan(HIDDEN_TEXT_NOTE_CHARS);
      expect(r.hiddenChars).toBeGreaterThan(HIDDEN_TEXT_NOTE_CHARS);
      expect(r.notes).toEqual(["hidden-text"]);
    });

    it("a visible main after a hidden one is still preferred, and a big wrapping form (ASP.NET) keeps its main", () => {
      const main = `${LONG} ${LONG} ${LONG}`;
      const later = extract(doc(`<div hidden><main><p>${CLAIMS}</p></main></div><div class="sidebar">Sidebar words</div><main><p>${main}</p></main>`));
      expect(later.text).toBe(main);
      const page = `${LONG} `.repeat(32).trim();
      const aspNet = extract(doc(`<form id="form1"><div class="sidebar">Sidebar words</div><main><p>${page}</p></main></form>`));
      expect(aspNet.text).toBe(page);
      const articles = extract(doc(`<div hidden><article><p>${CLAIMS}</p></article></div><div>Teaser text</div><article><p>${main}</p></article>`));
      expect(articles.text).toBe(main);
    });
  });

  it("adds img alt texts of three words or more after the text", () => {
    const r = extract(doc(`<p>${LONG}</p><img alt="Red dragon on a rock"><img alt="Logo"><img alt="  two words ">`));
    expect(r.text).toBe(`${LONG}\nRed dragon on a rock`);
  });

  it("caps the text at PAGE_TEXT_CAP characters", () => {
    const paras = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} about resin figures, busts and dragons.</p>`).join("");
    const r = extract(doc(paras));
    expect(r.text.length).toBeLessThanOrEqual(PAGE_TEXT_CAP);
    expect(r.text.length).toBeGreaterThan(PAGE_TEXT_CAP - 100);
  });

  it("removes control characters", () => {
    expect(cleanLine("a\u0000b\u0007c \u0085 d​")).toBe("abc d​");
  });
});

describe("metadata", () => {
  it("builds metaText from title, description, og tags and JSON-LD, without repeats", () => {
    const head = `<meta name="description" content="Dragons in resin.">
      <meta property="og:title" content="Studio"><meta property="og:description" content="Busts and dragons.">
      <meta property="og:site_name" content="Studio Nord">
      <script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"Studio Nord","description":"Cast by hand."},{"@type":"Person","name":"Anna"}]}</script>
      <script type="application/ld+json">{ broken json</script>
      <script type="application/ld+json">[{"@type":["Product"],"name":"Wyvern bust","description":"75mm kit."}]</script>`;
    const r = extract(doc(`<p>${LONG}</p>`, head));
    expect(r.title).toBe("Studio");
    expect(r.metaText).toBe("Studio\nDragons in resin.\nBusts and dragons.\nStudio Nord\nCast by hand.\nWyvern bust\n75mm kit.");
  });

  it("takes the page's title, not an inline SVG's tooltip title", () => {
    expect(extract(`<html><body><svg><title>Cart icon</title></svg><p>${LONG}</p></body></html>`).title).toBeNull();
    expect(extract(`<html><body><svg><title>Cart icon</title></svg><title>Real title</title></body></html>`).title).toBe("Real title");
  });

  it("keeps only the listed JSON-LD types, also with schema.org prefixes", () => {
    expect(jsonLdTexts(['{"@type":"schema:LocalBusiness","name":"Shop"}', '{"@type":"http://schema.org/WebSite","description":"Site"}', '{"@type":"Event","name":"Fair"}'])).toEqual([
      "Shop",
      "Site",
    ]);
  });

  it("collects links with absolute URLs, their text and whether they sit in the navigation", () => {
    const r = extract(
      doc(`<header><a href="/galerie">Galerie</a></header><nav><a href="ueber-uns">Über <b>uns</b></a></nav>
        <div role="navigation"><a href="https://studio.example/shop">Shop</a></div><p><a href="#top">Top</a> <a href="mailto:x@studio.example">Mail</a></p>
        <footer><a href="/impressum">Impressum</a></footer><a>no href</a>`),
    );
    expect(r.links).toEqual([
      { href: "https://studio.example/galerie", text: "Galerie", inNav: true },
      { href: "https://studio.example/ueber-uns", text: "Über uns", inNav: true },
      { href: "https://studio.example/shop", text: "Shop", inNav: true },
      { href: "https://studio.example/start#top", text: "Top", inNav: false },
      { href: "mailto:x@studio.example", text: "Mail", inNav: false },
      { href: "https://studio.example/impressum", text: "Impressum", inNav: false },
    ]);
  });

  it("reads a meta refresh and a noai robots meta", () => {
    const r = extract(doc(`<p>${LONG}</p>`, `<meta http-equiv="refresh" content="0; url='/neu'"><meta name="robots" content="index, NoAI">`));
    expect(r.refresh).toEqual({ delaySec: 0, url: "https://studio.example/neu" });
    expect(r.noai).toBe(true);
    expect(extract(doc(`<p>${LONG}</p>`, `<meta name="robots" content="noimageai">`)).noai).toBe(false);
  });

  it("parses refresh forms", () => {
    const base = new URL(URL_);
    expect(parseRefresh("5;URL=https://sedo.com/x", base)).toEqual({ delaySec: 5, url: "https://sedo.com/x" });
    expect(parseRefresh("10", base)).toEqual({ delaySec: 10, url: null });
    expect(parseRefresh("3, url=\"page.html\"", base)).toEqual({ delaySec: 3, url: "https://studio.example/page.html" });
    expect(parseRefresh("", base)).toBeNull();
    expect(parseRefresh("  7 ; URL = 'neu.html' ", base)).toEqual({ delaySec: 7, url: "https://studio.example/neu.html" });
    expect(parseRefresh("0.5;url=/a;b", base)).toEqual({ delaySec: 0.5, url: "https://studio.example/a;b" });
    expect(parseRefresh("; url=/home", base)).toEqual({ delaySec: 0, url: "https://studio.example/home" });
    expect(parseRefresh("0; urlaub.html", base)).toEqual({ delaySec: 0, url: "https://studio.example/urlaub.html" });
    expect(parseRefresh("2;", base)).toEqual({ delaySec: 2, url: null });
    for (const notARefresh of [";", " ; url= ", "soon; url=/x", "5 url=/x", "0.5.3", "1.", "   "]) {
      expect(parseRefresh(notARefresh, base), notARefresh).toBeNull();
    }
  });

  it("reads a refresh in linear time, and only its first REFRESH_CONTENT_CAP characters", () => {
    const base = new URL(URL_);
    // The old regex backtracked quadratically on a whitespace run followed by a character it couldn't match.
    const t0 = performance.now();
    expect(parseRefresh(`${" ".repeat(100_000)}x`, base)).toBeNull();
    expect(parseRefresh(`5;${" ".repeat(100_000)}x`, base)).toEqual({ delaySec: 5, url: null });
    expect(performance.now() - t0).toBeLessThan(50);
    const long = parseRefresh(`0; url=/${"a".repeat(5_000)}`, base);
    expect(long?.url?.length).toBeLessThanOrEqual("https://studio.example".length + REFRESH_CONTENT_CAP);
  });

  it("a 2 MB meta refresh of spaces is extracted in milliseconds", () => {
    const html = `<html><head><meta http-equiv="refresh" content="${" ".repeat(TWO_MB - 100)}x"></head><body><p>${LONG}</p></body></html>`;
    const t0 = performance.now();
    const r = extract(html);
    expect(performance.now() - t0).toBeLessThan(HOSTILE_PAGE_MS);
    expect(r.refresh).toBeNull();
    expect(r.text).toBe(LONG);
  });

  it("doesn't collect links longer than the URL rules allow", () => {
    const r = extract(doc(`<nav><a href="/${"x".repeat(3_000)}">Gallery</a><a href="/gallery">Gallery</a></nav>`));
    expect(r.links.map((l) => l.href)).toEqual(["https://studio.example/gallery"]);
  });

  it("notes app-shell signs: an empty app root, a noscript asking for JavaScript, external scripts", () => {
    const shell = extract(
      doc(`<noscript>You need to enable JavaScript to run this app.</noscript><div id="root">\n</div>`, `<script src="/a.js"></script><script src="/b.js"></script><script>inline()</script>`),
    );
    expect(shell).toMatchObject({ emptyAppRoot: true, noscriptAsksForJs: true, externalScripts: 2, text: "" });
    const rendered = extract(doc(`<div id="app"><p>${LONG}</p></div>`));
    expect(rendered).toMatchObject({ emptyAppRoot: false, noscriptAsksForJs: false, externalScripts: 0 });
    expect(extract(doc(`<div ng-version="17.0.0"></div>`)).emptyAppRoot).toBe(true);
  });
});

describe("language", () => {
  it("uses html[lang], then og:locale, then Content-Language, then a stop-word guess", () => {
    expect(extract(`<html lang="de-DE"><body><p>${LONG}</p></body></html>`).lang).toBe("de");
    expect(extract(`<html lang="nb"><body><p>${LONG}</p></body></html>`).lang).toBe("nb");
    expect(extract(`<html lang="no"><body><p>x</p></body></html>`).lang).toBe("nb");
    expect(extract(`<html lang="fr"><body><p>${LONG}</p></body></html>`).lang).toBeNull();
    expect(extract(`<html><head><meta property="og:locale" content="nb_NO"></head><body><p>x</p></body></html>`).lang).toBe("nb");
    expect(extract(`<html><body><p>x</p></body></html>`, { contentLanguage: "de-AT, en" }).lang).toBe("de");
    expect(extract(`<html><body><p>Wir bauen die Figuren und das Zubehör mit viel Liebe, der Sockel ist nicht dabei.</p></body></html>`).lang).toBe("de");
  });

  it("guesses only with at least three hits and a clear winner", () => {
    expect(guessLanguage("Vi lager troll og nisser, og det er ikke vanskelig å se på dem.")).toBe("nb");
    expect(guessLanguage("The dragons and the griffins, with bases, for painters.")).toBe("en");
    expect(guessLanguage("Dragons, griffins.")).toBeNull();
  });
});

describe("charset", () => {
  it("decodes a windows-1252 page without a charset header or meta charset", () => {
    const bytes = Buffer.from(`<html><body><p>Größe, Maßstab und Büsten für Sammler.</p></body></html>`, "latin1");
    expect(extract(bytes).text).toBe("Größe, Maßstab und Büsten für Sammler.");
  });

  it("follows the Content-Type charset and a meta charset", () => {
    const utf8 = Buffer.from(`<html><head><meta charset="utf-8"></head><body><p>Größe und Maßstab</p></body></html>`, "utf8");
    expect(extract(utf8).text).toBe("Größe und Maßstab");
    expect(extract(Buffer.from("<p>Tromsø verksted</p>", "utf8"), { charset: "utf-8" }).text).toBe("Tromsø verksted");
    expect(extract(Buffer.from("<p>Tromsø verksted</p>", "utf8"), { charset: "not-a-charset" }).text).toContain("verksted");
  });

  it("never throws for a charset it can't decode", () => {
    for (const html of ['<meta charset="x-user-defined"><p>Resin busts</p>', '<meta charset="utf-7"><p>Resin busts</p>']) {
      expect(decodePage(Buffer.from(html, "latin1"))).toContain("Resin busts");
      expect(decodePage(Buffer.from(html, "latin1"), "x-no-such-charset")).toContain("Resin busts");
    }
  });
});

describe("parsing", () => {
  const SITES = path.resolve("tests/fixtures/sites");
  const fixturePages = fs
    .readdirSync(SITES)
    .filter((d) => fs.statSync(path.join(SITES, d)).isDirectory())
    .flatMap((d) => fs.readdirSync(path.join(SITES, d)).filter((f) => f.endsWith(".html")).map((f) => path.join(d, f)));
  const tricky = [
    "<p>a<p>b<li>c<li>d<table><tr><td>x<td>y</table><svg><path d='1'/><title>t</title></svg><math><mi>x</mi></math>",
    "<!doctype html><html><head><title>A &amp; B</title></head><body><![CDATA[x]]><?php echo 1 ?><!-- c --><br></br></p><select><option>1<option>2</select><noembed><b>x</b></noembed>",
    "<div/><span/>text<b><i>mis</b>nested</i><script>if (a<b) {}</script><style>p{}</style><textarea><b>raw</b></textarea>",
  ];
  const options = { xml: { xmlMode: false, decodeEntities: true } } as const;
  const sameAsCheerio = (buf: Buffer) => {
    const { root, depthCut } = parseCapped(decodePage(buf));
    expect(depthCut).toBe(false);
    expect(cheerio.load(root as never, options).html()).toBe(cheerio.loadBuffer(buf, options).html());
  };

  it("builds the same document as cheerio.loadBuffer for every fixture page", () => {
    expect(fixturePages.length).toBeGreaterThan(20);
    for (const file of fixturePages) sameAsCheerio(fs.readFileSync(path.join(SITES, file)));
  });

  it.each(tricky)("builds the same document as cheerio.loadBuffer for %s", (html) => {
    sameAsCheerio(Buffer.from(html, "utf8"));
  });
});

describe("nesting", () => {
  it("stops building the document where htmlparser2's stack would pass MAX_DEPTH (html and body count)", () => {
    const { root, depthCut } = parseCapped("<html><body>" + "<div>".repeat(MAX_DEPTH + 10) + "x");
    expect(depthCut).toBe(true);
    expect(domDepth(root as DomLike)).toBe(MAX_DEPTH);
    const exact = parseCapped("<html><body>" + "<div>".repeat(MAX_DEPTH - 2) + "x");
    expect(exact.depthCut).toBe(false);
    expect(domDepth(exact.root as DomLike)).toBe(MAX_DEPTH);
  });

  it("doesn't cut void, implied, closed or raw-text elements", () => {
    const html =
      "<html><body>" +
      "<p>x".repeat(2_000) +
      "<li>y".repeat(2_000) +
      "<br><img src=a.png><input/>".repeat(2_000) +
      "<span></span>".repeat(2_000) +
      "<!-- <div><div><div> -->" +
      `<script>${"<div>".repeat(2_000)}</script>` +
      `<div title="a > b" class='c'>z</div>`.repeat(2_000) +
      "<svg><title>Cart</title><desc>Icon</desc><path d='M0 0'/></svg>".repeat(2_000) +
      "</body></html>";
    const r = parseCapped(html);
    expect(r.depthCut).toBe(false);
    expect(domDepth(r.root as DomLike)).toBeLessThan(10);
    expect(extract(html).depthCut).toBe(false);
  });

  it.each([
    ["<div/> (the slash is ignored in HTML)", fill2mb("<div/>")],
    ["<div></b> (a stray end tag closes nothing)", fill2mb("<div></b>")],
    ["<li><p> (implied tags nest)", fill2mb("<li><p>")],
    ["<div><script></script> (script pairs between the divs)", fill2mb("<div><script></script>")],
    ["<noembed> then <div>s (parsed as markup)", fill2mb("<div>", "<noembed>")],
    ["<body> (every body nests)", fill2mb("<body>")],
    ["<svg> then <svg/> (svg context flags pile up)", fill2mb("<svg/>", "<svg>")],
    ["<b><svg></b> (implied closes leave svg flags)", fill2mb("<b><svg></b>")],
  ])("a 2 MB page of %s is cut at MAX_DEPTH and extracted in milliseconds", (_label, html) => {
    const t0 = performance.now();
    const r = extract(Buffer.from(html, "latin1"));
    expect(performance.now() - t0).toBeLessThan(HOSTILE_PAGE_MS);
    expect(r.depthCut).toBe(true);
    expect(domDepth(parseCapped(html).root as DomLike)).toBeLessThanOrEqual(MAX_DEPTH);
  });

  it("cuts a UTF-16 page too (charset header or byte-order mark), because it counts on the decoded text", () => {
    const html = "<html><body>" + "<div>".repeat(200_000) + "x";
    const t0 = performance.now();
    const fromHeader = extract(Buffer.from(html, "utf16le"), { charset: "utf-16le" });
    const fromBom = extract(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, "utf16le")]));
    expect(performance.now() - t0).toBeLessThan(2 * HOSTILE_PAGE_MS);
    expect(fromHeader.depthCut).toBe(true);
    expect(fromBom.depthCut).toBe(true);
    const text = `<html><body><p>${LONG}</p></body></html>`;
    expect(extract(Buffer.from(text, "utf16le"), { charset: "utf-16le" }).text).toBe(LONG);
  });

  it("builds at most one element more than the walkers visit (a flat page stays small in memory)", () => {
    const r = parseCapped("<i>a</i>".repeat(MAX_ELEMENTS + 5_000));
    expect(r.depthCut).toBe(false);
    expect(elementCount(r.root as DomLike)).toBe(MAX_ELEMENTS + 1);
  });

  it("extracts a flat 2 MB page in milliseconds", () => {
    const html = fill2mb(`<p>${LONG}</p>\n`, "<html><body>");
    const t0 = performance.now();
    const r = extract(html);
    expect(performance.now() - t0).toBeLessThan(HOSTILE_PAGE_MS);
    expect(r.depthCut).toBe(false);
    expect(r.text).toBe(LONG);
  });

  it("extracts a 100,000-deep page without a stack overflow, in well under 2 seconds", () => {
    const html = "<!doctype html><html><body>" + '<div class="cookie">'.repeat(100_000) + "x" + "</div>".repeat(100_000) + "</body></html>";
    const buf = Buffer.from(html).subarray(0, 2 * 1024 * 1024);
    const t0 = performance.now();
    const r = extractPage(buf, { finalUrl: URL_ });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2_000);
    expect(r.depthCut).toBe(true);
    expect(typeof r.text).toBe("string");
  });

  it("keeps the text of elements nested just under the cut", () => {
    const html = "<html><body><p>" + "<b>".repeat(MAX_DEPTH - 5) + LONG + "</b>".repeat(MAX_DEPTH - 5) + "</p></body></html>";
    expect(extract(html).text).toBe(LONG);
  });
});
