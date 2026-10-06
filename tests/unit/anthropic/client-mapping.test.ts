import { describe, expect, it } from "vitest";
import { readLineAnswer } from "@/core/ai/parse";
import { answerFromMessage, CLAUDE_TIMEOUT_MS, claudeCallTimeoutMs, usageFromApi } from "@/server/anthropic/client";
import { UnreadableAnswerError } from "@/server/anthropic/errors";
import { modelCheckFromInfo } from "@/server/anthropic/models";

/** M5-DESIGN §3.5.2: the SDK's answer and model info in our words. */

const JSON_ANSWER = JSON.stringify({
  evidence_source: "homepage",
  evidence_quote: "Hand-painted 32mm tabletop miniatures for fantasy wargames",
  line: "You sell 32mm fantasy wargame miniatures in resin.",
  reason_if_null: null,
});

function message(content: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const m: Record<string, unknown> = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content,
    stop_reason: "end_turn",
    usage: { input_tokens: 3_000, output_tokens: 120 },
    ...extra,
  };
  Object.defineProperty(m, "_request_id", { value: "req_abc", enumerable: false });
  return m;
}

describe("answerFromMessage", () => {
  it("takes the text block even when a thinking block comes first (Sonnet 5)", () => {
    const a = answerFromMessage(
      message([
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: JSON_ANSWER },
      ]),
      "fallback",
    );
    expect(a).toMatchObject({ text: JSON_ANSWER, stopReason: "end_turn", requestId: "req_abc", model: "claude-sonnet-5" });
    expect(readLineAnswer(a).kind).toBe("ok");
  });

  it("no text block gives null text; a missing model falls back to the request's", () => {
    const a = answerFromMessage(message([{ type: "thinking", thinking: "", signature: "sig" }], { model: undefined }), "claude-haiku-4-5-20251001");
    expect(a.text).toBeNull();
    expect(a.model).toBe("claude-haiku-4-5-20251001");
    expect(readLineAnswer(a)).toMatchObject({ kind: "bad" });
  });

  it("anything that isn't a Messages answer is unreadable (it may have been billed)", () => {
    expect(() => answerFromMessage("<html>proxy error</html>", "m")).toThrow(UnreadableAnswerError);
    expect(() => answerFromMessage({ content: "text" }, "m")).toThrow(UnreadableAnswerError);
    expect(() => answerFromMessage(null, "m")).toThrow(UnreadableAnswerError);
  });

  it("the answer's request-id header wins, and an unreadable answer keeps it (AI-1)", () => {
    const a = answerFromMessage(message([{ type: "text", text: JSON_ANSWER }]), "m", "req_header");
    expect(a.requestId).toBe("req_header");
    let caught: unknown = null;
    try {
      answerFromMessage({ type: "error" }, "m", "req_header");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnreadableAnswerError);
    expect((caught as UnreadableAnswerError).requestId).toBe("req_header");
  });
});

describe("claudeCallTimeoutMs", () => {
  it("60 s plus 25 ms per max_tokens, so a long answer isn't cut off (AI-2)", () => {
    expect(CLAUDE_TIMEOUT_MS).toBe(60_000);
    expect(claudeCallTimeoutMs(600)).toBe(75_000);
    expect(claudeCallTimeoutMs(1_200)).toBe(90_000);
    expect(claudeCallTimeoutMs(2_000)).toBe(110_000);
    expect(claudeCallTimeoutMs(4_000)).toBe(160_000);
    expect(claudeCallTimeoutMs(Number.NaN)).toBe(60_000);
  });
});

describe("usageFromApi", () => {
  it("reads the cache breakdown when there is one", () => {
    expect(
      usageFromApi({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 70,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 30 },
        output_tokens_details: { thinking_tokens: 12 },
        inference_geo: "us",
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheWrite5mTokens: 40,
      cacheWrite1hTokens: 30,
      thinkingTokens: 12,
      inferenceGeo: "us",
    });
  });

  it("without a breakdown every cache write counts as a 5-minute one; missing fields are 0 or null", () => {
    expect(usageFromApi({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 70, cache_creation: null })).toMatchObject({
      cacheWrite5mTokens: 70,
      cacheWrite1hTokens: 0,
      thinkingTokens: null,
      inferenceGeo: null,
    });
    expect(usageFromApi(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      thinkingTokens: null,
      inferenceGeo: null,
    });
  });
});

describe("modelCheckFromInfo", () => {
  it("reads structured outputs, low effort and max_tokens", () => {
    expect(
      modelCheckFromInfo({
        id: "claude-test-custom",
        display_name: "Claude Test Custom",
        max_tokens: 8_192,
        capabilities: { structured_outputs: { supported: true }, effort: { supported: true, low: { supported: true } } },
      }),
    ).toEqual({ ok: true, id: "claude-test-custom", displayName: "Claude Test Custom", maxTokens: 8_192, structuredOutputs: true, effortLow: true });
    expect(
      modelCheckFromInfo({
        id: "claude-haiku-4-5-20251001",
        display_name: "Claude Haiku 4.5",
        max_tokens: 64_000,
        capabilities: { structured_outputs: { supported: true }, effort: { supported: false, low: { supported: false } } },
      }),
    ).toMatchObject({ structuredOutputs: true, effortLow: false });
  });

  it("missing capabilities count as unsupported", () => {
    expect(modelCheckFromInfo({ id: "claude-old", max_tokens: null, capabilities: null })).toEqual({
      ok: true,
      id: "claude-old",
      displayName: "claude-old",
      maxTokens: null,
      structuredOutputs: false,
      effortLow: false,
    });
  });
});
