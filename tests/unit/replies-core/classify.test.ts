import { describe, expect, it } from "vitest";
import { classify } from "@/core/replies/classify";
import { extractNewText, firstLines } from "@/core/replies/quote";
import { flattenMailText } from "@/core/replies/phrases";
import type { ClassifyInput } from "@/core/replies/types";
import { A, SA, vector, vectors, type Vector } from "./vectors";

/** Runs one vector and checks nature, reason and first lines. */
function check(v: Vector) {
  const r = classify(v.in);
  expect({ id: v.id, nature: r.nature }).toEqual({ id: v.id, nature: v.nature });
  if (v.reason !== undefined) expect({ id: v.id, reason: r.autoReason }).toEqual({ id: v.id, reason: v.reason });
  if (v.first) expect(firstLines(extractNewText(v.in.strippedText, v.in.bodyPlain))).toBe(v.first);
  return r;
}

const byId = (...ids: string[]) => ids.map(vector);
const thread: [string, string][] = [
  ["In-Reply-To", `<${A}>`],
  ["References", `<${A}>`],
];
const linkedReply = (over: Partial<ClassifyInput>): ClassifyInput => ({
  linked: true,
  subject: `Re: ${SA}`,
  fromEmail: "anna@firma.de",
  envelopeSender: "anna@firma.de",
  sentSubjects: [SA],
  headers: thread,
  ...over,
});

describe("classify: the research vectors V01–V40 (linked flag from 'Kind after linking')", () => {
  it.each(vectors.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    check(v);
  });

  it("has all 40 vectors", () => {
    expect(vectors).toHaveLength(40);
  });
});

describe("classify: named groups", () => {
  it("auto-replies in three languages (en, de, nb) and fr, es, pl are automatic out-of-office replies", () => {
    for (const v of byId("V03", "V04", "V05", "V32", "V33", "V34")) {
      const r = check(v);
      expect(r.nature).toBe("AUTO");
      expect(r.autoReason).toBe("out-of-office");
    }
  });

  it("possible replies: V08 and V21 (linked, no strong signal) now, V09, V11, V26, V27, V30, V37, V39", () => {
    for (const v of byId("V08", "V21", "V09", "V11", "V26", "V27", "V30", "V37", "V39")) {
      expect(check(v).nature).toBe("POSSIBLE");
    }
    // Unlinked, the research's answer (Appendix A as written) still holds.
    expect(classify({ ...vector("V08").in, linked: false }).nature).toBe("AUTO");
    expect(classify({ ...vector("V21").in, linked: false })).toMatchObject({ nature: "AUTO", autoReason: "challenge" });
  });

  it("bounce order: an Exim bounce with Auto-Submitted is a bounce, not an auto-reply (V15)", () => {
    const r = check(vector("V15"));
    expect(r).toMatchObject({ nature: "BOUNCE", confidence: "high", autoReason: "dsn", delay: false });
  });

  it("Auto-Submitted: no is a human (V28)", () => {
    expect(check(vector("V28")).nature).toBe("REPLY");
  });

  it("help desks: an acknowledgement is automatic, an agent's answer is only possible (V10, V11, V12)", () => {
    expect(check(vector("V10"))).toMatchObject({ nature: "AUTO", confidence: "certain", autoReason: "helpdesk-ack" });
    expect(check(vector("V11")).nature).toBe("POSSIBLE");
    expect(check(vector("V12"))).toMatchObject({ nature: "AUTO", autoReason: "helpdesk-ack" });
    // Linked, a help-desk acknowledgement without a strong signal is only possible (rule 3).
    expect(classify({ ...vector("V10").in, linked: true })).toMatchObject({ nature: "POSSIBLE", autoReason: "helpdesk-ack" });
  });

  it("delays are bounce notices that stop nothing (V18)", () => {
    expect(check(vector("V18"))).toMatchObject({ nature: "BOUNCE", autoReason: "delay", delay: true });
  });

  it("a challenge with a strong header stays automatic when linked (V20)", () => {
    expect(check(vector("V20"))).toMatchObject({ nature: "AUTO", autoReason: "challenge" });
  });
});

