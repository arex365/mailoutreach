import { describe, expect, it } from "vitest";
import { fakeValidationBody, FAKE_ROLE_LOCAL_PARTS, isSlowAddress } from "@/core/verification/fake-rules";
import { fromMailgun } from "@/core/verification/mailgun-map";
import { createFakeVerifier } from "@/server/verification/fake-verifier";

/**
 * The fake's deterministic answers (M5-DESIGN §7.1, research §11.2), shared by the fake Mailgun server and the
 * in-process test checker, and what they map to.
 */

function ok(address: string, opts: { callsSoFar?: number; providerLookup?: boolean } = {}) {
  const a = fakeValidationBody(address, opts);
  expect(a.status).toBe(200);
  return a.body as Record<string, unknown>;
}

describe("fakeValidationBody", () => {
  const rows: Array<[string, string, string, string[]]> = [
    ["x@nomx.test", "undeliverable", "high", ["no_mx"]],
    ["x@yaho.test", "undeliverable", "high", ["no_mx"]],
    ["x@catchall-low.test", "catch_all", "low", ["catch_all"]],
    ["x@catchall-medium.test", "catch_all", "medium", ["catch_all"]],
    ["x@catchall-high.test", "catch_all", "high", ["catch_all"]],
    ["x@disposable.test", "do_not_send", "high", ["mailbox_is_disposable_address"]],
    ["t@timeout.test", "unknown", "unknown", ["smtp_timeout"]],
    ["bad1@valid.test", "undeliverable", "high", ["mailbox_does_not_exist"]],
    ["dns1@valid.test", "do_not_send", "high", ["high_risk_domain"]],
    ["risky1@valid.test", "deliverable", "high", ["immature_domain"]],
    ["medium1@valid.test", "deliverable", "medium", []],
    ["weird1@valid.test", "maybe", "odd", []],
    ["slow1@valid.test", "deliverable", "low", []],
    ["temp1@valid.test", "deliverable", "low", ["mailbox_is_disposable_address"]],
    ["full1@valid.test", "undeliverable", "medium", ["mailbox_quota_exceeded"]],
    ["anna@valid.test", "deliverable", "low", []],
    ["noatsign", "undeliverable", "high", ["malformed_address"]],
  ];
  it.each(rows)("%s → %s / %s %j", (address, result, risk, reason) => {
    const b = ok(address);
    expect(b).toMatchObject({ address, result, risk, reason });
    expect(b.engagement).toEqual({ engaging: false, is_bot: false });
  });

  it("the domain rule wins over the local part; matching ignores case; the address is echoed as given", () => {
    expect(ok("bad@catchall-low.test")).toMatchObject({ result: "catch_all", risk: "low" });
    expect(ok("BAD1@Valid.Test")).toMatchObject({ address: "BAD1@Valid.Test", result: "undeliverable" });
  });

  it("flags: disposable, did_you_mean, role addresses and +tags", () => {
    expect(ok("x@disposable.test").is_disposable_address).toBe(true);
    expect(ok("temp1@valid.test").is_disposable_address).toBe(true);
    expect(ok("anna@yaho.test").did_you_mean).toBe("anna@yahoo.test");
    expect("did_you_mean" in ok("anna@valid.test")).toBe(false);
    for (const local of FAKE_ROLE_LOCAL_PARTS) expect(ok(`${local}@role.test`)).toMatchObject({ is_role_address: true, result: "deliverable" });
    expect(ok("info@catchall-medium.test")).toMatchObject({ is_role_address: true, result: "catch_all", risk: "medium" });
    expect(ok("anna@role.test").is_role_address).toBe(false);
    expect(ok("anna+cv@valid.test")).toMatchObject({ result: "deliverable", root_address: "anna@valid.test" });
    expect(ok("info+x@valid.test")).toMatchObject({ is_role_address: true, root_address: "info@valid.test" });
  });

  it("greylist: the first answer is unknown, every later one deliverable", () => {
    expect(ok("g@greylist.test", { callsSoFar: 0 })).toMatchObject({ result: "unknown", reason: ["smtp_timeout"] });
    expect(ok("g@greylist.test", { callsSoFar: 1 })).toMatchObject({ result: "deliverable", risk: "low", reason: [] });
  });

  it("v3shape answers a body without result; boom answers 500", () => {
    const v3 = ok("v3shape@valid.test");
    expect("result" in v3).toBe(false);
    expect(v3).toMatchObject({ is_valid: true, mailbox_verification: "true" });
    expect(fakeValidationBody("boom@valid.test")).toEqual({ status: 500, body: { message: "Internal Server Error" } });
  });

  it("refuses a missing or too long address (400) and answers no_data without a provider lookup", () => {
    expect(fakeValidationBody("")).toEqual({ status: 400, body: { message: "'address' parameter is required" } });
    expect(fakeValidationBody("   ")).toMatchObject({ status: 400 });
    expect(fakeValidationBody(`${"a".repeat(510)}@x.test`)).toEqual({ status: 400, body: { message: "address exceeds 512 characters" } });
    expect(ok("bad1@valid.test", { providerLookup: false })).toMatchObject({ result: "unknown", risk: "unknown", reason: ["no_data"] });
  });

  it("knows which addresses are slow", () => {
    expect(isSlowAddress("slow1@valid.test")).toBe(true);
    expect(isSlowAddress("SLOW@x.test")).toBe(true);
    expect(isSlowAddress("anna@slow.test")).toBe(false);
  });

  it("maps through fromMailgun as §2.3 says (temp → throwaway, full → soft unknown, weird/v3shape → unreadable)", () => {
    const map = (address: string) => fromMailgun(ok(address), { emailNorm: address.toLowerCase() });
    expect(map("temp1@valid.test")).toMatchObject({ status: "VALID", isDisposable: true });
    expect(map("full1@valid.test")).toMatchObject({ status: "UNKNOWN", risk: "MEDIUM" });
    expect(map("bad1@valid.test")).toMatchObject({ status: "INVALID" });
    expect(map("x@disposable.test")).toMatchObject({ status: "DO_NOT_SEND", isDisposable: true });
    expect(map("weird1@valid.test")).toBe("unreadable");
    expect(map("v3shape@valid.test")).toBe("unreadable");
    expect(map("x@yaho.test")).toMatchObject({ status: "INVALID", didYouMean: "x@yahoo.test" });
  });
});

