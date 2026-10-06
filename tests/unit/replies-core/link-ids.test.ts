import { describe, expect, it } from "vitest";
import { bodyMessageIds, bounceRecipients, findEmailAddresses, namedRecipients, threadIds } from "@/core/replies/link-ids";
import { extractNewText } from "@/core/replies/quote";
import { A, vector } from "./vectors";

describe("threadIds", () => {
  it("puts In-Reply-To first, then References newest → oldest", () => {
    expect(threadIds({ inReplyTo: "c@x.com", references: "a@x.com b@x.com c@x.com" })).toEqual(["c@x.com", "b@x.com", "a@x.com"]);
    expect(threadIds({ inReplyTo: "fwd@mail.gmail.com", references: [A, "fwd@mail.gmail.com"] })).toEqual(["fwd@mail.gmail.com", A]);
  });

  it("lowercases, strips angle brackets and de-duplicates", () => {
    expect(threadIds({ inReplyTo: "<PP.ABC@Send.Example.com>", references: "<pp.first@send.example.com>\r\n <pp.abc@send.example.com>" })).toEqual([
      "pp.abc@send.example.com",
      "pp.first@send.example.com",
    ]);
  });

  it("handles missing values", () => {
    expect(threadIds({ inReplyTo: null, references: null })).toEqual([]);
    expect(threadIds({ inReplyTo: null, references: [] })).toEqual([]);
    expect(threadIds({ inReplyTo: "only@x.com", references: null })).toEqual(["only@x.com"]);
  });

  it("returns at most 50 ids", () => {
    const refs = Array.from({ length: 80 }, (_, i) => `id${i}@x.com`).join(" ");
    const ids = threadIds({ inReplyTo: "top@x.com", references: refs });
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("top@x.com");
    expect(ids[1]).toBe("id79@x.com");
  });
});

describe("bodyMessageIds", () => {
  it("finds only our pp. ids, lowercase, in order, once", () => {
    const text = `Original message headers:\nMessage-ID: <${A.toUpperCase().replace("PP.", "pp.")}>\nIn-Reply-To: <CAF123@mail.gmail.com>\nSee ${A}.`;
    expect(bodyMessageIds(text)).toEqual([A]);
    expect(bodyMessageIds(vector("V14").in.bodyPlain)).toEqual([A]);
    expect(bodyMessageIds("pp.123@x.com pp.zzzzzzzzzzzzzzzzzzzzzzzz@x.com")).toEqual([]);
    expect(bodyMessageIds(null)).toEqual([]);
  });
});

describe("bounceRecipients", () => {
  const recipients = (id: string) => {
    const v = vector(id);
    return bounceRecipients({ headers: v.in.headers, text: v.in.bodyPlain ?? v.in.strippedText ?? null });
  };

  it("V13 Gmail: 'wasn't delivered to anna@firma.de'", () => {
    expect(recipients("V13")).toEqual(["anna@firma.de"]);
  });

  it("V14 Exchange: the lines after 'Delivery has failed to these recipients or groups:'", () => {
    expect(recipients("V14")).toEqual(["anna@firma.de"]);
  });

  it("V15 Exim: X-Failed-Recipients and the address after 'delivered to one or more …'", () => {
    expect(recipients("V15")).toEqual(["anna@firma.de"]);
    expect(bounceRecipients({ headers: [], text: vector("V15").in.bodyPlain ?? null })).toEqual(["anna@firma.de"]);
  });

  it("V17 German NDR: the address after 'konnte nicht zugestellt werden an:'", () => {
    expect(recipients("V17")).toEqual(["anna@firma.de"]);
  });

  it("reads Final-Recipient and Postfix's '<address>: host …' lines", () => {
    expect(recipients("V18")).toEqual(["anna@firma.de"]);
    const postfix =
      "I'm sorry to have to inform you that your message could not\nbe delivered to one or more recipients. It's attached below.\n\n" +
      "For further assistance, please send mail to postmaster.\n\n                   The mail system\n\n" +
      "<Ben.Braun@Firma.de>: host mx.firma.de[1.2.3.4] said: 550 5.1.1 User unknown";
    expect(bounceRecipients({ headers: [], text: postfix })).toEqual(["ben.braun@firma.de"]);
  });

  it("names every failed address once, headers first", () => {
    const text = "Delivery has failed to these recipients or groups:\n\nAnna Berg (anna@firma.de)\nold@firma.de\nThe addresses couldn't be found.";
    expect(bounceRecipients({ headers: [["X-Failed-Recipients", "old@firma.de, x@y.de"]], text })).toEqual([
      "old@firma.de",
      "x@y.de",
      "anna@firma.de",
    ]);
  });

  it("is empty when the notice names nobody", () => {
    expect(recipients("V16")).toEqual([]);
    expect(bounceRecipients({ headers: [], text: null })).toEqual([]);
  });
});

describe("namedRecipients", () => {
  it("V20 and V21: the address in the subject", () => {
    for (const id of ["V20", "V21"]) {
      const v = vector(id);
      const expected = id === "V20" ? ["anna@firma.de"] : ["info@firma.de"];
      expect(namedRecipients({ subject: v.in.subject, text: extractNewText(v.in.strippedText, v.in.bodyPlain) })).toEqual(expected);
    }
  });

  it("reads the first 10 lines of the new text, lowercased, unique, and skips links", () => {
    const text = ["Your email to Anna@Firma.de is held.", "https://filter.example/c/anna@firma.de", ...Array(10).fill("x"), "late@firma.de"].join("\n");
    expect(namedRecipients({ subject: "Confirm your message to anna@firma.de", text })).toEqual(["anna@firma.de"]);
    expect(namedRecipients({ subject: "Hello", text: null })).toEqual([]);
  });
});

describe("findEmailAddresses", () => {
  it("normalises addresses and drops punctuation around them", () => {
    expect(findEmailAddresses("Mail <Info@Firma.DE>, or info@firma.de. Also mailto:jonas@firma.de")).toEqual(["Info@firma.de".toLowerCase(), "jonas@firma.de"]);
  });
});