describe("classify: new vectors of M4-DESIGN §3.4 rule 14", () => {
  it("(a) 'We have received your samples, can you quote order #1042', linked → POSSIBLE", () => {
    const r = classify(linkedReply({ strippedText: "We have received your samples, can you quote order #1042?" }));
    expect(r).toMatchObject({ nature: "POSSIBLE", autoReason: "helpdesk-ack" });
    expect(r.signals).toContain("ack");
  });

  it("(b) a linked reply saying the captcha failed, with our footer link quoted below → REPLY", () => {
    const r = classify(
      linkedReply({
        strippedText: null,
        bodyPlain:
          "The captcha on your contact form failed, so I'm answering here. Please send prices.\n\n" +
          "On Mon, 21 Sep 2026 at 10:15, Ali Khan <ali@send.polygonparadise.com> wrote:\n" +
          "> Hi Anna,\n> I make print-ready 3D models.\n> --\n> Don't want these emails? https://outreach.example.com/u/abc123",
      }),
    );
    expect(r.nature).toBe("REPLY");
    expect(r.signals).not.toContain("challenge");
  });

  it("(c) 'I'm away this week, but when I return I'd love a quote', linked → POSSIBLE", () => {
    const r = classify(linkedReply({ strippedText: "I'm away this week, but when I return I'd love a quote." }));
    expect(r).toMatchObject({ nature: "POSSIBLE", autoReason: "out-of-office" });
    expect(r.signals).toEqual(expect.arrayContaining(["body:absence", "body:absence-details"]));
    // The same text unlinked has two medium signals: automatic (rule 2).
    expect(classify({ ...linkedReply({ strippedText: "I'm away this week, but when I return I'd love a quote." }), linked: false }).nature).toBe("AUTO");
  });

  it("(d) a linked reply with List-Unsubscribe and Feedback-ID only → POSSIBLE", () => {
    const r = classify(
      linkedReply({
        headers: [...thread, ["List-Unsubscribe", "<https://crm.firma.de/u/1>"], ["Feedback-ID", "123:firma:crm"]],
        strippedText: "Thanks Ali, we'd like a quote for 20 busts.",
      }),
    );
    expect(r.nature).toBe("POSSIBLE");
    expect(r.signals).toEqual(expect.arrayContaining(["list-headers", "feedback-id"]));
  });

  it("(e) 'Absence of prices on your site' is one medium signal (never AUTO); 'Abwesend: bis 5.10.' is automatic", () => {
    const absence = classify(
      linkedReply({ subject: "Absence of prices on your site", headers: [], strippedText: "Could you send your price list?" }),
    );
    expect(absence.nature).toBe("POSSIBLE");
    expect(absence.signals).toContain("subject:absence-word");
    const unlinked = classify({
      ...linkedReply({ subject: "Absence of prices on your site", headers: [], strippedText: "Could you send your price list?" }),
      linked: false,
    });
    expect(unlinked.nature).toBe("POSSIBLE");
    const abwesend = classify(linkedReply({ subject: "Abwesend: bis 5.10.", headers: [], strippedText: "Ab dem 5.10. wieder da." }));
    expect(abwesend).toMatchObject({ nature: "AUTO", autoReason: "out-of-office" });
    expect(abwesend.signals).toContain("subject:auto-prefix");
    const dash = classify(linkedReply({ subject: "Abwesenheitsnotiz - Anna Berg", headers: [], strippedText: "Bis Montag." }));
    expect(dash.nature).toBe("AUTO");
  });

  it("(f) a person's email about an undelivered parcel is a reply, not a bounce", () => {
    for (const subject of ["Undelivered parcel", "Undeliverable parcel from your shop", "Delivery failed: my order #2231"]) {
      const r = classify({
        subject,
        fromEmail: "anna@firma.de",
        envelopeSender: "anna@firma.de",
        headers: [],
        strippedText: "Hi Ali, the parcel with the sample prints never arrived. Can you check with the courier?",
        linked: true,
      });
      expect({ subject, nature: r.nature }).toEqual({ subject, nature: "REPLY" });
    }
    // With a mail-system sender, the same subject is a bounce.
    expect(
      classify({ subject: "Undeliverable: 3D models", fromEmail: "postmaster@firma.de", envelopeSender: "", headers: [], strippedText: "x" }).nature,
    ).toBe("BOUNCE");
  });
});

describe("classify: rows stored under M3 (only the snippet)", () => {
  it("the out-of-office vectors are still automatic with only an M3 snippet", () => {
    for (const v of byId("V03", "V04", "V05", "V06", "V07", "V32", "V33", "V34", "V36", "V38")) {
      const snippet = flattenMailText(v.in.strippedText ?? v.in.bodyPlain ?? "").slice(0, 300);
      const m3: ClassifyInput = { ...v.in, envelopeSender: undefined, strippedText: undefined, bodyPlain: undefined, snippet };
      const r = classify(m3);
      expect({ id: v.id, nature: r.nature, reason: r.autoReason }).toEqual({ id: v.id, nature: "AUTO", reason: v.reason });
    }
  });
});

