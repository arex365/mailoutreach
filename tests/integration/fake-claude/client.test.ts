import http from "node:http";
import type { AddressInfo } from "node:net";
import { APIConnectionError, APIConnectionTimeoutError, APIError, BadRequestError } from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkLine } from "@/core/ai/checks";
import { costUsd } from "@/core/ai/cost";
import { readLineAnswer } from "@/core/ai/parse";
import type { LinePageInput } from "@/core/ai/prompt";
import { buildLineRequest, buildSystemTokenRequest } from "@/core/ai/request";
import { DEFAULT_AI_PRICES, HAIKU_MODEL, resolveProfile, SONNET_MODEL } from "@/core/ai/types";
import { classifyAnthropicError, createClaudeApi, requestIdOfError, UnreadableAnswerError, type ClaudeApi } from "@/server/anthropic";
import { ECHO_LINE } from "../../fake-claude/answers";
import { FAKE_CLAUDE_KEY, startFakeClaude, type FakeClaude } from "../../fake-claude/server";

/**
 * The real SDK against the fake Claude server (M5-DESIGN §3.5.2, §7.2): messages, countTokens, models.retrieve, every
 * fault and the error table of research A7, the refusals of parameters the app must never send, request ids, and the
 * client's construction options (no retries on the paid call, no redirects, no logging, no environment overrides).
 */

const PAGE: LinePageInput = {
  source: "homepage",
  url: "https://www.figuren-werkstatt.example/",
  lang: "en",
  title: "Figuren Werkstatt",
  text: "Hand-painted 28mm tabletop miniatures for fantasy wargames, cast in resin and sold as unpainted kits.",
};
const INPUT = { company: { name: "Figuren Werkstatt", country: "Germany", niche: "miniatures" }, pages: [PAGE] };
const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
const sonnet = resolveProfile(SONNET_MODEL, null, DEFAULT_AI_PRICES);

let fake: FakeClaude;
let api: ClaudeApi;

beforeAll(async () => {
  fake = await startFakeClaude({ sitesDir: null });
  api = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin, { timeoutMs: 10_000 });
});
afterEach(() => {
  fake.reset();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await fake.close();
});

function errorBody(type: string, message: string, details?: object): object {
  return { type: "error", error: { type, message, ...(details ? { details } : {}) } };
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to fail");
}

