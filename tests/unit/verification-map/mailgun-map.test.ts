import { describe, expect, it } from "vitest";
import { fromMailgun, reasonList, SOFT_REASONS, unknownResultValue, UNREADABLE_REASON, unreadableResult } from "@/core/verification/mailgun-map";
import { checkDecision, DEFAULT_VERIFICATION_POLICY } from "@/core/rules/eligibility";

/**
 * B12 "verification mapping and policy", the mapping half (docs/dev/M5-DESIGN.md §2.3): Mailgun's answer → the stored
 * result, row by row, plus what the default policy then decides (so the mapping and the policy agree, D8).
 */

const NORM = "anna@firma.de";

function body(result: unknown, risk: unknown, extra: Record<string, unknown> = {}) {
  return { address: "anna@firma.de", is_disposable_address: false, is_role_address: false, reason: [], result, risk, ...extra };
}

function mapped(b: unknown) {
  const r = fromMailgun(b, { emailNorm: NORM });
  if (r === "unreadable") throw new Error("expected a readable answer");
  return r;
}

describe("fromMailgun: the §2.3 table", () => {
  const rows: Array<[string, string | undefined, string, string, string]> = [
    // result, risk, → status, → risk, default policy decision
    ["deliverable", "low", "VALID", "LOW", "send"],
    ["deliverable", "medium", "VALID", "MEDIUM", "send"],
    ["deliverable", "unknown", "VALID", "UNKNOWN", "send"],
    ["deliverable", undefined, "VALID", "UNKNOWN", "send"],
    ["deliverable", "high", "RISKY", "HIGH", "block"],
    ["catch_all", "low", "CATCH_ALL", "LOW", "send"],
    ["catch_all", "medium", "CATCH_ALL", "MEDIUM", "block"],
    ["catch_all", "high", "CATCH_ALL", "HIGH", "block"],
    ["catch_all", "unknown", "CATCH_ALL", "UNKNOWN", "block"],
    ["unknown", "unknown", "UNKNOWN", "UNKNOWN", "recheck"],
    ["unknown", "high", "UNKNOWN", "HIGH", "recheck"],
    ["undeliverable", "high", "INVALID", "HIGH", "undeliverable"],
    ["do_not_send", "high", "DO_NOT_SEND", "HIGH", "do-not-send"],
    ["do_not_send", "low", "DO_NOT_SEND", "LOW", "do-not-send"],
  ];
  it.each(rows)("%s / %s → %s / %s (default policy: %s)", (result, risk, status, outRisk, decision) => {
    const r = mapped(body(result, risk));
    expect(r.status).toBe(status);
    expect(r.risk).toBe(outRisk);
    expect(checkDecision(r.status, r.risk, DEFAULT_VERIFICATION_POLICY, { disposable: r.isDisposable })).toBe(decision);
  });

  it("deliverable + medium is sendable (VALID/MEDIUM, never RISKY: code map §0.4)", () => {
    expect(mapped(body("deliverable", "medium"))).toMatchObject({ status: "VALID", risk: "MEDIUM" });
  });

  it("undeliverable with only soft reasons is UNKNOWN (no suppression); with a hard one it is INVALID", () => {
    expect(SOFT_REASONS).toEqual(["mailbox_quota_exceeded", "smtp_error", "smtp_timeout"]);
    expect(mapped(body("undeliverable", "medium", { reason: ["mailbox_quota_exceeded"] })).status).toBe("UNKNOWN");
    expect(mapped(body("undeliverable", "high", { reason: ["smtp_error", "smtp_timeout"] })).status).toBe("UNKNOWN");
    expect(mapped(body("undeliverable", "high", { reason: "smtp_timeout" })).status).toBe("UNKNOWN");
    expect(mapped(body("undeliverable", "high", { reason: ["mailbox_does_not_exist"] })).status).toBe("INVALID");
    expect(mapped(body("undeliverable", "high", { reason: ["mailbox_quota_exceeded", "mailbox_does_not_exist"] })).status).toBe("INVALID");
    // No reasons at all: not proof of anything soft.
    expect(mapped(body("undeliverable", "high", { reason: [] })).status).toBe("INVALID");
    expect(mapped(body("undeliverable", "high", { reason: null })).status).toBe("INVALID");
  });

  it("reads the flags; a role address is only a flag (never blocks)", () => {
    const role = mapped(body("deliverable", "low", { is_role_address: true }));
    expect(role).toMatchObject({ isRole: true, isDisposable: false, status: "VALID" });
    expect(checkDecision(role.status, role.risk, DEFAULT_VERIFICATION_POLICY, { disposable: role.isDisposable })).toBe("send");
    const temp = mapped(body("deliverable", "low", { is_disposable_address: true, reason: ["mailbox_is_disposable_address"] }));
    expect(temp).toMatchObject({ status: "VALID", isDisposable: true });
    // A throwaway address is blocked by the default policy (D7), whatever its verdict.
    expect(checkDecision(temp.status, temp.risk, DEFAULT_VERIFICATION_POLICY, { disposable: true })).toBe("block");
    // Only `true` counts.
    expect(mapped(body("deliverable", "low", { is_role_address: "true", is_disposable_address: 1 }))).toMatchObject({ isRole: false, isDisposable: false });
  });

  it("keeps the reasons as received: an array, a bare string, null or missing", () => {
    expect(mapped(body("unknown", "unknown", { reason: ["smtp_timeout", "failed custom grammar check", 7, ""] })).reasons).toEqual([
      "smtp_timeout",
      "failed custom grammar check",
    ]);
    expect(mapped(body("undeliverable", "high", { reason: "No MX host found" })).reasons).toEqual(["No MX host found"]);
    expect(mapped(body("deliverable", "low", { reason: null })).reasons).toEqual([]);
    const noReason: Record<string, unknown> = body("deliverable", "low");
    delete noReason.reason;
    expect(mapped(noReason).reasons).toEqual([]);
    expect(reasonList(undefined)).toEqual([]);
  });

  it("offers did_you_mean only when it differs from OUR stored address (not just in case)", () => {
    expect(mapped(body("undeliverable", "high", { did_you_mean: "anna@yahoo.test" })).didYouMean).toBe("anna@yahoo.test");
    expect(mapped(body("deliverable", "low", { did_you_mean: "anna@firma.de" })).didYouMean).toBeNull();
    expect(mapped(body("deliverable", "low", { did_you_mean: "Anna@FIRMA.de" })).didYouMean).toBeNull();
    expect(mapped(body("deliverable", "low", { did_you_mean: "  " })).didYouMean).toBeNull();
    expect(mapped(body("deliverable", "low", { did_you_mean: null })).didYouMean).toBeNull();
    expect(mapped(body("deliverable", "low", {})).didYouMean).toBeNull();
    // Mailgun's echoed address differs in case from ours: a suggestion equal to OUR address is still no suggestion.
    expect(mapped({ ...body("deliverable", "low"), address: "ANNA@firma.de", did_you_mean: "anna@firma.de" }).didYouMean).toBeNull();
  });

  it("keeps the whole answer in raw", () => {
    const b = body("deliverable", "low", { engagement: { engaging: false, is_bot: false }, root_address: "anna@firma.de", last_seen: 1790000000 });
    expect(mapped(b).raw).toEqual(b);
  });

  it("accepts the values in any case and with spaces", () => {
    expect(mapped(body(" Deliverable ", "HIGH"))).toMatchObject({ status: "RISKY", risk: "HIGH" });
  });
});

