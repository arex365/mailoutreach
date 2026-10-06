import { describe, expect, it } from "vitest";
import { aboutUsd, formatUsd, roundUsd, smallUsd } from "@/core/money";
import { monthBounds } from "@/core/time/month";
import { foldForLookup, normalizeForMatch, withPositionMap } from "@/core/ai/normalize";
import {
  AI_QUEUE_TABS,
  AI_TAB_LABELS,
  AI_TAB_STATUS,
  DEFAULT_AI_PRICES,
  HAIKU_MODEL,
  NO_LINE_TEXT,
  REASON_CODES,
  SKIP_CODES,
  SONNET_MODEL,
  estimateTextTokens,
  resolveProfile,
} from "@/core/ai/types";
import { CLEARED_CHECK_FIELDS, EMPTY_VERIFY_CARRY, LIVE_CHECK_CONTEXT, REAL_PROVIDERS } from "@/core/verification/types";
import {
  NOT_PAUSED_AI,
  NOT_PAUSED_CHECKS,
  parseAiPause,
  parseAiTokens,
  parseCheckPause,
} from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import {
  CHECK_PENDING_CODES,
  DEFAULT_VERIFICATION_POLICY,
  ELIGIBILITY_CODES,
  checkDecision,
  evaluateEligibility,
  policyBlockedText,
  reasonOrder,
  type EligibilityContext,
  type PersonFacts,
} from "@/core/rules/eligibility";
import { recheckStateText } from "@/core/sequences/wording";
import { AI_NOTIFICATION, VERIFY_NOTIFICATION, notificationFilterOf, popupGroupOf } from "@/core/notification-types";

/** The Milestone 5 step-C contract (docs/dev/M5-DESIGN.md §5.8–§5.9): the pure pieces every package builds on. */