describe("classify: no text at all", () => {
  it("bodyAvailable false is always POSSIBLE, linked or not, keeping the automatic hint", () => {
    for (const v of vectors) {
      for (const linked of [true, false]) {
        const r = classify({ ...v.in, linked, bodyAvailable: false });
        expect({ id: v.id, linked, nature: r.nature }).toEqual({ id: v.id, linked, nature: "POSSIBLE" });
      }
    }
    expect(classify({ ...vector("V03").in, bodyAvailable: false }).autoReason).toBe("out-of-office");
    expect(classify({ ...vector("V01").in, bodyAvailable: false }).autoReason).toBeNull();
    expect(classify({ ...vector("V13").in, bodyAvailable: false })).toMatchObject({ nature: "POSSIBLE", delay: false });
  });
});

describe("classify: Mailgun's spam marking", () => {
  it("X-Mailgun-Sflag: Yes adds mailgun-spam without changing the nature", () => {
    const base = linkedReply({ strippedText: "Yes please, send the catalogue." });
    const plain = classify(base);
    const flagged = classify({ ...base, headers: [...thread, ["X-Mailgun-Sflag", "Yes"], ["X-Mailgun-Sscore", "12.5"]] });
    expect(flagged.nature).toBe(plain.nature);
    expect(flagged.signals).toContain("mailgun-spam");
    expect(plain.signals).not.toContain("mailgun-spam");
    expect(classify({ ...base, headers: [["X-Mailgun-Sflag", "No"]] }).signals).not.toContain("mailgun-spam");
    const unlinkedSpam = classify({
      subject: "Grow your sales 300% this month",
      fromEmail: "offers@bulk-mailer.example",
      headers: [["X-Mailgun-Sflag", "Yes"]],
      strippedText: "Click here.",
    });
    expect(unlinkedSpam.signals).toContain("mailgun-spam");
    const bounce = classify({ ...vector("V13").in, headers: [...vector("V13").in.headers, ["X-Mailgun-Sflag", "Yes"]] });
    expect(bounce).toMatchObject({ nature: "BOUNCE" });
    expect(bounce.signals).toContain("mailgun-spam");
  });
});

describe("classify: details", () => {
  it("a reply to our own subject never counts as an auto subject", () => {
    const r = classify(linkedReply({ subject: "Re: Out of office furniture", sentSubjects: ["Out of office furniture"], strippedText: "Yes, send the catalogue." }));
    expect(r.nature).toBe("REPLY");
    const ours = classify(linkedReply({ subject: "Automatic reply systems", sentSubjects: ["Automatic reply systems"], headers: [], strippedText: "Yes." }));
    expect(ours.nature).toBe("REPLY");
  });

  it("reads the null sender from X-Envelope-From too", () => {
    const r = classify(linkedReply({ envelopeSender: null, headers: [...thread, ["X-Envelope-From", "<>"]], strippedText: "Away." }));
    expect(r.signals).toContain("null-sender");
    expect(r.nature).toBe("AUTO");
  });

  it("ignores malformed header entries from the database", () => {
    const junk = [["Auto-Submitted"], [1, 2], "x", null] as unknown as ClassifyInput["headers"];
    expect(classify(linkedReply({ headers: junk, strippedText: "Yes please." })).nature).toBe("REPLY");
  });

  it("returns every signal that fired", () => {
    const r = check(vector("V03"));
    expect(r.signals).toEqual(expect.arrayContaining(["auto-submitted:auto-generated", "null-sender", "subject:auto-prefix", "x-auto-response-suppress"]));
    expect(r.confidence).toBe("certain");
  });

  it("is deterministic", () => {
    for (const v of vectors) expect(classify(v.in)).toEqual(classify(v.in));
  });
});

describe("classify: cost (M4-DESIGN §3.4 rule 13)", () => {
  it("stays under 50 ms per call for a 16,000-character single line and for 2,000 lines starting with digits", () => {
    const oneLine = "x".repeat(16_000);
    const digits = Array.from({ length: 2_000 }, (_, i) => `${i} 21.09.2026 10:15 line of text with a number ${i}`).join("\n");
    const mixed = Array.from({ length: 2_000 }, (_, i) => `${i} On Mon ${i} wrote something: Final-Recipient: x`).join("\n");
    const inputs: ClassifyInput[] = [
      { subject: "Re: x", fromEmail: "a@b.de", headers: [], bodyPlain: oneLine, linked: true },
      { subject: "Re: x", fromEmail: "a@b.de", headers: [], strippedText: oneLine, bodyPlain: oneLine },
      { subject: "Re: x", fromEmail: "a@b.de", headers: [], bodyPlain: digits, linked: true },
      { subject: "Re: x", fromEmail: "a@b.de", headers: [], bodyPlain: mixed },
    ];
    for (const input of inputs) classify(input); // warm up
    for (const input of inputs) {
      const start = performance.now();
      for (let i = 0; i < 5; i++) classify(input);
      const perCall = (performance.now() - start) / 5;
      expect(perCall).toBeLessThan(50);
    }
  });
});
