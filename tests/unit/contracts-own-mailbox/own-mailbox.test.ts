import { describe, expect, it } from "vitest";
import { SENDING_DOMAIN_TEXTS, validateSendingDomain } from "@/core/sender-address";
import { TEAM_FROM_TEXTS, senderHeaderProblem, validateTeamFromAddress } from "@/core/sending/from-address";
import {
  INBOX_CHECK_TEXTS,
  NEVER_MAILGUN_MX_TEXT,
  OWN_MAILBOX_TEXTS,
  OWN_REPLY_TEST_TEXTS,
  THEY_REPLIED_TEXTS,
  ownMailboxHeaders,
  ownMailboxRuleFrom,
  repliesOf,
  validateFromAddressFor,
  validateOwnMailboxFrom,
} from "@/core/sending/own-mailbox";

/**
 * Step C of docs/dev/MAIN-DOMAIN-DESIGN.md (§7.4, §7.5): the own-mailbox contract file and the two edited pure
 * functions it relies on (`senderHeaderProblem`, `validateSendingDomain`). App mode must answer exactly as before.
 */

const D = "polygonparadise.com";
const FROM = `contact@${D}`;

describe("repliesOf and ownMailboxRuleFrom (O1, O6)", () => {
  it("reads only exactly 'own-mailbox' as own-mailbox mode; anything else is app mode (fail closed)", () => {
    expect(repliesOf("own-mailbox")).toBe("own-mailbox");
    for (const v of ["app", "Own-mailbox", " own-mailbox", "", null, undefined, 1, true, {}, ["own-mailbox"]]) {
      expect(repliesOf(v)).toBe("app");
    }
  });

  it("is null in app mode, the own From (lowercase) in own-mailbox mode, and '' there while none fits", () => {
    expect(ownMailboxRuleFrom("app", FROM)).toBeNull();
    expect(ownMailboxRuleFrom("app", null)).toBeNull();
    expect(ownMailboxRuleFrom("own-mailbox", " Contact@PolygonParadise.com ")).toBe(FROM);
    expect(ownMailboxRuleFrom("own-mailbox", null)).toBe("");
  });
});

describe("ownMailboxHeaders (§2.3, §0.2 rule 6)", () => {
  it("gives the display name with the own From and never a Reply-To", () => {
    expect(ownMailboxHeaders({ displayName: "Arslan from Polygon Paradise", from: " Contact@PolygonParadise.com " })).toEqual({
      from: "Arslan from Polygon Paradise <contact@polygonparadise.com>",
      replyTo: null,
    });
    // A name that needs quoting is quoted, as every From line (formatFromHeader).
    expect(ownMailboxHeaders({ displayName: "Berg, Anna", from: FROM }).from).toBe(`"Berg, Anna" <${FROM}>`);
    expect(ownMailboxHeaders({ displayName: "", from: FROM }).from).toBe(FROM);
  });
});

