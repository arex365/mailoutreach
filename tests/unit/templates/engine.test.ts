import { describe, expect, it } from "vitest";
import { fnv1a32, variationIndex } from "@/core/templates/hash";
import { textToHtml } from "@/core/templates/html";
import { parseTemplate, TOO_DEEP_PROBLEM, type TemplateNode } from "@/core/templates/parse";
import { lintTemplate, renderTemplateText, suggestVariable, variablesUsed } from "@/core/templates/render";
import { STANDARD_VARIABLES } from "@/core/templates/variables";

/**
 * SPEC testing list: "template rendering: variables, fallbacks, stable variations,
 * missing-detail detection" (+ PLAN B12: line removal, warnings, escaping).
 */

const VALUES = {
  first_name: "Anna",
  contact_name: "Anna Berg",
  company: "Acme 3D",
  website: "acme.de",
  country: "Germany",
  niche: "Figurines",
  personal_line: "Your hand-painted dragon busts caught my eye.",
  sender_name: "Ali Khan",
  sender_signature: "Ali Khan\nPolygon Paradise · print-ready 3D models",
  portfolio_url: "https://www.polygonparadise.com",
  est_revenue: "",
  followers: "12k",
};

function body(source: string, values: Record<string, string> = {}, personId = 1, step = 0) {
  return renderTemplateText(source, { personId, step, values: { ...VALUES, ...values }, where: "body" });
}

const KNOWN = Object.keys(VALUES);

describe("variables", () => {
  it("renders every standard variable", () => {
    for (const v of STANDARD_VARIABLES) {
      const r = body(`[{{${v.name}}}]`);
      expect(r.text).toBe(`[${VALUES[v.name as keyof typeof VALUES]}]`);
      expect(r.warnings).toEqual([]);
    }
  });

  it("renders custom fields", () => {
    expect(body("{{followers}} followers").text).toBe("12k followers");
  });

  it("ignores case and spaces inside the braces", () => {
    expect(body("Hi {{ First_Name }}!").text).toBe("Hi Anna!");
  });

  it("keeps values as plain text (never parsed again)", () => {
    const r = body("Line: {{personal_line}}", { personal_line: "We love {braces} and {{company}} and a|bar" });
    expect(r.text).toBe("Line: We love {braces} and {{company}} and a|bar");
    expect(r.warnings).toEqual([]);
  });

  it("inserts multi-line values such as the signature", () => {
    expect(body("Thanks,\n{{sender_signature}}").text).toBe("Thanks,\nAli Khan\nPolygon Paradise · print-ready 3D models");
  });

  it("treats Windows line breaks like plain ones", () => {
    expect(body("Hi {{first_name}},\r\n\r\nBye").text).toBe("Hi Anna,\n\nBye");
  });
});

describe("fallbacks", () => {
  it("uses the fallback only when the value is empty", () => {
    expect(body("Hi {{first_name|there}},").text).toBe("Hi Anna,");
    expect(body("Hi {{first_name|there}},", { first_name: "" }).text).toBe("Hi there,");
    expect(body("Hi {{first_name|there}},", { first_name: "   " }).text).toBe("Hi there,");
    expect(body("Hi {{first_name| there }},", { first_name: "" }).text).toBe("Hi there,");
    expect(body("Hi {{first_name|there}},", { first_name: "" }).warnings).toEqual([]);
  });

  it("allows escaped bars and braces in a fallback", () => {
    expect(body("{{niche|3D \\| print}}", { niche: "" }).text).toBe("3D | print");
  });
});

