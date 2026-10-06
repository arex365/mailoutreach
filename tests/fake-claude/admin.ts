import { FAKE_CLAUDE_ROUTES, type ClaudeFault, type FakeClaude, type FakeClaudeRoute } from "./types";

/**
 * The fake Claude server's admin API for the lead's manual checks (M5-DESIGN §7.2). The server only listens on
 * 127.0.0.1 and refuses admin calls from anywhere else.
 *
 *   GET  /__fake/requests                         every API request seen, oldest first
 *   POST /__fake/fail-next {route, fault, times}  queue a fault ("POST /v1/messages", {"kind":"status",…})
 *   POST /__fake/usage {input, output}            the usage every answer reports
 *   POST /__fake/script {contains, answer}        answer messages whose user text contains `contains`
 *   POST /__fake/reset                            forget requests, faults and scripts
 */

type AdminRequest = { method: string; path: string; body: string };
type AdminReply = { status: number; body: unknown };

const FAULT_KINDS = new Set(["status", "stop", "thinkingFirst", "answer", "hang", "delay", "cutBody"]);

function parseJson(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bad(message: string): AdminReply {
  return { status: 400, body: { error: message } };
}

/** A fault from JSON, or a sentence saying what is wrong with it. */
function faultOf(v: unknown): ClaudeFault | string {
  const f = v as {
    kind?: unknown;
    status?: unknown;
    body?: unknown;
    headers?: unknown;
    stopReason?: unknown;
    answer?: unknown;
    ms?: unknown;
    stall?: unknown;
  };
  if (!f || typeof f !== "object" || typeof f.kind !== "string" || !FAULT_KINDS.has(f.kind)) {
    return `fault.kind must be one of ${[...FAULT_KINDS].join(", ")}.`;
  }
  switch (f.kind) {
    case "status":
      if (typeof f.status !== "number" || !Number.isInteger(f.status) || f.status < 100 || f.status > 599) return "fault.status must be an HTTP status.";
      return {
        kind: "status",
        status: f.status,
        body: f.body && typeof f.body === "object" ? (f.body as object) : {},
        headers: f.headers && typeof f.headers === "object" ? (f.headers as Record<string, string>) : undefined,
      };
    case "stop":
      if (f.stopReason !== "max_tokens" && f.stopReason !== "refusal") return 'fault.stopReason must be "max_tokens" or "refusal".';
      return { kind: "stop", stopReason: f.stopReason };
    case "answer":
      if (typeof f.answer !== "string" && (!f.answer || typeof f.answer !== "object")) return "fault.answer must be an object or a string.";
      return { kind: "answer", answer: f.answer as object | string };
    case "delay":
      if (typeof f.ms !== "number" || f.ms < 0) return "fault.ms must be a number of milliseconds.";
      return { kind: "delay", ms: f.ms };
    case "hang":
      return { kind: "hang" };
    case "cutBody":
      return { kind: "cutBody", stall: f.stall === true };
    default:
      return { kind: "thinkingFirst" };
  }
}

/** Answers one admin call. */
export function handleAdmin(fake: FakeClaude, req: AdminRequest): AdminReply {
  const key = `${req.method} ${req.path.replace(/\/+$/, "")}`;
  if (key === "GET /__fake/requests") return { status: 200, body: fake.requests };
  const body = parseJson(req.body);
  if (body === null) return bad("The body must be a JSON object.");
  switch (key) {
    case "POST /__fake/fail-next": {
      const route = body.route as FakeClaudeRoute;
      if (!FAKE_CLAUDE_ROUTES.includes(route)) return bad(`route must be one of ${FAKE_CLAUDE_ROUTES.join(", ")}.`);
      const fault = faultOf(body.fault);
      if (typeof fault === "string") return bad(fault);
      const times = typeof body.times === "number" && body.times >= 1 ? Math.floor(body.times) : 1;
      fake.failNext(route, fault, times);
      return { status: 200, body: { ok: true, route, times } };
    }
    case "POST /__fake/usage": {
      if (typeof body.input !== "number" || typeof body.output !== "number" || body.input < 0 || body.output < 0) {
        return bad("input and output must be token counts.");
      }
      fake.setUsage({ input: body.input, output: body.output });
      return { status: 200, body: { ok: true } };
    }
    case "POST /__fake/script": {
      const contains = body.contains;
      const answer = body.answer;
      if (typeof contains !== "string" || !contains) return bad("contains must be the text to look for in the user message.");
      if (typeof answer !== "string" && (!answer || typeof answer !== "object")) return bad("answer must be an object or a string.");
      fake.script((userText) => userText.includes(contains), answer as object | string);
      return { status: 200, body: { ok: true } };
    }
    case "POST /__fake/reset":
      fake.reset();
      return { status: 200, body: { ok: true } };
    default:
      return { status: 404, body: { error: `Unknown admin call ${key}.` } };
  }
}