describe("validateOwnMailboxFrom and validateFromAddressFor (§2.2, O3)", () => {
  it("accepts an address exactly on the sending domain, contact@ included, and forgives mailto: and case", () => {
    expect(validateOwnMailboxFrom(FROM, D)).toEqual({ ok: true, address: FROM });
    expect(validateOwnMailboxFrom(" mailto:Contact@PolygonParadise.com ", "PolygonParadise.com.")).toEqual({ ok: true, address: FROM });
    for (const local of ["info", "hello", "sales", "arslan"]) {
      expect(validateOwnMailboxFrom(`${local}@${D}`, D)).toEqual({ ok: true, address: `${local}@${D}` });
    }
  });

  it("allows saving it empty, so the Owner can always switch back", () => {
    for (const v of ["", "   ", null, undefined, "mailto:"]) expect(validateOwnMailboxFrom(v, D)).toEqual({ ok: true, address: null });
  });

  it("refuses without a sending domain, anything but one bare address, another domain and reserved names", () => {
    expect(validateOwnMailboxFrom(FROM, null)).toEqual({ ok: false, error: TEAM_FROM_TEXTS.notConnected });
    const invalid = { ok: false, error: TEAM_FROM_TEXTS.invalid(FROM) };
    for (const v of ["not an address", `Arslan <${FROM}>`, `${FROM}, ali@${D}`, "contact@", `contact@@${D}`]) {
      expect(validateOwnMailboxFrom(v, D), v).toEqual(invalid);
    }
    const wrong = { ok: false, error: OWN_MAILBOX_TEXTS.fromWrongDomain(D) };
    for (const v of [`contact@mail.${D}`, "contact@example.com", "arslan@gmail.com", `contact@${D}.evil.test`]) {
      expect(validateOwnMailboxFrom(v, D), v).toEqual(wrong);
    }
    expect(OWN_MAILBOX_TEXTS.fromWrongDomain(D)).toBe("The From address must end in @polygonparadise.com, your sending domain.");
    for (const local of ["postmaster", "noreply", "no-reply", "bounce", "u", "dmarc", "pp-route-check", "pp-route-check-7"]) {
      expect(validateOwnMailboxFrom(`${local}@${D}`, D), local).toEqual({ ok: false, error: TEAM_FROM_TEXTS.reserved(local, FROM) });
    }
  });

  it("dispatches: app mode is exactly today's shared-From rules, own-mailbox mode the own rules", () => {
    const cases: Array<[string, string]> = [
      [FROM, `mail.${D}`],
      [FROM, D],
      [`ali@mail.${D}`, `mail.${D}`],
      ["", `mail.${D}`],
      ["x@gmail.com", `mail.${D}`],
    ];
    for (const [input, domain] of cases) {
      expect(validateFromAddressFor(input, domain, "app")).toEqual(validateTeamFromAddress(input, domain));
      expect(validateFromAddressFor(input, domain, "own-mailbox")).toEqual(validateOwnMailboxFrom(input, domain));
    }
    // The owner's address fits shared-From mode on the subdomain and own-mailbox mode on the root, never the other way.
    expect(validateFromAddressFor(FROM, `mail.${D}`, "app")).toEqual({ ok: true, address: FROM });
    expect(validateFromAddressFor(FROM, D, "own-mailbox")).toEqual({ ok: true, address: FROM });
    expect(validateFromAddressFor(FROM, `mail.${D}`, "own-mailbox").ok).toBe(false);
    expect(validateFromAddressFor(FROM, D, "app").ok).toBe(false);
  });
});

describe("senderHeaderProblem with ownMailboxFrom (O6, §2.4)", () => {
  const line = (address: string) => `Arslan from Polygon Paradise <${address}>`;

  it("accepts only the own From, on the sending domain, with no Reply-To", () => {
    expect(senderHeaderProblem(D, line(FROM), null, { ownMailboxFrom: FROM })).toBeNull();
    expect(senderHeaderProblem(D, line("Contact@PolygonParadise.com"), undefined, { ownMailboxFrom: " CONTACT@polygonparadise.com " })).toBeNull();
    expect(senderHeaderProblem(D, FROM, "", { ownMailboxFrom: FROM })).toBeNull();
  });

  it("refuses everything while no From fits, another From, another domain and any Reply-To", () => {
    expect(senderHeaderProblem(D, line(FROM), null, { ownMailboxFrom: "" })).toBe("Own-mailbox mode has no From address yet.");
    expect(senderHeaderProblem(D, line(`ali@${D}`), null, { ownMailboxFrom: FROM })).toBe(`The From address isn't the own From ${FROM}.`);
    expect(senderHeaderProblem(`mail.${D}`, line(FROM), null, { ownMailboxFrom: FROM })).toBe(`The From address isn't on mail.${D}.`);
    expect(senderHeaderProblem(D, line(FROM), `ali@${D}`, { ownMailboxFrom: FROM })).toBe("An own-mailbox email has a reply address.");
    expect(senderHeaderProblem(D, line(FROM), `ali@mail.${D}`, { ownMailboxFrom: FROM })).toBe("An own-mailbox email has a reply address.");
  });

  it("without the option (null or absent) answers exactly as before", () => {
    const cases: Array<[string, string, string | null]> = [
      [`send.example.com`, line("ali@send.example.com"), null],
      [`mail.${D}`, line(FROM), `ali@mail.${D}`],
      [`mail.${D}`, line(FROM), null],
      [`mail.${D}`, line("x@other.test"), null],
      [D, line(FROM), null],
    ];
    for (const [d, from, replyTo] of cases) {
      const before = senderHeaderProblem(d, from, replyTo);
      expect(senderHeaderProblem(d, from, replyTo, { ownMailboxFrom: null })).toBe(before);
      expect(senderHeaderProblem(d, from, replyTo, {})).toBe(before);
    }
    // Per-person mode on the root is still "fine" for the header check: app mode relies on connect refusing the root.
    expect(senderHeaderProblem(D, line(FROM), null)).toBeNull();
  });
});