describe("missing details", () => {
  it("warns about an empty variable without a fallback and leaves it empty", () => {
    const r = body("Hi {{first_name}},", { first_name: "" });
    expect(r.text).toBe("Hi ,");
    expect(r.warnings).toEqual([
      {
        kind: "missing",
        variable: "first_name",
        where: "body",
        message: "{{first_name}} is empty for this person and has no fallback.",
      },
    ]);
  });

  it("words the warning for company, custom, sender and portfolio variables", () => {
    expect(body("{{company}}", { company: "" }).warnings[0]?.message).toBe("{{company}} is empty for this company and has no fallback.");
    expect(body("{{est_revenue}}").warnings[0]?.message).toBe("{{est_revenue}} is empty for this company and has no fallback.");
    expect(body("{{sender_signature}}", { sender_signature: "" }).warnings[0]?.message).toMatch(
      /^\{\{sender_signature\}\} is empty for this sender and has no fallback\. They can fill it in under Settings › My profile\.$/,
    );
    expect(body("{{portfolio_url}}", { portfolio_url: "" }).warnings[0]?.message).toMatch(/Owner can set the portfolio link in Settings/);
  });

  it("warns once per variable, even when it's used twice", () => {
    const r = body("{{first_name}} {{first_name}}", { first_name: "" });
    expect(r.warnings).toHaveLength(1);
  });

  it("keeps a line whose only variable is missing (the warning explains the gap)", () => {
    const r = body("Hi,\n\n{{personal_line}}\n\nBye", { personal_line: "" });
    expect(r.text).toBe("Hi,\n\n\n\nBye");
    expect(r.warnings.map((w) => w.kind)).toEqual(["missing"]);
  });
});

