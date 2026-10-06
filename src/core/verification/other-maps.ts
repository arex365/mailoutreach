/**
 * ZeroBounce and NeverBounce answers mapped to our words (docs/dev/research/verification-reference.md §9–§10). Only
 * the mappings exist in Milestone 5: there is no adapter for either provider and Settings offers Mailgun only
 * (docs/dev/M5-DESIGN.md §1.5, §2.2). Written and tested now so a later adapter plugs in behind the same `Verifier`.
 * Browser-safe and pure.
 *
 * Provider label trap: Mailgun says `catch_all`, ZeroBounce `catch-all`, NeverBounce `catchall`. Neither of these two
 * grades the risk of a catch-all, so it maps to CATCH_ALL / UNKNOWN, which the default policy blocks.
 */
import { reasonList } from "./mailgun-map";
import type { CheckResult, RiskValue, VerificationStatusValue } from "./types";

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function lower(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** A suggestion that is a non-empty string and not the address itself (case ignored), else null. */
function suggestionOf(v: unknown, address: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  return typeof address === "string" && address.trim().toLowerCase() === s.toLowerCase() ? null : s;
}

type Mapped = { status: VerificationStatusValue; risk: RiskValue; isRole?: boolean; isDisposable?: boolean };

/** ZeroBounce `do_not_mail` sub-statuses (research §9); anything else under `do_not_mail` is treated like `toxic`. */
function zeroBounceDoNotMail(sub: string): Mapped {
  switch (sub) {
    case "role_based":
      // A role address is a General inbox person: sendable, never blocked for being a role (B6.9).
      return { status: "VALID", risk: "MEDIUM", isRole: true };
    case "role_based_catch_all":
      return { status: "CATCH_ALL", risk: "UNKNOWN", isRole: true };
    case "disposable":
      return { status: "DO_NOT_SEND", risk: "HIGH", isDisposable: true };
    case "mx_forward":
      // Blocked by the policy (deliverable, high risk) but never suppressed.
      return { status: "RISKY", risk: "HIGH" };
    default:
      // toxic, global_suppression, possible_trap and any sub-status we don't know.
      return { status: "DO_NOT_SEND", risk: "HIGH" };
  }
}

/**
 * ZeroBounce `GET /v2/validate` body → our result, or "unreadable" (no `status`, an `{error}` body, or a status we
 * don't know). `reasons` = `[sub_status]` when there is one; `didYouMean` = `did_you_mean`.
 *
 * | status / sub_status                        | → status / risk     | flags        |
 * |--------------------------------------------|---------------------|--------------|
 * | valid (+ any other sub_status)             | VALID / LOW         |              |
 * | valid + accept_all                         | CATCH_ALL / LOW     |              |
 * | valid + role_based_accept_all              | CATCH_ALL / LOW     | isRole       |
 * | catch-all                                  | CATCH_ALL / UNKNOWN |              |
 * | unknown                                    | UNKNOWN / UNKNOWN   |              |
 * | invalid                                    | INVALID / HIGH      |              |
 * | do_not_mail + role_based                   | VALID / MEDIUM      | isRole       |
 * | do_not_mail + role_based_catch_all         | CATCH_ALL / UNKNOWN | isRole       |
 * | do_not_mail + disposable                   | DO_NOT_SEND / HIGH  | isDisposable |
 * | do_not_mail + mx_forward                   | RISKY / HIGH        |              |
 * | do_not_mail + toxic, global_suppression, … | DO_NOT_SEND / HIGH  |              |
 * | spamtrap, abuse                            | DO_NOT_SEND / HIGH  |              |
 */
export function fromZeroBounce(body: unknown): CheckResult | "unreadable" {
  if (!isObject(body) || typeof body.status !== "string") return "unreadable";
  const status = lower(body.status);
  const sub = lower(body.sub_status);
  let mapped: Mapped;
  switch (status) {
    case "valid":
      mapped =
        sub === "accept_all"
          ? { status: "CATCH_ALL", risk: "LOW" }
          : sub === "role_based_accept_all"
            ? { status: "CATCH_ALL", risk: "LOW", isRole: true }
            : { status: "VALID", risk: "LOW" };
      break;
    case "catch-all":
      mapped = { status: "CATCH_ALL", risk: "UNKNOWN" };
      break;
    case "unknown":
      mapped = { status: "UNKNOWN", risk: "UNKNOWN" };
      break;
    case "invalid":
      mapped = { status: "INVALID", risk: "HIGH" };
      break;
    case "do_not_mail":
      mapped = zeroBounceDoNotMail(sub);
      break;
    case "spamtrap":
    case "abuse":
      mapped = { status: "DO_NOT_SEND", risk: "HIGH" };
      break;
    default:
      return "unreadable";
  }
  const rawSub = typeof body.sub_status === "string" ? body.sub_status.trim() : "";
  return {
    status: mapped.status,
    risk: mapped.risk,
    isRole: mapped.isRole === true,
    isDisposable: mapped.isDisposable === true,
    didYouMean: suggestionOf(body.did_you_mean, body.address),
    reasons: rawSub ? [rawSub] : [],
    raw: body,
  };
}

/**
 * NeverBounce `GET /v4.2/single/check` body → our result, or "unreadable": NeverBounce reports errors inside HTTP 200
 * with `status` other than "success" (auth_failure, throttle_triggered, …), and a `result` we don't know is unreadable
 * too. `reasons` = `flags`; `isRole` when the flags hold `role_account`; `didYouMean` = `suggested_correction`.
 *
 * | result     | → status / risk     | flags                    |
 * |------------|---------------------|--------------------------|
 * | valid      | VALID / LOW         | isRole from flags        |
 * | invalid    | INVALID / HIGH      |                          |
 * | disposable | DO_NOT_SEND / HIGH  | isDisposable             |
 * | catchall   | CATCH_ALL / UNKNOWN | isRole from flags        |
 * | unknown    | UNKNOWN / UNKNOWN   |                          |
 */
export function fromNeverBounce(body: unknown): CheckResult | "unreadable" {
  if (!isObject(body) || lower(body.status) !== "success" || typeof body.result !== "string") return "unreadable";
  const flags = reasonList(body.flags);
  const role = flags.some((f) => f.trim().toLowerCase() === "role_account");
  let mapped: Mapped;
  switch (lower(body.result)) {
    case "valid":
      mapped = { status: "VALID", risk: "LOW", isRole: role };
      break;
    case "invalid":
      mapped = { status: "INVALID", risk: "HIGH" };
      break;
    case "disposable":
      mapped = { status: "DO_NOT_SEND", risk: "HIGH", isDisposable: true };
      break;
    case "catchall":
      mapped = { status: "CATCH_ALL", risk: "UNKNOWN", isRole: role };
      break;
    case "unknown":
      mapped = { status: "UNKNOWN", risk: "UNKNOWN" };
      break;
    default:
      return "unreadable";
  }
  return {
    status: mapped.status,
    risk: mapped.risk,
    isRole: mapped.isRole === true,
    isDisposable: mapped.isDisposable === true,
    didYouMean: suggestionOf(body.suggested_correction, body.email),
    reasons: flags,
    raw: body,
  };
}
