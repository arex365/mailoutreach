import { describe, expect, it } from "vitest";
import { MailgunError } from "@/server/mailgun/errors";
import { checkSendGuard, isSingleBareAddress } from "@/server/mailgun/send-guard";
import type { SendGuard, SendPurpose } from "@/server/mailgun/types";

const beforeGoLive: SendGuard = { goLive: false, testList: new Set(["tester@gmail.com", "tester@outlook.com"]) };
const afterGoLive: SendGuard = { goLive: true, testList: new Set() };

function guardError(fn: () => void): MailgunError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MailgunError);
    return err as MailgunError;
  }
  throw new Error("expected the guard to refuse");
}

/** A campaign email launched after go-live says `testListOnly: false`; everything else leaves it out or says true. */
const check =
  (to: string, purpose: SendPurpose, guard: SendGuard, extra: { testMode?: boolean; testListOnly?: boolean } = {}) =>
  () =>
    checkSendGuard({ to, purpose, guard, ...extra });

describe("checkSendGuard (§4.2.3 step 1, B6.5)", () => {
  it("lets campaign and reply-test emails reach test-list addresses before go-live", () => {
    expect(check("tester@gmail.com", "campaign", beforeGoLive)).not.toThrow();
    expect(check("tester@outlook.com", "reply-test", beforeGoLive)).not.toThrow();
  });

  it("refuses anyone else before go-live, without sending anything", () => {
    for (const purpose of ["campaign", "reply-test"] as const) {
      const err = guardError(check("anna@studio.de", purpose, beforeGoLive));
      expect(err.kind).toBe("guard");
      expect(err.requestStarted).toBe(false);
      expect(err.ambiguous).toBe(false);
      expect(err.message).toBe("Stopped by the test-list guard: anna@studio.de isn't on your test list.");
    }
  });

  it("sends a self-test only to the user's own reply inbox", () => {
    const own = { ...beforeGoLive, ownInbox: "Ali.Khan@Gmail.com" };
    expect(check("ali.khan@gmail.com", "self-test", own)).not.toThrow();
    expect(guardError(check("tester@gmail.com", "self-test", own)).message).toBe(
      "Stopped by the test-list guard: tester@gmail.com isn't your own reply inbox.",
    );
    expect(guardError(check("ali.khan@gmail.com", "self-test", beforeGoLive)).kind).toBe("guard");
    // still only the own inbox after go-live (B10)
    expect(guardError(check("anna@studio.de", "self-test", { ...afterGoLive, ownInbox: "ali.khan@gmail.com" })).kind).toBe("guard");
  });

  it("refuses lists, display names and un-normalised addresses whatever the mode", () => {
    for (const to of [
      "tester@gmail.com, tester@outlook.com",
      "tester@gmail.com;tester@outlook.com",
      "Tester <tester@gmail.com>",
      '"tester"@gmail.com',
      "tester@gmail.com ",
      "Tester@Gmail.com",
      "not-an-address",
      "",
    ]) {
      const err = guardError(check(to, "campaign", afterGoLive));
      expect(err.kind).toBe("guard");
      expect(err.requestStarted).toBe(false);
    }
  });

  it("lets a campaign email of a campaign launched after go-live reach anyone (M6-DESIGN §2.3)", () => {
    expect(check("anna@studio.de", "campaign", afterGoLive, { testListOnly: false })).not.toThrow();
    expect(check("anna@studio.de", "campaign", afterGoLive, { testListOnly: false, testMode: false })).not.toThrow();
  });

  it("after go-live keeps test-list-only emails, and a campaign email without the flag, on the test list (fail closed)", () => {
    const listed: SendGuard = { goLive: true, testList: new Set(["tester@gmail.com"]) };
    for (const extra of [{ testListOnly: true }, {}, { testListOnly: undefined }]) {
      const err = guardError(check("anna@studio.de", "campaign", listed, extra));
      expect(err).toMatchObject({ kind: "guard", requestStarted: false });
      expect(err.message).toBe("Stopped by the test-list guard: anna@studio.de isn't on your test list.");
      // A test-list address still gets it.
      expect(check("tester@gmail.com", "campaign", listed, extra)).not.toThrow();
    }
  });

  it("keeps Mailgun's test mode on the test list after go-live, whatever the flag says (G3)", () => {
    const listed: SendGuard = { goLive: true, testList: new Set(["tester@gmail.com"]) };
    for (const testListOnly of [false, true, undefined]) {
      expect(guardError(check("anna@studio.de", "campaign", listed, { testMode: true, testListOnly })).message).toBe(
        "Stopped by the test-list guard: anna@studio.de isn't on your test list.",
      );
      expect(check("tester@gmail.com", "campaign", listed, { testMode: true, testListOnly })).not.toThrow();
    }
  });

  it("keeps the reply test on the test list after go-live, even with testListOnly: false", () => {
    const listed: SendGuard = { goLive: true, testList: new Set(["tester@gmail.com"]) };
    expect(guardError(check("anna@studio.de", "reply-test", listed, { testListOnly: false })).message).toBe(
      "Stopped by the test-list guard: anna@studio.de isn't on your test list.",
    );
    expect(check("tester@gmail.com", "reply-test", listed)).not.toThrow();
  });

  it("before go-live, testListOnly: false changes nothing: the test list only", () => {
    expect(guardError(check("anna@studio.de", "campaign", beforeGoLive, { testListOnly: false })).kind).toBe("guard");
    expect(check("tester@gmail.com", "campaign", beforeGoLive, { testListOnly: false })).not.toThrow();
  });

  it("the self-test is unchanged: only the user's own inbox, whatever the flags", () => {
    const own = { ...afterGoLive, ownInbox: "ali.khan@gmail.com" };
    expect(check("ali.khan@gmail.com", "self-test", own, { testListOnly: false })).not.toThrow();
    expect(guardError(check("anna@studio.de", "self-test", own, { testListOnly: false })).message).toBe(
      "Stopped by the test-list guard: anna@studio.de isn't your own reply inbox.",
    );
  });
});

describe("isSingleBareAddress", () => {
  it("accepts exactly one normalised address", () => {
    expect(isSingleBareAddress("a@x.com")).toBe(true);
    expect(isSingleBareAddress("A@x.com")).toBe(false);
    expect(isSingleBareAddress("a@x.com,b@y.com")).toBe(false);
    expect(isSingleBareAddress("<a@x.com>")).toBe(false);
  });
});
