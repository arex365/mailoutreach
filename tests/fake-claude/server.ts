import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { handleAdmin } from "./admin";
import { echoAnswer, fixtureAnswer, promptCharacters, userTextOf } from "./answers";
import { fakeModelInfo, isFakeHaiku } from "./models";
import {
  FAKE_CLAUDE_ROUTES,
  type ClaudeFault,
  type FakeClaude,
  type FakeClaudeOptions,
  type FakeClaudeRequest,
  type FakeClaudeRoute,
} from "./types";

export {
  FAKE_CLAUDE_KEY,
  FAKE_CLAUDE_ROUTES,
  type ClaudeFault,
  type FakeClaude,
  type FakeClaudeOptions,
  type FakeClaudeRequest,
  type FakeClaudeRoute,
} from "./types";

/**
 * The fake Claude server (M5-DESIGN §7.2): a plain node:http server on 127.0.0.1 that answers the three Anthropic
 * endpoints the app uses (messages, count_tokens, models) the way the real API does (research ai-and-fetch A4–A7),
 * with a fault queue per endpoint, per-request scripts and fixture-site answers. It never makes an outbound request.
 *
 * Auth: `x-api-key` must start with "sk-ant-fake-" (else 401 authentication_error); `anthropic-version` is required.
 * `POST /v1/messages` refuses (400) what the app must never send: temperature, top_p, top_k, tools, inference_geo, an
 * assistant last message (prefill), and `output_config.effort` for the Haiku id (the fake's assumption, D26). It
 * answers, in this order: a queued fault → a matching script → the fixture site's claude.json → the echo answer.
 */

const FAKE_KEY_PREFIX = "sk-ant-fake-";
const DEFAULT_USAGE = { input: 3_000, output: 120 };
const MAX_BODY_BYTES = 32 * 1024 * 1024;

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function errorBody(type: string, message: string, requestId: string): object {
  return { type: "error", error: { type, message }, request_id: requestId };
}

