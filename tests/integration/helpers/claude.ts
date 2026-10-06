import type { ClaudeUsage } from "@/core/ai/cost";
import type { ClaudeAnswer } from "@/core/ai/parse";
import type { LineRequest } from "@/core/ai/request";
import type { ClaudeApi } from "@/server/anthropic/client";
import { modelCheckFromInfo, type ModelCheck } from "@/server/anthropic/models";
import { echoAnswer, promptCharacters, userTextOf } from "../../fake-claude/answers";
import { fakeModelInfo } from "../../fake-claude/models";
import { startFakeClaude } from "../../fake-claude/server";
import { FAKE_CLAUDE_KEY, type FakeClaude, type FakeClaudeOptions } from "../../fake-claude/types";

/**
 * Points the app at a fresh fake Claude server for one integration test file (M5-DESIGN §7.2, §7.4). Call it AFTER
 * createTestDb(): it saves Secret "anthropic.apiKey" in the test database.
 *
 *   const t = await createTestDb("x");
 *   const cl = await connectFakeClaude();              // fake.origin is now OUTREACH_ANTHROPIC_BASE_URL
 *   const res = await getClaudeApi();                  // a client for the fake, with the test key
 *   …
 *   afterAll(() => cl.stop());
 *
 * Keys are always test keys (sk-ant-fake-…), which the real Anthropic API never gets. The fixture sites answer by
 * default (OUTREACH_WEB_FIXTURES, set by tests/setup/env.ts); pass `sitesDir: null` for echo answers only.
 */
export type FakeClaudeConnection = {
  fake: FakeClaude;
  apiKey: string;
  /** Closes the fake and puts OUTREACH_ANTHROPIC_BASE_URL back. */
  stop: () => Promise<void>;
};

export async function connectFakeClaude(opts: FakeClaudeOptions & { apiKey?: string } = {}): Promise<FakeClaudeConnection> {
  const apiKey = opts.apiKey ?? FAKE_CLAUDE_KEY;
  if (!apiKey.startsWith("sk-ant-fake-")) throw new Error("connectFakeClaude: the key must start with sk-ant-fake-.");
  const sitesDir = opts.sitesDir !== undefined ? opts.sitesDir : (process.env.OUTREACH_WEB_FIXTURES ?? null);
  const fake = await startFakeClaude({ ...opts, sitesDir });
  const previous = process.env.OUTREACH_ANTHROPIC_BASE_URL;
  process.env.OUTREACH_ANTHROPIC_BASE_URL = fake.origin;

  const { setSecret } = await import("@/server/secrets");
  await setSecret("anthropic.apiKey", apiKey, null);

  return {
    fake,
    apiKey,
    stop: async () => {
      if (previous === undefined) delete process.env.OUTREACH_ANTHROPIC_BASE_URL;
      else process.env.OUTREACH_ANTHROPIC_BASE_URL = previous;
      await fake.close();
    },
  };
}

/**
 * One scripted reply of stubClaudeApi:
 * - a plain answer object (a LineAnswer) or `{answer}` (object or raw text) with optional stop reason, usage, request
 *   id and model: an `end_turn` answer unless said otherwise;
 * - `{error}`: createLine throws it (build SDK errors with `APIError.generate(status, body, message, headers)`);
 * - a function of the request and the call number (1-based) that returns the answer.
 */
export type StubReply =
  | { answer: object | string; stopReason?: string | null; usage?: Partial<ClaudeUsage>; requestId?: string | null; model?: string }
  | { error: unknown }
  | ((params: LineRequest, call: number) => ClaudeAnswer | Promise<ClaudeAnswer>)
  | Record<string, unknown>;

export type StubClaudeApi = ClaudeApi & {
  /** Every createLine request, oldest first. */
  readonly calls: LineRequest[];
  /** Every countTokens request. */
  readonly countCalls: Array<Omit<LineRequest, "max_tokens">>;
  /** Every retrieveModel id. */
  readonly modelCalls: string[];
  /** Adds replies to the end of the queue. */
  push(...replies: StubReply[]): void;
};

const STUB_USAGE: ClaudeUsage = {
  inputTokens: 3_000,
  outputTokens: 120,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  thinkingTokens: null,
  inferenceGeo: null,
};

/**
 * An in-process ClaudeApi for unit-level tests (M5-DESIGN §7.2): createLine answers from `replies` in order, then
 * with the fake's echo answer (the homepage's first 8 words as the quote); countTokens counts characters / 4 like the
 * fake; retrieveModel answers from the fake's model catalogue (or `opts.models`). No network, no database.
 */
export function stubClaudeApi(
  replies: StubReply[] = [],
  opts: { usage?: Partial<ClaudeUsage>; countTokens?: number; models?: Record<string, ModelCheck> } = {},
): StubClaudeApi {
  const queue = [...replies];
  const calls: LineRequest[] = [];
  const countCalls: Array<Omit<LineRequest, "max_tokens">> = [];
  const modelCalls: string[] = [];
  const baseUsage = { ...STUB_USAGE, ...(opts.usage ?? {}) };

  function answerOf(params: LineRequest, reply: { answer: object | string; stopReason?: string | null; usage?: Partial<ClaudeUsage>; requestId?: string | null; model?: string }): ClaudeAnswer {
    return {
      text: typeof reply.answer === "string" ? reply.answer : JSON.stringify(reply.answer),
      stopReason: reply.stopReason === undefined ? "end_turn" : reply.stopReason,
      usage: { ...baseUsage, ...(reply.usage ?? {}) },
      requestId: reply.requestId === undefined ? `req_stub_${calls.length}` : reply.requestId,
      model: reply.model ?? params.model,
    };
  }

  return {
    calls,
    countCalls,
    modelCalls,
    push(...more) {
      queue.push(...more);
    },
    async createLine(params) {
      calls.push(params);
      const reply = queue.shift();
      if (reply === undefined) return answerOf(params, { answer: echoAnswer(userTextOf(params)) });
      if (typeof reply === "function") return reply(params, calls.length);
      if ("error" in reply) throw reply.error;
      if ("answer" in reply && (typeof reply.answer === "string" || (reply.answer && typeof reply.answer === "object"))) {
        return answerOf(params, reply as { answer: object | string });
      }
      return answerOf(params, { answer: reply });
    },
    async countTokens(params) {
      countCalls.push(params);
      return opts.countTokens ?? Math.ceil(promptCharacters(params) / 4);
    },
    async retrieveModel(id) {
      modelCalls.push(id);
      const known = opts.models?.[id];
      if (known) return known;
      const info = fakeModelInfo(id);
      if (!info) return { ok: false, failure: { kind: "pause", reason: "model_not_found" } };
      return modelCheckFromInfo(info);
    },
  };
}
