import { fakeValidationBody } from "@/core/verification/fake-rules";
import { fromMailgun, unreadableResult } from "@/core/verification/mailgun-map";
import { TEST_CHECKER_PROVIDER } from "@/core/verification/types";
import { VERIFY_FAILURE_TEXT } from "./failures";
import type { Verifier, VerifyFailureKind, VerifyOutcome } from "./verifier";

/**
 * The in-process test checker (docs/dev/M5-DESIGN.md §2.2, D19): the practice copy's checker and the unit tests'. No
 * network at all: it answers with the fake Mailgun server's own deterministic rules (`fakeValidationBody`, §7.1)
 * mapped by `fromMailgun`, after 1–5 ms, for $0. Its results are stored with provider "fake", which never counts for
 * TEST/LIVE sending ("Only checked by the test checker").
 */

/** A scripted answer for the next call, taken before the address rules (like the fake server's `failNext`). */
export type FakeVerifierFault =
  | { kind: VerifyFailureKind; timedOut?: boolean; retryAfterMs?: number | null; detail?: string | null }
  /** A 200 whose body can't be read (stored as "couldn't be read", charged, the person left alone). */
  | { kind: "unreadable"; body?: unknown };

export type FakeVerifierOptions = {
  /** Answers for the next calls, in order, before the address rules. */
  faults?: readonly FakeVerifierFault[];
  /** How long one check takes, in ms (default a random 1–5 ms). */
  delayMs?: () => number;
};

export type FakeVerifier = Verifier & {
  /** Queues `fault` for the next `times` calls (default 1). */
  failNext(fault: FakeVerifierFault, times?: number): void;
  /** Every address checked so far, in order, as given (scripted faults included). */
  readonly calls: readonly string[];
  /** Answers (200s) per address, lowercase: what the greylist rule counts. */
  readonly answers: ReadonlyMap<string, number>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function messageOf(body: unknown): string | null {
  const m = body && typeof body === "object" ? (body as { message?: unknown }).message : undefined;
  return typeof m === "string" && m ? m : null;
}

/** A new test checker with its own greylist memory and fault queue. */
export function createFakeVerifier(opts: FakeVerifierOptions = {}): FakeVerifier {
  const queue: FakeVerifierFault[] = [...(opts.faults ?? [])];
  const calls: string[] = [];
  const answers = new Map<string, number>();
  const delayMs = opts.delayMs ?? (() => 1 + Math.floor(Math.random() * 5));

  return {
    provider: TEST_CHECKER_PROVIDER,
    pricePerCheck: 0,
    calls,
    answers,
    failNext(fault: FakeVerifierFault, times = 1): void {
      for (let i = 0; i < Math.max(1, Math.floor(times)); i++) queue.push(fault);
    },
    async check(email: string, emailNorm: string): Promise<VerifyOutcome> {
      const started = Date.now();
      calls.push(email);
      await sleep(delayMs());
      const ms = () => Math.max(0, Date.now() - started);

      const fault = queue.shift();
      if (fault?.kind === "unreadable") {
        return { ok: true, result: unreadableResult(fault.body ?? { answer: "unreadable" }), unreadable: true, ms: ms() };
      }
      if (fault) {
        return {
          ok: false,
          kind: fault.kind,
          retryAfterMs: fault.kind === "rate-limited" ? (fault.retryAfterMs ?? null) : null,
          timedOut: fault.timedOut === true,
          message: VERIFY_FAILURE_TEXT[fault.kind],
          detail: fault.detail ?? null,
        };
      }

      const key = email.trim().toLowerCase();
      const answer = fakeValidationBody(email, { callsSoFar: answers.get(key) ?? 0 });
      if (answer.status !== 200) {
        const kind: VerifyFailureKind = answer.status === 400 ? "rejected" : "transient";
        return { ok: false, kind, retryAfterMs: null, timedOut: false, message: VERIFY_FAILURE_TEXT[kind], detail: messageOf(answer.body) };
      }
      answers.set(key, (answers.get(key) ?? 0) + 1);
      const mapped = fromMailgun(answer.body, { emailNorm });
      if (mapped === "unreadable") return { ok: true, result: unreadableResult(answer.body), unreadable: true, ms: ms() };
      return { ok: true, result: mapped, unreadable: false, ms: ms() };
    },
  };
}

let practice: FakeVerifier | null = null;

/** The practice copy's test checker: one per process, so its greylist memory lasts as long as the process. */
export function practiceChecker(): FakeVerifier {
  practice ??= createFakeVerifier();
  return practice;
}
