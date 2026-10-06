/**
 * The deterministic answers of the fake address checks (docs/dev/M5-DESIGN.md §7.1, research
 * verification-reference.md §11.2): shared by the fake Mailgun server's `GET /v4/address/validate` (tests/fake-mailgun)
 * and the in-process test checker (the practice copy and unit tests), so both answer the same address the same way.
 * Pure, no imports (the fake server's command line loads it through tsx without path aliases).
 *
 * Rule order: (an override, handled by the fake server) → the domain → the local part → `deliverable` / `low`.
 * Matching is case-insensitive; the answer echoes the address as given. Every 200 carries
 * `engagement: {engaging: false, is_bot: false}` (the fake's switches can change that), `reason` defaults to `[]`, and
 * `did_you_mean` is absent unless a rule sets it.
 *
 * | Address                                  | Answer                                                              |
 * |------------------------------------------|---------------------------------------------------------------------|
 * | missing or empty                         | 400 `'address' parameter is required`                               |
 * | longer than 512 characters               | 400 `address exceeds 512 characters`                                 |
 * | `providerLookup: false`                  | unknown / unknown, `no_data` (every address)                         |
 * | no `@`                                   | undeliverable / high, `malformed_address`                            |
 * | domain `nomx.test`                       | undeliverable / high, `no_mx`                                        |
 * | domain `yaho.test`                       | undeliverable / high, `no_mx`, did_you_mean `<local>@yahoo.test`     |
 * | domain `catchall-low/medium/high.test`   | catch_all / low, medium, high, `catch_all`                           |
 * | domain `disposable.test`                 | do_not_send / high, disposable, `mailbox_is_disposable_address`      |
 * | domain `greylist.test`                   | first answer unknown / unknown `smtp_timeout`; later deliverable/low |
 * | domain `timeout.test`                    | always unknown / unknown, `smtp_timeout`                             |
 * | local part `bad…`                        | undeliverable / high, `mailbox_does_not_exist`                       |
 * | local part `dns…`                        | do_not_send / high, `high_risk_domain`                               |
 * | local part `risky…`                      | deliverable / high, `immature_domain`                                |
 * | local part `medium…`                     | deliverable / medium                                                 |
 * | local part `weird…`                      | result "maybe", risk "odd" (an answer we don't know)                 |
 * | local part `v3shape…`                    | the v3-shaped body without `result` (unreadable)                     |
 * | local part `slow…`                       | deliverable / low, after the fake's `validateSlowMs`                 |
 * | local part `boom…`                       | 500 `Internal Server Error`                                          |
 * | local part `temp…` (ours)                | deliverable / low but disposable, `mailbox_is_disposable_address`    |
 * | local part `full…` (ours)                | undeliverable / medium, `mailbox_quota_exceeded` (soft)              |
 * | a role local part (info, post, …)        | the address's own answer + `is_role_address: true`                   |
 * | a `+tag`                                 | the address's own answer + `root_address` without the tag           |
 * | anything else                            | deliverable / low                                                    |
 */

/** Mailgun's documented maximum length of `address`. */
export const FAKE_VALIDATE_MAX_LENGTH = 512;

/** Local parts the fake treats as role addresses (research §11.2). */
export const FAKE_ROLE_LOCAL_PARTS: readonly string[] = [
  "info",
  "post",
  "kontakt",
  "firmapost",
  "sales",
  "support",
  "admin",
  "contact",
  "hello",
  "office",
];

export type FakeValidationAnswer = { status: number; body: unknown };

type Outcome = {
  result: string;
  risk: string;
  reason?: string[];
  disposable?: boolean;
  didYouMean?: string;
};

function splitAddress(address: string): { local: string; domain: string } | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/** True for a `slow…` address: the fake server answers it after its `validateSlowMs` switch. */
export function isSlowAddress(address: string): boolean {
  const parts = splitAddress(address.trim().toLowerCase());
  return parts !== null && parts.local.startsWith("slow");
}

function domainOutcome(domain: string, local: string, callsSoFar: number): Outcome | null {
  switch (domain) {
    case "nomx.test":
      return { result: "undeliverable", risk: "high", reason: ["no_mx"] };
    case "yaho.test":
      return { result: "undeliverable", risk: "high", reason: ["no_mx"], didYouMean: `${local}@yahoo.test` };
    case "catchall-low.test":
      return { result: "catch_all", risk: "low", reason: ["catch_all"] };
    case "catchall-medium.test":
      return { result: "catch_all", risk: "medium", reason: ["catch_all"] };
    case "catchall-high.test":
      return { result: "catch_all", risk: "high", reason: ["catch_all"] };
    case "disposable.test":
      return { result: "do_not_send", risk: "high", reason: ["mailbox_is_disposable_address"], disposable: true };
    case "greylist.test":
      return callsSoFar === 0 ? { result: "unknown", risk: "unknown", reason: ["smtp_timeout"] } : { result: "deliverable", risk: "low" };
    case "timeout.test":
      return { result: "unknown", risk: "unknown", reason: ["smtp_timeout"] };
    default:
      return null;
  }
}

