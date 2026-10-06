import { describe, expect, it } from "vitest";
import {
  MAILGUN_PLANS,
  MAILGUN_PLAN_FACTS,
  PLAN_TEST_RESERVE,
  PLAN_TEXTS,
  effectiveLogRetentionDays,
  effectiveMaxDailyCap,
  planLimits,
  planOf,
  planRoom,
} from "@/core/mailgun/plan";
import { MailgunError, classifyStatus, isAuthorizedOnlyRefusal, plainMailgunError } from "@/server/mailgun/errors";
import { mailgunFailure } from "@/server/services/sending/mailgun-transport";

/**
 * Step C of docs/dev/MAIN-DOMAIN-DESIGN.md: the Mailgun plan contract (§7.4, O22–O26) and the send-only "limit" kind
 * and authorized-recipients sentence of errors.ts (§2.8, O24, O25). Without a plan in app mode, and for every call but a
 * send, everything answers exactly as before.
 */

describe("plans (O22)", () => {
  it("knows the four plans and their facts from the pricing page", () => {
    expect(MAILGUN_PLANS).toEqual(["free", "basic", "foundation", "scale"]);
    expect(MAILGUN_PLAN_FACTS).toEqual({
      free: { label: "Free (100 emails a day)", dailyLimit: 100, logDays: 1, messageDays: 1 },
      basic: { label: "Basic", dailyLimit: null, logDays: 1, messageDays: 1 },
      foundation: { label: "Foundation", dailyLimit: null, logDays: 5, messageDays: 1 },
      scale: { label: "Scale or higher", dailyLimit: null, logDays: 30, messageDays: 7 },
    });
  });

  it("planOf reads only the exact plan names", () => {
    for (const p of MAILGUN_PLANS) expect(planOf(p)).toBe(p);
    for (const v of ["Free", " free", "enterprise", "", null, undefined, 1, {}]) expect(planOf(v)).toBeNull();
  });

  it("planLimits: a chosen plan everywhere; none chosen = Free (assumed) in own-mailbox mode and nothing in app mode", () => {
    expect(planLimits(null, "app")).toBeNull();
    expect(planLimits(null, "own-mailbox")).toEqual({ ...MAILGUN_PLAN_FACTS.free, plan: "free", assumed: true });
    expect(planLimits("foundation", "own-mailbox")).toEqual({ ...MAILGUN_PLAN_FACTS.foundation, plan: "foundation", assumed: false });
    expect(planLimits("free", "app")).toEqual({ ...MAILGUN_PLAN_FACTS.free, plan: "free", assumed: false });
  });
});

describe("effectiveLogRetentionDays (O26)", () => {
  it("without plan limits is today's saved number (1–30, else 5)", () => {
    expect(effectiveLogRetentionDays(5, null)).toBe(5);
    expect(effectiveLogRetentionDays(12, null)).toBe(12);
    expect(effectiveLogRetentionDays(45, null)).toBe(30);
    expect(effectiveLogRetentionDays(2.7, null)).toBe(2);
    for (const bad of [0, -3, "x", null, undefined, Number.NaN]) expect(effectiveLogRetentionDays(bad, null)).toBe(5);
  });

  it("never more than the plan keeps", () => {
    expect(effectiveLogRetentionDays(5, planLimits(null, "own-mailbox"))).toBe(1);
    expect(effectiveLogRetentionDays(5, planLimits("foundation", "app"))).toBe(5);
    expect(effectiveLogRetentionDays(10, planLimits("foundation", "app"))).toBe(5);
    expect(effectiveLogRetentionDays(3, planLimits("foundation", "app"))).toBe(3);
    expect(effectiveLogRetentionDays(30, planLimits("scale", "app"))).toBe(30);
  });
});