describe("optional variables ({{x|}})", () => {
  const A7 = "{Hi|Hello} {{first_name|there}},\n\n{{personal_line|}}\n\nI'm {{sender_name}} from Polygon Paradise.\n\n{{sender_signature}}";

  it("keeps the line when the value is there", () => {
    const text = body(A7, {}, 1).text;
    expect(text).toMatch(/^(Hi|Hello) Anna,\n\nYour hand-painted dragon busts caught my eye\.\n\nI'm Ali Khan from Polygon Paradise\.\n\nAli Khan\n/);
  });

  it("removes a line with only an empty optional variable, plus the blank line after it", () => {
    const r = body(A7, { personal_line: "", first_name: "" }, 1);
    expect(r.text).toMatch(/^(Hi|Hello) there,\n\nI'm Ali Khan from Polygon Paradise\.\n\nAli Khan\nPolygon Paradise/);
    expect(r.text).not.toMatch(/\n\n\n/);
    expect(r.warnings).toEqual([]);
  });

  it("removes such a line at the very start or end without leaving blank lines", () => {
    expect(body("{{personal_line|}}\n\nHello", { personal_line: "" }).text).toBe("Hello");
    expect(body("Hello\n\n{{personal_line|}}", { personal_line: "" }).text).toBe("Hello");
    expect(body("  {{personal_line|}}  \n\nHello", { personal_line: "" }).text).toBe("Hello");
  });

  it("removes several such lines in a row", () => {
    const r = body("Hi\n\n{{personal_line|}}\n\n{{niche|}}\n\nBye", { personal_line: "", niche: "" });
    expect(r.text).toBe("Hi\n\nBye");
  });

  it("removes a line whose optional pieces are all empty", () => {
    expect(body("Hi\n{{personal_line|}} {{niche|}}\nBye", { personal_line: "", niche: "" }).text).toBe("Hi\nBye");
  });

  it("keeps a line with other text on it, without stray spaces", () => {
    expect(body("We love {{niche|}} models.", { niche: "" }).text).toBe("We love models.");
    expect(body("Hi {{first_name|}},", { first_name: "" }).text).toBe("Hi,");
    expect(body("Thanks {{first_name|}}!", { first_name: "" }).text).toBe("Thanks!");
    expect(body("Thanks {{first_name|}}", { first_name: "" }).text).toBe("Thanks");
    expect(body("{{first_name|}} hello", { first_name: "" }).text).toBe("hello");
    expect(body("We love {{niche|}} models.").text).toBe("We love Figurines models.");
  });

  it("does not remove the next line when it isn't blank", () => {
    expect(body("Hi\n{{personal_line|}}\nBye", { personal_line: "" }).text).toBe("Hi\nBye");
  });

  it("keeps the paragraph break when the removed line sits right under a paragraph", () => {
    expect(body("Hi\n{{personal_line|}}\n\nNext", { personal_line: "" }).text).toBe("Hi\n\nNext");
    expect(body("Intro line.\n{{personal_line|}}\n\nNext paragraph.", { personal_line: "" }).text).toBe(
      "Intro line.\n\nNext paragraph.",
    );
    const r = body("Hi Anna,\n{{personal_line|}}\n\nI'm Ali.\n\nBye", { personal_line: "" });
    expect(r.text).toBe("Hi Anna,\n\nI'm Ali.\n\nBye");
    expect(textToHtml(r.text)).toBe("<p>Hi Anna,</p>\n<p>I&#39;m Ali.</p>\n<p>Bye</p>");
  });

  it("gives the same paragraphs whether the optional line is empty or filled", () => {
    const src = "Hi Anna,\n{{personal_line|}}\n\nI'm Ali.";
    const paragraphs = (text: string) => text.split(/\n\n+/).length;
    expect(paragraphs(body(src, { personal_line: "" }).text)).toBe(2);
    expect(paragraphs(body(src).text)).toBe(2);
  });
});

describe("variations", () => {
  it("picks one option", () => {
    expect(["Hi", "Hello", "Hey"]).toContain(body("{Hi|Hello|Hey}").text);
  });

  it("is stable across calls for the same person and step", () => {
    for (let person = 1; person <= 30; person++) {
      const a = body("{Hi|Hello|Hey} there. {Thanks|Cheers}", {}, person).text;
      const b = body("{Hi|Hello|Hey} there. {Thanks|Cheers}", {}, person).text;
      expect(a).toBe(b);
    }
  });

  it("differs between people", () => {
    const picks = new Set<string>();
    for (let person = 1; person <= 60; person++) picks.add(body("{Hi|Hello|Hey}", {}, person).text);
    expect(picks).toEqual(new Set(["Hi", "Hello", "Hey"]));
  });

  it("spreads picks fairly evenly", () => {
    const counts = { A: 0, B: 0 };
    for (let person = 1; person <= 2000; person++) counts[body("{A|B}", {}, person).text as "A" | "B"]++;
    expect(counts.A).toBeGreaterThan(850);
    expect(counts.B).toBeGreaterThan(850);
  });

  it("doesn't change when text around it is edited", () => {
    for (let person = 1; person <= 20; person++) {
      const alone = body("{Hi|Hello}", {}, person).text;
      const edited = body("Intro line\n\n{Hi|Hello} {{first_name}}, how are you?", {}, person).text;
      expect(edited.split("\n\n")[1]!.startsWith(alone + " ")).toBe(true);
    }
  });

  it("uses the occurrence index, so the same options twice can pick differently", () => {
    let differs = false;
    for (let person = 1; person <= 40 && !differs; person++) {
      const [a, b] = body("{A|B}-{A|B}", {}, person).text.split("-");
      if (a !== b) differs = true;
    }
    expect(differs).toBe(true);
  });

  it("depends on the step", () => {
    let differs = false;
    for (let person = 1; person <= 40 && !differs; person++) {
      if (body("{A|B|C|D}", {}, person, 0).text !== body("{A|B|C|D}", {}, person, 1).text) differs = true;
    }
    expect(differs).toBe(true);
  });

  it("matches the documented hash exactly (preview, Review and the sent email agree)", () => {
    const pick = (person: number) => variationIndex({ personId: person, step: 0, options: "Hi|Hello", occurrence: 0 }, 2);
    for (let person = 1; person <= 10; person++) {
      expect(body("{Hi|Hello}", {}, person).text).toBe(["Hi", "Hello"][pick(person)]);
    }
  });

  it("may contain variables and other variations", () => {
    for (let person = 1; person <= 10; person++) {
      const text = body("{Hi {{first_name|there}}|Hello {{first_name|there}}}", { first_name: "" }, person).text;
      expect(["Hi there", "Hello there"]).toContain(text);
      expect(["a", "b", "c"]).toContain(body("{a|{b|c}}", {}, person).text);
    }
  });

  it("allows an empty option (an optional word)", () => {
    const seen = new Set<string>();
    for (let person = 1; person <= 40; person++) seen.add(body("Thanks {so much|}!", {}, person).text);
    expect(seen).toEqual(new Set(["Thanks so much!", "Thanks!"]));
  });

  it("allows an option that starts with a variable ({{{first_name|there}}, …|Hello})", () => {
    const src = "{{{first_name|there}}, hope you're well|Hello}!";
    const seen = new Set<string>();
    const seenEmpty = new Set<string>();
    for (let person = 1; person <= 40; person++) {
      const r = body(src, {}, person);
      expect(r.warnings).toEqual([]);
      seen.add(r.text);
      seenEmpty.add(body(src, { first_name: "" }, person).text);
    }
    expect(seen).toEqual(new Set(["Anna, hope you're well!", "Hello!"]));
    expect(seenEmpty).toEqual(new Set(["there, hope you're well!", "Hello!"]));
    expect(body("{{{first_name}} and {{company}}|Hi}", {}, 3).warnings).toEqual([]);
  });

  it("still reads '{Hello|{{first_name}}}' and '{{first_name}}' next to a brace the old way", () => {
    for (let person = 1; person <= 10; person++) {
      expect(["Hello", "Anna"]).toContain(body("{Hello|{{first_name}}}", {}, person).text);
    }
    // "{{" that never closes: the brace after it can still start a variation.
    const r = body("{{{a|b}");
    expect(["{{a", "{{b"]).toContain(r.text);
    expect(r.warnings[0]?.message).toMatch(/"\{\{" isn't closed with "\}\}"/);
  });

  it("reads '{{{name}}' that never closes as a variable, as before", () => {
    const r = body("Hi {{{first_name}}, welcome");
    expect(r.text).toBe("Hi {{{first_name}}, welcome");
    expect(r.warnings).toEqual([
      {
        kind: "unknown",
        variable: "{first_name",
        where: "body",
        message: "{{{first_name}} isn't a variable we know. Did you mean {{first_name}}?",
      },
    ]);
  });

  it("reads '{{{first_name}}}' as the variable, with a one-option note", () => {
    const r = body("Hi {{{first_name}}}!");
    expect(r.text).toBe("Hi Anna!");
    expect(r.warnings.map((w) => w.kind)).toEqual(["syntax"]);
    expect(r.warnings[0]?.message).toMatch(/has only one option/);
  });
});

describe("hash", () => {
  it("is 32-bit FNV-1a", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("returns 0 for a single option", () => {
    expect(variationIndex({ personId: 5, step: 0, options: "x", occurrence: 0 }, 1)).toBe(0);
  });
});

describe("escapes", () => {
  it("writes real braces and bars", () => {
    const r = body("Use \\{braces\\} and a \\| bar, and \\{\\{first_name\\}\\}.");
    expect(r.text).toBe("Use {braces} and a | bar, and {{first_name}}.");
    expect(r.warnings).toEqual([]);
  });

  it("keeps a bar outside braces as it is", () => {
    expect(body("Figurines | busts").text).toBe("Figurines | busts");
  });

  it("allows an escaped bar inside a variation option", () => {
    const seen = new Set<string>();
    for (let person = 1; person <= 30; person++) seen.add(body("{a\\|b|c}", {}, person).text);
    expect(seen).toEqual(new Set(["a|b", "c"]));
  });

  it("keeps other backslashes", () => {
    expect(body("C:\\models\\dragon.stl").text).toBe("C:\\models\\dragon.stl");
  });
});

describe("unknown variables", () => {
  it("keeps the text visible and suggests the closest name", () => {
    const r = body("Hi {{frist_name}},");
    expect(r.text).toBe("Hi {{frist_name}},");
    expect(r.warnings).toEqual([
      {
        kind: "unknown",
        variable: "frist_name",
        where: "body",
        message: "{{frist_name}} isn't a variable we know. Did you mean {{first_name}}?",
      },
    ]);
  });

  it("suggests the snake_case name for a name with spaces", () => {
    expect(body("{{first name}}").warnings[0]?.message).toMatch(/Did you mean \{\{first_name\}\}\?/);
    expect(suggestVariable("Company", KNOWN)).toBe("company");
    expect(suggestVariable("xyzzy", KNOWN)).toBeNull();
  });

  it("uses the fallback when one is given, but still warns", () => {
    const r = body("Hi {{nickname|friend}}");
    expect(r.text).toBe("Hi friend");
    expect(r.warnings[0]).toMatchObject({ kind: "unknown", variable: "nickname" });
    expect(r.warnings[0]?.message).toMatch(/Use one of the variable buttons/);
  });

  it("warns about unknown names in every variation option, for every person", () => {
    for (let person = 1; person <= 5; person++) {
      expect(body("{Hi|Hey {{nme}}}", {}, person).warnings.map((w) => w.kind)).toEqual(["unknown"]);
    }
  });
});

describe("syntax problems", () => {
  const kinds = (src: string) => body(src).warnings.map((w) => w.kind);

  it("reports a variation that isn't closed and keeps the text", () => {
    const r = body("{Hi|Hello there");
    expect(r.text).toBe("{Hi|Hello there");
    expect(kinds("{Hi|Hello there")).toEqual(["syntax"]);
    expect(r.warnings[0]?.message).toMatch(/There's a "\{" without a matching "\}"/);
  });

  it("reports a stray closing brace", () => {
    expect(body("Hello} there").text).toBe("Hello} there");
    expect(body("Hello} there").warnings[0]?.message).toMatch(/There's a "\}" without a matching "\{"/);
  });

  it("reports a variable that isn't closed", () => {
    const r = body("Hi {{first_name, welcome");
    expect(r.text).toBe("Hi {{first_name, welcome");
    expect(r.warnings[0]?.message).toMatch(/"\{\{" isn't closed with "\}\}"/);
  });

  it("never lets a brace reach past the end of its line", () => {
    const r = body("{Hi|Hello\nthere}");
    expect(r.text).toBe("{Hi|Hello\nthere}");
    expect(kinds("{Hi|Hello\nthere}")).toEqual(["syntax", "syntax"]);
  });

  it("reports an empty option list and a single option", () => {
    expect(body("a{}b").text).toBe("ab");
    expect(body("a{}b").warnings[0]?.message).toMatch(/has no options/);
    expect(body("{|}").warnings[0]?.message).toMatch(/has no options/);
    expect(body("{Hi}").text).toBe("Hi");
    expect(body("{Hi}").warnings[0]?.message).toMatch(/has only one option/);
  });

  it("reports a variable without a name", () => {
    const r = body("Hi {{}} and {{|x}}");
    expect(r.text).toBe("Hi {{}} and {{|x}}");
    expect(r.warnings.every((w) => w.kind === "syntax")).toBe(true);
    expect(r.warnings[0]?.message).toMatch(/has no variable name/);
  });

  it("reports braces inside a fallback", () => {
    expect(body("{{first_name|{there}}}").warnings.some((w) => /can only be plain text/.test(w.message))).toBe(true);
  });

  it("stays fast on long runs of unbalanced braces", () => {
    const started = Date.now();
    const r = body(`${"{a|".repeat(300)}x`);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.warnings.some((w) => w.kind === "syntax")).toBe(true);
    expect(r.text).toBe(`${"{a|".repeat(300)}x`);
  });

  describe("long or deeply nested lines (never throws, stays fast)", () => {
    const timed = <T>(fn: () => T): { value: T; ms: number } => {
      const started = performance.now();
      const value = fn();
      return { value, ms: performance.now() - started };
    };

    it.each([
      ["'{x' × 5,000", "{x".repeat(5000)],
      ["'{a|' × 6,000", "{a|".repeat(6000)],
      ["'Our prices: {small …' × 300", "Our prices: {small 20 EUR, {medium 30 EUR, {large 40 EUR. ".repeat(300)],
      ["'{{' × 10,000", "{{".repeat(10_000)],
      ["'}' × 20,000", "}".repeat(20_000)],
      ["'{{{' × 6,000 closing once", `${"{{{".repeat(6000)}a}}`],
    ])("%s", (_label, src) => {
      const parsed = timed(() => parseTemplate(src));
      expect(parsed.ms).toBeLessThan(1000);
      const lint = timed(() => lintTemplate(src, KNOWN, "body"));
      expect(lint.ms).toBeLessThan(1000);
      expect(lint.value.some((w) => w.kind === "syntax" || w.kind === "unknown")).toBe(true);
      const rendered = timed(() => body(src));
      expect(rendered.ms).toBeLessThan(1000);
      // Broken text is kept as written, so the preview shows the problem.
      expect(rendered.value.text).toBe(src.trim());
    });

    it("keeps unclosed braces as written, with the usual message", () => {
      const src = "Our prices: {small 20 EUR, {medium 30 EUR, {large 40 EUR. ".repeat(300);
      const r = body(src);
      expect(r.text).toBe(src.trim());
      expect(r.warnings.every((w) => /^There's a "\{" without a matching "\}"/.test(w.message))).toBe(true);
      expect(r.warnings.length).toBeLessThan(10);
    });

    it("reads variations up to 10 deep, and keeps deeper ones as written with one note", () => {
      const nested = (depth: number) => `${"{a|".repeat(depth)}b${"}".repeat(depth)}`;
      const ten = body(nested(10));
      expect(ten.warnings).toEqual([]);
      expect(["a", "b"]).toContain(ten.text);

      const deep = body(nested(12), {}, 7);
      expect(deep.warnings.map((w) => w.message)).toEqual([TOO_DEEP_PROBLEM]);
      expect(TOO_DEEP_PROBLEM).toMatch(/^Variations can be nested up to 10 deep/);
      expect(["a", "{a|{a|b}}"]).toContain(deep.text);

      // Levels 1–10 are variations; levels 11 and 12 come out exactly as written.
      const parsed = parseTemplate(nested(12));
      expect(parsed.problems).toEqual([TOO_DEEP_PROBLEM]);
      let node: TemplateNode = parsed.lines[0]![0]!;
      for (let level = 1; level < 10; level++) {
        if (node.type !== "variation") throw new Error(`level ${level} isn't a variation`);
        node = node.options[1]![0]!;
      }
      expect(node).toMatchObject({ type: "variation", source: "a|{a|{a|b}}" });
      if (node.type === "variation") expect(node.options[1]).toEqual([{ type: "text", value: "{a|{a|b}}" }]);
    });

    it("stays fast and doesn't throw on very deep nesting that does close", () => {
      const src = `${"{a|".repeat(4000)}b${"}".repeat(4000)}`;
      const r = timed(() => body(src));
      expect(r.ms).toBeLessThan(1000);
      expect(r.value.warnings.map((w) => w.message)).toEqual([TOO_DEEP_PROBLEM]);
    });

    it("stays fast on long random mixes of braces, bars and variables", () => {
      const pieces = ["{", "}", "|", "{{", "}}", "\\", "{{first_name}}", "{Hi|Hello}", "x", " ", "{{{", "{{n|"];
      let seed = 12345;
      const next = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      for (let round = 0; round < 5; round++) {
        let src = "";
        while (src.length < 20_000) src += pieces[Math.floor(next() * pieces.length)];
        const r = timed(() => lintTemplate(src, KNOWN, "body"));
        expect(r.ms).toBeLessThan(1000);
        expect(timed(() => body(src)).ms).toBeLessThan(1000);
      }
    });
  });

  it("labels warnings with where they are", () => {
    const r = renderTemplateText("{Hi", { personId: 1, step: 0, values: VALUES, where: "subject" });
    expect(r.warnings[0]?.where).toBe("subject");
  });
});

describe("subjects", () => {
  it("are one line with single spaces", () => {
    const r = renderTemplateText("  {{company}}   and\n{{sender_signature}} ", {
      personId: 1,
      step: 0,
      values: VALUES,
      where: "subject",
    });
    expect(r.text).toBe("Acme 3D and Ali Khan Polygon Paradise · print-ready 3D models");
  });
});

describe("lintTemplate (live editor warnings)", () => {
  it("finds syntax problems and unknown names, never 'missing'", () => {
    const warnings = lintTemplate("{Hi|Hello {{frist_name}}\n{{company}} {{est_revenue}}", KNOWN, "body");
    expect(warnings.map((w) => w.kind).sort()).toEqual(["syntax", "unknown"]);
  });

  it("accepts every default variable", () => {
    expect(lintTemplate(STANDARD_VARIABLES.map((v) => `{{${v.name}}}`).join(" "), KNOWN, "body")).toEqual([]);
  });

  it("lists the variables a text uses", () => {
    expect(variablesUsed("{Hi|Hey {{First_name}}} {{company}} {{first_name|x}} {{nope}}")).toEqual(["first_name", "company", "nope"]);
  });
});

describe("parseTemplate", () => {
  it("gives one node list per line and counts repeated option lists", () => {
    const p = parseTemplate("{A|B}\n{A|B} {C|D}");
    expect(p.lines).toHaveLength(2);
    const occurrences = p.lines.flat().filter((n) => n.type === "variation").map((n) => (n.type === "variation" ? `${n.source}#${n.occurrence}` : ""));
    expect(occurrences).toEqual(["A|B#0", "A|B#1", "C|D#0"]);
    expect(p.problems).toEqual([]);
  });
});
