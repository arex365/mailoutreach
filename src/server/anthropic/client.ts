import Anthropic, { APIConnectionTimeoutError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { ClaudeUsage } from "@/core/ai/cost";
import type { ClaudeAnswer } from "@/core/ai/parse";
import type { LineRequest } from "@/core/ai/request";
import { getSecret } from "../secrets";
import { getSettings } from "../settings";
import {
  anthropicBaseUrl,
  assertAllowedAnthropicBase,
  assertAnthropicKeyMatchesTarget,
  isAnthropicFakeMode,
} from "./base-url";
import { classifyAnthropicError, UnreadableAnswerError } from "./errors";
import { modelCheckFromInfo, type ModelCheck } from "./models";

export type { ClaudeAnswer, ClaudeUsage, LineRequest, ModelCheck };

/**
 * The Anthropic client (M5-DESIGN §3.5.2). The SDK is used through this module only.
 *
 * Both clients are built with an explicit key, `authToken: null` and an explicit `baseURL` (so ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL on the PC are ignored), `logLevel: "off"` (ANTHROPIC_LOG=debug can't
 * write website text to the logs) and `redirect: "error"` (a redirect can never carry the key to another host).
 *
 * `createLine` is the one paid call: `maxRetries: 0` and no outside signal, so it is exactly one request with its own
 * timeout (claudeCallTimeoutMs) over the headers AND the body; the drafting job decides every retry and records every
 * call (§0.2 rule 11). Once the answer's headers came, Anthropic has billed the request: a body that then breaks off,
 * stalls past the timeout or isn't a Messages answer is an UnreadableAnswerError with the answer's request id (the job
 * records it at its ceiling, never at $0). `countTokens` and `retrieveModel` are free and may retry twice.
 */

/** Each Claude request's own timeout, before the allowance for its `max_tokens` (claudeCallTimeoutMs). */
export const CLAUDE_TIMEOUT_MS = 60_000;
/** More time per `max_tokens` of a paid call: writing a long answer (the doubled retry of §3.6) takes longer. */
export const CLAUDE_TIMEOUT_MS_PER_MAX_TOKEN = 25;
/** Retries of the free calls (countTokens, retrieveModel); the paid call never retries. */
const FREE_CALL_RETRIES = 2;

/**
 * The paid call's whole timeout, headers and body: 60 s plus 25 ms per `max_tokens` (Haiku 75 s, its doubled retry
 * 90 s; Sonnet 5 110 s and 160 s), so a long answer that is being written isn't cut off, paid for and asked again on
 * every try (M5 review AI-2).
 */
export function claudeCallTimeoutMs(maxTokens: number): number {
  const n = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0;
  return CLAUDE_TIMEOUT_MS + CLAUDE_TIMEOUT_MS_PER_MAX_TOKEN * n;
}

export interface ClaudeApi {
  /**
   * messages.create: paid. maxRetries 0 and no outside signal: one request, its own timeout over headers and body
   * (§0.2 rule 11). A 200 whose body can't be read throws UnreadableAnswerError with the request id.
   */
  createLine(params: LineRequest): Promise<ClaudeAnswer>;
  /** messages.countTokens (free; retried twice): the input tokens of this request. */
  countTokens(params: Omit<LineRequest, "max_tokens">): Promise<number>;
  /** models.retrieve (free; retried twice): never throws, a failure comes back classified. */
  retrieveModel(id: string): Promise<ModelCheck>;
}

export type ClaudeApiResult =
  | { ok: true; api: ClaudeApi; fakeMode: boolean }
  | { ok: false; reason: "no-key" | "unreadable" | "mismatch" | "practice-copy"; text: string };

/** Why no client could be built, in words (the drafting job pauses with it; Settings › AI shows it). */
export const CLAUDE_NOT_READY_TEXT = {
  "practice-copy": "The practice copy never talks to Anthropic.",
  "no-key": "Add your Anthropic API key in Settings › AI first.",
  unreadable: "The saved Anthropic key can't be read: the app's encryption key changed. Save the key again in Settings › AI.",
  mismatch:
    "The saved Anthropic key doesn't fit this server (a test key on the real Anthropic API, or the other way round). Save the right key in Settings › AI.",
} as const;

export type ClaudeClientOptions = {
  /** Per-request timeout in milliseconds (default 60 s, and claudeCallTimeoutMs for the paid call; tests lower it). */
  timeoutMs?: number;
  /** A fetch implementation (tests); default the global fetch. */
  fetch?: typeof fetch;
};

/** The saved key, or "unreadable" when it can't be decrypted (the encryption key in .env changed). */
async function readKey(): Promise<string | null | "unreadable"> {
  try {
    return await getSecret("anthropic.apiKey");
  } catch {
    return "unreadable";
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** The SDK's `usage` in our words (research A8). A missing breakdown counts every cache write as a 5-minute one. */
export function usageFromApi(u: unknown): ClaudeUsage {
  const o = (u && typeof u === "object" ? u : {}) as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } | null;
    output_tokens_details?: { thinking_tokens?: unknown } | null;
    inference_geo?: unknown;
  };
  const breakdown = o.cache_creation && typeof o.cache_creation === "object" ? o.cache_creation : null;
  const thinking = o.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: num(o.input_tokens),
    outputTokens: num(o.output_tokens),
    cacheReadTokens: num(o.cache_read_input_tokens),
    cacheWrite5mTokens: breakdown ? num(breakdown.ephemeral_5m_input_tokens) : num(o.cache_creation_input_tokens),
    cacheWrite1hTokens: breakdown ? num(breakdown.ephemeral_1h_input_tokens) : 0,
    thinkingTokens: typeof thinking === "number" && Number.isFinite(thinking) ? thinking : null,
    inferenceGeo: typeof o.inference_geo === "string" ? o.inference_geo : null,
  };
}