async function rawPost(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${fake.origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": FAKE_CLAUDE_KEY, "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("createLine (messages.create)", () => {
  it("answers with the echo line, usage and a request id", async () => {
    const req = buildLineRequest(INPUT, haiku);
    const answer = await api.createLine(req);
    expect(answer.stopReason).toBe("end_turn");
    expect(answer.model).toBe(HAIKU_MODEL);
    expect(answer.requestId).toMatch(/^req_fake_\d+$/);
    expect(answer.usage).toMatchObject({ inputTokens: 3_000, outputTokens: 120, cacheReadTokens: 0, cacheWrite5mTokens: 0 });
    expect(costUsd(answer.usage, haiku.prices)).toBe(0.0036);

    const read = readLineAnswer(answer);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.value).toEqual({
      evidence_source: "homepage",
      evidence_quote: "Hand-painted 28mm tabletop miniatures for fantasy wargames, cast",
      line: ECHO_LINE,
      reason_if_null: null,
    });
    const checked = checkLine({
      answer: read.value,
      pages: [{ source: "homepage", title: PAGE.title, text: PAGE.text, lang: PAGE.lang }],
      companyName: "Figuren Werkstatt",
      countryName: "Germany",
      companyDomain: "figuren-werkstatt.example",
      avoid: [],
    });
    expect(checked.problems).toEqual([]);
  });

  it("sends exactly the request built, with the version header and no bearer token", async () => {
    await api.createLine(buildLineRequest(INPUT, haiku));
    expect(fake.requests).toHaveLength(1);
    const seen = fake.requests[0]!;
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/v1/messages");
    expect(Object.keys(seen.body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(seen.body.max_tokens).toBe(600);
    expect(seen.body.output_config.effort).toBeUndefined();
    expect(seen.body.output_config.format.type).toBe("json_schema");
    expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen.headers["x-api-key"]).toBe("[hidden]");
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["x-stainless-retry-count"]).toBe("0");
  });

  it("Sonnet 5 sends effort low, and a thinking block first still finds the text", async () => {
    fake.failNext("POST /v1/messages", { kind: "thinkingFirst" });
    const answer = await api.createLine(buildLineRequest(INPUT, sonnet));
    expect(fake.requests[0]!.body.output_config.effort).toBe("low");
    expect(readLineAnswer(answer).kind).toBe("ok");
  });

  it("stops: max_tokens (cut JSON) and refusal", async () => {
    fake.failNext("POST /v1/messages", { kind: "stop", stopReason: "max_tokens" });
    const cut = await api.createLine(buildLineRequest(INPUT, haiku));
    expect(cut.stopReason).toBe("max_tokens");
    expect(cut.usage.outputTokens).toBe(600);
    expect(readLineAnswer(cut)).toEqual({ kind: "max_tokens" });
    expect(() => JSON.parse(cut.text ?? "")).toThrow();

    fake.failNext("POST /v1/messages", { kind: "stop", stopReason: "refusal" });
    expect(readLineAnswer(await api.createLine(buildLineRequest(INPUT, haiku)))).toEqual({ kind: "refusal" });
  });

  it("a fixed answer, and bad JSON as a string", async () => {
    const none = { evidence_source: "none", evidence_quote: null, line: null, reason_if_null: "only_generic_claims" };
    fake.failNext("POST /v1/messages", { kind: "answer", answer: none });
    expect(readLineAnswer(await api.createLine(buildLineRequest(INPUT, haiku)))).toEqual({ kind: "ok", value: none });
    fake.failNext("POST /v1/messages", { kind: "answer", answer: "{not json" });
    expect(readLineAnswer(await api.createLine(buildLineRequest(INPUT, haiku)))).toMatchObject({ kind: "bad" });
  });

  it("scripts answer the requests they match", async () => {
    const scripted = { evidence_source: "homepage", evidence_quote: "Hand-painted 28mm tabletop miniatures", line: "You sell miniatures made in Leipzig.", reason_if_null: null };
    fake.script((text) => text.includes('<company>{"name":"Figuren Werkstatt"'), scripted);
    const a = readLineAnswer(await api.createLine(buildLineRequest(INPUT, haiku)));
    expect(a).toEqual({ kind: "ok", value: scripted });
    const other = readLineAnswer(await api.createLine(buildLineRequest({ ...INPUT, company: { name: "Other", country: null, niche: null } }, haiku)));
    expect(other.kind === "ok" && other.value.line).toBe(ECHO_LINE);
  });

  it("request ids count up", async () => {
    const a = await api.createLine(buildLineRequest(INPUT, haiku));
    const b = await api.createLine(buildLineRequest(INPUT, haiku));
    const n = (id: string | null) => Number(id?.replace("req_fake_", ""));
    expect(n(b.requestId)).toBe(n(a.requestId) + 1);
  });

  it("setUsage changes the reported usage; reset restores it", async () => {
    fake.setUsage({ input: 4_500, output: 200 });
    const a = await api.createLine(buildLineRequest(INPUT, haiku));
    expect(costUsd(a.usage, haiku.prices)).toBe(0.0055);
    fake.reset();
    expect(fake.requests).toHaveLength(0);
    const b = await api.createLine(buildLineRequest(INPUT, haiku));
    expect(b.usage.inputTokens).toBe(3_000);
  });
});

describe("errors through the SDK (research A7)", () => {
  const cases: Array<{ name: string; status: number; body: object; headers?: Record<string, string>; expected: unknown }> = [
    { name: "401", status: 401, body: errorBody("authentication_error", "invalid x-api-key"), expected: { kind: "pause", reason: "key_rejected" } },
    { name: "403", status: 403, body: errorBody("permission_error", "not allowed"), expected: { kind: "pause", reason: "no_permission" } },
    { name: "404 model", status: 404, body: errorBody("not_found_error", "model: claude-x"), expected: { kind: "pause", reason: "model_not_found" } },
    {
      name: "429 with retry-after",
      status: 429,
      body: errorBody("rate_limit_error", "Rate limited"),
      headers: { "retry-after": "7" },
      expected: { kind: "requeue", afterMs: 7_000 },
    },
    { name: "429 without retry-after", status: 429, body: errorBody("rate_limit_error", "Rate limited"), expected: { kind: "pause", reason: "tier_spend_cap" } },
    {
      name: "429 spend cap",
      status: 429,
      body: errorBody("rate_limit_error", "You have reached your API usage limits.", { error_code: "enforced_spend_limit_reached" }),
      expected: { kind: "pause", reason: "tier_spend_cap" },
    },
    {
      name: "400 own limit",
      status: 400,
      body: errorBody("invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."),
      expected: { kind: "pause", reason: "own_spend_limit" },
    },
    { name: "402", status: 402, body: errorBody("billing_error", "Payment required"), expected: { kind: "pause", reason: "billing" } },
    { name: "500", status: 500, body: errorBody("api_error", "Internal server error"), expected: { kind: "backoff", mayBeBilled: false } },
    { name: "529", status: 529, body: errorBody("overloaded_error", "Overloaded"), expected: { kind: "backoff", mayBeBilled: false } },
    {
      name: "400 other",
      status: 400,
      body: errorBody("invalid_request_error", "messages.0.content: text must be non-empty"),
      expected: { kind: "fail_draft", message: "messages.0.content: text must be non-empty" },
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${JSON.stringify(c.expected)}, one request, the request id kept`, async () => {
      fake.failNext("POST /v1/messages", { kind: "status", status: c.status, body: c.body, headers: c.headers });
      const err = await thrown(api.createLine(buildLineRequest(INPUT, haiku)));
      expect(err).toBeInstanceOf(APIError);
      expect((err as APIError).requestID).toMatch(/^req_fake_\d+$/);
      expect(classifyAnthropicError(err)).toEqual(c.expected);
      // maxRetries 0: the paid call is never repeated, not even for 429, 500 or 529.
      expect(fake.requests).toHaveLength(1);
    });
  }

  it("a connection error (nothing listening) backs off without billing", async () => {
    const dead = createClaudeApi(FAKE_CLAUDE_KEY, "http://127.0.0.1:19", { timeoutMs: 5_000 });
    const err = await thrown(dead.createLine(buildLineRequest(INPUT, haiku)));
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err).not.toBeInstanceOf(APIConnectionTimeoutError);
    expect(classifyAnthropicError(err)).toEqual({ kind: "backoff", mayBeBilled: false });
  });

  it("a timeout (the request left, no answer) may be billed, and is not retried", async () => {
    const quick = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin, { timeoutMs: 300 });
    fake.failNext("POST /v1/messages", { kind: "hang" });
    const err = await thrown(quick.createLine(buildLineRequest(INPUT, haiku)));
    expect(err).toBeInstanceOf(APIConnectionTimeoutError);
    expect(classifyAnthropicError(err)).toEqual({ kind: "backoff", mayBeBilled: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests).toHaveLength(1);
  });

  it("a 200 whose body breaks off is an unreadable answer with its request id: may be billed (AI-1)", async () => {
    fake.failNext("POST /v1/messages", { kind: "cutBody" });
    const err = await thrown(api.createLine(buildLineRequest(INPUT, haiku)));
    expect(err).toBeInstanceOf(UnreadableAnswerError);
    expect(requestIdOfError(err)).toMatch(/^req_fake_\d+$/);
    expect(classifyAnthropicError(err)).toEqual({ kind: "backoff", mayBeBilled: true });
    expect(fake.requests).toHaveLength(1);
  });

  it("the timeout covers the body too: a body that stalls after the headers ends the call in time (AI-1)", async () => {
    const quick = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin, { timeoutMs: 400 });
    fake.failNext("POST /v1/messages", { kind: "cutBody", stall: true });
    const started = Date.now();
    const err = await thrown(quick.createLine(buildLineRequest(INPUT, haiku)));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(UnreadableAnswerError);
    expect(requestIdOfError(err)).toMatch(/^req_fake_\d+$/);
    expect(classifyAnthropicError(err)).toEqual({ kind: "backoff", mayBeBilled: true });
  });

  it("a body cut by the network (TypeError terminated), broken JSON or a stalled stream: unreadable, request id kept (AI-1)", async () => {
    const answerWith = (body: ReadableStream<Uint8Array> | string): typeof fetch =>
      (async () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json", "request-id": "req_trunc" } })) as typeof fetch;
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"msg_1","type":"mes'));
        controller.error(new TypeError("terminated"));
      },
    });
    const never = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"msg_1"'));
      },
    });
    for (const [name, body, timeoutMs] of [
      ["terminated", cut, 10_000],
      ["broken JSON", '{"id":"msg_1","content":[', 10_000],
      ["stalled", never, 300],
    ] as const) {
      const custom = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin, { timeoutMs, fetch: answerWith(body) });
      const err = await thrown(custom.createLine(buildLineRequest(INPUT, haiku)));
      expect(err, name).toBeInstanceOf(UnreadableAnswerError);
      expect(requestIdOfError(err), name).toBe("req_trunc");
      expect(classifyAnthropicError(err), name).toEqual({ kind: "backoff", mayBeBilled: true });
    }
  });

  it("the paid call's own timeout grows with max_tokens (the doubled retry isn't cut off at 60 s, AI-2)", async () => {
    let seen: string | null = null;
    const spy: typeof fetch = async (input, init) => {
      seen = new Headers(init?.headers).get("x-stainless-timeout");
      return fetch(input, init);
    };
    const withSpy = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin, { fetch: spy });
    await withSpy.createLine(buildLineRequest(INPUT, haiku, { maxTokens: 1_200 }));
    // 60 s + 25 ms × 1,200 = 90 s (the SDK sends its timeout in seconds).
    expect(seen).toBe("90");
  });

  it("a delayed answer inside the timeout is fine", async () => {
    fake.failNext("POST /v1/messages", { kind: "delay", ms: 50 });
    expect((await api.createLine(buildLineRequest(INPUT, haiku))).stopReason).toBe("end_turn");
  });

  it("a 302 is an error: the redirect is never followed", async () => {
    let hits = 0;
    const target = http.createServer((_req, res) => {
      hits++;
      res.end("{}");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
    const port = (target.address() as AddressInfo).port;
    try {
      fake.failNext("POST /v1/messages", { kind: "status", status: 302, body: {}, headers: { location: `http://127.0.0.1:${port}/v1/messages` } });
      const err = await thrown(api.createLine(buildLineRequest(INPUT, haiku)));
      expect(err).toBeInstanceOf(APIConnectionError);
      expect(classifyAnthropicError(err)).toEqual({ kind: "backoff", mayBeBilled: false });
      expect(fake.requests).toHaveLength(1);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((r) => target.close(() => r()));
    }
  });

  it("the fake refuses effort for Haiku (the profile never sends it)", async () => {
    const req = buildLineRequest(INPUT, haiku);
    const withEffort = { ...req, output_config: { ...req.output_config, effort: "low" as const } };
    const err = await thrown(api.createLine(withEffort));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(classifyAnthropicError(err)).toMatchObject({ kind: "fail_draft" });
  });
});

