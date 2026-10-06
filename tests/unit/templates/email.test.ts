import { describe, expect, it } from "vitest";
import { followUpSubject, footerStart, renderEmail, renderFirstSubject } from "@/core/templates/email";
import { escapeHtml, footerHtml, footerText, linkifyLine, textToHtml } from "@/core/templates/html";

const FOOTER = {
  companyName: "Polygon Paradise",
  address: "55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan",
  unsubscribeText: "If you'd rather not hear from us, unsubscribe here:",
};

const VALUES = {
  first_name: "Anna",
  contact_name: "Anna Berg",
  company: "Acme 3D",
  website: "acme.de",
  country: "Germany",
  niche: "",
  personal_line: "",
  sender_name: "Ali Khan",
  sender_signature: "Ali Khan\nPolygon Paradise",
  portfolio_url: "https://www.polygonparadise.com",
};

const SUBJECT = "{Print-ready 3D models|3D models} for {{company}}";

describe("textToHtml", () => {
  it("escapes, makes paragraphs and line breaks, and nothing else", () => {
    expect(textToHtml("Hi <Anna> & \"co\",\n\nLine one\nLine two\n\n\n\nLast")).toBe(
      "<p>Hi &lt;Anna&gt; &amp; &quot;co&quot;,</p>\n<p>Line one<br>\nLine two</p>\n<p>Last</p>",
    );
    expect(textToHtml("")).toBe("");
    expect(textToHtml("  \n \n")).toBe("");
    expect(textToHtml("a\r\n\r\nb")).toBe("<p>a</p>\n<p>b</p>");
    expect(textToHtml("x")).not.toMatch(/style=/);
  });

  it("links http(s) addresses, leaving sentence punctuation outside", () => {
    expect(linkifyLine("See https://www.polygonparadise.com/work.")).toBe(
      'See <a href="https://www.polygonparadise.com/work">https://www.polygonparadise.com/work</a>.',
    );
    expect(linkifyLine("(https://x.com/a_(b))")).toBe('(<a href="https://x.com/a_(b)">https://x.com/a_(b)</a>)');
    expect(linkifyLine("https://x.com/?a=1&b=<2>")).toBe('<a href="https://x.com/?a=1&amp;b=">https://x.com/?a=1&amp;b=</a>&lt;2&gt;');
    expect(linkifyLine("http:// nothing, www.acme.de, ftp://x.y")).toBe("http:// nothing, www.acme.de, ftp://x.y");
    expect(linkifyLine('"https://x.com"')).toBe('&quot;<a href="https://x.com">https://x.com</a>&quot;');
  });

  it("escapes every special character", () => {
    expect(escapeHtml(`<a href='x'>&"</a>`)).toBe("&lt;a href=&#39;x&#39;&gt;&amp;&quot;&lt;/a&gt;");
  });
});

describe("footer (PLAN A7)", () => {
  it("keeps %unsubscribe_url% for sending and shows [unsubscribe link] in previews", () => {
    expect(footerText(FOOTER, "send")).toBe(
      "--\nPolygon Paradise · 55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan\nIf you'd rather not hear from us, unsubscribe here: %unsubscribe_url%",
    );
    expect(footerText(FOOTER, "preview")).toBe(
      "--\nPolygon Paradise · 55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan\nIf you'd rather not hear from us, unsubscribe here: [unsubscribe link]",
    );
  });

  it("has a real link only when sending", () => {
    expect(footerHtml(FOOTER, "send")).toBe(
      '<p>--<br>\nPolygon Paradise · 55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan<br>\nIf you&#39;d rather not hear from us, unsubscribe here: <a href="%unsubscribe_url%">%unsubscribe_url%</a></p>',
    );
    const preview = footerHtml(FOOTER, "preview");
    expect(preview).toContain("unsubscribe here: [unsubscribe link]</p>");
    expect(preview).not.toContain("<a ");
    expect(preview).not.toContain("%unsubscribe_url%");
  });

  it("copes with empty settings", () => {
    expect(footerText({ companyName: "", address: "", unsubscribeText: "" }, "send")).toBe("--\nUnsubscribe: %unsubscribe_url%");
    expect(footerText({ ...FOOTER, address: " " }, "preview")).toBe(
      "--\nPolygon Paradise\nIf you'd rather not hear from us, unsubscribe here: [unsubscribe link]",
    );
  });
});