describe("validateSendingDomain with the mode (O7, §2.2)", () => {
  it("app mode (absent or 'app') is exactly today's rules, with the new website sentence (O30)", () => {
    for (const opts of [undefined, {}, { replies: "app" as const }]) {
      expect(validateSendingDomain(D, opts)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.website });
      expect(validateSendingDomain(`www.${D}`, opts)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.website });
      expect(validateSendingDomain(`mail.${D}`, opts)).toEqual({ ok: true, domain: `mail.${D}` });
      expect(validateSendingDomain("", opts)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.empty });
      expect(validateSendingDomain("sandbox1.mailgun.org", opts)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.sandbox });
      expect(validateSendingDomain("gmail.com", opts)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.shared });
      expect(validateSendingDomain("localhost", opts)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.invalid });
    }
    expect(SENDING_DOMAIN_TEXTS.website).toBe(
      "polygonparadise.com is your own domain. To send through it, choose From polygonparadise.com itself above. For replies through the app, type mail.polygonparadise.com here (Mailgun guide, step 4).",
    );
  });

  it("own-mailbox mode allows the website domain, refuses www. names and uses the polygonparadise.com sentences", () => {
    const own = { replies: "own-mailbox" as const };
    expect(validateSendingDomain(D, own)).toEqual({ ok: true, domain: D });
    expect(validateSendingDomain(" https://PolygonParadise.com/ ", own)).toEqual({ ok: true, domain: D });
    expect(validateSendingDomain(`mail.${D}`, own)).toEqual({ ok: true, domain: `mail.${D}` });
    expect(validateSendingDomain(`www.${D}`, own)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.www });
    expect(validateSendingDomain("www.example.com", own)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.www });
    expect(validateSendingDomain("", own)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.emptyOwn });
    for (const bad of ["localhost", "-bad.com", "a..b.com", "1.2.3.4"]) {
      expect(validateSendingDomain(bad, own), bad).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.invalidOwn });
    }
    expect(validateSendingDomain("sandbox9f2c.mailgun.org", own)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.sandboxOwn });
    expect(validateSendingDomain("mailgun.org", own)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.sandboxOwn });
    expect(validateSendingDomain("gmail.com", own)).toEqual({ ok: false, error: SENDING_DOMAIN_TEXTS.sharedOwn });
  });

  it("never names mail.polygonparadise.com in an own-mailbox sentence", () => {
    for (const k of ["www", "emptyOwn", "invalidOwn", "sandboxOwn", "sharedOwn"] as const) {
      expect(SENDING_DOMAIN_TEXTS[k]).not.toContain("mail.polygonparadise.com");
      expect(SENDING_DOMAIN_TEXTS[k]).toContain("polygonparadise.com");
    }
  });
});

describe("the MX sentences (O10, §2.5)", () => {
  it("NEVER_MAILGUN_MX_TEXT names Mailgun's hosts once, and every fix that needs it carries it", () => {
    expect(NEVER_MAILGUN_MX_TEXT(D)).toBe("Never add Mailgun's MX records (mxa.mailgun.org, mxb.mailgun.org) to polygonparadise.com.");
    expect(OWN_MAILBOX_TEXTS.mailgunDomainFix(D)).toContain(NEVER_MAILGUN_MX_TEXT(D));
    expect(OWN_MAILBOX_TEXTS.mailgunDomainFix(D).replace(NEVER_MAILGUN_MX_TEXT(D), "")).not.toMatch(/mailgun\.org/);
  });

  it("putBackMx names the last good MX by priority, or the mail provider's help pages", () => {
    const zoho = [
      { priority: 50, host: "mx3.zoho.com" },
      { priority: 10, host: "mx.zoho.com" },
      { priority: 20, host: "mx2.zoho.com" },
    ];
    expect(OWN_MAILBOX_TEXTS.putBackMx(zoho)).toBe(
      "put back your mail provider's MX records: mx.zoho.com (priority 10), mx2.zoho.com (priority 20), mx3.zoho.com (priority 50)",
    );
    expect(zoho[0]!.host).toBe("mx3.zoho.com");
    for (const none of [null, undefined, []]) {
      expect(OWN_MAILBOX_TEXTS.putBackMx(none)).toBe("put back your mail provider's MX records (its help pages list them)");
    }
  });
});