describe("countTokens and retrieveModel (free, retried)", () => {
  it("countTokens counts characters / 4 and sends no max_tokens", async () => {
    const req = buildSystemTokenRequest(haiku);
    const n = await api.countTokens(req);
    expect(n).toBe(Math.ceil((req.system.length + req.messages[0].content.length) / 4));
    expect(fake.requests[0]!.path).toBe("/v1/messages/count_tokens");
    expect("max_tokens" in fake.requests[0]!.body).toBe(false);
    expect(fake.requests[0]!.body.output_config.format.type).toBe("json_schema");
  });

  it("countTokens is retried after a 500 (it's free), unlike createLine", async () => {
    fake.failNext("POST /v1/messages/count_tokens", { kind: "status", status: 500, body: errorBody("api_error", "boom") });
    expect(await api.countTokens(buildSystemTokenRequest(haiku))).toBeGreaterThan(100);
    expect(fake.requests).toHaveLength(2);
  });

  it("retrieveModel reads the capabilities of each model", async () => {
    expect(await api.retrieveModel(HAIKU_MODEL)).toEqual({
      ok: true,
      id: HAIKU_MODEL,
      displayName: "Claude Haiku 4.5",
      maxTokens: 64_000,
      structuredOutputs: true,
      effortLow: false,
    });
    expect(await api.retrieveModel("claude-haiku-4-5")).toMatchObject({ ok: true, id: HAIKU_MODEL });
    expect(await api.retrieveModel(SONNET_MODEL)).toMatchObject({ ok: true, structuredOutputs: true, effortLow: true, maxTokens: 128_000 });
    expect(await api.retrieveModel("claude-test-custom")).toMatchObject({ ok: true, structuredOutputs: true, effortLow: true, maxTokens: 8_192 });
    expect(await api.retrieveModel("claude-test-nostructured")).toMatchObject({ ok: true, structuredOutputs: false, effortLow: false });
    expect(await api.retrieveModel("claude-nope")).toEqual({ ok: false, failure: { kind: "pause", reason: "model_not_found" } });
    expect(fake.requests.at(-1)!.path).toBe("/v1/models/claude-nope");
  });

  it("retrieveModel returns a failure instead of throwing", async () => {
    const bad = createClaudeApi("sk-ant-fake-wrong", fake.origin);
    fake.failNext("GET /v1/models/:id", { kind: "status", status: 401, body: errorBody("authentication_error", "invalid x-api-key") });
    expect(await bad.retrieveModel(HAIKU_MODEL)).toEqual({ ok: false, failure: { kind: "pause", reason: "key_rejected" } });
  });
});

