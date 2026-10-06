import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeTargetError } from "@/server/anthropic/base-url";
import {
  aiPauseText,
  classifyAnthropicError,
  requestIdOfError,
  scrubAnthropicText,
  tierCapResetAt,
  UnreadableAnswerError,
} from "@/server/anthropic/errors";

/** M5-DESIGN §3.5.2, §3.7; research ai-and-fetch A7: every SDK error class and body → the right AiFailure. */

function apiError(status: number, type: string, message: string, headers: Record<string, string> = {}, details?: object): APIError {
  const body = { type: "error", error: { type, message, ...(details ? { details } : {}) }, request_id: "req_err_1" };
  return APIError.generate(status, body, undefined, new Headers({ "request-id": "req_err_1", ...headers }));
}

describe("classifyAnthropicError: statuses", () => {
  it("401 → key_rejected, 403 → no_permission, 404 model → model_not_found", () => {
    expect(classifyAnthropicError(apiError(401, "authentication_error", "invalid x-api-key"))).toEqual({ kind: "pause", reason: "key_rejected" });
    expect(classifyAnthropicError(apiError(403, "permission_error", "Your API key does not have permission"))).toEqual({
      kind: "pause",
      reason: "no_permission",
    });
    expect(classifyAnthropicError(apiError(404, "not_found_error", "model: claude-x"))).toEqual({ kind: "pause", reason: "model_not_found" });
  });

  it("429 with retry-after requeues (at most 300 s); without it, or with the spend-cap code, pauses", () => {
    expect(classifyAnthropicError(apiError(429, "rate_limit_error", "Rate limited", { "retry-after": "30" }))).toEqual({
      kind: "requeue",
      afterMs: 30_000,
    });
    expect(classifyAnthropicError(apiError(429, "rate_limit_error", "Rate limited", { "retry-after": "900" }))).toEqual({
      kind: "requeue",
      afterMs: 300_000,
    });
    const now = new Date("2026-09-26T10:00:00Z");
    expect(
      classifyAnthropicError(apiError(429, "rate_limit_error", "Rate limited", { "retry-after": "Sat, 26 Sep 2026 10:01:00 GMT" }), { now }),
    ).toEqual({ kind: "requeue", afterMs: 60_000 });
    expect(classifyAnthropicError(apiError(429, "rate_limit_error", "Rate limited"))).toEqual({ kind: "pause", reason: "tier_spend_cap" });
    expect(classifyAnthropicError(apiError(429, "rate_limit_error", "Rate limited", { "retry-after": "soon" }))).toEqual({
      kind: "pause",
      reason: "tier_spend_cap",
    });
    const cap = apiError(
      429,
      "rate_limit_error",
      "You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-10-01 at 00:00 UTC.",
      { "retry-after": "60" },
      { error_code: "enforced_spend_limit_reached" },
    );
    expect(classifyAnthropicError(cap)).toEqual({ kind: "pause", reason: "tier_spend_cap" });
  });

  it("the Owner's own Console limit (400) → own_spend_limit; 402 and credit balance → billing", () => {
    expect(classifyAnthropicError(apiError(400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-10-01."))).toEqual({
      kind: "pause",
      reason: "own_spend_limit",
    });
    expect(classifyAnthropicError(apiError(400, "invalid_request_error", "You have reached your specified workspace API usage limits."))).toEqual({
      kind: "pause",
      reason: "own_spend_limit",
    });
    expect(classifyAnthropicError(apiError(402, "billing_error", "Payment required"))).toEqual({ kind: "pause", reason: "billing" });
    expect(classifyAnthropicError(apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."))).toEqual({
      kind: "pause",
      reason: "billing",
    });
  });

  it("500, 504 and 529 back off without billing; so do 408 and 409", () => {
    for (const [status, type] of [
      [500, "api_error"],
      [504, "timeout_error"],
      [529, "overloaded_error"],
      [408, "request_timeout"],
      [409, "conflict_error"],
    ] as const) {
      expect(classifyAnthropicError(apiError(status, type, "Overloaded"))).toEqual({ kind: "backoff", mayBeBilled: false });
    }
  });

  it("other 4xx fail this draft with a scrubbed message", () => {
    expect(classifyAnthropicError(apiError(400, "invalid_request_error", "messages: text content blocks must be non-empty"))).toEqual({
      kind: "fail_draft",
      message: "messages: text content blocks must be non-empty",
    });
    expect(classifyAnthropicError(apiError(422, "invalid_request_error", "Unprocessable"))).toMatchObject({ kind: "fail_draft" });
    expect(classifyAnthropicError(apiError(413, "request_too_large", "Request too large"))).toMatchObject({ kind: "fail_draft" });
    const leaky = apiError(400, "invalid_request_error", "Bad value from anna@firma.de with sk-ant-api03-abcdefghijklmnop " + "x".repeat(400));
    const failure = classifyAnthropicError(leaky);
    expect(failure.kind).toBe("fail_draft");
    if (failure.kind !== "fail_draft") return;
    expect(failure.message).not.toContain("anna@firma.de");
    expect(failure.message).not.toContain("sk-ant-api03");
    expect(failure.message).toContain("[address]");
    expect(failure.message.length).toBeLessThanOrEqual(300);
    expect(classifyAnthropicError(leaky, { scrub: () => "scrubbed by P4" })).toEqual({ kind: "fail_draft", message: "scrubbed by P4" });
  });
});

describe("classifyAnthropicError: no answer", () => {
  it("a connection error backs off (not billed); a timeout or an abort after sending may be billed", () => {
    expect(classifyAnthropicError(new APIConnectionError({ message: "Connection error." }))).toEqual({ kind: "backoff", mayBeBilled: false });
    expect(classifyAnthropicError(new APIConnectionTimeoutError())).toEqual({ kind: "backoff", mayBeBilled: true });
    expect(classifyAnthropicError(new APIUserAbortError())).toEqual({ kind: "backoff", mayBeBilled: true });
    expect(classifyAnthropicError(new DOMException("The operation was aborted.", "AbortError"))).toEqual({ kind: "backoff", mayBeBilled: true });
    expect(classifyAnthropicError(new DOMException("Timed out", "TimeoutError"))).toEqual({ kind: "backoff", mayBeBilled: true });
    expect(classifyAnthropicError(new UnreadableAnswerError())).toEqual({ kind: "backoff", mayBeBilled: true });
  });

  it("a key that doesn't fit the server pauses; anything else fails the draft", () => {
    expect(classifyAnthropicError(new ClaudeTargetError("This is a test key.", "test-key"))).toEqual({ kind: "pause", reason: "key_rejected" });
    expect(classifyAnthropicError(new TypeError("x is not a function"))).toEqual({ kind: "fail_draft", message: "x is not a function" });
    expect(classifyAnthropicError("odd")).toEqual({ kind: "fail_draft", message: "odd" });
  });
});

describe("requestIdOfError", () => {
  it("reads the request-id header, else the body's request_id; null without an answer", () => {
    expect(requestIdOfError(apiError(500, "api_error", "boom"))).toBe("req_err_1");
    const bodyOnly = APIError.generate(400, { type: "error", error: { type: "x", message: "y" }, request_id: "req_body" }, undefined, new Headers());
    expect(requestIdOfError(bodyOnly)).toBe("req_body");
    expect(requestIdOfError(new APIConnectionTimeoutError())).toBeNull();
    expect(requestIdOfError(new Error("x"))).toBeNull();
  });

  it("keeps the request id of an answer whose body couldn't be read (AI-1)", () => {
    const err = new UnreadableAnswerError("Anthropic's answer broke off or took too long to arrive.", "req_trunc");
    expect(requestIdOfError(err)).toBe("req_trunc");
    expect(err.requestId).toBe("req_trunc");
    expect(classifyAnthropicError(err)).toEqual({ kind: "backoff", mayBeBilled: true });
    expect(requestIdOfError(new UnreadableAnswerError())).toBeNull();
  });
});

describe("scrubAnthropicText", () => {
  it("hides keys and addresses and caps the text", () => {
    expect(scrubAnthropicText("key sk-ant-api03-ABCDEFGHIJKLMNOP for bob@x.example")).toBe("key [hidden] for [address]");
    expect(scrubAnthropicText("x-api-key: sk-ant-fake-key-123").includes("sk-ant-fake-key-123")).toBe(false);
    expect(scrubAnthropicText("y".repeat(500))).toHaveLength(300);
  });
});

describe("aiPauseText", () => {
  const now = new Date("2026-10-15T09:00:00Z");

  it("monthly limit: the limit and the office month's reset", () => {
    expect(aiPauseText("monthly_limit", { model: "claude-haiku-4-5-20251001", limitUsd: 20, timeZone: "Asia/Karachi", now })).toBe(
      "AI drafting stopped: this month's limit of $20 is reached. Raise it in Settings › AI or wait until 1 November.",
    );
    expect(aiPauseText("monthly_limit", { model: "m", limitUsd: 12.5, resetLabel: "1 October" })).toBe(
      "AI drafting stopped: this month's limit of $12.50 is reached. Raise it in Settings › AI or wait until 1 October.",
    );
    // 30 Sep 19:30 UTC is already October in Karachi.
    expect(aiPauseText("monthly_limit", { model: "m", limitUsd: 1_000, timeZone: "Asia/Karachi", now: new Date("2026-09-30T19:30:00Z") })).toBe(
      "AI drafting stopped: this month's limit of $1,000 is reached. Raise it in Settings › AI or wait until 1 November.",
    );
  });

  it("Anthropic's tier cap: 00:00 UTC on the 1st, in the Owner's zone", () => {
    expect(aiPauseText("tier_spend_cap", { model: "m", timeZone: "Asia/Karachi", now })).toBe(
      "AI drafting paused: your Anthropic account reached its monthly spending cap. Drafting starts again on 1 November at 05:00, or raise the cap in the Anthropic Console.",
    );
    expect(aiPauseText("tier_spend_cap", { model: "m", timeZone: "Europe/Berlin", now })).toContain("on 1 November at 01:00,");
    expect(aiPauseText("tier_spend_cap", { model: "m", resetLabel: "2 March at 10:00" })).toContain("on 2 March at 10:00,");
    expect(tierCapResetAt(new Date("2026-12-31T23:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(tierCapResetAt(new Date("2026-10-01T00:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("the Owner's sentences for the other kinds", () => {
    expect(aiPauseText("key_rejected", { model: "m" })).toBe(
      "AI drafting paused: Anthropic didn't accept the API key. Paste a new key in Settings › AI, then click Resume drafting.",
    );
    expect(aiPauseText("no_permission", { model: "m" })).toBe(
      "AI drafting paused: this Anthropic key isn't allowed to use Claude. Check the key in the Anthropic Console, then click Resume drafting.",
    );
    expect(aiPauseText("model_not_found", { model: "claude-x" })).toBe(
      "AI drafting paused: Anthropic doesn't know the model “claude-x”, or your account can't use it. Pick another model in Settings › AI.",
    );
    expect(aiPauseText("own_spend_limit", { model: "m" })).toBe(
      "AI drafting paused: the spending limit you set in the Anthropic Console is reached. Raise it there, then click Resume drafting.",
    );
    expect(aiPauseText("billing", { model: "m" })).toBe(
      "AI drafting paused: Anthropic refused the request for a billing reason. Check Billing in the Anthropic Console, then click Resume drafting.",
    );
    expect(aiPauseText("no_price", { model: "claude-x" })).toBe(
      "AI drafting paused: no price is saved for the model “claude-x”. Enter its prices in Settings › AI.",
    );
  });
});
