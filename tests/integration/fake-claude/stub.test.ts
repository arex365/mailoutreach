import { APIError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { emptyUsage } from "@/core/ai/cost";
import { readLineAnswer } from "@/core/ai/parse";
import { buildLineRequest, buildSystemTokenRequest } from "@/core/ai/request";
import { DEFAULT_AI_PRICES, HAIKU_MODEL, resolveProfile } from "@/core/ai/types";
import { classifyAnthropicError } from "@/server/anthropic/errors";
import { ECHO_LINE } from "../../fake-claude/answers";
import { stubClaudeApi } from "../helpers/claude";

/** M5-DESIGN §7.2: stubClaudeApi, the in-process ClaudeApi for unit-level tests (no network, no database). */

const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
const REQ = buildLineRequest(
  {
    company: { name: "Firma", country: null, niche: null },
    pages: [{ source: "homepage", url: "https://firma.example/", lang: "en", title: "Firma", text: "Resin busts of dragons, orcs and knights for collectors." }],
  },
  haiku,
);
const ANSWER = { evidence_source: "homepage", evidence_quote: "Resin busts of dragons, orcs and knights", line: "You make resin busts of dragons, orcs and knights.", reason_if_null: null };

describe("stubClaudeApi", () => {
  it("answers in order, then with the echo answer", async () => {
    const api = stubClaudeApi([ANSWER, { answer: "{bad", stopReason: "end_turn" }, { answer: ANSWER, stopReason: "max_tokens", usage: { outputTokens: 600 } }]);
    expect(readLineAnswer(await api.createLine(REQ))).toEqual({ kind: "ok", value: ANSWER });
    expect(readLineAnswer(await api.createLine(REQ))).toMatchObject({ kind: "bad" });
    const cut = await api.createLine(REQ);
    expect(readLineAnswer(cut)).toEqual({ kind: "max_tokens" });
    expect(cut.usage.outputTokens).toBe(600);
    const echo = readLineAnswer(await api.createLine(REQ));
    expect(echo).toEqual({
      kind: "ok",
      value: { evidence_source: "homepage", evidence_quote: "Resin busts of dragons, orcs and knights for", line: ECHO_LINE, reason_if_null: null },
    });
    expect(api.calls).toHaveLength(4);
    expect(api.calls[0]).toBe(REQ);
  });

  it("throws scripted errors and runs reply functions", async () => {
    const err = APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers());
    const api = stubClaudeApi([
      { error: err },
      (params, call) => ({ text: JSON.stringify(ANSWER), stopReason: "end_turn", usage: emptyUsage(), requestId: `req_fn_${call}`, model: params.model }),
    ]);
    const thrown = await api.createLine(REQ).catch((e: unknown) => e);
    expect(classifyAnthropicError(thrown)).toEqual({ kind: "backoff", mayBeBilled: false });
    const a = await api.createLine(REQ);
    expect(a.requestId).toBe("req_fn_2");
    api.push(ANSWER);
    expect(readLineAnswer(await api.createLine(REQ))).toEqual({ kind: "ok", value: ANSWER });
  });

  it("reports usage and request ids like the fake", async () => {
    const api = stubClaudeApi([], { usage: { inputTokens: 4_500, outputTokens: 200 } });
    const a = await api.createLine(REQ);
    expect(a.usage).toMatchObject({ inputTokens: 4_500, outputTokens: 200 });
    expect(a.requestId).toBe("req_stub_1");
    expect(a.model).toBe(HAIKU_MODEL);
  });

  it("counts tokens and checks models from the fake's catalogue", async () => {
    const api = stubClaudeApi([], { models: { "claude-mine": { ok: true, id: "claude-mine", displayName: "Mine", maxTokens: 1_000, structuredOutputs: true, effortLow: false } } });
    const req = buildSystemTokenRequest(haiku);
    expect(await api.countTokens(req)).toBe(Math.ceil((req.system.length + req.messages[0].content.length) / 4));
    expect(await stubClaudeApi([], { countTokens: 1_234 }).countTokens(req)).toBe(1_234);
    expect(await api.retrieveModel("claude-sonnet-5")).toMatchObject({ ok: true, effortLow: true, structuredOutputs: true });
    expect(await api.retrieveModel("claude-test-nostructured")).toMatchObject({ ok: true, structuredOutputs: false });
    expect(await api.retrieveModel("claude-mine")).toMatchObject({ ok: true, displayName: "Mine" });
    expect(await api.retrieveModel("claude-nope")).toEqual({ ok: false, failure: { kind: "pause", reason: "model_not_found" } });
    expect(api.modelCalls).toEqual(["claude-sonnet-5", "claude-test-nostructured", "claude-mine", "claude-nope"]);
    expect(api.countCalls).toHaveLength(1);
  });
});
