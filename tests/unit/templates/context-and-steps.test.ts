import { describe, expect, it } from "vitest";
import { buildTemplateValues, customFieldText, websiteForTemplate } from "@/core/templates/context";
import { renderEmail } from "@/core/templates/email";
import { CREATORS_SEQUENCE, DEFAULT_TEMPLATES, MASTER_SEQUENCE } from "@/core/templates/defaults";
import { lintTemplate } from "@/core/templates/render";
import { stepLabel, templateNameProblem, validateSequence, type SequenceStep } from "@/core/templates/steps";
import { mergeVariables, STANDARD_VARIABLES } from "@/core/templates/variables";

const PERSON = { id: 11, name: "Dr. Anna Berg", firstName: null, isGeneric: false, personalLineOverride: null, customFields: null };
const COMPANY = {
  name: "Acme 3D GmbH",
  website: "https://www.acme.de/",
  country: "DE",
  niche: "Tabletop miniatures",
  personalLine: "Your dragon busts are lovely.",
  customFields: { est_revenue: "2M", followers: 1200, platforms: ["Etsy", "", "Shopify"], company: "not me" },
};
const SENDER = { name: "Ali Khan", signature: "Ali Khan\r\nPolygon Paradise\n" };

describe("buildTemplateValues", () => {
  it("fills every standard variable", () => {
    const v = buildTemplateValues({ person: PERSON, company: COMPANY, sender: SENDER, portfolioUrl: "https://www.polygonparadise.com" });
    expect(v).toMatchObject({
      first_name: "Anna",
      contact_name: "Dr. Anna Berg",
      company: "Acme 3D GmbH",
      website: "acme.de",
      country: "Germany",
      niche: "Tabletop miniatures",
      personal_line: "Your dragon busts are lovely.",
      sender_name: "Ali Khan",
      sender_signature: "Ali Khan\nPolygon Paradise",
      portfolio_url: "https://www.polygonparadise.com",
    });
    for (const s of STANDARD_VARIABLES) expect(Object.keys(v)).toContain(s.name);
  });

  it("leaves first and full name empty for a General inbox", () => {
    const v = buildTemplateValues({
      person: { ...PERSON, name: "General inbox", firstName: "General", isGeneric: true },
      company: COMPANY,
      sender: SENDER,
      portfolioUrl: null,
    });
    expect(v.first_name).toBe("");
    expect(v.contact_name).toBe("");
    expect(v.portfolio_url).toBe("");
  });

  it("uses the stored first name when there is one", () => {
    expect(buildTemplateValues({ person: { ...PERSON, firstName: "Annie" }, company: COMPANY, sender: SENDER, portfolioUrl: "" }).first_name).toBe("Annie");
  });

  it("prefers the person's own personal line", () => {
    const v = buildTemplateValues({ person: { ...PERSON, personalLineOverride: "Loved your owl." }, company: COMPANY, sender: SENDER, portfolioUrl: "" });
    expect(v.personal_line).toBe("Loved your owl.");
    const none = buildTemplateValues({ person: PERSON, company: { ...COMPANY, personalLine: null }, sender: SENDER, portfolioUrl: "" });
    expect(none.personal_line).toBe("");
  });

  it("adds custom fields: every known key, company values, then the person's non-empty values", () => {
    const v = buildTemplateValues({
      person: { ...PERSON, customFields: { followers: "15k", platforms: "" } },
      company: COMPANY,
      sender: SENDER,
      portfolioUrl: "",
      customFieldKeys: ["members", "est_revenue", "Bad Key", "company"],
    });
    expect(v.members).toBe("");
    expect(v.est_revenue).toBe("2M");
    expect(v.followers).toBe("15k");
    expect(v.platforms).toBe("Etsy, Shopify");
    expect(v.company).toBe("Acme 3D GmbH");
    expect(Object.keys(v)).not.toContain("Bad Key");
  });

  it("formats custom values as plain text", () => {
    expect(customFieldText(null)).toBe("");
    expect(customFieldText(" x ")).toBe("x");
    expect(customFieldText(12)).toBe("12");
    expect(customFieldText(false)).toBe("false");
    expect(customFieldText(["a", null, "b"])).toBe("a, b");
    expect(customFieldText({ a: 1 })).toBe('{"a":1}');
  });

  it("writes websites the way people say them", () => {
    // A company's own site: just the host.
    expect(websiteForTemplate("https://www.acme.de/", { domain: "acme.de" })).toBe("acme.de");
    expect(websiteForTemplate("https://shop.acme.de/en/", { domain: "acme.de" })).toBe("shop.acme.de");
    // A profile on a shared site: the account.
    expect(websiteForTemplate("https://www.instagram.com/sculpt_by_anna/", { domain: null, profileKey: "instagram.com/sculpt_by_anna" })).toBe(
      "instagram.com/sculpt_by_anna",
    );
    // Unknown kind: host and path.
    expect(websiteForTemplate("shop.acme.de/figures/")).toBe("shop.acme.de/figures");
    expect(websiteForTemplate("https://www.etsy.com/listing/123", { domain: null, profileKey: null })).toBe("etsy.com/listing/123");
    expect(websiteForTemplate(null)).toBe("");
    expect(websiteForTemplate("   ")).toBe("");
  });

  it("uses the company's domain and profile columns for {{website}}", () => {
    const own = buildTemplateValues({ person: PERSON, company: { ...COMPANY, website: "https://www.acme.de/de/start", domain: "acme.de" }, sender: SENDER, portfolioUrl: "" });
    expect(own.website).toBe("acme.de");
    const creator = buildTemplateValues({
      person: PERSON,
      company: { ...COMPANY, website: "https://www.instagram.com/sculpt_by_anna", domain: null, profileKey: "instagram.com/sculpt_by_anna" },
      sender: SENDER,
      portfolioUrl: "",
    });
    expect(creator.website).toBe("instagram.com/sculpt_by_anna");
  });
});