describe("fromMailgun: answers it can't read", () => {
  it("a result it doesn't know ('weird…' → 'maybe') is unreadable", () => {
    expect(fromMailgun(body("maybe", "odd"), { emailNorm: NORM })).toBe("unreadable");
    expect(unknownResultValue(body("maybe", "odd"))).toBe("maybe");
    expect(unknownResultValue(body("deliverable", "low"))).toBeNull();
  });

  it("the v3-shaped body (no result) and a result that isn't a string are unreadable", () => {
    const v3 = { address: NORM, is_valid: true, mailbox_verification: "true", parts: { display_name: null, domain: "firma.de", local_part: "anna" }, reason: null };
    expect(fromMailgun(v3, { emailNorm: NORM })).toBe("unreadable");
    expect(fromMailgun(body(1, "low"), { emailNorm: NORM })).toBe("unreadable");
    expect(fromMailgun(null, { emailNorm: NORM })).toBe("unreadable");
    expect(fromMailgun("deliverable", { emailNorm: NORM })).toBe("unreadable");
    expect(fromMailgun([body("deliverable", "low")], { emailNorm: NORM })).toBe("unreadable");
    expect(unknownResultValue(v3)).toBeNull();
  });

  it("an unreadable answer is stored as UNKNOWN with app:unreadable_response and the raw body", () => {
    const raw = { odd: true };
    expect(unreadableResult(raw)).toEqual({
      status: "UNKNOWN",
      risk: "UNKNOWN",
      isRole: false,
      isDisposable: false,
      didYouMean: null,
      reasons: [UNREADABLE_REASON],
      raw,
    });
    expect(UNREADABLE_REASON).toBe("app:unreadable_response");
    expect(unreadableResult(undefined).raw).toBeNull();
  });
});
