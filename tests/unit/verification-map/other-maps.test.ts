import { describe, expect, it } from "vitest";
import { fromNeverBounce, fromZeroBounce } from "@/core/verification/other-maps";

/** ZeroBounce and NeverBounce mappings (research verification-reference §9–§10): written now, no adapter yet (§1.5). */

describe("fromZeroBounce (research §9)", () => {
  const zb = (status: string, sub_status = "", extra: Record<string, unknown> = {}) => ({
    address: "anna@firma.de",
    status,
    sub_status,
    free_email: false,
    did_you_mean: null,
    ...extra,
  });

  const rows: Array<[string, string, string, string, { isRole?: boolean; isDisposable?: boolean }]> = [
    ["valid", "", "VALID", "LOW", {}],
    ["valid", "alias_address", "VALID", "LOW", {}],
    ["valid", "gold", "VALID", "LOW", {}],
    ["valid", "accept_all", "CATCH_ALL", "LOW", {}],
    ["valid", "role_based_accept_all", "CATCH_ALL", "LOW", { isRole: true }],
    ["catch-all", "", "CATCH_ALL", "UNKNOWN", {}],
    ["unknown", "greylisted", "UNKNOWN", "UNKNOWN", {}],
    ["unknown", "timeout_exceeded", "UNKNOWN", "UNKNOWN", {}],
    ["invalid", "mailbox_not_found", "INVALID", "HIGH", {}],
    ["invalid", "possible_typo", "INVALID", "HIGH", {}],
    ["do_not_mail", "role_based", "VALID", "MEDIUM", { isRole: true }],
    ["do_not_mail", "role_based_catch_all", "CATCH_ALL", "UNKNOWN", { isRole: true }],
    ["do_not_mail", "disposable", "DO_NOT_SEND", "HIGH", { isDisposable: true }],
    ["do_not_mail", "mx_forward", "RISKY", "HIGH", {}],
    ["do_not_mail", "toxic", "DO_NOT_SEND", "HIGH", {}],
    ["do_not_mail", "global_suppression", "DO_NOT_SEND", "HIGH", {}],
    ["do_not_mail", "possible_trap", "DO_NOT_SEND", "HIGH", {}],
    ["spamtrap", "", "DO_NOT_SEND", "HIGH", {}],
    ["abuse", "", "DO_NOT_SEND", "HIGH", {}],
  ];
  it.each(rows)("%s + %s → %s / %s", (status, sub, outStatus, risk, flags) => {
    const r = fromZeroBounce(zb(status, sub));
    expect(r).not.toBe("unreadable");
    expect(r).toMatchObject({
      status: outStatus,
      risk,
      isRole: flags.isRole === true,
      isDisposable: flags.isDisposable === true,
      reasons: sub ? [sub] : [],
    });
  });

  it("reads did_you_mean unless it is the address itself", () => {
    expect(fromZeroBounce(zb("invalid", "possible_typo", { did_you_mean: "anna@firma.com" }))).toMatchObject({ didYouMean: "anna@firma.com" });
    expect(fromZeroBounce(zb("valid", "", { did_you_mean: "ANNA@firma.de" }))).toMatchObject({ didYouMean: null });
  });

  it("an error body, a missing status or a status it doesn't know is unreadable", () => {
    expect(fromZeroBounce({ error: "Invalid API Key or your account ran out of credits" })).toBe("unreadable");
    expect(fromZeroBounce(zb("catch_all"))).toBe("unreadable");
    expect(fromZeroBounce(zb("perhaps"))).toBe("unreadable");
    expect(fromZeroBounce(null)).toBe("unreadable");
  });
});

describe("fromNeverBounce (research §10)", () => {
  const nb = (result: string, flags: string[] = [], extra: Record<string, unknown> = {}) => ({
    status: "success",
    result,
    flags,
    suggested_correction: "",
    execution_time: 285,
    ...extra,
  });

  const rows: Array<[string, string[], string, string, { isRole?: boolean; isDisposable?: boolean }]> = [
    ["valid", ["has_dns", "has_dns_mx"], "VALID", "LOW", {}],
    ["valid", ["role_account"], "VALID", "LOW", { isRole: true }],
    ["invalid", ["bad_syntax"], "INVALID", "HIGH", {}],
    ["disposable", ["disposable_email"], "DO_NOT_SEND", "HIGH", { isDisposable: true }],
    ["catchall", ["has_dns"], "CATCH_ALL", "UNKNOWN", {}],
    ["catchall", ["role_account"], "CATCH_ALL", "UNKNOWN", { isRole: true }],
    ["unknown", [], "UNKNOWN", "UNKNOWN", {}],
  ];
  it.each(rows)("%s %j → %s / %s", (result, flags, status, risk, f) => {
    expect(fromNeverBounce(nb(result, flags))).toMatchObject({
      status,
      risk,
      isRole: f.isRole === true,
      isDisposable: f.isDisposable === true,
      reasons: flags,
    });
  });

  it("reads suggested_correction", () => {
    expect(fromNeverBounce(nb("invalid", [], { suggested_correction: "anna@gmail.com" }))).toMatchObject({ didYouMean: "anna@gmail.com" });
    expect(fromNeverBounce(nb("valid"))).toMatchObject({ didYouMean: null });
  });

  it("errors inside HTTP 200 and results it doesn't know are unreadable", () => {
    expect(fromNeverBounce({ status: "auth_failure", message: "Invalid API key" })).toBe("unreadable");
    expect(fromNeverBounce({ status: "throttle_triggered", message: "Too many requests" })).toBe("unreadable");
    expect(fromNeverBounce(nb("catch_all"))).toBe("unreadable");
    expect(fromNeverBounce({ result: "valid", flags: [] })).toBe("unreadable");
  });
});