/**
 * A Messages API answer in our words: the first text block (Sonnet 5 may put an empty thinking block first), the stop
 * reason, the usage and the request id (`requestId`, from the answer's header, else the SDK's `_request_id`). Throws
 * UnreadableAnswerError (with that request id) when it isn't a Messages answer at all.
 */
export function answerFromMessage(msg: unknown, fallbackModel: string, requestId: string | null = null): ClaudeAnswer {
  if (!msg || typeof msg !== "object" || !Array.isArray((msg as { content?: unknown }).content)) {
    throw new UnreadableAnswerError(undefined, requestId);
  }
  const m = msg as { content: unknown[]; stop_reason?: unknown; usage?: unknown; model?: unknown; _request_id?: unknown };
  const block = m.content.find(
    (b): b is { type: "text"; text: string } =>
      Boolean(b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string"),
  );
  return {
    text: block ? block.text : null,
    stopReason: typeof m.stop_reason === "string" ? m.stop_reason : null,
    usage: usageFromApi(m.usage),
    requestId: requestId || (typeof m._request_id === "string" && m._request_id ? m._request_id : null),
    model: typeof m.model === "string" && m.model ? m.model : fallbackModel,
  };
}

/** The answer's body as text; rejects once `deadline` fires, so a stalled body never holds a call past its timeout. */
async function bodyText(res: Response, deadline: AbortSignal): Promise<string> {
  if (deadline.aborted) throw new Error("The answer took too long to arrive.");
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("The answer took too long to arrive."));
      void res.body?.cancel().catch(() => {});
    };
    deadline.addEventListener("abort", onAbort, { once: true });
    res
      .text()
      .then(resolve, reject)
      .finally(() => deadline.removeEventListener("abort", onAbort));
  });
}

/** The SDK body, field by field (nothing but what LineRequest allows ever leaves). */
function createParams(params: LineRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: params.model,
    max_tokens: params.max_tokens,
    system: params.system,
    messages: [{ role: "user", content: params.messages[0].content }],
    output_config: outputConfig(params.output_config),
  };
}

function outputConfig(c: LineRequest["output_config"]): Anthropic.OutputConfig {
  return {
    format: { type: "json_schema", schema: c.format.schema as unknown as Record<string, unknown> },
    ...(c.effort === "low" ? { effort: "low" as const } : {}),
  };
}

