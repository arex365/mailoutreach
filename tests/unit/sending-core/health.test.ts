import { describe, expect, it } from "vitest";
import { MAILGUN_LIMITS, emailsCountedText, evaluateHealth, healthLine, type HealthCounts, type HealthSettings } from "@/core/sending/health";

const S: HealthSettings = { bounceWindow: 200, bouncePercent: 3, complaintWindow: 1000, complaintPercent: 0.1 };
const notWarned = { bounce: false, complaint: false };

function counts(c: Partial<HealthCounts> = {}): HealthCounts {
  return { bounces: 0, bounceSample: 200, complaints: 0, complaintSample: 1000, ...c };
}

describe("evaluateHealth: limits and pauses", () => {
  it("computes the limits from the fixed windows", () => {
    const v = evaluateHealth(counts(), S, notWarned);
    expect(v.bounceLimit).toBe(6);
    expect(v.complaintLimit).toBe(1);
    expect(v.pause).toBeNull();
    expect(v.warn).toEqual([]);
  });

  it("doesn't pause at 6 bounces of 200 and pauses at 7", () => {
    expect(evaluateHealth(counts({ bounces: 6 }), S, notWarned).pause).toBeNull();
    const v = evaluateHealth(counts({ bounces: 7 }), S, notWarned);
    expect(v.pause).toEqual({
      kind: "health-bounce",
      reason: "7 of the last 200 emails bounced",
      fixText:
        "Your limit is 6. Open the bounced list in Settings › Deliverability (it shows each bounce's campaign and lists), remove or re-check the list they came from, then click Resume.",
      detail: { count: 7, sample: 200, window: 200, limit: 6 },
    });
  });

  it("pauses at 7 bounces among the first 50 emails (fixed denominator)", () => {
    const v = evaluateHealth(counts({ bounces: 7, bounceSample: 50, complaintSample: 50 }), S, notWarned);
    expect(v.pause?.kind).toBe("health-bounce");
    expect(v.pause?.reason).toBe("7 of the last 50 emails bounced");
    expect(v.pause?.detail).toEqual({ count: 7, sample: 50, window: 200, limit: 6 });
    expect(evaluateHealth(counts({ bounces: 6, bounceSample: 50 }), S, notWarned).pause).toBeNull();
  });

  it("doesn't pause at 1 complaint of 1,000 and pauses at 2", () => {
    expect(evaluateHealth(counts({ complaints: 1 }), S, notWarned).pause).toBeNull();
    const v = evaluateHealth(counts({ complaints: 2 }), S, notWarned);
    expect(v.pause).toEqual({
      kind: "health-complaint",
      reason: "2 of the last 1,000 emails were marked as spam",
      fixText:
        "Your limit is 1. Settings › Deliverability shows which campaign they came from; check it before you resume. Mailgun's own limit is 0.08%.",
      detail: { count: 2, sample: 1000, window: 1000, limit: 1 },
    });
  });

  it("returns the bounce pause when both rules trip", () => {
    const v = evaluateHealth(counts({ bounces: 9, complaints: 3 }), S, notWarned);
    expect(v.pause?.kind).toBe("health-bounce");
    expect(v.warn).toEqual([]);
  });

  it("says 'was' for a single complaint when the limit is 0", () => {
    const strict = { ...S, complaintWindow: 200, complaintPercent: 0.01 };
    const v = evaluateHealth(counts({ complaints: 1, complaintSample: 120 }), strict, notWarned);
    expect(v.complaintLimit).toBe(0);
    expect(v.pause?.reason).toBe("1 of the last 120 emails was marked as spam");
  });
});

