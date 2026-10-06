import { describe, expect, it } from "vitest";
import {
  MAILGUN_PLAN_FACTS,
  PLAN_TEST_RESERVE,
  effectiveLogRetentionDays,
  effectiveMaxDailyCap,
  planLimits,
  planOf,
  planRoom,
} from "@/core/mailgun/plan";
import { TEAM_FROM_TEXTS, senderHeaderProblem, validateTeamFromAddress } from "@/core/sending/from-address";
import {
  OWN_MAILBOX_TEXTS,
  ownMailboxHeaders,
  ownMailboxRuleFrom,
  repliesOf,
  validateFromAddressFor,
  validateOwnMailboxFrom,
} from "@/core/sending/own-mailbox";

/**
 * The step-C helpers own-mailbox sending stands on (docs/dev/MAIN-DOMAIN-DESIGN.md §2.2, §2.3, §2.4, §2.8, §7.4, §8 P1):
 * the one flag, the own From's rules and the one dispatch every writer and reader uses, the From line without a
 * Reply-To, the sender check's own-mailbox option, and the Mailgun plan's limits.
 */

const D = "example.com";
const OWN = `contact@${D}`;

describe("repliesOf: the one flag (O1)", () => {
  it("is own-mailbox only for exactly that string; anything else is app mode (fail closed)", () => {
    expect(repliesOf("own-mailbox")).toBe("own-mailbox");
    for (const v of ["app", "Own-Mailbox", "own-mailbox ", "", 1, 0, true, null, undefined, {}, ["own-mailbox"]]) {
      expect(repliesOf(v), JSON.stringify(v)).toBe("app");
    }
  });
});

describe("validateOwnMailboxFrom (§2.2)", () => {
  const ok = (input: string, domain = D) => validateOwnMailboxFrom(input, domain);

  it("accepts an address exactly on the sending domain, lowercase; uppercase and a pasted mailto: are forgiven", () => {
    expect(ok("contact@example.com")).toEqual({ ok: true, address: OWN });
    expect(ok("  Contact@Example.COM ")).toEqual({ ok: true, address: OWN });
    expect(ok("mailto:contact@example.com")).toEqual({ ok: true, address: OWN });
    expect(ok("MAILTO: contact@example.com")).toEqual({ ok: true, address: OWN });
    expect(ok("contact@polygonparadise.com", "polygonparadise.com")).toEqual({ ok: true, address: "contact@polygonparadise.com" });
    // A trailing dot or upper case in the stored domain changes nothing.
    expect(ok("contact@example.com", "Example.com.")).toEqual({ ok: true, address: OWN });
    for (const local of ["contact", "info", "hello", "sales"]) expect(ok(`${local}@example.com`)).toEqual({ ok: true, address: `${local}@${D}` });
  });

  it("empty is allowed (nothing saved), whatever the domain", () => {
    expect(ok("")).toEqual({ ok: true, address: null });
    expect(validateOwnMailboxFrom(null, D)).toEqual({ ok: true, address: null });
    expect(validateOwnMailboxFrom("   ", null)).toEqual({ ok: true, address: null });
  });

  it("no sending domain → Connect Mailgun first", () => {
    expect(validateOwnMailboxFrom(OWN, null)).toEqual({ ok: false, error: TEAM_FROM_TEXTS.notConnected });
    expect(validateOwnMailboxFrom(OWN, "  ")).toEqual({ ok: false, error: TEAM_FROM_TEXTS.notConnected });
  });

  it("anything but exactly the sending domain → fromWrongDomain (a subdomain, another domain, free mail)", () => {
    for (const input of ["contact@mail.example.com", "contact@other.com", "contact@gmail.com", "contact@example.com.au"]) {
      expect(ok(input), input).toEqual({ ok: false, error: OWN_MAILBOX_TEXTS.fromWrongDomain(D) });
    }
    expect(OWN_MAILBOX_TEXTS.fromWrongDomain(D)).toBe("The From address must end in @example.com, your sending domain.");
  });

  it("a mail-server or no-reply name, or the route check's → reserved", () => {
    for (const local of ["noreply", "postmaster", "no-reply", "bounce", "u", "dmarc", "pp-route-check-1"]) {
      expect(ok(`${local}@example.com`), local).toEqual({ ok: false, error: TEAM_FROM_TEXTS.reserved(local, OWN) });
    }
  });

  it("not exactly one bare address → invalid", () => {
    for (const input of ['"Ali" <contact@example.com>', "Ali <contact@example.com>", "contact", "contact@example.com, info@example.com", "con tact@example.com"]) {
      expect(ok(input), input).toEqual({ ok: false, error: TEAM_FROM_TEXTS.invalid(OWN) });
    }
  });
});