describe("the in-process test checker (createFakeVerifier)", () => {
  const fast = () => createFakeVerifier({ delayMs: () => 0 });

  it("answers with the fake's rules as provider 'fake', for $0", async () => {
    const v = fast();
    expect(v.provider).toBe("fake");
    expect(v.pricePerCheck).toBe(0);
    const res = await v.check("medium1@valid.test", "medium1@valid.test");
    expect(res).toMatchObject({ ok: true, unreadable: false, result: { status: "VALID", risk: "MEDIUM" } });
    if (res.ok) expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  it("remembers the greylist per checker", async () => {
    const v = fast();
    expect(await v.check("g@greylist.test", "g@greylist.test")).toMatchObject({ ok: true, result: { status: "UNKNOWN" } });
    expect(await v.check("G@greylist.test", "g@greylist.test")).toMatchObject({ ok: true, result: { status: "VALID" } });
    expect(v.answers.get("g@greylist.test")).toBe(2);
    expect(v.calls).toEqual(["g@greylist.test", "G@greylist.test"]);
    // Another checker starts over.
    expect(await fast().check("g@greylist.test", "g@greylist.test")).toMatchObject({ result: { status: "UNKNOWN" } });
  });

  it("maps 400 to rejected, 500 to transient, and weird answers to unreadable", async () => {
    const v = fast();
    expect(await v.check("", "")).toMatchObject({ ok: false, kind: "rejected", timedOut: false, detail: "'address' parameter is required" });
    expect(await v.check("boom@valid.test", "boom@valid.test")).toMatchObject({ ok: false, kind: "transient" });
    expect(await v.check("weird@valid.test", "weird@valid.test")).toMatchObject({
      ok: true,
      unreadable: true,
      result: { status: "UNKNOWN", reasons: ["app:unreadable_response"] },
    });
  });

  it("takes scripted faults first, in order", async () => {
    const v = createFakeVerifier({ delayMs: () => 0, faults: [{ kind: "rate-limited", retryAfterMs: 2_000 }] });
    v.failNext({ kind: "transient", timedOut: true }, 2);
    v.failNext({ kind: "unreadable" });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: false, kind: "rate-limited", retryAfterMs: 2_000 });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: false, kind: "transient", timedOut: true, retryAfterMs: null });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: false, kind: "transient", timedOut: true });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: true, unreadable: true });
    expect(await v.check("a@valid.test", "a@valid.test")).toMatchObject({ ok: true, unreadable: false, result: { status: "VALID" } });
  });
});