describe("money (@/core/money)", () => {
  it("rounds to six decimals and treats non-numbers as 0", () => {
    expect(roundUsd(0.1234567)).toBe(0.123457);
    expect(roundUsd(0.012 * 3)).toBe(0.036);
    expect(roundUsd(Number.NaN)).toBe(0);
    expect(roundUsd(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("formats amounts the way people read them", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(-3)).toBe("$0");
    expect(formatUsd(Number.NaN)).toBe("$0");
    expect(formatUsd(0.004)).toBe("less than $0.01");
    expect(formatUsd(0.48)).toBe("$0.48");
    expect(formatUsd(12.3)).toBe("$12.30");
    expect(formatUsd(1240.4)).toBe("$1,240");
    expect(aboutUsd(0.48)).toBe("about $0.48");
    expect(aboutUsd(0)).toBe("$0");
    expect(aboutUsd(0.001)).toBe("less than $0.01");
    expect(smallUsd(0.0061)).toBe("$0.006");
    expect(smallUsd(0)).toBe("$0");
    expect(smallUsd(2.5)).toBe("$2.50");
  });
});

describe("the office month (@/core/time/month)", () => {
  it("uses the office zone: 30 Sep 19:30 UTC is already October in Karachi", () => {
    const b = monthBounds(new Date("2026-09-30T19:30:00Z"), "Asia/Karachi");
    expect(b.start.toISOString()).toBe("2026-09-30T19:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-10-31T19:00:00.000Z");
    expect(b.label).toBe("October");
    expect(b.resetLabel).toBe("1 November");
    expect(monthBounds(new Date("2026-09-30T18:59:59Z"), "Asia/Karachi").label).toBe("September");
  });

  it("is DST-safe, rolls over the year and falls back to Karachi for a bad zone", () => {
    const berlin = monthBounds(new Date("2026-10-15T12:00:00Z"), "Europe/Berlin");
    expect(berlin.start.toISOString()).toBe("2026-09-30T22:00:00.000Z"); // CEST
    expect(berlin.end.toISOString()).toBe("2026-10-31T23:00:00.000Z"); // CET
    const december = monthBounds(new Date("2026-12-10T12:00:00Z"), "Asia/Karachi");
    expect(december.resetLabel).toBe("1 January");
    expect(december.end.toISOString()).toBe("2026-12-31T19:00:00.000Z");
    expect(monthBounds(new Date("2026-09-30T19:30:00Z"), "Not/AZone").label).toBe("October");
  });
});

describe("quote normalisation (@/core/ai/normalize)", () => {
  it("unifies quotes, dashes, ellipses and spaces, drops invisible characters, collapses whitespace", () => {
    expect(normalizeForMatch("  Hello “World”…  ")).toBe('hello "world"...');
    expect(normalizeForMatch("It’s 28–mm «gut»")).toBe("it's 28-mm \"gut\"");
    expect(normalizeForMatch("Ma­nu​fak﻿tur")).toBe("manufaktur");
    expect(normalizeForMatch("line one\n\n\tline two")).toBe("line one line two");
    expect(normalizeForMatch("ＡＢＣ")).toBe("abc"); // fullwidth letters (NFKC)
  });

  it("keeps where each normalised unit came from", () => {
    expect(withPositionMap("A  b")).toEqual({ text: "a b", start: [0, 1, 3], end: [1, 2, 4] });
    // A base letter with a combining accent is one cluster: é (NFKC) maps back to both source units.
    expect(withPositionMap("Café!")).toEqual({ text: "café!", start: [0, 1, 2, 3, 5], end: [1, 2, 3, 5, 6] });
  });

  it("folds diacritics and the Nordic and German letters for word lookups", () => {
    expect(foldForLookup("Straße Øre Æble Åse München")).toBe("strasse ore aeble ase munchen");
  });
});

describe("AI types (@/core/ai/types)", () => {
  it("has a tab, a status and a label for every queue tab, and a text for every no-line code", () => {
    for (const tab of AI_QUEUE_TABS) {
      expect(AI_TAB_STATUS[tab]).toBeTruthy();
      expect(AI_TAB_LABELS[tab]).toBeTruthy();
    }
    for (const code of [...REASON_CODES, ...SKIP_CODES, "model_declined" as const]) expect(NO_LINE_TEXT[code]).toBeTruthy();
  });

  it("estimates tokens conservatively (3 characters each, at least one per non-ASCII character)", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(2);
    expect(estimateTextTokens("äöü")).toBe(3);
  });

  it("resolves built-in, custom and unknown models", () => {
    const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
    expect(haiku).toMatchObject({ id: HAIKU_MODEL, maxTokens: 600, effort: null, builtIn: true, prices: { inputPerMTok: 1, outputPerMTok: 5 } });
    expect(resolveProfile(SONNET_MODEL, null, {})).toMatchObject({ effort: "low", prices: { inputPerMTok: 2, outputPerMTok: 10 } });
    const custom = { id: "claude-new", label: "Claude New", maxTokens: 64_000, effortLow: true, checkedAt: "2026-09-26T10:00:00Z" };
    expect(resolveProfile("claude-new", custom, { "claude-new": { inputPerMTok: 3, outputPerMTok: 15 } })).toMatchObject({
      label: "Claude New",
      maxTokens: 4_000,
      effort: "low",
      builtIn: false,
      prices: { inputPerMTok: 3, outputPerMTok: 15 },
    });
    expect(resolveProfile("claude-other", custom, {})).toMatchObject({ label: "claude-other", effort: null, prices: null });
  });
});

describe("address check types (@/core/verification/types)", () => {
  it("clears all six check fields together and starts runs from an empty carry", () => {
    expect(Object.keys(CLEARED_CHECK_FIELDS)).toHaveLength(6);
    expect(EMPTY_VERIFY_CARRY).toMatchObject({ cursor: 0, pending: [], single: null });
    expect(LIVE_CHECK_CONTEXT).toEqual({ mode: "LIVE", phase: "launch", goLive: true, testListCountsAsChecked: false });
    expect(REAL_PROVIDERS).not.toContain("fake");
  });
});

describe("SystemState parsers for checks and AI", () => {
  it("adds the three keys", () => {
    expect(STATE_KEYS).toMatchObject({ checksPause: "checks.pause", aiPause: "ai.pause", aiTokens: "ai.tokens" });
  });

  it("reads a check pause, and anything unknown as not paused (a fresh copy each time)", () => {
    const empty = parseCheckPause(null);
    expect(empty).toEqual(NOT_PAUSED_CHECKS);
    expect(empty).not.toBe(NOT_PAUSED_CHECKS);
    expect(Object.isFrozen(NOT_PAUSED_CHECKS)).toBe(true);
    expect(parseCheckPause({ paused: true, kind: "cosmic-rays", text: "x" })).toEqual(NOT_PAUSED_CHECKS);
    expect(parseCheckPause({ paused: false, kind: "auth", text: "x" })).toEqual(NOT_PAUSED_CHECKS);
    expect(
      parseCheckPause({ paused: true, kind: "monthly_limit", text: "Stopped.", since: "2026-09-26T10:00:00Z", until: "soon", detail: 5 }),
    ).toEqual({ paused: true, kind: "monthly_limit", text: "Stopped.", since: "2026-09-26T10:00:00Z", until: null, detail: null });
  });

  it("reads an AI pause with its model", () => {
    expect(parseAiPause(undefined)).toEqual(NOT_PAUSED_AI);
    expect(parseAiPause({ paused: true, kind: "model_not_found", text: "Pick another model.", model: "claude-x", detail: "404" })).toEqual({
      paused: true,
      kind: "model_not_found",
      text: "Pick another model.",
      since: null,
      until: null,
      model: "claude-x",
      detail: "404",
    });
    expect(parseAiPause({ paused: true, kind: "unknown_kind" })).toEqual(NOT_PAUSED_AI);
  });

  it("keeps only token entries with a whole number and a date", () => {
    const parsed = parseAiTokens(
      JSON.parse(
        '{"entries":{"a|v1":{"systemTokens":1400,"measuredAt":"2026-09-26T10:00:00Z"},"b|v1":{"systemTokens":-1,"measuredAt":"2026-09-26T10:00:00Z"},' +
          '"c|v1":{"systemTokens":1.5,"measuredAt":"2026-09-26T10:00:00Z"},"d|v1":{"systemTokens":10,"measuredAt":"never"},' +
          '"__proto__":{"systemTokens":1,"measuredAt":"2026-09-26T10:00:00Z"}}}',
      ),
    );
    expect(parsed).toEqual({ entries: { "a|v1": { systemTokens: 1400, measuredAt: "2026-09-26T10:00:00Z" } } });
    expect(Object.getPrototypeOf(parsed.entries)).toBe(Object.prototype);
    expect(parseAiTokens("nonsense")).toEqual({ entries: {} });
  });
});

describe("eligibility contract edits", () => {
  const NOW = new Date("2026-10-20T12:00:00Z");
  const person = (over: Partial<PersonFacts> = {}): PersonFacts => ({
    id: 1,
    email: "anna@acme.de",
    emailNorm: "anna@acme.de",
    deleted: false,
    verificationStatus: null,
    verificationRisk: null,
    verifiedAt: null,
    verificationProvider: null,
    unsubscribedAt: null,
    bouncedAt: null,
    complainedAt: null,
    suppression: null,
    ...over,
  });
  const ctx = (over: Partial<EligibilityContext> = {}): EligibilityContext => ({
    mode: "LIVE",
    now: NOW,
    maxCheckAgeDays: 90,
    policy: DEFAULT_VERIFICATION_POLICY,
    testList: new Set(["anna@acme.de"]),
    goLive: false,
    ...over,
  });
  const company = { id: 1, status: "NOT_CONTACTED" as const, deleted: false };

  it("adds check-waiting in its place and the pending codes", () => {
    expect(reasonOrder("check-too-old")).toBeLessThan(reasonOrder("check-waiting"));
    expect(reasonOrder("check-waiting")).toBeLessThan(reasonOrder("check-undeliverable"));
    for (const c of CHECK_PENDING_CODES) expect(ELIGIBILITY_CODES).toContain(c);
    expect(DEFAULT_VERIFICATION_POLICY.disposable).toBe("block");
  });

  it("blocks a throwaway address unless the policy says send, and never changes the hard results", () => {
    const p = DEFAULT_VERIFICATION_POLICY;
    expect(checkDecision("VALID", "LOW", p, { disposable: true })).toBe("block");
    expect(checkDecision("CATCH_ALL", "LOW", p, { disposable: true })).toBe("block");
    expect(checkDecision("VALID", "LOW", { ...p, disposable: "send" }, { disposable: true })).toBe("send");
    expect(checkDecision("VALID", "LOW", { ...p, disposable: "maybe" }, { disposable: true })).toBe("block");
    expect(checkDecision("INVALID", "HIGH", p, { disposable: true })).toBe("undeliverable");
    expect(checkDecision("DO_NOT_SEND", null, p, { disposable: true })).toBe("do-not-send");
    expect(checkDecision("UNKNOWN", null, p, { disposable: true })).toBe("recheck");
    expect(checkDecision("VALID", "MEDIUM", p)).toBe("send");
  });

  it("words the policy for throwaway and unknown addresses", () => {
    expect(policyBlockedText("VALID", "LOW", { disposable: true })).toBe("A throwaway address; your check settings skip these");
    expect(policyBlockedText("UNKNOWN", null, { disposable: true })).toBe("The address check got no answer; your check settings skip these");
    expect(policyBlockedText("CATCH_ALL", "MEDIUM")).toBe("Can't confirm this address (medium risk); your check settings skip these");
  });

  it("returns no pending reasons and no check need until P1, and honours testListCountsAsChecked", () => {
    const before = evaluateEligibility({ company, person: person(), teamRule: null, ctx: ctx() });
    expect(before).toMatchObject({ eligible: true, pending: [], checkNeed: "none", notes: ["On test list"] });
    const judgedAtLaunch = evaluateEligibility({ company, person: person(), teamRule: null, ctx: ctx({ testListCountsAsChecked: false }) });
    expect(judgedAtLaunch.blocking.map((r) => r.code)).toEqual(["not-checked"]);
  });
});

describe("wording and notification types", () => {
  it("words a RECHECK recipient the same everywhere", () => {
    expect(recheckStateText("27 Sep at 14:05", "campaign")).toBe("Waiting for re-check on 27 Sep at 14:05");
    expect(recheckStateText("27 Sep at 14:05", "panel")).toBe("waiting for re-check on 27 Sep at 14:05");
    expect(recheckStateText(null, "campaign")).toBe("Waiting for re-check");
  });

  it("files check and AI notifications under Sending and system, with no pop-up group", () => {
    for (const type of [...Object.values(VERIFY_NOTIFICATION), ...Object.values(AI_NOTIFICATION)]) {
      expect(notificationFilterOf(type)).toBe("system");
      expect(popupGroupOf(type)).toBeNull();
    }
  });
});