function localOutcome(local: string): Outcome | "boom" | "v3shape" | null {
  if (local.startsWith("bad")) return { result: "undeliverable", risk: "high", reason: ["mailbox_does_not_exist"] };
  if (local.startsWith("dns")) return { result: "do_not_send", risk: "high", reason: ["high_risk_domain"] };
  if (local.startsWith("risky")) return { result: "deliverable", risk: "high", reason: ["immature_domain"] };
  if (local.startsWith("medium")) return { result: "deliverable", risk: "medium" };
  if (local.startsWith("weird")) return { result: "maybe", risk: "odd" };
  if (local.startsWith("v3shape")) return "v3shape";
  if (local.startsWith("boom")) return "boom";
  if (local.startsWith("temp")) return { result: "deliverable", risk: "low", reason: ["mailbox_is_disposable_address"], disposable: true };
  if (local.startsWith("full")) return { result: "undeliverable", risk: "medium", reason: ["mailbox_quota_exceeded"] };
  // `slow…` answers like the default; the fake server adds the delay.
  return null;
}

function body(address: string, o: Outcome, extra: { role: boolean; rootAddress: string | null }): Record<string, unknown> {
  return {
    address,
    ...(o.didYouMean !== undefined ? { did_you_mean: o.didYouMean } : {}),
    engagement: { engaging: false, is_bot: false },
    is_disposable_address: o.disposable === true,
    is_role_address: extra.role,
    reason: o.reason ?? [],
    result: o.result,
    risk: o.risk,
    ...(extra.rootAddress !== null ? { root_address: extra.rootAddress } : {}),
  };
}

/**
 * The fake's answer to validating `address`. `callsSoFar`: how many answers this address already got (the greylist
 * rule); `providerLookup: false` answers unknown / `no_data` for every address, so a test can prove the app always sends
 * `provider_lookup=true`.
 */
export function fakeValidationBody(address: string, opts: { callsSoFar?: number; providerLookup?: boolean } = {}): FakeValidationAnswer {
  const given = typeof address === "string" ? address.trim() : "";
  if (!given) return { status: 400, body: { message: "'address' parameter is required" } };
  if (given.length > FAKE_VALIDATE_MAX_LENGTH) return { status: 400, body: { message: "address exceeds 512 characters" } };
  if (opts.providerLookup === false) {
    return { status: 200, body: body(given, { result: "unknown", risk: "unknown", reason: ["no_data"] }, { role: false, rootAddress: null }) };
  }
  const parts = splitAddress(given);
  if (!parts || !parts.local || !parts.domain) {
    return { status: 200, body: body(given, { result: "undeliverable", risk: "high", reason: ["malformed_address"] }, { role: false, rootAddress: null }) };
  }
  const local = parts.local.toLowerCase();
  const domain = parts.domain.toLowerCase();
  const plus = parts.local.indexOf("+");
  const baseLocal = (plus >= 0 ? local.slice(0, plus) : local).trim();
  const extra = {
    role: FAKE_ROLE_LOCAL_PARTS.includes(baseLocal),
    rootAddress: plus >= 0 ? `${parts.local.slice(0, plus)}@${parts.domain}` : null,
  };

  const byDomain = domainOutcome(domain, parts.local, Math.max(0, Math.floor(opts.callsSoFar ?? 0)));
  if (byDomain) return { status: 200, body: body(given, byDomain, extra) };

  const byLocal = localOutcome(local);
  if (byLocal === "boom") return { status: 500, body: { message: "Internal Server Error" } };
  if (byLocal === "v3shape") {
    return {
      status: 200,
      body: {
        address: given,
        did_you_mean: null,
        is_disposable_address: false,
        is_role_address: extra.role,
        is_valid: true,
        mailbox_verification: "true",
        parts: { display_name: null, domain: parts.domain, local_part: parts.local },
        reason: null,
      },
    };
  }
  if (byLocal) return { status: 200, body: body(given, byLocal, extra) };
  return { status: 200, body: body(given, { result: "deliverable", risk: "low" }, extra) };
}