describe("evaluateHealth: warnings", () => {
  it("warns at half the bounce limit, once", () => {
    expect(evaluateHealth(counts({ bounces: 2 }), S, notWarned).warn).toEqual([]);
    expect(evaluateHealth(counts({ bounces: 3 }), S, notWarned).warn).toEqual([
      {
        rule: "bounce",
        title: "Bounces are rising: 3 of the last 200 emails bounced",
        body: "Sending pauses automatically at 7. Check the bounced addresses in Settings › Deliverability.",
      },
    ]);
    expect(evaluateHealth(counts({ bounces: 5 }), S, { bounce: true, complaint: false }).warn).toEqual([]);
  });

  it("warns at the first complaint, once", () => {
    expect(evaluateHealth(counts({ complaints: 1 }), S, notWarned).warn).toEqual([
      {
        rule: "complaint",
        title: "An email was marked as spam",
        body: "1 of the last 1,000 emails drew a complaint. Sending pauses automatically at 2.",
      },
    ]);
    expect(evaluateHealth(counts({ complaints: 1 }), S, { bounce: false, complaint: true }).warn).toEqual([]);
  });

  it("can warn about both rules at once, and never while pausing", () => {
    expect(evaluateHealth(counts({ bounces: 4, complaints: 1 }), S, notWarned).warn.map((w) => w.rule)).toEqual([
      "bounce",
      "complaint",
    ]);
    const paused = evaluateHealth(counts({ bounces: 7, complaints: 1 }), S, notWarned);
    expect(paused.pause?.kind).toBe("health-bounce");
    expect(paused.warn).toEqual([]);
  });

  it("words several complaints in the plural", () => {
    const loose = { ...S, complaintPercent: 1 }; // limit 10, warning from 5
    const v = evaluateHealth(counts({ complaints: 5 }), loose, notWarned);
    expect(v.warn[0]).toEqual({
      rule: "complaint",
      title: "5 emails were marked as spam",
      body: "5 of the last 1,000 emails drew complaints. Sending pauses automatically at 11.",
    });
  });
});

describe("healthLine", () => {
  it("shows the count, the pause limit and Mailgun's own limit", () => {
    expect(healthLine("bounce", counts({ bounces: 3 }), S)).toBe(
      "3 of the last 200 emails bounced · sending pauses above 6 (3%) · Mailgun's own limit is 5%.",
    );
    expect(healthLine("complaint", counts(), S)).toBe(
      "0 of the last 1,000 emails were marked as spam · sending pauses above 1 (0.1%) · Mailgun's own limit is 0.08%.",
    );
    expect(healthLine("bounce", counts({ bounceSample: 0 }), S)).toBe(
      "No emails counted yet · sending pauses above 6 (3%) · Mailgun's own limit is 5%.",
    );
  });

  it("words a single counted email in the singular ('of 1 email so far', never 'of the last 1 emails')", () => {
    expect(healthLine("bounce", counts({ bounceSample: 1 }), S)).toBe(
      "0 of 1 email so far bounced · sending pauses above 6 (3%) · Mailgun's own limit is 5%.",
    );
    expect(healthLine("complaint", counts({ complaintSample: 1 }), S)).toBe(
      "0 of 1 email so far was marked as spam · sending pauses above 1 (0.1%) · Mailgun's own limit is 0.08%.",
    );
    expect(healthLine("complaint", counts({ complaints: 1, complaintSample: 1 }), S).startsWith("1 of 1 email so far was marked as spam")).toBe(
      true,
    );
    expect(healthLine("bounce", counts({ bounces: 1, bounceSample: 2 }), S).startsWith("1 of the last 2 emails bounced")).toBe(true);
    // One live email that drew a complaint: the warning says so plainly.
    expect(evaluateHealth(counts({ complaints: 1, complaintSample: 1, bounceSample: 1 }), S, notWarned).warn).toEqual([
      {
        rule: "complaint",
        title: "An email was marked as spam",
        body: "1 of 1 email so far drew a complaint. Sending pauses automatically at 2.",
      },
    ]);
    expect(emailsCountedText(1)).toBe("1 email so far");
    expect(emailsCountedText(1200)).toBe("the last 1,200 emails");
  });

  it("knows Mailgun's limits", () => {
    expect(MAILGUN_LIMITS).toEqual({ bouncePercent: 5, complaintPercent: 0.08 });
  });
});