describe("validateFromAddressFor: the one dispatch (§2.2)", () => {
  it("app mode gives exactly validateTeamFromAddress's answers (the shared-From table)", () => {
    const table: Array<[string, string]> = [
      ["", "send.example.com"],
      ["contact@example.com", "send.example.com"],
      ["mailto:Contact@Example.com", "send.example.com"],
      ["ali@send.example.com", "send.example.com"],
      ["contact@other.com", "send.example.com"],
      ["contact@gmail.com", "send.example.com"],
      ["noreply@example.com", "send.example.com"],
      ["Ali <contact@example.com>", "send.example.com"],
      ["contact@example.com", "example.com"],
      ["contact@example.com", ""],
    ];
    for (const [input, domain] of table) {
      expect(validateFromAddressFor(input, domain, "app"), `${input} / ${domain}`).toEqual(validateTeamFromAddress(input, domain));
    }
  });

  it("own-mailbox mode gives validateOwnMailboxFrom's", () => {
    for (const input of ["contact@example.com", "contact@mail.example.com", "", "noreply@example.com"]) {
      expect(validateFromAddressFor(input, D, "own-mailbox"), input).toEqual(validateOwnMailboxFrom(input, D));
    }
    // The same address the other way round: shared From is refused on the sending domain, own-mailbox accepts it.
    expect(validateFromAddressFor(OWN, D, "app").ok).toBe(false);
    expect(validateFromAddressFor(OWN, D, "own-mailbox")).toEqual({ ok: true, address: OWN });
  });
});

describe("ownMailboxHeaders: the From line (§2.3, O5)", () => {
  it("the display name with the own From, never a Reply-To", () => {
    expect(ownMailboxHeaders({ displayName: "Ali from Polygon Paradise", from: OWN })).toEqual({
      from: `Ali from Polygon Paradise <${OWN}>`,
      replyTo: null,
    });
    expect(ownMailboxHeaders({ displayName: "Ali", from: " Contact@Example.com " }).from).toBe(`Ali <${OWN}>`);
  });

  it("quotes a display name that needs it; an empty one leaves the bare address", () => {
    expect(ownMailboxHeaders({ displayName: "Ali, Polygon Paradise", from: OWN }).from).toBe(`"Ali, Polygon Paradise" <${OWN}>`);
    expect(ownMailboxHeaders({ displayName: 'Ali "3D" Khan', from: OWN }).from).toBe(`"Ali \\"3D\\" Khan" <${OWN}>`);
    expect(ownMailboxHeaders({ displayName: "  ", from: OWN }).from).toBe(OWN);
  });
});

describe("ownMailboxRuleFrom: what the sender checks compare with (O6)", () => {
  it("null in app mode; the own From (lowercase) in own-mailbox mode; empty while none fits", () => {
    expect(ownMailboxRuleFrom("app", OWN)).toBeNull();
    expect(ownMailboxRuleFrom("app", null)).toBeNull();
    expect(ownMailboxRuleFrom("own-mailbox", " Contact@Example.com ")).toBe(OWN);
    expect(ownMailboxRuleFrom("own-mailbox", null)).toBe("");
  });
});