describe("effectiveMaxDailyCap and planRoom (O23)", () => {
  const free = planLimits("free", "own-mailbox");
  it("keeps the saved maximum without a daily limit, and at most the limit minus the reserve with one", () => {
    expect(PLAN_TEST_RESERVE).toBe(10);
    expect(effectiveMaxDailyCap(1000, null)).toBe(1000);
    expect(effectiveMaxDailyCap(1000, planLimits("foundation", "app"))).toBe(1000);
    expect(effectiveMaxDailyCap(1000, free)).toBe(90);
    expect(effectiveMaxDailyCap(50, free)).toBe(50);
    expect(effectiveMaxDailyCap("200", free)).toBe(90);
    expect(effectiveMaxDailyCap("x", null)).toBe(0);
    expect(effectiveMaxDailyCap(-5, null)).toBe(0);
    expect(effectiveMaxDailyCap(1000, { ...free!, dailyLimit: 5 })).toBe(0);
  });

  it("planRoom keeps the reserve for tests and never goes below 0; null without a daily limit", () => {
    expect(planRoom(null, 3)).toBeNull();
    expect(planRoom(planLimits("foundation", "app"), 3)).toBeNull();
    expect(planRoom(free, 0)).toEqual({ campaign: 90, tests: 100 });
    expect(planRoom(free, 89.6)).toEqual({ campaign: 1, tests: 11 });
    expect(planRoom(free, 95)).toEqual({ campaign: 0, tests: 5 });
    expect(planRoom(free, 150)).toEqual({ campaign: 0, tests: 0 });
    expect(planRoom(free, -4)).toEqual({ campaign: 90, tests: 100 });
  });

  it("words the limits as the Limits page and the checklist show them", () => {
    expect(PLAN_TEXTS.capLine(90, 100)).toBe(
      "Your Mailgun plan sends at most 100 emails a day, so the app plans at most 90 campaign emails a day and keeps 10 for test emails.",
    );
    expect(PLAN_TEXTS.maxFieldHint(90)).toBe("Your Mailgun plan keeps this at 90 at most.");
    expect(PLAN_TEXTS.testsFull(100)).toBe("Your Mailgun plan sends at most 100 emails in 24 hours, and that many have gone out. Try again later.");
    expect(PLAN_TEXTS.monthlyNotNeeded(100)).toBe("Your Mailgun plan stops at 100 emails a day, so a monthly safety limit isn't needed.");
    expect(PLAN_TEXTS.planSummary("Arslan", "Free", 1, 1)).toBe(
      "Arslan set the Mailgun plan to Free, with 1 day of event logs and 1 day of stored replies",
    );
    expect(PLAN_TEXTS.planSummary("Arslan", "Scale or higher", 30, 7)).toBe(
      "Arslan set the Mailgun plan to Scale or higher, with 30 days of event logs and 7 days of stored replies",
    );
  });
});