describe("the fake's refusals and auth", () => {
  const body = (over: Record<string, unknown> = {}) => ({ ...buildLineRequest(INPUT, haiku), ...over });

  it("refuses what the app must never send", async () => {
    for (const over of [{ temperature: 0.2 }, { top_p: 0.9 }, { top_k: 5 }, { tools: [] }, { inference_geo: "us" }]) {
      const r = await rawPost("/v1/messages", body(over));
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    }
    const prefill = await rawPost("/v1/messages", body({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "{" }] }));
    expect(prefill.status).toBe(400);
    expect(JSON.stringify(prefill.json)).toContain("prefill");
    const effortHaiku = await rawPost("/v1/messages", body({ output_config: { effort: "low", format: { type: "json_schema", schema: {} } } }));
    expect(effortHaiku.status).toBe(400);
    const effortSonnet = await rawPost("/v1/messages", buildLineRequest(INPUT, sonnet));
    expect(effortSonnet.status).toBe(200);
    const noStructured = await rawPost("/v1/messages", body({ model: "claude-test-nostructured" }));
    expect(noStructured.status).toBe(400);
  });

  it("answers 404 model: <id> for an unknown model, 401 for a key that isn't a test key, 400 without the version", async () => {
    const unknown = await rawPost("/v1/messages", body({ model: "claude-nope" }));
    expect(unknown).toMatchObject({ status: 404, json: { error: { type: "not_found_error", message: "model: claude-nope" } } });
    expect((await rawPost("/v1/messages", body(), { "x-api-key": "sk-ant-api03-real" })).status).toBe(401);
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": FAKE_CLAUDE_KEY },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("request-id")).toMatch(/^req_fake_\d+$/);
  });
});