describe("renderEmail", () => {
  const base = { subject: SUBJECT, personId: 7, values: VALUES, footer: FOOTER } as const;

  it("renders the first email with the footer after the signature", () => {
    const e = renderEmail({ ...base, step: 0, body: "Hi {{first_name|there}},\n\n{{personal_line|}}\n\nSee {{portfolio_url}}\n\n{{sender_signature}}", purpose: "send" });
    expect(["Print-ready 3D models for Acme 3D", "3D models for Acme 3D"]).toContain(e.subject);
    expect(e.text).toBe(
      "Hi Anna,\n\nSee https://www.polygonparadise.com\n\nAli Khan\nPolygon Paradise\n\n--\nPolygon Paradise · 55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan\nIf you'd rather not hear from us, unsubscribe here: %unsubscribe_url%",
    );
    expect(e.html).toBe(
      [
        "<p>Hi Anna,</p>",
        '<p>See <a href="https://www.polygonparadise.com">https://www.polygonparadise.com</a></p>',
        "<p>Ali Khan<br>\nPolygon Paradise</p>",
        '<p>--<br>\nPolygon Paradise · 55th Avenue, Thokar Niaz Baig, Lahore 53700, Pakistan<br>\nIf you&#39;d rather not hear from us, unsubscribe here: <a href="%unsubscribe_url%">%unsubscribe_url%</a></p>',
      ].join("\n"),
    );
    expect(e.warnings).toEqual([]);
  });

  it("gives the same subject and body for preview and send (only the unsubscribe link differs)", () => {
    for (let personId = 1; personId <= 20; personId++) {
      const input = { ...base, personId, step: 0, body: "{Hi|Hello|Hey} {{first_name}}" };
      const preview = renderEmail({ ...input, purpose: "preview" });
      const send = renderEmail({ ...input, purpose: "send" });
      expect(preview.subject).toBe(send.subject);
      expect(preview.text.replace("[unsubscribe link]", "%unsubscribe_url%")).toBe(send.text);
    }
  });

  it("collects subject and body warnings", () => {
    const e = renderEmail({ ...base, subject: "{{niche}} for {{company}}", step: 0, body: "Hi {{frist_name}}", purpose: "preview" });
    expect(e.warnings.map((w) => `${w.where}:${w.kind}`)).toEqual(["subject:missing", "body:unknown"]);
  });

  it("gives follow-ups 'Re: ' + the first subject exactly as this person got it", () => {
    for (let personId = 1; personId <= 20; personId++) {
      const first = renderEmail({ ...base, personId, step: 0, body: "x", purpose: "send" });
      const follow = renderEmail({ ...base, personId, step: 2, body: "Hi again", purpose: "send" });
      expect(follow.subject).toBe(`Re: ${first.subject}`);
      expect(follow.text.startsWith("Hi again\n\n--\n")).toBe(true);
    }
  });

  it("prefers the subject the person actually received, and never doubles Re:", () => {
    expect(renderEmail({ ...base, step: 1, body: "x", firstSubject: "3D models for Acme", purpose: "send" }).subject).toBe(
      "Re: 3D models for Acme",
    );
    expect(renderEmail({ ...base, step: 1, body: "x", firstSubject: "RE: hello", purpose: "send" }).subject).toBe("RE: hello");
    expect(followUpSubject("Re:  Hello ")).toBe("Re: Hello");
    expect(followUpSubject("Hello")).toBe("Re: Hello");
    expect(followUpSubject("")).toBe("Re:");
  });

  it("doesn't repeat the first subject's warnings on follow-ups", () => {
    const e = renderEmail({ ...base, subject: "{{niche}}", step: 1, body: "Hi", purpose: "preview" });
    expect(e.warnings).toEqual([]);
    expect(renderFirstSubject("{{niche}}", 1, VALUES).warnings).toHaveLength(1);
  });

  it("finds where the footer starts", () => {
    const e = renderEmail({ ...base, step: 0, body: "Hello\n-- not a footer", purpose: "preview" });
    expect(e.text.slice(footerStart(e.text))).toBe(footerText(FOOTER, "preview"));
    expect(footerStart("no footer")).toBe(-1);
  });
});
