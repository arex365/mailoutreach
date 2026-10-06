import { describe, expect, it } from "vitest";
import { extractNewText, findCut, firstLines } from "@/core/replies/quote";
import { quoteVectors } from "./vectors";

describe("quoting: the research vectors Q01–Q15", () => {
  it.each(quoteVectors)("%s", (_id, body, want) => {
    expect(firstLines(extractNewText(null, body))).toBe(want);
  });

  it("has all 15 vectors", () => {
    expect(quoteVectors).toHaveLength(15);
  });
});

describe("extractNewText", () => {
  it("prefers Mailgun's stripped-text, and falls back to body-plain when it is missing or blank", () => {
    expect(extractNewText("Yes please.", "Yes please.\n\nOn Mon, 1 Sep 2026 Ali wrote:\n> Hi")).toBe("Yes please.");
    expect(extractNewText("   ", "Gerne!\n\n-----Ursprüngliche Nachricht-----\nVon: Ali")).toBe("Gerne!");
    expect(extractNewText(null, null)).toBe("");
    expect(extractNewText(undefined, "")).toBe("");
  });

  it("keeps newlines, drops quoted lines and collapses runs of blank lines", () => {
    expect(extractNewText(null, "Line one\r\n\r\n\r\n\r\nLine two\n> quoted\nLine three")).toBe("Line one\n\nLine two\nLine three");
  });

  it("stops at a mobile footer", () => {
    expect(extractNewText(null, "Sounds good.\nSent from my iPhone\n\nOn Mon…")).toBe("Sounds good.");
  });

  it("turns no-break spaces into spaces", () => {
    expect(extractNewText("Oui merci", null)).toBe("Oui merci");
  });
});

describe("findCut", () => {
  it("finds an attribution wrapped over lines, an Outlook block and separators", () => {
    expect(findCut(["Hi", "", "On Mon, Sep 21, 2026 at 10:15 AM Ali Khan <", "ali@x.com> wrote:"])).toBe(2);
    expect(findCut(["Hi", "From: Ali", "Sent: Monday", "To: Anna", "Subject: x"])).toBe(1);
    expect(findCut(["Hi", "________________", "From: Ali", "Sent: Monday", "Subject: x"])).toBe(1);
    expect(findCut(["Hi", "---------- Forwarded message ---------"])).toBe(1);
    expect(findCut(["Hi", "Begin forwarded message:"])).toBe(1);
    expect(findCut(["Just a line", "From: someone on the phone"])).toBe(-1);
  });
});

describe("firstLines", () => {
  it("takes at most 3 non-empty lines", () => {
    expect(firstLines("One\n\nTwo\nThree\nFour")).toBe("One Two Three");
  });

  it("cuts at 300 characters with an ellipsis", () => {
    const out = firstLines("word ".repeat(200));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
    expect(firstLines("x".repeat(300))).toHaveLength(300);
    expect(firstLines("x".repeat(301))).toHaveLength(300);
  });

  it("stops at a sign-off after the first line, never at the first line itself", () => {
    expect(firstLines("Hi Ali,\nsounds good.\nBest, Anna\nAnna Berg")).toBe("Hi Ali, sounds good.");
    expect(firstLines("Viele Grüße\nAnna")).toBe("Viele Grüße Anna");
    expect(firstLines("Ja takk.\nMed vennlig hilsen\nOle")).toBe("Ja takk.");
  });

  it("keeps a short thanks right after the greeting (REPLY-04)", () => {
    const anna = "Hi Ali,\n\nThanks!\n\nWe want 20 pieces. What's the price?\n\nAnna";
    expect(firstLines(extractNewText(anna, null))).toBe("Hi Ali, Thanks! We want 20 pieces. What's the price?");
    expect(firstLines(extractNewText(null, anna))).toBe("Hi Ali, Thanks! We want 20 pieces. What's the price?");
    expect(firstLines(extractNewText("Hello,\nThank you Ali.\nPlease send the catalogue.", null))).toBe(
      "Hello, Thank you Ali. Please send the catalogue.",
    );
    expect(firstLines("Dear Mr. Khan,\nMany thanks.\nPlease call me tomorrow.")).toBe("Dear Mr. Khan, Many thanks. Please call me tomorrow.");
    expect(firstLines("Good morning,\nThanks.\nWe need 5 models.")).toBe("Good morning, Thanks. We need 5 models.");
    expect(firstLines("Hallo Ali!\nThank you!\nBitte Preise schicken.")).toBe("Hallo Ali! Thank you! Bitte Preise schicken.");
    // A thanks that is the whole message is kept too, never only the greeting.
    expect(firstLines("Hi Ali,\nThanks!\nAnna")).toBe("Hi Ali, Thanks! Anna");
    // After the greeting and a thanks, a later sign-off still ends the text.
    expect(firstLines("Hi Ali,\nThanks!\nSend prices please.\nBest regards,\nAnna Berg")).toBe("Hi Ali, Thanks! Send prices please.");
  });

  it("keeps a thanks that more of the message follows, and stops at one that only a signature follows", () => {
    expect(firstLines("Great news.\nThanks!\nCan you send prices?\nAnna")).toBe("Great news. Thanks! Can you send prices?");
    expect(firstLines("Sounds good.\nThanks,\nAnna\nFirma GmbH | +49 30 1234567")).toBe("Sounds good.");
    expect(firstLines("Yes please.\nThank you!\nAnna B.")).toBe("Yes please.");
    // Other sign-offs end the text as before, whatever follows.
    expect(firstLines("Yes please.\nBest regards,\nAnna\nThis email is confidential and meant for the addressee only.")).toBe("Yes please.");
  });

  it("a greeting line with more in it is content, not only a greeting", () => {
    expect(firstLines("Hi Ali, sounds good.\nThanks,\nAnna")).toBe("Hi Ali, sounds good.");
  });

  it("accepts other limits", () => {
    expect(firstLines("A\nB\nC", 2)).toBe("A B");
    expect(firstLines("abcdef", 3, 4)).toBe("abc…");
  });
});
