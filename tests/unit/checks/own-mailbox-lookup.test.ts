import { describe, expect, it } from "vitest";
import type { DnsRecordFact } from "@/core/dns/checklist";
import {
  FAKE_FROM_DOMAIN_RECORDS,
  FAKE_OWN_MAILBOX_RECORDS,
  GUIDE_DMARC_RECORD,
  mailgunRecordsLookup,
} from "@/server/services/checks/dns-lookup";
import { spfLookupReport } from "@/server/services/checks/spf-count";

/**
 * Fake mode in own-mailbox mode (MAIN-DOMAIN-DESIGN §5): the sending domain is the Owner's own mailbox domain, so the
 * lookup answers for it as a mail provider's domain whose DNS host wraps each SPF part in a GoDaddy-style `_spfm`
 * include (4 lookups, Mailgun reached through the tree, nothing dangling), never with Mailgun's receiving records. The
 * lead's manual checks then show spf and from-mx green without real DNS.
 */

const D = "example.com";
const rec = (recordType: string, name: string | null, value: string, valid = "valid", priority: string | null = null): DnsRecordFact => ({
  recordType,
  name,
  value,
  priority,
  valid,
  isActive: true,
  cached: [],
});

/** Mailgun's records for the domain as the fake lists them with `receivesMail: false` (US region). */
function mailgun(valid = "valid", spfValid = valid) {
  return {
    sending: [
      rec("TXT", D, "v=spf1 include:mailgun.org ~all", spfValid),
      rec("TXT", `pdk1._domainkey.${D}`, "k=rsa; p=MIIBfake", valid),
      rec("CNAME", `email.${D}`, "mailgun.org", valid),
    ],
    receiving: [rec("MX", null, "mxa.mailgun.org", "unverified", "10"), rec("MX", null, "mxb.mailgun.org", "unverified", "10")],
  };
}

