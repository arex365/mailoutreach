import { describe, expect, it } from "vitest";
import { emptyUsage } from "@/core/ai/cost";
import { readLineAnswer, type ClaudeAnswer } from "@/core/ai/parse";

/** M5-DESIGN §3.5.3: stop_reason first, then JSON.parse and a constraint-free schema. */

const GOOD = {
  evidence_source: "homepage",
  evidence_quote: "Hand-painted 32mm tabletop miniatures for fantasy wargames",
  line: "You sell 32mm fantasy wargame miniatures in resin.",
  reason_if_null: null,
};

function answer(text: string | null, stopReason: string | null = "end_turn"): ClaudeAnswer {
  return { text, stopReason, usage: emptyUsage(), requestId: "req_1", model: "claude-haiku-4-5-20251001" };
}

describe("readLineAnswer", () => {
  it("end_turn with valid JSON is an answer", () => {
    expect(readLineAnswer(answer(JSON.stringify(GOOD)))).toEqual({ kind: "ok", value: GOOD });
  });

  it("a no-line answer is an answer too", () => {
    const none = { evidence_source: "none", evidence_quote: null, line: null, reason_if_null: "only_generic_claims" };
    expect(readLineAnswer(answer(JSON.stringify(none)))).toEqual({ kind: "ok", value: none });
  });

  it("a very long line is still read (length is the checks' job, never a parse error)", () => {
    const long = { ...GOOD, line: "word ".repeat(200).trim() + "." };
    expect(readLineAnswer(answer(JSON.stringify(long))).kind).toBe("ok");
  });

  it("max_tokens and refusal are read before the text", () => {
    expect(readLineAnswer(answer('{"evidence_source":"home', "max_tokens"))).toEqual({ kind: "max_tokens" });
    expect(readLineAnswer(answer("", "refusal"))).toEqual({ kind: "refusal" });
    expect(readLineAnswer(answer(JSON.stringify(GOOD), "refusal"))).toEqual({ kind: "refusal" });
  });

  it("any other stop reason, no text or bad JSON is a bad answer", () => {
    expect(readLineAnswer(answer(JSON.stringify(GOOD), "pause_turn"))).toMatchObject({ kind: "bad" });
    expect(readLineAnswer(answer(JSON.stringify(GOOD), null))).toMatchObject({ kind: "bad" });
    expect(readLineAnswer(answer(JSON.stringify(GOOD), "model_context_window_exceeded"))).toMatchObject({ kind: "bad" });
    expect(readLineAnswer(answer(null))).toEqual({ kind: "bad", reason: "Claude's answer had no text." });
    expect(readLineAnswer(answer("  "))).toMatchObject({ kind: "bad" });
    expect(readLineAnswer(answer("not json at all"))).toEqual({ kind: "bad", reason: "Claude's answer wasn't valid JSON." });
    expect(readLineAnswer(answer('{"line": "x"'))).toMatchObject({ kind: "bad" });
  });

  it("a schema mismatch is a bad answer", () => {
    const bad = "Claude's answer didn't have the expected fields.";
    const { line: _line, ...missing } = GOOD;
    expect(readLineAnswer(answer(JSON.stringify(missing)))).toEqual({ kind: "bad", reason: bad });
    expect(readLineAnswer(answer(JSON.stringify({ ...GOOD, evidence_source: "footer" })))).toEqual({ kind: "bad", reason: bad });
    expect(readLineAnswer(answer(JSON.stringify({ ...GOOD, reason_if_null: "boring" })))).toEqual({ kind: "bad", reason: bad });
    expect(readLineAnswer(answer(JSON.stringify({ ...GOOD, line: 42 })))).toEqual({ kind: "bad", reason: bad });
    expect(readLineAnswer(answer(JSON.stringify([GOOD])))).toEqual({ kind: "bad", reason: bad });
  });

  it("reads JSON inside a code fence (a custom model might add one)", () => {
    expect(readLineAnswer(answer("```json\n" + JSON.stringify(GOOD) + "\n```"))).toEqual({ kind: "ok", value: GOOD });
  });
});
