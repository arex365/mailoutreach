import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeOwner } from "../mail-events/seed";
import { FakeDns, type FakeZone } from "../../unit/checks/fake-dns";

/**
 * O37 with review DOMAIN-4: the website domain (polygonparadise.com) stored as an app-mode sending domain (a corrupted
 * or missing "mailgun.replies"). The domain check gathers the own-mailbox SPF facts for it (both resolvers' walks, the
 * dangling includes), so a GoDaddy helper lost in a DNS move gets the "add it again" fix, and no fix ever asks to add
 * Mailgun's include to the everyday domain's SPF record.
 */

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    constructor() {
      throw new Error("A real DNS resolver was created in a test.");
    }
  },
}));

const t = await createTestDb("checks-website-app-mode");
const mg = await connectFakeMailgun({ domain: "polygonparadise.com", region: "US" });
const { db } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runDomainCheck } = await import("@/server/services/checks/domain-check");
const { SPREADING } = await import("@/core/dns/checklist");
const { OWN_MAILBOX_TEXTS } = await import("@/core/sending/own-mailbox");

const P = mg.domain;
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
const noFetch = (async () => {
  throw new TypeError("fetch failed (no network in this test)");
}) as unknown as typeof fetch;

function zone(): FakeZone {
  return {
    [P]: { txt: [`v=spf1 include:dc-aa._spfm.${P} include:dc-bb._spfm.${P} ~all`], mx: [{ priority: 10, exchange: "mx.zoho.com" }] },
    [`dc-aa._spfm.${P}`]: { txt: ["v=spf1 include:zoho.com ~all"] },
    [`dc-bb._spfm.${P}`]: { txt: ["v=spf1 include:mailgun.org ~all"] },
    "zoho.com": { txt: ["v=spf1 ip4:136.143.188.0/24 ~all"] },
    "mailgun.org": { txt: ["v=spf1 ip4:192.0.2.40 ~all"] },
  };
}

function without(name: string): FakeZone {
  const z = zone();
  delete z[name];
  return z;
}

async function spfRow(a: FakeZone, b: FakeZone) {
  const state = await runDomainCheck({ lookups: [new FakeDns(a), new FakeDns(b)], mailgun, fetchImpl: noFetch });
  expect(state.replies).toBe("app");
  const row = state.rows.find((r) => r.key === "spf");
  if (!row) throw new Error("no spf row");
  return { row, state };
}

beforeAll(async () => {
  await makeOwner("Arslan", "arslan@polygonparadise.test");
  mg.fake.setDns("all");
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("a website domain checked in app mode (O37, review DOMAIN-4)", () => {
  it("a helper lost on both resolvers: the dangling fix, never an include to add", async () => {
    const { row, state } = await spfRow(without(`dc-bb._spfm.${P}`), without(`dc-bb._spfm.${P}`));
    expect(row).toMatchObject({
      status: "bad",
      text: `${P}'s SPF record includes dc-bb._spfm.${P}, which has no SPF record, so mail servers treat ${P}'s SPF as broken: your campaign emails and your everyday email fail SPF.`,
      records: [],
    });
    for (const r of state.rows) expect(r.fix ?? "", r.key).not.toMatch(/add include:|v=spf1/i);
    // The guard's MX row asks to connect again in own-mailbox mode.
    expect(state.rows.find((r) => r.key === "mx")).toMatchObject({ status: "bad", fix: OWN_MAILBOX_TEXTS.websiteInAppModeFix, records: [] });
  });

  it("lost on one resolver only: still spreading; Mailgun missing on both: connect again in own-mailbox mode", async () => {
    expect((await spfRow(without(`dc-bb._spfm.${P}`), zone())).row).toMatchObject({ status: "warn", text: SPREADING, fix: null });
    const noMailgun = zone();
    noMailgun[`dc-bb._spfm.${P}`] = { txt: ["v=spf1 ~all"] };
    expect((await spfRow(noMailgun, noMailgun)).row).toMatchObject({
      status: "bad",
      text: `${P}'s SPF record doesn't include Mailgun, so the app's emails fail SPF.`,
      fix: OWN_MAILBOX_TEXTS.websiteInAppModeFix,
    });
    expect((await spfRow(zone(), zone())).row.status).toBe("ok");
  });
});
