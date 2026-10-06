import { describe, expect, it } from "vitest";
import { parseAuthResults, parseDmarcResult, parseTestOriginal } from "@/core/reply-test";
import { testOriginal } from "./originals";

/**
 * Review REPLIES-04: pasted originals and headers (up to 200,000 characters, the actions' limit) are read in the web
 * server's own process, so reading them must take linear time. Before the fix a From: or Return-Path: line of one long
 * token without an @ took about 20 seconds at that size (the /([^\s<>"]+@[^\s<>"]+)/ fallback backtracked
 * quadratically), blocking the app for everyone. Each garbled paste below must now read in a fraction of a second, and
 * a real original still reads the same.
 */

const LIMIT = 200_000;
const D = "send.example.com";
const opts = { sendingDomain: D, fromDomain: "example.com" };
/** Generous for a slow PC; the quadratic version needed seconds to tens of seconds for each case. */
const BUDGET_MS = 750;

function timed<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

/** A garbled paste of about LIMIT characters: a Message-ID and one huge header line. */
function huge(name: string, value: string): string {
  const head = `Message-ID: <pp.t.1.abc@${D}>\n${name}: `;
  return head + value.slice(0, LIMIT - head.length);
}

describe("reading a pasted original takes linear time (REPLIES-04)", () => {
  const cases: Array<[string, string]> = [
    ["a From: line of one long token without an @", huge("From", "x".repeat(LIMIT))],
    ["a Return-Path: line of one long token without an @", huge("Return-Path", "x".repeat(LIMIT))],
    ["a From: line of a@a@a@… in an unclosed <", huge("From", `<${"a@".repeat(LIMIT)}`)],
    ["a From: line of many <x> without an @", huge("From", "<xx>".repeat(LIMIT))],
    ["a Return-Path: whose host is a long run of dots", huge("Return-Path", `<bounce@${".".repeat(LIMIT)}x>`)],
    ["a List-Unsubscribe mailto: host of dots and ?", huge("List-Unsubscribe", `<mailto:u@${".?".repeat(LIMIT)}>`)],
    [
      "Authentication-Results with a long result and a Unicode line separator",
      huge("Authentication-Results", `mx.google.com; dmarc=${"a".repeat(LIMIT)}${String.fromCharCode(0x2028)}x`),
    ],
    ["Authentication-Results folded over thousands of lines", `Message-ID: <pp.t.1.abc@${D}>\nAuthentication-Results: mx.google.com;\n${" dkim=pass header.d=example.com;\n".repeat(6_000)}`],
    ["thousands of short header lines", `Message-ID: <pp.t.1.abc@${D}>\n${"From: x\n".repeat(25_000)}`],
  ];

  for (const [what, text] of cases) {
    it(what, () => {
      expect(text.length).toBeGreaterThan(LIMIT * 0.9);
      const original = timed(() => parseTestOriginal(text, opts));
      expect(original.ms, `parseTestOriginal: ${what}`).toBeLessThan(BUDGET_MS);
      expect(original.value.messageId).toBe(`pp.t.1.abc@${D}`);
      const dmarc = timed(() => parseDmarcResult(text, { fromDomain: "example.com" }));
      expect(dmarc.ms, `parseDmarcResult: ${what}`).toBeLessThan(BUDGET_MS);
      // The "Not sure" paste box of the reply's dkim/arc question: with and without the mailbox's address.
      const withFrom = timed(() => parseAuthResults(text, { from: "t.gmail@gmail.com" }));
      expect(withFrom.ms, `parseAuthResults: ${what}`).toBeLessThan(BUDGET_MS);
      const withoutFrom = timed(() => parseAuthResults(text));
      expect(withoutFrom.ms, `parseAuthResults without from: ${what}`).toBeLessThan(BUDGET_MS);
    });
  }

  it("parseAuthResults reads the From: line of pasted headers in linear time too (a@a@… in <)", () => {
    const text = `Authentication-Results: mx.google.com; dkim=fail header.i=@gmail.com\nFrom: <${"a@".repeat(LIMIT / 2)}`;
    const { ms, value } = timed(() => parseAuthResults(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toBe("fail");
  });

  it("a garbled From: reads as no address; a sane one after the cut is still found", () => {
    expect(parseTestOriginal(huge("From", "x".repeat(LIMIT)), opts).from).toBeNull();
    expect(parseTestOriginal(`Message-ID: <a@${D}>\nFrom: Arslan <contact@example.com>`, opts).from).toBe("contact@example.com");
    expect(parseTestOriginal(`Message-ID: <a@${D}>\nFrom: contact@example.com (Arslan)`, opts).from).toBe("contact@example.com");
    expect(parseTestOriginal(`Message-ID: <a@${D}>\nReturn-Path: <bounce@${D}...>`, opts)).toMatchObject({ returnPathDomain: D, returnPathOk: true });
  });

  it("a real original of the maximum size still reads the same", () => {
    const real = testOriginal({ from: "Arslan from Polygon Paradise <contact@example.com>", messageId: `pp.t.9.1a2b3c4d5e6f@${D}` });
    const padded = `${real}\n${"x".repeat(LIMIT - real.length - 1)}`;
    const { ms, value } = timed(() => parseTestOriginal(padded, opts));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toEqual(parseTestOriginal(real, opts));
    expect(value).toMatchObject({ from: "contact@example.com", returnPathOk: true, dmarc: "pass", dkimSigner: "example.com", mailtoOk: true });
  });
});