describe("senderHeaderProblem with the own-mailbox option (§2.4)", () => {
  const own = { ownMailboxFrom: OWN };

  it("accepts only today's own From on the domain with no Reply-To", () => {
    expect(senderHeaderProblem(D, `Ali <${OWN}>`, null, own)).toBeNull();
    expect(senderHeaderProblem(D, `Ali <${OWN}>`, "", own)).toBeNull();
    expect(senderHeaderProblem(D, OWN, undefined, own)).toBeNull();
    expect(senderHeaderProblem(D, "Ali <CONTACT@example.com>", null, { ownMailboxFrom: "Contact@Example.com" })).toBeNull();
  });

  it("refuses another address on the domain, a Reply-To, another domain, and everything when none fits", () => {
    expect(senderHeaderProblem(D, "Ali <ali@example.com>", null, own)).toMatch(/isn't the own From/);
    expect(senderHeaderProblem(D, `Ali <${OWN}>`, "ali@example.com", own)).toBe("An own-mailbox email has a reply address.");
    expect(senderHeaderProblem("mail.example.com", `Ali <${OWN}>`, null, own)).toMatch(/isn't on mail\.example\.com/);
    expect(senderHeaderProblem("", `Ali <${OWN}>`, null, own)).toMatch(/isn't on the sending domain/);
    expect(senderHeaderProblem(D, `Ali <${OWN}>`, null, { ownMailboxFrom: "" })).toBe("Own-mailbox mode has no From address yet.");
    expect(senderHeaderProblem(D, `Ali <${OWN}>`, null, { ownMailboxFrom: "  " })).toBe("Own-mailbox mode has no From address yet.");
  });

  it("without the option (null or absent): today's answers", () => {
    // Per-person: the From on the domain, any Reply-To (as before).
    expect(senderHeaderProblem("send.example.com", "Ali <ali@send.example.com>", "anything@elsewhere.org")).toBeNull();
    expect(senderHeaderProblem("send.example.com", "Ali <ali@send.example.com>", "anything@elsewhere.org", { ownMailboxFrom: null })).toBeNull();
    // Shared From: needs a Reply-To on the sending domain.
    expect(senderHeaderProblem("send.example.com", "Ali <contact@example.com>", "ali@send.example.com")).toBeNull();
    expect(senderHeaderProblem("send.example.com", "Ali <contact@example.com>", null)).not.toBeNull();
    // The own-mailbox shape in app mode is simply per-person (From on the domain).
    expect(senderHeaderProblem(D, `Ali <${OWN}>`, null)).toBeNull();
  });
});

describe("the Mailgun plan (§2.8, O22–O26)", () => {
  it("planOf reads only the four plans", () => {
    for (const p of ["free", "basic", "foundation", "scale"] as const) expect(planOf(p)).toBe(p);
    for (const v of ["Free", "enterprise", "", null, undefined, 1, {}]) expect(planOf(v), JSON.stringify(v)).toBeNull();
  });

  it("planLimits: a chosen plan's facts; none chosen → Free assumed in own-mailbox mode, nothing in app mode", () => {
    expect(planLimits("foundation", "app")).toEqual({ ...MAILGUN_PLAN_FACTS.foundation, plan: "foundation", assumed: false });
    expect(planLimits("free", "own-mailbox")).toEqual({ ...MAILGUN_PLAN_FACTS.free, plan: "free", assumed: false });
    expect(planLimits(null, "own-mailbox")).toEqual({ ...MAILGUN_PLAN_FACTS.free, plan: "free", assumed: true });
    expect(planLimits(null, "app")).toBeNull();
    expect(MAILGUN_PLAN_FACTS.free).toMatchObject({ dailyLimit: 100, logDays: 1, messageDays: 1 });
  });

  it("effectiveLogRetentionDays: the saved number, never more than the plan keeps", () => {
    const free = planLimits("free", "app");
    expect(effectiveLogRetentionDays(5, free)).toBe(1);
    expect(effectiveLogRetentionDays(5, null)).toBe(5);
    expect(effectiveLogRetentionDays(3, planLimits("foundation", "app"))).toBe(3);
    expect(effectiveLogRetentionDays(30, planLimits("foundation", "app"))).toBe(5);
    // 0 / NaN / junk → the default 5, then capped by the plan.
    expect(effectiveLogRetentionDays(0, null)).toBe(5);
    expect(effectiveLogRetentionDays(Number.NaN, null)).toBe(5);
    expect(effectiveLogRetentionDays("x", null)).toBe(5);
    expect(effectiveLogRetentionDays(0, free)).toBe(1);
    expect(effectiveLogRetentionDays(99, null)).toBe(30);
  });

  it("effectiveMaxDailyCap: never above the plan's limit minus the test reserve", () => {
    const free = planLimits("free", "app");
    expect(PLAN_TEST_RESERVE).toBe(10);
    expect(effectiveMaxDailyCap(1000, free)).toBe(90);
    expect(effectiveMaxDailyCap(50, free)).toBe(50);
    expect(effectiveMaxDailyCap(1000, planLimits("foundation", "app"))).toBe(1000);
    expect(effectiveMaxDailyCap(1000, null)).toBe(1000);
    expect(effectiveMaxDailyCap(1000, planLimits(null, "own-mailbox"))).toBe(90);
    expect(effectiveMaxDailyCap("junk", free)).toBe(0);
  });

  it("planRoom: campaign room keeps the reserve, tests may use the whole limit; null without a daily limit", () => {
    const free = planLimits("free", "app");
    expect(planRoom(free, 0)).toEqual({ campaign: 90, tests: 100 });
    expect(planRoom(free, 89)).toEqual({ campaign: 1, tests: 11 });
    expect(planRoom(free, 90)).toEqual({ campaign: 0, tests: 10 });
    expect(planRoom(free, 100)).toEqual({ campaign: 0, tests: 0 });
    expect(planRoom(free, 150)).toEqual({ campaign: 0, tests: 0 });
    expect(planRoom(planLimits("foundation", "app"), 5000)).toBeNull();
    expect(planRoom(null, 5)).toBeNull();
  });
});

describe("putBackMx (O10)", () => {
  it("names the last good MX sorted by priority, or the help pages without one", () => {
    expect(
      OWN_MAILBOX_TEXTS.putBackMx([
        { priority: 50, host: "mx3.zoho.com" },
        { priority: 10, host: "mx.zoho.com" },
        { priority: 20, host: "mx2.zoho.com" },
      ]),
    ).toBe("put back your mail provider's MX records: mx.zoho.com (priority 10), mx2.zoho.com (priority 20), mx3.zoho.com (priority 50)");
    expect(OWN_MAILBOX_TEXTS.putBackMx(null)).toBe("put back your mail provider's MX records (its help pages list them)");
    expect(OWN_MAILBOX_TEXTS.putBackMx([])).toBe("put back your mail provider's MX records (its help pages list them)");
  });
});
