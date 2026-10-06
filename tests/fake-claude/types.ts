/** Shapes of the fake Claude server (M5-DESIGN §7.2), shared by the server, its admin API and the CLI. */

export type FakeClaudeOptions = {
  /** 0 or missing = any free port. */
  port?: number;
  /** Fixture sites (tests/fixtures/sites): a site's claude.json answers for its homepage. Null = none. */
  sitesDir?: string | null;
  now?: () => Date;
  /** Usage reported on every answer (default 3,000 input / 120 output tokens). */
  usage?: { input: number; output: number };
};

export type ClaudeFault =
  /** Answer with this status, body and headers (401, 403, 404 model, 429 ± retry-after, 400 limits, 402, 500, 529, 302…). */
  | { kind: "status"; status: number; body: object; headers?: Record<string, string> }
  /** A normal answer that stopped early: `max_tokens` (the JSON cut in half) or `refusal`. */
  | { kind: "stop"; stopReason: "max_tokens" | "refusal" }
  /** An empty thinking block before the text block (Sonnet 5). */
  | { kind: "thinkingFirst" }
  /** This answer instead of the usual one (a string is sent as the text as it is: bad JSON). */
  | { kind: "answer"; answer: object | string }
  /** Never answer (the client's timeout fires). */
  | { kind: "hang" }
  /** Answer normally after `ms` milliseconds. */
  | { kind: "delay"; ms: number }
  /**
   * Send the answer's status and headers (request-id included) and half its body, then drop the connection, or with
   * `stall` never send the rest (the client's timeout fires during the body). The request was answered: it may be billed.
   */
  | { kind: "cutBody"; stall?: boolean };

export type FakeClaudeRoute = "POST /v1/messages" | "POST /v1/messages/count_tokens" | "GET /v1/models/:id";
export const FAKE_CLAUDE_ROUTES: readonly FakeClaudeRoute[] = [
  "POST /v1/messages",
  "POST /v1/messages/count_tokens",
  "GET /v1/models/:id",
];

/** One API request as the fake saw it (admin calls excluded); x-api-key and authorization show as "[hidden]". */
export type FakeClaudeRequest = {
  method: string;
  path: string;
  // Parsed JSON bodies are read freely in tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, string>;
  at: string;
};

export interface FakeClaude {
  /** "http://127.0.0.1:<port>". */
  readonly origin: string;
  /** Every API request, oldest first. */
  readonly requests: FakeClaudeRequest[];
  /** The next `times` requests to `route` get `fault`. */
  failNext(route: FakeClaudeRoute, fault: ClaudeFault, times?: number): void;
  /** Answers every messages request whose user text matches with `answer` (first registered match wins). */
  script(match: (userText: string) => boolean, answer: object | string): void;
  setUsage(u: { input: number; output: number }): void;
  /** Forgets requests, faults and scripts, and restores the starting usage. */
  reset(): void;
  close(): Promise<void>;
}

/** The test key the fake accepts (any key starting with sk-ant-fake- works). */
export const FAKE_CLAUDE_KEY = "sk-ant-fake-key";