describe("the client ignores the PC's environment", () => {
  it("ANTHROPIC_LOG=debug, ANTHROPIC_BASE_URL and env keys change nothing: no log output, requests reach the fake", async () => {
    const keep = {
      log: process.env.ANTHROPIC_LOG,
      base: process.env.ANTHROPIC_BASE_URL,
      key: process.env.ANTHROPIC_API_KEY,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    process.env.ANTHROPIC_LOG = "debug";
    process.env.ANTHROPIC_BASE_URL = "http://evil.invalid";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-from-the-environment";
    process.env.ANTHROPIC_AUTH_TOKEN = "token-from-the-environment";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const envApi = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin);
      const answer = await envApi.createLine(buildLineRequest(INPUT, haiku));
      expect(answer.stopReason).toBe("end_turn");
      await envApi.countTokens(buildSystemTokenRequest(haiku));
      await envApi.retrieveModel(HAIKU_MODEL);
      expect(fake.requests).toHaveLength(3);
      for (const r of fake.requests) {
        expect(r.headers["x-api-key"]).toBe("[hidden]");
        expect(r.headers.authorization).toBeUndefined();
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const [k, v] of [
        ["ANTHROPIC_LOG", keep.log],
        ["ANTHROPIC_BASE_URL", keep.base],
        ["ANTHROPIC_API_KEY", keep.key],
        ["ANTHROPIC_AUTH_TOKEN", keep.token],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
