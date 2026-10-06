/**
 * Milestone 5 (docs/dev/M5-DESIGN.md §3.5.3; research ai-and-fetch C4): reading Claude's answer. Browser-safe, pure.
 *
 * `stop_reason` is read first: only `end_turn` is parsed (JSON.parse + a constraint-free Zod schema, so a billed answer
 * never throws for being too long); `max_tokens` means one retry with double `max_tokens`; `refusal` means no line
 * ("model_declined"); anything else is a bad answer. The JSON is in the first text block (Sonnet 5 may put an empty
 * thinking block first; the client picks the text block).
 */
import { z } from "zod";
import type { ClaudeUsage } from "./cost";
import { EVIDENCE_SOURCES, REASON_CODES, type LineAnswer } from "./types";

/** One Messages API answer, as the Anthropic client returns it (src/server/anthropic re-exports this type). */
export type ClaudeAnswer = {
  /** The first text block's text; null when the answer had none. */
  text: string | null;
  stopReason: string | null;
  usage: ClaudeUsage;
  /** The `request-id` header (shown behind "Details" on a failed card). */
  requestId: string | null;
  model: string;
};

/** What an answer means for the draft. */
export type LineAnswerRead =
  | { kind: "ok"; value: LineAnswer }
  | { kind: "max_tokens" }
  | { kind: "refusal" }
  | { kind: "bad"; reason: string };

/** The structured-output schema in Zod, without length constraints (the automatic checks count words). */
const LineAnswerSchema = z.object({
  evidence_source: z.enum(EVIDENCE_SOURCES),
  evidence_quote: z.string().nullable(),
  line: z.string().nullable(),
  reason_if_null: z.enum(REASON_CODES).nullable(),
});

/** The JSON text without a Markdown code fence around it (structured outputs never add one; a custom model might). */
function unfenced(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1]! : t;
}

/** Reads one answer (M5-DESIGN §3.5.3). The `bad` reasons are plain sentences for the worker log, never shown as-is. */
export function readLineAnswer(answer: ClaudeAnswer): LineAnswerRead {
  const stop = answer.stopReason;
  if (stop === "max_tokens") return { kind: "max_tokens" };
  if (stop === "refusal") return { kind: "refusal" };
  if (stop !== "end_turn") return { kind: "bad", reason: `Claude's answer ended early (stop reason: ${stop ?? "none"}).` };
  if (answer.text == null || !answer.text.trim()) return { kind: "bad", reason: "Claude's answer had no text." };
  let json: unknown;
  try {
    json = JSON.parse(unfenced(answer.text));
  } catch {
    return { kind: "bad", reason: "Claude's answer wasn't valid JSON." };
  }
  const parsed = LineAnswerSchema.safeParse(json);
  if (!parsed.success) return { kind: "bad", reason: "Claude's answer didn't have the expected fields." };
  return { kind: "ok", value: parsed.data };
}