describe("mergeVariables", () => {
  it("adds custom fields after the standard ones, sorted, skipping clashes and bad keys", () => {
    const names = mergeVariables([
      { key: "platforms", label: "Platforms" },
      { key: "est_revenue", label: "Est. revenue" },
      { key: "company", label: "Company" },
      { key: "Bad", label: "Bad" },
    ]).map((v) => v.name);
    expect(names).toEqual([...STANDARD_VARIABLES.map((v) => v.name), "est_revenue", "platforms"]);
  });
});

describe("validateSequence", () => {
  const first: SequenceStep = { step: 0, enabled: true, subject: "  Hello   there ", body: "Hi  \r\nthere\n\n", delayDays: 5 };

  it("tidies a valid sequence", () => {
    const res = validateSequence([{ step: 1, enabled: false, subject: "ignored", body: "Again", delayDays: 3 }, first]);
    expect(res).toEqual({
      ok: true,
      steps: [
        { step: 0, enabled: true, subject: "Hello there", body: "Hi\nthere", delayDays: 0 },
        { step: 1, enabled: false, subject: null, body: "Again", delayDays: 3 },
      ],
    });
  });

  it("needs a subject and body on the first email", () => {
    const res = validateSequence([{ step: 0, enabled: true, subject: " ", body: " \n ", delayDays: 0 }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.fieldErrors).toEqual({
      "step0.subject": ["Write a subject for the first email."],
      "step0.body": ["Write the first email."],
    });
    expect(res.error).toBe("Some details need fixing in first email. Check the highlighted fields.");
  });

  it("needs a body and at least one day on follow-ups", () => {
    const res = validateSequence([first, { step: 1, enabled: true, body: "", delayDays: 0 }, { step: 2, enabled: true, body: "x", delayDays: 1.5 }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.fieldErrors).toEqual({
      "step1.body": ["Write follow-up 1, or remove it."],
      "step1.delayDays": ["Pick a whole number of days from 1 to 90."],
      "step2.delayDays": ["Pick a whole number of days from 1 to 90."],
    });
  });

  it("refuses gaps, too many follow-ups and a missing first email", () => {
    expect(validateSequence([first, { step: 2, enabled: true, body: "x", delayDays: 2 }]).ok).toBe(false);
    expect(validateSequence([{ step: 1, enabled: true, body: "x", delayDays: 2 }]).ok).toBe(false);
    const five = [0, 1, 2, 3, 4].map((step) => ({ ...first, step, delayDays: 2 }));
    const res = validateSequence(five);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("A sequence can have up to 3 follow-ups.");
  });

  it("checks lengths and names", () => {
    expect(validateSequence([{ ...first, subject: "x".repeat(201) }]).ok).toBe(false);
    expect(validateSequence([{ ...first, body: "x".repeat(20_001) }]).ok).toBe(false);
    expect(templateNameProblem("  ")).toBe("Give the template a name.");
    expect(templateNameProblem("x".repeat(81))).toMatch(/under 80/);
    expect(templateNameProblem("Creators")).toBeNull();
    expect(stepLabel(0)).toBe("First email");
    expect(stepLabel(3)).toBe("Follow-up 3");
  });
});

describe("default sequences (PLAN A7)", () => {
  const known = STANDARD_VARIABLES.map((v) => v.name);

  it("have the planned shape", () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.name)).toEqual(["Master sequence", "Creators"]);
    expect(MASTER_SEQUENCE.steps.map((s) => [s.step, s.enabled, s.delayDays])).toEqual([
      [0, true, 0],
      [1, true, 3],
      [2, true, 4],
      [3, false, 7],
    ]);
    expect(CREATORS_SEQUENCE.steps.map((s) => [s.step, s.enabled, s.delayDays])).toEqual([
      [0, true, 0],
      [1, true, 4],
    ]);
    expect(MASTER_SEQUENCE.steps[0]!.subject).toBe("{Print-ready 3D models|3D models} for {{company}}");
    expect(CREATORS_SEQUENCE.steps[0]!.subject).toBe("Print-ready 3D models");
    for (const t of DEFAULT_TEMPLATES) {
      for (const s of t.steps) {
        if (s.step > 0) expect(s.subject).toBeNull();
        expect(s.body.endsWith("{{sender_signature}}")).toBe(true);
        expect(validateSequence(t.steps).ok).toBe(true);
        expect(lintTemplate(s.body, known, "body")).toEqual([]);
        expect(lintTemplate(s.subject ?? "", known, "subject")).toEqual([]);
      }
    }
  });

  it("read well for a General inbox with no personal line", () => {
    const values = buildTemplateValues({
      person: { id: 3, name: "General inbox", firstName: null, isGeneric: true, personalLineOverride: null },
      company: { name: "Printwerk", website: "printwerk.de", country: "DE", niche: null, personalLine: null },
      sender: { name: "Ali Khan", signature: "Ali Khan\nPolygon Paradise · print-ready 3D models\nhttps://www.polygonparadise.com" },
      portfolioUrl: "https://www.polygonparadise.com",
    });
    const footer = { companyName: "Polygon Paradise", address: "Lahore", unsubscribeText: "Unsubscribe here:" };
    const e = renderEmail({ step: 0, subject: MASTER_SEQUENCE.steps[0]!.subject, body: MASTER_SEQUENCE.steps[0]!.body, personId: 3, values, footer, purpose: "preview" });
    expect(e.warnings).toEqual([]);
    expect(e.text).toMatch(
      /^(Hi|Hello) there,\n\nI'm Ali Khan from Polygon Paradise\. We make print-ready 3D models: character figurines, animals and creatures, busts and statues\. Every file is clean and watertight, so there's no repair work before printing\.\n\n/,
    );
    expect(e.text).toContain("Would it help if I sent two or three examples close to what you make?\n\nAli Khan\nPolygon Paradise · print-ready 3D models");
    expect(["Print-ready 3D models for Printwerk", "3D models for Printwerk"]).toContain(e.subject);

    const follow = renderEmail({ step: 1, subject: MASTER_SEQUENCE.steps[0]!.subject, body: MASTER_SEQUENCE.steps[1]!.body, personId: 3, values, footer, purpose: "preview" });
    expect(follow.subject).toBe(`Re: ${e.subject}`);
    expect(follow.text.startsWith("Hi there,\n\nHere are a few of our recent models, in case they're useful: https://www.polygonparadise.com\n\n")).toBe(true);
  });
});
