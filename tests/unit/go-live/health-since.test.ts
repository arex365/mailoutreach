import { describe, expect, it } from "vitest";
import { countsFromGoLive, healthCountingSince, healthGoLiveAt, nextHealthSince, parseHealthSinceGoLive } from "@/core/sending/health-since";

/** Health counted from go-live on real data (M6-DESIGN §2.6, G12): the later of the baseline and go-live. */

const BASE = "2026-09-20T10:00:00.000Z";
const LIVE = "2026-09-23T08:30:00.000Z";

describe("healthCountingSince", () => {
  it("takes the later of the baseline and go-live on real data", () => {
    expect(healthCountingSince(BASE, LIVE, false)?.toISOString()).toBe(LIVE);
    expect(healthCountingSince("2026-09-25T00:00:00.000Z", LIVE, false)?.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(healthCountingSince(null, LIVE, false)?.toISOString()).toBe(LIVE);
    expect(healthCountingSince(BASE, null, false)?.toISOString()).toBe(BASE);
    expect(healthCountingSince(null, null, false)).toBeNull();
  });

  it("uses the baseline alone in the practice copy (it never goes live)", () => {
    expect(healthCountingSince(BASE, LIVE, true)?.toISOString()).toBe(BASE);
    expect(healthCountingSince(null, LIVE, true)).toBeNull();
  });

  it("ignores unreadable values", () => {
    expect(healthCountingSince("not a date", LIVE, false)?.toISOString()).toBe(LIVE);
    expect(healthCountingSince(BASE, "", false)?.toISOString()).toBe(BASE);
    expect(healthCountingSince("", "nope", false)).toBeNull();
  });

  it("tells when the counting starts at go-live (for 'Counting since you went live on …')", () => {
    expect(countsFromGoLive(healthCountingSince(BASE, LIVE, false), LIVE, false)).toBe(true);
    expect(countsFromGoLive(healthCountingSince("2026-09-25T00:00:00.000Z", LIVE, false), LIVE, false)).toBe(false);
    expect(countsFromGoLive(healthCountingSince(BASE, LIVE, true), LIVE, true)).toBe(false);
    expect(countsFromGoLive(null, LIVE, false)).toBe(false);
  });
});

/**
 * Review REPLIES-02: health counts from the FIRST go-live on the sending domain. A From change ends go-live on the same
 * Mailgun domain; going live again must keep the earlier live period's bounces and complaints in the count.
 */
const FIRST = "2026-09-10T09:00:00.000Z";
const AGAIN = "2026-09-26T09:00:00.000Z";
const D = "send.example.com";

describe("parseHealthSinceGoLive", () => {
  it("reads a complete value (times normalised, domain lowercase) and refuses anything else", () => {
    expect(parseHealthSinceGoLive({ since: FIRST, goLiveAt: AGAIN, domain: " Send.Example.com " })).toEqual({ since: FIRST, goLiveAt: AGAIN, domain: D });
    expect(parseHealthSinceGoLive({ since: "2026-09-10T11:00:00+02:00", goLiveAt: AGAIN, domain: D })?.since).toBe(FIRST);
    for (const bad of [null, undefined, "x", 3, [], {}, { since: FIRST, goLiveAt: AGAIN }, { since: "nope", goLiveAt: AGAIN, domain: D }, { since: FIRST, goLiveAt: "", domain: D }, { since: FIRST, goLiveAt: AGAIN, domain: " " }]) {
      expect(parseHealthSinceGoLive(bad)).toBeNull();
    }
  });
});

describe("healthGoLiveAt", () => {
  it("uses the first go-live while the value belongs to today's go-live", () => {
    expect(healthGoLiveAt(AGAIN, { since: FIRST, goLiveAt: AGAIN, domain: D })).toBe(FIRST);
    // And healthCountingSince then counts from it (a later baseline still wins).
    expect(healthCountingSince(null, healthGoLiveAt(AGAIN, { since: FIRST, goLiveAt: AGAIN, domain: D }), false)?.toISOString()).toBe(FIRST);
    expect(healthCountingSince(BASE, healthGoLiveAt(AGAIN, { since: FIRST, goLiveAt: AGAIN, domain: D }), false)?.toISOString()).toBe(BASE);
  });

  it("falls back to sending.goLiveAt: missing (older installs, seeds), unreadable, or written for another go-live", () => {
    expect(healthGoLiveAt(LIVE, null)).toBe(LIVE);
    expect(healthGoLiveAt(LIVE, undefined)).toBe(LIVE);
    expect(healthGoLiveAt(LIVE, { since: "bad" })).toBe(LIVE);
    // A go-live written directly after goLive() wrote the value (a seed or a test): the value doesn't belong to it.
    expect(healthGoLiveAt(LIVE, { since: FIRST, goLiveAt: AGAIN, domain: D })).toBe(LIVE);
    // A start after the go-live itself is never used.
    expect(healthGoLiveAt(FIRST, { since: AGAIN, goLiveAt: FIRST, domain: D })).toBe(FIRST);
  });

  it("is null without a readable go-live (everything counts, as before)", () => {
    expect(healthGoLiveAt(null, { since: FIRST, goLiveAt: AGAIN, domain: D })).toBeNull();
    expect(healthGoLiveAt("", null)).toBeNull();
    expect(healthGoLiveAt("nope", null)).toBeNull();
  });

  it("keeps saying 'Counting since you went live' for the first go-live", () => {
    const live = healthGoLiveAt(AGAIN, { since: FIRST, goLiveAt: AGAIN, domain: D });
    expect(countsFromGoLive(healthCountingSince(null, live, false), live, false)).toBe(true);
  });
});

describe("nextHealthSince (what goLive() writes)", () => {
  it("the first go-live ever starts counting at that go-live", () => {
    expect(nextHealthSince({ goLiveAt: null, goLiveDomain: null, healthSince: null }, D, FIRST)).toEqual({ since: FIRST, goLiveAt: FIRST, domain: D });
  });

  it("going live again on the same sending domain (a From change ended go-live) keeps the first go-live", () => {
    const first = nextHealthSince({ goLiveAt: null, goLiveDomain: null, healthSince: null }, D, FIRST);
    const again = nextHealthSince({ goLiveAt: FIRST, goLiveDomain: "Send.Example.com", healthSince: first }, D, AGAIN);
    expect(again).toEqual({ since: FIRST, goLiveAt: AGAIN, domain: D });
    // A third go-live on the same domain still counts from the first.
    const third = "2026-09-27T09:00:00.000Z";
    expect(nextHealthSince({ goLiveAt: AGAIN, goLiveDomain: D, healthSince: again }, D, third)).toEqual({ since: FIRST, goLiveAt: third, domain: D });
  });

  it("an install that went live before this setting existed keeps its earlier go-live", () => {
    expect(nextHealthSince({ goLiveAt: FIRST, goLiveDomain: D, healthSince: null }, D, AGAIN)).toEqual({ since: FIRST, goLiveAt: AGAIN, domain: D });
  });

  it("a go-live on another sending domain starts counting again", () => {
    const first = { since: FIRST, goLiveAt: FIRST, domain: "old.example.com" };
    expect(nextHealthSince({ goLiveAt: FIRST, goLiveDomain: "old.example.com", healthSince: first }, D, AGAIN)).toEqual({ since: AGAIN, goLiveAt: AGAIN, domain: D });
  });

  it("an unreadable previous go-live, or one after this go-live, starts at this go-live", () => {
    expect(nextHealthSince({ goLiveAt: "nope", goLiveDomain: D, healthSince: null }, D, AGAIN)).toEqual({ since: AGAIN, goLiveAt: AGAIN, domain: D });
    expect(nextHealthSince({ goLiveAt: AGAIN, goLiveDomain: D, healthSince: null }, D, FIRST)).toEqual({ since: FIRST, goLiveAt: FIRST, domain: D });
  });
});