function routeOf(method: string, pathname: string): { route: FakeClaudeRoute; modelId?: string } | null {
  if (method === "POST" && pathname === "/v1/messages") return { route: "POST /v1/messages" };
  if (method === "POST" && pathname === "/v1/messages/count_tokens") return { route: "POST /v1/messages/count_tokens" };
  const m = /^\/v1\/models\/([^/]+)$/.exec(pathname);
  if (method === "GET" && m) {
    let id = m[1]!;
    try {
      id = decodeURIComponent(id);
    } catch {
      // keep it as sent
    }
    return { route: "GET /v1/models/:id", modelId: id };
  }
  return null;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

class FakeClaudeServer implements FakeClaude {
  readonly requests: FakeClaudeRequest[] = [];
  origin = "";
  #server: http.Server;
  #sockets = new Set<Socket>();
  #hanging = new Set<http.ServerResponse>();
  #faults = new Map<FakeClaudeRoute, Array<{ fault: ClaudeFault; left: number }>>();
  #scripts: Array<{ match: (userText: string) => boolean; answer: object | string }> = [];
  #usage: { input: number; output: number };
  #count = 0;
  #now: () => Date;

  constructor(private readonly init: FakeClaudeOptions) {
    this.#usage = { ...(init.usage ?? DEFAULT_USAGE) };
    this.#now = init.now ?? (() => new Date());
    this.#server = http.createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify(errorBody("api_error", `Fake Claude error: ${err instanceof Error ? err.message : String(err)}`, "req_fake_error")));
        }
      });
    });
    this.#server.on("connection", (s: Socket) => {
      this.#sockets.add(s);
      s.on("close", () => this.#sockets.delete(s));
    });
  }

  async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, "127.0.0.1", () => resolve());
    });
    const addr = this.#server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${addr.port}`;
  }

  // ───────────── request handling ─────────────

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const url = new URL(req.url ?? "/", this.origin || "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    const text = raw.toString("utf8");

    if (url.pathname.startsWith("/__fake/")) {
      if (!isLoopback(req.socket.remoteAddress)) {
        this.#send(res, { status: 403, body: { error: "The admin API only answers this PC." } });
        return;
      }
      this.#send(res, handleAdmin(this, { method, path: url.pathname, body: text }));
      return;
    }

    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const logged: Record<string, string> = { ...headers };
    for (const secret of ["x-api-key", "authorization"]) if (secret in logged) logged[secret] = "[hidden]";
    this.requests.push({ method, path: url.pathname, body, headers: logged, at: this.#now().toISOString() });

    const requestId = `req_fake_${++this.#count}`;
    const withId = (reply: Reply): Reply => ({ ...reply, headers: { "request-id": requestId, ...(reply.headers ?? {}) } });
    const found = routeOf(method, url.pathname);
    if (!found) {
      this.#send(res, withId({ status: 404, body: errorBody("not_found_error", "Not found", requestId) }));
      return;
    }
    const key = headers["x-api-key"] ?? "";
    if (!key.startsWith(FAKE_KEY_PREFIX)) {
      this.#send(res, withId({ status: 401, body: errorBody("authentication_error", "invalid x-api-key", requestId) }));
      return;
    }
    if (!headers["anthropic-version"]) {
      this.#send(res, withId({ status: 400, body: errorBody("invalid_request_error", "anthropic-version: header is required", requestId) }));
      return;
    }

    const fault = this.#popFault(found.route);
    if (fault?.kind === "hang") {
      this.#hanging.add(res);
      res.on("close", () => this.#hanging.delete(res));
      return;
    }
    if (fault?.kind === "status") {
      const b = fault.body as { request_id?: unknown };
      const faultBody = b && typeof b === "object" && "error" in b && b.request_id === undefined ? { ...b, request_id: requestId } : fault.body;
      this.#send(res, withId({ status: fault.status, body: faultBody, headers: fault.headers }));
      return;
    }
    if (fault?.kind === "delay") {
      await new Promise((r) => setTimeout(r, Math.max(0, fault.ms)));
      if (res.destroyed || res.writableEnded) return;
    }

    let reply: Reply;
    if (found.route === "GET /v1/models/:id") reply = this.#model(found.modelId ?? "", requestId);
    else if (found.route === "POST /v1/messages/count_tokens") reply = this.#countTokens(body, requestId);
    else reply = this.#message(body, requestId, fault);
    if (fault?.kind === "cutBody") {
      this.#sendCut(res, withId(reply), fault.stall === true);
      return;
    }
    this.#send(res, withId(reply));
  }

  /**
   * The status, the headers (with the full Content-Length) and the first half of the body; then the connection is
   * dropped, or with `stall` left open without the rest (closed by reset() or close()).
   */
  #sendCut(res: http.ServerResponse, out: Reply, stall: boolean): void {
    const payload = typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? {});
    const headers: Record<string, string> = { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
    for (const [k, v] of Object.entries(out.headers ?? {})) headers[k.toLowerCase()] = v;
    res.writeHead(out.status, headers);
    const part = payload.slice(0, Math.floor(payload.length / 2));
    if (stall) {
      this.#hanging.add(res);
      res.on("close", () => this.#hanging.delete(res));
      res.write(part);
      return;
    }
    res.write(part, () => res.socket?.destroy());
  }

  #model(id: string, requestId: string): Reply {
    const info = fakeModelInfo(id);
    if (!info) return { status: 404, body: errorBody("not_found_error", `model: ${id}`, requestId) };
    return { status: 200, body: info };
  }

  #countTokens(body: unknown, requestId: string): Reply {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const problem = this.#requestProblem(b, false);
    if (problem) return { status: problem.status, body: errorBody(problem.type, problem.message, requestId) };
    return { status: 200, body: { input_tokens: Math.ceil(promptCharacters(b) / 4) } };
  }

  /** What the real API (or the fake's assumptions) refuse; null when the request is fine. */
  #requestProblem(b: Record<string, unknown>, create: boolean): { status: number; type: string; message: string } | null {
    const bad = (message: string) => ({ status: 400, type: "invalid_request_error", message });
    if (typeof b.model !== "string" || !b.model) return bad("model: Field required");
    if (create && (typeof b.max_tokens !== "number" || !Number.isInteger(b.max_tokens) || b.max_tokens < 1)) {
      return bad("max_tokens: Field required");
    }
    if (!Array.isArray(b.messages) || b.messages.length === 0) return bad("messages: at least one message is required");
    for (const field of ["temperature", "top_p", "top_k", "tools", "tool_choice", "inference_geo"]) {
      if (field in b) return bad(`${field}: the app must never send this (fake Claude refuses it)`);
    }
    const last = b.messages[b.messages.length - 1] as { role?: unknown } | null;
    if (!last || last.role !== "user") {
      return bad("This model does not support assistant message prefill. The conversation must end with a user message.");
    }
    const info = fakeModelInfo(b.model);
    if (!info) return { status: 404, type: "not_found_error", message: `model: ${b.model}` };
    const config = (b.output_config && typeof b.output_config === "object" ? b.output_config : {}) as { effort?: unknown; format?: unknown };
    if (config.effort != null && isFakeHaiku(b.model)) return bad("output_config.effort: effort is not supported on this model");
    if (config.format != null && !info.capabilities.structured_outputs.supported) {
      return bad("output_config.format: structured outputs are not supported on this model");
    }
    const thinking = b.thinking as { type?: unknown } | undefined;
    if (thinking?.type === "adaptive" && !info.capabilities.thinking.types.adaptive.supported) {
      return bad("thinking.type: adaptive thinking is not supported on this model");
    }
    return null;
  }

  #message(body: unknown, requestId: string, fault: ClaudeFault | null): Reply {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const problem = this.#requestProblem(b, true);
    if (problem) return { status: problem.status, body: errorBody(problem.type, problem.message, requestId) };

    const userText = userTextOf(b);
    const answer: object | string =
      (fault?.kind === "answer" ? fault.answer : null) ??
      this.#scripts.find((s) => s.match(userText))?.answer ??
      fixtureAnswer(this.init.sitesDir, userText) ??
      echoAnswer(userText);
    let answerText = typeof answer === "string" ? answer : JSON.stringify(answer);
    let stopReason = "end_turn";
    let output = this.#usage.output;
    if (fault?.kind === "stop") {
      stopReason = fault.stopReason;
      if (fault.stopReason === "max_tokens") {
        answerText = answerText.slice(0, Math.floor(answerText.length / 2));
        output = b.max_tokens as number;
      } else {
        answerText = "";
      }
    }
    const content: object[] = [];
    if (fault?.kind === "thinkingFirst") content.push({ type: "thinking", thinking: "", signature: "fake-signature" });
    content.push({ type: "text", text: answerText });
    return {
      status: 200,
      body: {
        id: `msg_fake_${this.#count}`,
        type: "message",
        role: "assistant",
        model: b.model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        stop_details: null,
        container: null,
        usage: {
          input_tokens: this.#usage.input,
          output_tokens: output,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
          inference_geo: "global",
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: "standard",
        },
      },
    };
  }

  #send(res: http.ServerResponse, out: Reply): void {
    const headers: Record<string, string> = {};
    let payload = "";
    if (typeof out.body === "string") {
      headers["content-type"] = "text/plain; charset=utf-8";
      payload = out.body;
    } else if (out.body !== undefined && out.body !== null) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(out.body);
    }
    for (const [k, v] of Object.entries(out.headers ?? {})) headers[k.toLowerCase()] = v;
    res.writeHead(out.status, headers);
    res.end(payload);
  }

  #popFault(route: FakeClaudeRoute): ClaudeFault | null {
    const queue = this.#faults.get(route);
    if (!queue?.length) return null;
    const head = queue[0]!;
    head.left -= 1;
    if (head.left <= 0) queue.shift();
    return head.fault;
  }

  // ───────────── controls ─────────────

  failNext(route: FakeClaudeRoute, fault: ClaudeFault, times = 1): void {
    if (!FAKE_CLAUDE_ROUTES.includes(route)) throw new Error(`Unknown route ${route}. Known: ${FAKE_CLAUDE_ROUTES.join(", ")}.`);
    const queue = this.#faults.get(route) ?? [];
    queue.push({ fault, left: Math.max(1, Math.floor(times)) });
    this.#faults.set(route, queue);
  }

  script(match: (userText: string) => boolean, answer: object | string): void {
    this.#scripts.push({ match, answer });
  }

  setUsage(u: { input: number; output: number }): void {
    this.#usage = { input: Math.max(0, Math.floor(u.input)), output: Math.max(0, Math.floor(u.output)) };
  }

  reset(): void {
    this.#abortHanging();
    this.requests.length = 0;
    this.#faults.clear();
    this.#scripts = [];
    this.#usage = { ...(this.init.usage ?? DEFAULT_USAGE) };
  }

  #abortHanging(): void {
    for (const res of this.#hanging) res.socket?.destroy();
    this.#hanging.clear();
  }

  async close(): Promise<void> {
    this.#abortHanging();
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** Starts the fake on 127.0.0.1 (port 0 = any free port) and resolves once it listens. */
export async function startFakeClaude(opts: FakeClaudeOptions = {}): Promise<FakeClaude> {
  const fake = new FakeClaudeServer(opts);
  await fake.listen(opts.port ?? 0);
  return fake;
}