describe("classifyStatus: the send-only limit rule (O24, §2.8)", () => {
  const send = { send: true };
  it("a 400 or 403 to a send that says the plan's limit is reached is 'limit'", () => {
    expect(classifyStatus(400, "Domain example.com has reached its daily sending limit of 100 messages.", send)).toBe("limit");
    expect(classifyStatus(403, "sending quota exceeded", send)).toBe("limit");
    expect(classifyStatus(400, "Free accounts are limited to 100 messages per day", send)).toBe("limit");
    expect(classifyStatus(403, "Account limit reached: plan limit exceeded", send)).toBe("limit");
  });

  it("message-sized limits and texts without the plan words stay 'rejected'", () => {
    expect(classifyStatus(400, "Message size limit exceeded", send)).toBe("rejected");
    expect(classifyStatus(400, "Recipient limit exceeded: 1000 recipients per message", send)).toBe("rejected");
    expect(classifyStatus(400, "limit reached", send)).toBe("rejected");
    expect(classifyStatus(400, "to parameter is not a valid address. please check documentation.", send)).toBe("rejected");
  });

  it("every other endpoint (no `send`) and every other status keeps today's kinds", () => {
    const limitText = "Domain example.com has reached its daily sending limit of 100 messages.";
    expect(classifyStatus(400, limitText)).toBe("rejected");
    expect(classifyStatus(400, limitText, { send: false })).toBe("rejected");
    expect(classifyStatus(403, "sending quota exceeded")).toBe("auth");
    expect(classifyStatus(402, "quota exceeded", send)).toBe("payment");
    expect(classifyStatus(402, "quota exceeded")).toBe("payment");
    expect(classifyStatus(429, limitText, send)).toBe("rate-limited");
    expect(classifyStatus(500, limitText, send)).toBe("server");
    expect(classifyStatus(404, limitText, send)).toBe("not-found");
  });

  it("business verification wins over the limit rule, and the limit rule over 'not allowed'", () => {
    expect(classifyStatus(403, "Domain x is not allowed to send: business verification is required (daily sending limit)", send)).toBe(
      "business-verification",
    );
    expect(classifyStatus(403, "Domain x is not allowed to send: daily sending limit reached", send)).toBe("limit");
    expect(classifyStatus(403, "Domain x is not allowed to send: daily sending limit reached")).toBe("not-allowed");
    const authorized =
      "Domain example.com is not allowed to send: Free accounts are for test purposes only. Please upgrade or add the address to authorized recipients in Account Settings.";
    expect(classifyStatus(403, authorized, send)).toBe("not-allowed");
  });
});

describe("the sending loop's answer to a limit refusal (O24)", () => {
  it("pauses sending and puts the email back, never failing it for good", () => {
    const err = new MailgunError({
      kind: "limit",
      status: 400,
      mailgunMessage: "Domain example.com has reached its daily sending limit of 100 messages.",
      message: "Mailgun answered 400 to POST /v3/example.com/messages",
    });
    expect(mailgunFailure(err, { domain: "example.com", now: new Date("2026-09-28T04:00:00Z") })).toEqual({
      kind: "pause",
      pause: "mailgun-not-allowed",
      reason: "Mailgun's sending limit for your plan is reached",
      fixText: PLAN_TEXTS.limitRefused,
      mailgunMessage: "Domain example.com has reached its daily sending limit of 100 messages.",
    });
  });
});

describe("plainMailgunError and isAuthorizedOnlyRefusal (O24, O25)", () => {
  const err = (kind: MailgunError["kind"], mailgunMessage: string, status = 403) =>
    new MailgunError({ kind, status, mailgunMessage, message: `Mailgun answered ${status} to POST /v3/example.com/messages: ${mailgunMessage}` });

  it("the limit kind has the plan sentence", () => {
    expect(plainMailgunError(err("limit", "daily sending limit", 400))).toBe(PLAN_TEXTS.limitRefused);
    expect(err("limit", "daily sending limit", 400).ambiguous).toBe(false);
  });

  it("an authorized-recipients refusal gets the campaign sentence (never asks to authorize a prospect); other refusals as before", () => {
    const text = "Domain example.com is not allowed to send: Free accounts are for test purposes only.";
    expect(isAuthorizedOnlyRefusal(text)).toBe(true);
    expect(isAuthorizedOnlyRefusal("please add the address to Authorised Recipients")).toBe(true);
    expect(isAuthorizedOnlyRefusal("Domain example.com is not allowed to send: disabled")).toBe(false);
    expect(plainMailgunError(err("not-allowed", text))).toBe(PLAN_TEXTS.authorizedOnlyCampaign);
    expect(PLAN_TEXTS.authorizedOnlyCampaign).not.toMatch(/authorized recipients,|add this|Authorized recipients/);
    expect(plainMailgunError(err("not-allowed", "Domain example.com is disabled"), { domain: "example.com" })).toBe(
      "Mailgun won't send from example.com right now. Check the banner in Mailgun, then click Resume.",
    );
  });
});