describe("mailgunRecordsLookup in own-mailbox mode", () => {
  const lookup = mailgunRecordsLookup(D, mailgun(), { ownMailbox: true });

  it("answers the sending domain's MX as a mail provider's, never Mailgun's", async () => {
    expect(await lookup.mx(D)).toEqual({ ok: true, value: [{ priority: 10, exchange: "mx.mail-provider.invalid" }] });
    expect(FAKE_OWN_MAILBOX_RECORDS.mx).toBe(FAKE_FROM_DOMAIN_RECORDS.mx);
    // Even when Mailgun marks its receiving records valid, they are never answered in this mode.
    const validMx = { ...mailgun(), receiving: mailgun().receiving.map((r) => ({ ...r, valid: "valid" })) };
    const mx = await mailgunRecordsLookup(D, validMx, { ownMailbox: true }).mx(D);
    expect(JSON.stringify(mx)).not.toContain("mailgun.org");
  });

  it("answers the GoDaddy-style SPF tree: 4 lookups, Mailgun reached through dc-2._spfm, nothing dangling", async () => {
    const top = await lookup.txt(D);
    expect(top).toEqual({ ok: true, value: [`v=spf1 include:dc-1._spfm.${D} include:dc-2._spfm.${D} ~all`] });
    expect(await lookup.txt(`dc-1._spfm.${D}`)).toEqual({ ok: true, value: ["v=spf1 include:_spf.mail-provider.invalid ~all"] });
    expect(await lookup.txt(`dc-2._spfm.${D}`)).toEqual({ ok: true, value: ["v=spf1 include:mailgun.org ~all"] });
    expect(await lookup.txt("_spf.mail-provider.invalid")).toEqual({ ok: true, value: ["v=spf1 ip4:192.0.2.10 ~all"] });
    expect(await lookup.txt("mailgun.org")).toEqual({ ok: true, value: ["v=spf1 ip4:192.0.2.30 ~all"] });
    const report = await spfLookupReport(FAKE_OWN_MAILBOX_RECORDS.spf(D), lookup);
    expect(report).toEqual({
      count: 4,
      complete: true,
      dangling: [],
      names: [`dc-1._spfm.${D}`, "_spf.mail-provider.invalid", `dc-2._spfm.${D}`, "mailgun.org"],
    });
    // Mailgun's own SPF value is never answered at the domain itself (the provider's record is).
    expect(top.ok && top.value.some((v) => v === "v=spf1 include:mailgun.org ~all")).toBe(false);
  });

  it("answers DKIM and the tracking CNAME as always, and DMARC once every sending record is valid (receiving ignored)", async () => {
    expect(await lookup.txt(`pdk1._domainkey.${D}`)).toEqual({ ok: true, value: ["k=rsa; p=MIIBfake"] });
    expect(await lookup.cname(`email.${D}`)).toEqual({ ok: true, value: ["mailgun.org"] });
    expect(await lookup.txt(`_dmarc.${D}`)).toEqual({ ok: true, value: [GUIDE_DMARC_RECORD] });
    const pending = mailgunRecordsLookup(D, mailgun("unknown"), { ownMailbox: true });
    expect(await pending.txt(`_dmarc.${D}`)).toMatchObject({ ok: false, code: "missing" });
    expect(await pending.txt(`pdk1._domainkey.${D}`)).toMatchObject({ ok: false, code: "missing" });
    // The provider's MX stays whatever Mailgun says.
    expect((await pending.mx(D)).ok).toBe(true);
  });

  it("while Mailgun's SPF record isn't valid, dc-2._spfm carries no Mailgun include (the SPF row then says so)", async () => {
    const noSpf = mailgunRecordsLookup(D, mailgun("valid", "unknown"), { ownMailbox: true });
    expect(await noSpf.txt(`dc-2._spfm.${D}`)).toEqual({ ok: true, value: ["v=spf1 ~all"] });
    const report = await spfLookupReport(FAKE_OWN_MAILBOX_RECORDS.spf(D), noSpf);
    expect(report.names).not.toContain("mailgun.org");
    expect(report.dangling).toEqual([]);
  });

  it("an EU domain's dc-2._spfm carries Mailgun's EU include, answered too", async () => {
    const eu = {
      sending: [rec("TXT", D, "v=spf1 include:eu.mailgun.org ~all")],
      receiving: [],
    };
    const l = mailgunRecordsLookup(D, eu, { ownMailbox: true });
    expect(await l.txt(`dc-2._spfm.${D}`)).toEqual({ ok: true, value: ["v=spf1 include:eu.mailgun.org ~all"] });
    expect(await l.txt("eu.mailgun.org")).toEqual({ ok: true, value: ["v=spf1 ip4:192.0.2.30 ~all"] });
  });

  it("every other name is missing, and app mode's answers are unchanged without the option", async () => {
    expect(await lookup.txt(`www.${D}`)).toMatchObject({ ok: false, code: "missing" });
    expect(await lookup.mx(`mail.${D}`)).toMatchObject({ ok: false, code: "missing" });
    expect(await lookup.a(D)).toMatchObject({ ok: false, code: "missing" });
    const app = mailgunRecordsLookup(D, mailgun());
    expect(await app.txt(D)).toEqual({ ok: true, value: ["v=spf1 include:mailgun.org ~all"] });
    expect(await app.txt(`dc-2._spfm.${D}`)).toMatchObject({ ok: false, code: "missing" });
    expect(await app.txt("mailgun.org")).toMatchObject({ ok: false, code: "missing" });
    expect(await app.mx(D)).toMatchObject({ ok: false, code: "missing" });
    // App mode counts the receiving records: unverified MX → no DMARC answer (today's rule).
    expect(await app.txt(`_dmarc.${D}`)).toMatchObject({ ok: false, code: "missing" });
  });

  it("ignores fromDomain in own-mailbox mode (the From domain is the sending domain)", async () => {
    const l = mailgunRecordsLookup(D, mailgun(), { ownMailbox: true, fromDomain: "other.example" });
    expect(await l.mx("other.example")).toMatchObject({ ok: false, code: "missing" });
    expect(await l.txt("other.example")).toMatchObject({ ok: false, code: "missing" });
  });
});