describe("the own-mailbox texts (§9.1 sweep 3)", () => {
  /** Every string of a text object, functions called with sample values. */
  function allStrings(texts: Record<string, unknown>): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [key, v] of Object.entries(texts)) {
      if (typeof v === "string") out.push([key, v]);
      else if (typeof v === "function") {
        const args = Array.from({ length: v.length }, (_, i) => [FROM, D, "Arslan", "Acme Studio", "Anna Berg"][i] ?? FROM);
        const r: unknown = (v as (...a: unknown[]) => unknown)(...args);
        if (typeof r === "string") out.push([key, r]);
        else if (Array.isArray(r)) for (const s of r) out.push([key, String(s)]);
      }
    }
    return out;
  }

  it("never say 'reply address', 'sending address' or 'reply route'; only repliesAppHint names mail.polygonparadise.com", () => {
    const objects = { OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS, THEY_REPLIED_TEXTS, INBOX_CHECK_TEXTS };
    for (const [name, texts] of Object.entries(objects)) {
      for (const [key, s] of allStrings(texts)) {
        expect(s, `${name}.${key}`).not.toMatch(/reply address|sending address|reply route/i);
        if (!(name === "OWN_MAILBOX_TEXTS" && key === "repliesAppHint")) expect(s, `${name}.${key}`).not.toContain("mail.polygonparadise.com");
      }
    }
    expect(OWN_MAILBOX_TEXTS.repliesAppHint).toContain("mail.polygonparadise.com");
  });

  it("pins a few sentences the screens and the guide quote", () => {
    expect(OWN_MAILBOX_TEXTS.fromMissing(D)).toBe(
      "Type the address your emails come from in Settings › Sending & Mailgun › From address, for example contact@polygonparadise.com. Test and live campaigns can't start without it.",
    );
    expect(OWN_MAILBOX_TEXTS.misfit("x@other.test", D)).toBe(
      "The From address x@other.test isn't on your sending domain polygonparadise.com. Change it in Settings › Sending & Mailgun.",
    );
    expect(OWN_MAILBOX_TEXTS.checklistLine(FROM, D)).toBe(
      "Emails show From contact@polygonparadise.com and go out through polygonparadise.com itself. Replies go straight to that mailbox.",
    );
    expect(OWN_MAILBOX_TEXTS.checklistLine(null, D)).toBe(
      "Emails go out through polygonparadise.com itself. Type your From address in Settings › Sending & Mailgun.",
    );
    expect(OWN_MAILBOX_TEXTS.goodToKnow(FROM, D)).toHaveLength(6);
    expect(OWN_MAILBOX_TEXTS.switchedSummary("Arslan", D, "own-mailbox")).toBe("Arslan switched replies for polygonparadise.com to your own mailbox");
    expect(OWN_MAILBOX_TEXTS.switchedSummary("Arslan", `mail.${D}`, "app")).toBe("Arslan switched replies for mail.polygonparadise.com to go through the app");
    expect(INBOX_CHECK_TEXTS.item(1, FROM)).toMatch(/^1 follow-up waits for today's check of contact@polygonparadise\.com\./);
    expect(INBOX_CHECK_TEXTS.item(1234, FROM)).toMatch(/^1,234 follow-ups wait /);
    expect(INBOX_CHECK_TEXTS.button(FROM)).toBe("I've read contact@polygonparadise.com");
    expect(THEY_REPLIED_TEXTS.toast(1)).toBe("Marked as replied. Follow-ups to 1 person stopped.");
    expect(THEY_REPLIED_TEXTS.toast(3)).toBe("Marked as replied. Follow-ups to 3 people stopped.");
    expect(THEY_REPLIED_TEXTS.toast(0)).toBe("Marked as replied. No follow-ups were waiting.");
    expect(THEY_REPLIED_TEXTS.activity("Arslan", "Acme Studio", null)).toBe("Arslan marked Acme Studio as replied");
    expect(THEY_REPLIED_TEXTS.activity("Arslan", "Acme Studio", "Anna Berg")).toBe("Arslan marked Anna Berg (Acme Studio) as replied");
    expect(OWN_REPLY_TEST_TEXTS.passedRow(" on 28 Sep", FROM)).toBe(
      "The reply test passed on 28 Sep with the From address contact@polygonparadise.com: test emails arrived, your replies reached contact@polygonparadise.com, unsubscribing works, and the test email passed DMARC.",
    );
  });
});
