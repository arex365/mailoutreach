import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";

/**
 * Fake mode (M3-DESIGN §6.3): the domain check never asks the public resolvers about the fake's made-up records. The
 * DNS rows follow Mailgun's own record list instead, which the fake's setDns (POST /__fake/dns {valid}) switches, so
 * the lead's manual check can turn the checklist green and set Live without any real DNS.
 */

// Any real resolver in this file is a bug: node:dns is replaced by one that refuses to be made.
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    constructor() {
      throw new Error("A real DNS resolver was created in fake mode.");
    }
  },
}));

const t = await createTestDb("fake-mode-dns");
const mg = await connectFakeMailgun();
const { db } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runDomainCheck } = await import("@/server/services/checks/domain-check");
const { mailgunRecordsLookup, GUIDE_DMARC_RECORD } = await import("@/server/services/checks/dns-lookup");

const D = mg.domain;
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
const noFetch = (async () => {
  throw new TypeError("fetch failed (no network in this test)");
}) as unknown as typeof fetch;
const DNS_ROWS = ["spf", "dkim", "mx", "tracking-cname", "dmarc"];

async function dnsRows() {
  const state = await runDomainCheck({ verify: true, now: new Date(Date.now() + Math.random() * 1e9), mailgun, fetchImpl: noFetch });
  return Object.fromEntries(state.rows.filter((r) => DNS_ROWS.includes(r.key)).map((r) => [r.key, r.status]));
}

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("the domain check in fake mode", () => {
  it("reads the DNS rows from Mailgun's own record list: all valid → all done, including the guide's DMARC record", async () => {
    mg.fake.setDns("all");
    expect(await dnsRows()).toEqual({ spf: "ok", dkim: "ok", mx: "ok", "tracking-cname": "ok", dmarc: "ok" });
    const state = await runDomainCheck({ mailgun, fetchImpl: noFetch });
    expect(state.rows.find((r) => r.key === "mailgun-domain")?.status).toBe("ok");
  });

  it("shows what the fake says is missing", async () => {
    mg.fake.setDns(["spf", "mx"]);
    const rows = await dnsRows();
    expect(rows).toMatchObject({ spf: "ok", mx: "ok", dkim: "bad", "tracking-cname": "bad" });
    // The DMARC record is only answered once every Mailgun record is valid (the Owner added them all, step 7).
    expect(rows.dmarc).toBe("bad");
    mg.fake.setDns("all");
  });

  it("answers exactly the valid records, nothing else", async () => {
    const ctx = await mailgun();
    if (!ctx.connected) throw new Error(ctx.text);
    const info = await ctx.client.getDomain(D);
    const lookup = mailgunRecordsLookup(D, info);
    const spf = info.sending.find((r) => r.recordType === "TXT" && r.name === D)!;
    expect(await lookup.txt(D)).toEqual({ ok: true, value: [spf.value] });
    expect(await lookup.txt(`_dmarc.${D}`)).toEqual({ ok: true, value: [GUIDE_DMARC_RECORD] });
    expect((await lookup.mx(D)).ok).toBe(true);
    expect(await lookup.a(`email.${D}`)).toMatchObject({ ok: false, code: "missing" });
    expect(await lookup.txt("example.org")).toMatchObject({ ok: false, code: "missing" });
    const none = mailgunRecordsLookup(D, { sending: info.sending.map((r) => ({ ...r, valid: "unknown" as const })), receiving: [] });
    expect(await none.txt(D)).toMatchObject({ ok: false, code: "missing" });
    expect(await none.txt(`_dmarc.${D}`)).toMatchObject({ ok: false, code: "missing" });
  });
});

describe("the domain check in fake mode with a shared From address (SHARED-FROM-DESIGN §5)", () => {
  it("a made-up mail provider answers for the From domain: from-mx, from-spf and its DMARC are done, no real DNS", async () => {
    const { setSetting } = await import("@/server/settings");
    await setSetting("mailgun.fromAddress", "contact@example.com", null);
    try {
      mg.fake.setDns("all");
      const state = await runDomainCheck({ verify: true, now: new Date(Date.now() + 2e9), mailgun, fetchImpl: noFetch });
      const rows = Object.fromEntries(state.rows.map((r) => [r.key, r]));
      expect(state.rows).toHaveLength(22);
      expect(rows["from-mx"]).toMatchObject({
        status: "ok",
        text: "Mail for example.com goes to your mail provider (mx.mail-provider.invalid), not to Mailgun. Keep it that way.",
      });
      expect(rows["from-spf"]?.status).toBe("ok");
      expect(rows.dmarc).toMatchObject({ status: "ok", text: "example.com's policy: monitor only. Right for now." });
      expect(Object.fromEntries(state.rows.filter((r) => DNS_ROWS.includes(r.key)).map((r) => [r.key, r.status]))).toEqual({
        spf: "ok",
        dkim: "ok",
        mx: "ok",
        "tracking-cname": "ok",
        dmarc: "ok",
      });

      // Before every Mailgun record is valid, the From domain's DMARC isn't answered either (today's rule).
      mg.fake.setDns(["spf", "mx"]);
      const partial = await runDomainCheck({ verify: true, now: new Date(Date.now() + 3e9), mailgun, fetchImpl: noFetch });
      expect(partial.rows.find((r) => r.key === "dmarc")?.status).toBe("bad");
      expect(partial.rows.find((r) => r.key === "from-mx")?.status).toBe("ok");
    } finally {
      mg.fake.setDns("all");
      await setSetting("mailgun.fromAddress", null, null);
    }
  });

  it("never makes a real resolver, even when Mailgun's domain can't be read", async () => {
    const { setSetting } = await import("@/server/settings");
    await setSetting("mailgun.fromAddress", "contact@example.com", null);
    await setSetting("mailgun.domain", "unknown.example.com", null);
    try {
      // The mocked node:dns throws if a Resolver is made: the check still finishes.
      const state = await runDomainCheck({ mailgun, fetchImpl: noFetch });
      expect(state.rows.find((r) => r.key === "mailgun-domain")?.status).toBe("bad");
      expect(state.rows.find((r) => r.key === "from-mx")?.status).toBe("ok");
    } finally {
      await setSetting("mailgun.domain", D, null);
      await setSetting("mailgun.fromAddress", null, null);
    }
  });
});
