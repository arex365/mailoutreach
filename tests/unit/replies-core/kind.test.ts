import { describe, expect, it } from "vitest";
import { hasBeenLive, replyLabel, replyScope, storedKind } from "@/core/replies/kind";
import type { LinkTarget, Nature } from "@/core/replies/types";

describe("storedKind (M4-DESIGN §3.5 table)", () => {
  const table: Array<[Nature, LinkTarget, string]> = [
    ["REPLY", "email", "REPLY"],
    ["REPLY", "company", "REPLY"],
    ["REPLY", "test", "TEST_REPLY"],
    ["REPLY", "none", "UNLINKED"],
    ["POSSIBLE", "email", "POSSIBLE_REPLY"],
    ["POSSIBLE", "company", "POSSIBLE_REPLY"],
    ["POSSIBLE", "test", "TEST_REPLY"],
    ["POSSIBLE", "none", "UNLINKED"],
    ["AUTO", "email", "AUTO_REPLY"],
    ["AUTO", "company", "AUTO_REPLY"],
    ["AUTO", "test", "TEST_REPLY"],
    ["AUTO", "none", "AUTO_REPLY"],
    ["BOUNCE", "email", "BOUNCE_NOTICE"],
    ["BOUNCE", "company", "BOUNCE_NOTICE"],
    ["BOUNCE", "test", "TEST_REPLY"],
    ["BOUNCE", "none", "BOUNCE_NOTICE"],
  ];
  it.each(table)("%s + %s → %s", (nature, link, kind) => {
    expect(storedKind(nature, link)).toBe(kind);
  });
});

describe("replyScope (M4-DESIGN §3.6 table)", () => {
  const base = { simulated: false, practiceCopy: false, everLive: false, launchedGoLive: null };

  it("LIVE of a campaign launched after go-live: real scope, changes status, no label", () => {
    expect(replyScope({ ...base, mode: "LIVE", link: "email", everLive: true, launchedGoLive: true })).toEqual({
      scope: "real",
      changesStatus: true,
      label: "",
    });
  });

  it("LIVE of a campaign launched before go-live (a test-list mailbox): real scope, status unchanged", () => {
    expect(replyScope({ ...base, mode: "LIVE", link: "email", launchedGoLive: false })).toEqual({ scope: "real", changesStatus: false, label: "" });
  });

  it("M6-DESIGN §2.2: a live email is judged by its campaign's launch flag, never by go-live", () => {
    // A late reply to a test email sent before go-live never makes a test mailbox Replied, also after go-live.
    expect(replyScope({ ...base, mode: "LIVE", link: "email", everLive: true, launchedGoLive: false }).changesStatus).toBe(false);
    expect(replyScope({ ...base, mode: "LIVE", link: "email", everLive: true, launchedGoLive: null }).changesStatus).toBe(false);
    // A campaign launched after go-live keeps changing status whatever the switch says.
    expect(replyScope({ ...base, mode: "LIVE", link: "email", everLive: false, launchedGoLive: true }).changesStatus).toBe(true);
  });

  it("a company link has no email to judge by: it asks whether the app has been live (or the practice copy)", () => {
    for (const launchedGoLive of [true, false, null]) {
      expect(replyScope({ ...base, mode: null, link: "company", everLive: true, launchedGoLive }).changesStatus).toBe(true);
      expect(replyScope({ ...base, mode: null, link: "company", everLive: false, launchedGoLive }).changesStatus).toBe(false);
    }
  });

  it("DRY_RUN in the practice copy, from any source: real scope, changes status", () => {
    for (const simulated of [true, false]) {
      for (const everLive of [true, false]) {
        expect(replyScope({ mode: "DRY_RUN", link: "email", simulated, practiceCopy: true, everLive, launchedGoLive: everLive })).toEqual({
          scope: "real",
          changesStatus: true,
          label: "",
        });
      }
    }
  });

  it("DRY_RUN on real data (simulated): only that campaign, no status, 'Dry run: '", () => {
    expect(replyScope({ ...base, mode: "DRY_RUN", link: "email", simulated: true })).toEqual({
      scope: "campaign",
      changesStatus: false,
      label: "Dry run: ",
    });
    expect(replyScope({ ...base, mode: "DRY_RUN", link: "email", simulated: true, everLive: true }).scope).toBe("campaign");
  });

  it("TEST (Mailgun's test mode): only that campaign, 'Test: '", () => {
    for (const practiceCopy of [true, false]) {
      expect(replyScope({ ...base, mode: "TEST", link: "email", practiceCopy, everLive: true })).toEqual({
        scope: "campaign",
        changesStatus: false,
        label: "Test: ",
      });
    }
  });

  it("a company without an email: real scope, status in the practice copy or once the app has been live", () => {
    expect(replyScope({ ...base, mode: null, link: "company" })).toEqual({ scope: "real", changesStatus: false, label: "" });
    expect(replyScope({ ...base, mode: null, link: "company", everLive: true }).changesStatus).toBe(true);
    expect(replyScope({ ...base, mode: null, link: "company", practiceCopy: true }).changesStatus).toBe(true);
  });

  it("a TestSend or internal sender, and unlinked: no scope", () => {
    for (const link of ["test", "none"] as const) {
      expect(replyScope({ ...base, mode: "LIVE", link, everLive: true, practiceCopy: true })).toEqual({ scope: "none", changesStatus: false, label: "" });
      expect(replyScope({ ...base, mode: null, link })).toEqual({ scope: "none", changesStatus: false, label: "" });
    }
  });
});

describe("hasBeenLive (review GOLIVE-01)", () => {
  it("is live today, or went live before (a domain change switched go-live off but kept when)", () => {
    expect(hasBeenLive({ goLive: true, goLiveAt: "2026-09-20T08:00:00.000Z" })).toBe(true);
    expect(hasBeenLive({ goLive: true, goLiveAt: null })).toBe(true);
    // After a sending-domain change (G8): go-live off, its time kept.
    expect(hasBeenLive({ goLive: false, goLiveAt: "2026-09-20T08:00:00.000Z" })).toBe(true);
  });

  it("is false before the first go-live, and for anything that isn't a time", () => {
    expect(hasBeenLive({ goLive: false, goLiveAt: null })).toBe(false);
    expect(hasBeenLive({ goLive: undefined, goLiveAt: undefined })).toBe(false);
    expect(hasBeenLive({ goLive: "true", goLiveAt: "" })).toBe(false);
    expect(hasBeenLive({ goLive: false, goLiveAt: "not a date" })).toBe(false);
  });
});

describe("replyLabel", () => {
  it("labels campaign-scope replies by the email's mode only", () => {
    expect(replyLabel("campaign", "DRY_RUN")).toBe("Dry run: ");
    expect(replyLabel("campaign", "TEST")).toBe("Test: ");
    expect(replyLabel("campaign", "LIVE")).toBe("");
    expect(replyLabel("real", "DRY_RUN")).toBe("");
    expect(replyLabel(null, "TEST")).toBe("");
  });
});
