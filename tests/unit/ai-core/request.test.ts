import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, type LineMessageInput } from "@/core/ai/prompt";
import { buildLineRequest, buildSystemTokenRequest, retryMaxTokens } from "@/core/ai/request";
import { DEFAULT_AI_PRICES, HAIKU_MODEL, LINE_SCHEMA, resolveProfile, SONNET_MODEL } from "@/core/ai/types";
import type { AiCustomModel } from "@/core/setting-types";

/** M5-DESIGN §3.5.1, §3.5.3: the request per model profile. */

const INPUT: LineMessageInput = {
  company: { name: "Firma GmbH", country: "Germany", niche: null },
  pages: [{ source: "homepage", url: "https://firma.example/", lang: "de", title: "Firma", text: "Handbemalte Figuren." }],
};
const FORBIDDEN = ["thinking", "temperature", "top_p", "top_k", "tools", "tool_choice", "inference_geo", "stop_sequences", "metadata"];

function custom(effortLow: boolean, maxTokens = 8_192): AiCustomModel {
  return { id: "claude-test-custom", label: "Claude Test Custom", maxTokens, effortLow, checkedAt: "2026-09-26T10:00:00.000Z" };
}

describe("buildLineRequest", () => {
  it("Haiku 4.5: max_tokens 600, no effort, no thinking or sampling parameters", () => {
    const req = buildLineRequest(INPUT, resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES));
    expect(Object.keys(req).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(req.model).toBe(HAIKU_MODEL);
    expect(req.max_tokens).toBe(600);
    expect(req.system).toBe(SYSTEM_PROMPT);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content).toContain('"text":"Handbemalte Figuren."');
    expect(req.output_config).toEqual({ format: { type: "json_schema", schema: LINE_SCHEMA } });
    expect("effort" in req.output_config).toBe(false);
    for (const key of FORBIDDEN) expect(key in req).toBe(false);
  });

  it("Sonnet 5: max_tokens 2,000 and effort low", () => {
    const req = buildLineRequest(INPUT, resolveProfile(SONNET_MODEL, null, DEFAULT_AI_PRICES));
    expect(req.model).toBe(SONNET_MODEL);
    expect(req.max_tokens).toBe(2_000);
    expect(req.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: LINE_SCHEMA } });
    for (const key of FORBIDDEN) expect(key in req).toBe(false);
  });

  it("a custom model gets effort only when it supports low effort, and at most 4,000 tokens", () => {
    const prices = { ...DEFAULT_AI_PRICES, "claude-test-custom": { inputPerMTok: 3, outputPerMTok: 15 } };
    const withEffort = buildLineRequest(INPUT, resolveProfile("claude-test-custom", custom(true), prices));
    expect(withEffort.output_config.effort).toBe("low");
    expect(withEffort.max_tokens).toBe(4_000);
    const without = buildLineRequest(INPUT, resolveProfile("claude-test-custom", custom(false, 1_500), prices));
    expect("effort" in without.output_config).toBe(false);
    expect(without.max_tokens).toBe(1_500);
    // An id that isn't the checked custom model: neutral (no effort), 4,000 tokens.
    const unknown = buildLineRequest(INPUT, resolveProfile("claude-other", custom(true), prices));
    expect("effort" in unknown.output_config).toBe(false);
    expect(unknown.max_tokens).toBe(4_000);
  });

  it("takes a doubled max_tokens for the retry after a max_tokens stop", () => {
    const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
    expect(retryMaxTokens(600)).toBe(1_200);
    expect(retryMaxTokens(2_000)).toBe(4_000);
    expect(buildLineRequest(INPUT, haiku, { maxTokens: retryMaxTokens(haiku.maxTokens) }).max_tokens).toBe(1_200);
    expect(buildLineRequest(INPUT, haiku, { maxTokens: 0 }).max_tokens).toBe(600);
    expect(buildLineRequest(INPUT, haiku, { maxTokens: Number.NaN }).max_tokens).toBe(600);
    expect(buildLineRequest(INPUT, haiku, { maxTokens: 700.9 }).max_tokens).toBe(700);
  });
});

describe("buildSystemTokenRequest", () => {
  it("is the system prompt, an empty page block and the schema, without max_tokens", () => {
    const req = buildSystemTokenRequest(resolveProfile(SONNET_MODEL, null, DEFAULT_AI_PRICES));
    expect("max_tokens" in req).toBe(false);
    expect(req.system).toBe(SYSTEM_PROMPT);
    expect(req.messages[0].content).toContain("<website_pages>\n</website_pages>");
    expect(req.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: LINE_SCHEMA } });
  });
});
