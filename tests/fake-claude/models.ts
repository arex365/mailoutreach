/**
 * The fake Claude server's model catalogue (M5-DESIGN §7.2): what `GET /v1/models/:id` answers, in the Models API's
 * shape (research ai-and-fetch A6). Haiku 4.5 and Sonnet 5 as documented; two made-up ids for Settings › AI tests:
 * `claude-test-custom` (structured outputs, low effort) and `claude-test-nostructured` (no structured outputs).
 */

type Support = { supported: boolean };
const yes: Support = { supported: true };
const no: Support = { supported: false };

export type FakeModelInfo = {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number;
  max_tokens: number;
  capabilities: {
    batch: Support;
    citations: Support;
    code_execution: Support;
    context_management: {
      clear_thinking_20251015: Support | null;
      clear_tool_uses_20250919: Support | null;
      compact_20260112: Support | null;
      supported: boolean;
    };
    effort: { supported: boolean; low: Support; medium: Support; high: Support; xhigh: Support | null; max: Support };
    image_input: Support;
    pdf_input: Support;
    structured_outputs: Support;
    thinking: { supported: boolean; types: { adaptive: Support; enabled: Support } };
  };
};

function effort(levels: boolean): FakeModelInfo["capabilities"]["effort"] {
  const s = levels ? yes : no;
  return { supported: levels, low: s, medium: s, high: s, xhigh: levels ? yes : null, max: s };
}

function model(
  id: string,
  displayName: string,
  opts: { maxInput: number; maxTokens: number; structured: boolean; effort: boolean; adaptive: boolean; enabled: boolean; createdAt: string },
): FakeModelInfo {
  return {
    type: "model",
    id,
    display_name: displayName,
    created_at: opts.createdAt,
    max_input_tokens: opts.maxInput,
    max_tokens: opts.maxTokens,
    capabilities: {
      batch: yes,
      citations: yes,
      code_execution: no,
      context_management: { clear_thinking_20251015: null, clear_tool_uses_20250919: null, compact_20260112: null, supported: false },
      effort: effort(opts.effort),
      image_input: yes,
      pdf_input: yes,
      structured_outputs: opts.structured ? yes : no,
      thinking: {
        supported: opts.adaptive || opts.enabled,
        types: { adaptive: opts.adaptive ? yes : no, enabled: opts.enabled ? yes : no },
      },
    },
  };
}

export const FAKE_HAIKU = "claude-haiku-4-5-20251001";
export const FAKE_SONNET = "claude-sonnet-5";
export const FAKE_CUSTOM = "claude-test-custom";
export const FAKE_NO_STRUCTURED = "claude-test-nostructured";

const CATALOGUE: Record<string, FakeModelInfo> = {
  [FAKE_HAIKU]: model(FAKE_HAIKU, "Claude Haiku 4.5", {
    maxInput: 200_000, maxTokens: 64_000, structured: true, effort: false, adaptive: false, enabled: true,
    createdAt: "2025-10-01T00:00:00Z",
  }),
  [FAKE_SONNET]: model(FAKE_SONNET, "Claude Sonnet 5", {
    maxInput: 1_000_000, maxTokens: 128_000, structured: true, effort: true, adaptive: true, enabled: false,
    createdAt: "2026-06-30T00:00:00Z",
  }),
  [FAKE_CUSTOM]: model(FAKE_CUSTOM, "Claude Test Custom", {
    maxInput: 200_000, maxTokens: 8_192, structured: true, effort: true, adaptive: true, enabled: false,
    createdAt: "2026-09-01T00:00:00Z",
  }),
  [FAKE_NO_STRUCTURED]: model(FAKE_NO_STRUCTURED, "Claude Test Without Structured Outputs", {
    maxInput: 100_000, maxTokens: 4_096, structured: false, effort: false, adaptive: false, enabled: false,
    createdAt: "2026-09-01T00:00:00Z",
  }),
};
/** Aliases resolve to their pinned id, as the real Models API does. */
const ALIASES: Record<string, string> = { "claude-haiku-4-5": FAKE_HAIKU };

/** The model's info, or null for an id the fake doesn't know (it answers 404 "model: <id>"). */
export function fakeModelInfo(id: string): FakeModelInfo | null {
  const found = CATALOGUE[ALIASES[id] ?? id];
  return found ? structuredClone(found) : null;
}

/** True for the Haiku id and its alias (the fake refuses `output_config.effort` for them, M5-DESIGN D26). */
export function isFakeHaiku(id: string): boolean {
  return id === FAKE_HAIKU || id === "claude-haiku-4-5";
}