function sdkClient(apiKey: string, baseURL: string, maxRetries: number, opts: ClaudeClientOptions): Anthropic {
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL,
    maxRetries,
    timeout: opts.timeoutMs ?? CLAUDE_TIMEOUT_MS,
    logLevel: "off",
    fetchOptions: { redirect: "error" },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/**
 * A client for `apiKey` at `baseUrl` (Anthropic's API, or the fake at http://127.0.0.1:<port>). Throws
 * ClaudeTargetError when the base URL isn't allowed (in a test run: anything but loopback) or the key doesn't fit it
 * (a test key only goes to the fake, and the fake only gets test keys).
 */
export function createClaudeApi(apiKey: string, baseUrl: string, opts: ClaudeClientOptions = {}): ClaudeApi {
  assertAllowedAnthropicBase(baseUrl);
  assertAnthropicKeyMatchesTarget(apiKey, baseUrl);
  const baseURL = baseUrl.trim().replace(/\/+$/, "");
  const paid = sdkClient(apiKey.trim(), baseURL, 0, opts);
  const free = sdkClient(apiKey.trim(), baseURL, FREE_CALL_RETRIES, opts);
  return {
    async createLine(params) {
      const timeoutMs = opts.timeoutMs ?? claudeCallTimeoutMs(params.max_tokens);
      // One deadline for the whole call: the SDK's own timeout ends when the headers arrive, not the body (M5 review AI-1).
      const deadline = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await paid.messages.create(createParams(params), { signal: deadline, timeout: timeoutMs }).asResponse();
      } catch (err) {
        // The deadline fired before the headers came: the same as the SDK's own timeout (the request may be billed).
        if (deadline.aborted && err instanceof APIUserAbortError) throw new APIConnectionTimeoutError();
        throw err;
      }
      // Anthropic answered, so the request is billed: from here any failure is an unreadable answer, with its id.
      const requestId = res.headers.get("request-id") || null;
      let text: string;
      try {
        text = await bodyText(res, deadline);
      } catch {
        throw new UnreadableAnswerError("Anthropic's answer broke off or took too long to arrive.", requestId);
      }
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        throw new UnreadableAnswerError(undefined, requestId);
      }
      return answerFromMessage(msg, params.model, requestId);
    },
    async countTokens(params) {
      const res = await free.messages.countTokens({
        model: params.model,
        system: params.system,
        messages: [{ role: "user", content: params.messages[0].content }],
        output_config: outputConfig(params.output_config),
      });
      const n = (res as { input_tokens?: unknown } | null)?.input_tokens;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new UnreadableAnswerError("Anthropic's token count couldn't be read.");
      return n;
    },
    async retrieveModel(id) {
      try {
        const info: unknown = await free.models.retrieve(id);
        return modelCheckFromInfo(info);
      } catch (err) {
        return { ok: false, failure: classifyAnthropicError(err) };
      }
    },
  };
}

/**
 * The client for the saved key (Secret "anthropic.apiKey"), or why there is none: the practice copy never talks to
 * Anthropic, no key, a key that can't be decrypted, or a key that doesn't fit this server. In a test run without the
 * fake server this throws, on purpose (anthropicBaseUrl).
 */
export async function getClaudeApi(opts: ClaudeClientOptions = {}): Promise<ClaudeApiResult> {
  const s = await getSettings(["practice.copy"] as const);
  if (s["practice.copy"]) return { ok: false, reason: "practice-copy", text: CLAUDE_NOT_READY_TEXT["practice-copy"] };
  const key = await readKey();
  if (key === "unreadable") return { ok: false, reason: "unreadable", text: CLAUDE_NOT_READY_TEXT.unreadable };
  if (!key || !key.trim()) return { ok: false, reason: "no-key", text: CLAUDE_NOT_READY_TEXT["no-key"] };
  const baseUrl = anthropicBaseUrl();
  try {
    assertAnthropicKeyMatchesTarget(key, baseUrl);
  } catch {
    return { ok: false, reason: "mismatch", text: CLAUDE_NOT_READY_TEXT.mismatch };
  }
  return { ok: true, api: createClaudeApi(key, baseUrl, opts), fakeMode: isAnthropicFakeMode() };
}

/** The saved Anthropic key (when readable), for redacting logs and job errors. */
export async function anthropicSecrets(): Promise<string[]> {
  const key = await readKey();
  return key && key !== "unreadable" && key.trim() ? [key.trim()] : [];
}
