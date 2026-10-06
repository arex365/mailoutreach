import type { AiFailure } from "./errors";

/**
 * What `models.retrieve` says about a model (M5-DESIGN §3.5.1; research ai-and-fetch A6). Settings › AI refuses a
 * custom model without structured outputs, and gives it `effort: "low"` only when the model supports that level.
 * No database or network here, so tests can build model checks without either.
 */
export type ModelCheck =
  | { ok: true; id: string; displayName: string; maxTokens: number | null; structuredOutputs: boolean; effortLow: boolean }
  | { ok: false; failure: AiFailure };

type Supported = { supported?: unknown } | null | undefined;

function supported(c: Supported): boolean {
  return Boolean(c && typeof c === "object" && c.supported === true);
}

/** Reads a Models API answer (`GET /v1/models/{id}`); missing capabilities count as unsupported. */
export function modelCheckFromInfo(info: unknown): ModelCheck & { ok: true } {
  const o = (info && typeof info === "object" ? info : {}) as {
    id?: unknown;
    display_name?: unknown;
    max_tokens?: unknown;
    capabilities?: { structured_outputs?: Supported; effort?: (Supported & { low?: Supported }) | null } | null;
  };
  const id = typeof o.id === "string" ? o.id : "";
  const caps = o.capabilities && typeof o.capabilities === "object" ? o.capabilities : null;
  const maxTokens = typeof o.max_tokens === "number" && Number.isFinite(o.max_tokens) && o.max_tokens > 0 ? Math.floor(o.max_tokens) : null;
  return {
    ok: true,
    id,
    displayName: typeof o.display_name === "string" && o.display_name ? o.display_name : id,
    maxTokens,
    structuredOutputs: supported(caps?.structured_outputs),
    effortLow: supported(caps?.effort) && supported(caps?.effort?.low),
  };
}
