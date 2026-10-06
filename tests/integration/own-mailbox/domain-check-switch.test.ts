import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeOwner, setSetting, setState } from "../mail-events/seed";
import { FakeDns, type FakeZone } from "../../unit/checks/fake-dns";

/**
 * The domain check in own-mailbox mode, reviews DOMAIN-6 and DOMAIN-8: a check that read its Mailgun context before a
 * mode switch or a new sending domain never builds rows for the old domain in the new mode and never sends a notice for
 * them (it runs again, and after its reruns writes nothing); the Owner's from-mx notice names Cloudflare Email Routing
 * when that is what the row is red for.
 */

// Any real resolver in this file is a bug: node:dns is replaced by one that refuses to be made.
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    constructor() {
      throw new Error("A real DNS resolver was created in a test.");
    }
  },
}));

const t = await createTestDb("own-mailbox-domain-check-switch");
const mg = await connectFakeMailgun({
  domain: "example.com",
  region: "US",
  replies: "own-mailbox",
  fromAddress: "contact@example.com",
  plan: "free",
  fake: { plan: "free", receivesMail: false },
});
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runDomainCheck, FROM_DOMAIN_NOTICE_TEXTS } = await import("@/server/services/checks/domain-check");
const { parseDomainCheckState } = await import("@/core/system-state-parse");

const D = mg.domain;
const FROM = "contact@example.com";
const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
const noFetch = (async () => {
  throw new TypeError("fetch failed (no network in this test)");
}) as unknown as typeof fetch;
const previousPub = process.env.APP_PUBLIC_URL;

/** The owner's shape, with the MX given (Mailgun's by default: from-mx red, the notice due). */
function zone(mx: Array<{ priority: number; exchange: string }> = [{ priority: 10, exchange: "mxa.mailgun.org" }]): FakeZone {
  return {
    [D]: { mx, txt: [`v=spf1 include:dc-2._spfm.${D} ~all`] },
    [`dc-2._spfm.${D}`]: { txt: ["v=spf1 include:mailgun.org ~all"] },
    "mailgun.org": { txt: ["v=spf1 ip4:192.0.2.40 ~all"] },
    [`_dmarc.${D}`]: { txt: ["v=DMARC1; p=none"] },
  };
}

const lookups = (z: FakeZone): [FakeDns, FakeDns] => [new FakeDns(z), new FakeDns(z)];

async function mxNotes() {
  return db.notification.findMany({ where: { title: FROM_DOMAIN_NOTICE_TEXTS.mxTitle(D) } });
}

async function storedCheck() {
  const row = await db.systemState.findUnique({ where: { key: "domain.check" } });
  return row ? parseDomainCheckState(row.value) : null;
}

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = "";
  await makeOwner("Arslan", "arslan@polygonparadise.test");
  mg.fake.setDns("all");
});

beforeEach(async () => {
  await setSetting("mailgun.domain", D);
  await setSetting("mailgun.replies", "own-mailbox");
  await setSetting("mailgun.fromAddress", FROM);
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: { in: ["domain.check", "sending.pause", "notices"] } } });
    await c.notification.deleteMany({});
  });
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("review DOMAIN-8: the from-mx notice names the row's cause", () => {
  it("Cloudflare Email Routing: the notice says so (and how to fix it); a Mailgun MX keeps the own-mailbox body", async () => {
    const cf = await runDomainCheck({ lookups: lookups(zone([{ priority: 10, exchange: "route1.mx.cloudflare.net" }])), mailgun, fetchImpl: noFetch });
    expect(cf.rows.find((r) => r.key === "from-mx")).toMatchObject({ status: "bad", text: expect.stringContaining("Cloudflare Email Routing") });
    const notes = await mxNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwnCloudflare(D));
    expect(notes[0]!.body).toBe(
      "Mail for example.com goes to Cloudflare Email Routing instead of your mail provider, so your everyday email and the replies to your campaigns can be lost. Live campaign emails wait until it's fixed: switch Email Routing off in Cloudflare. Open Settings › Domain checklist.",
    );
    expect(notes[0]!.body).not.toContain("point to Mailgun");

    await dbWrite((c) => c.systemState.deleteMany({ where: { key: "notices" } }));
    await dbWrite((c) => c.notification.deleteMany({}));
    await runDomainCheck({ lookups: lookups(zone()), mailgun, fetchImpl: noFetch });
    expect((await mxNotes()).map((n) => n.body)).toEqual([FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwn(D)]);
  });
});

describe("review DOMAIN-6: a mode switch or a new domain while the check runs", () => {
  /**
   * The review's shape: the check reads its context in app mode for the old sending domain (example.com here, whose MX
   * is Mailgun's), then the Owner saves own-mailbox mode with another domain while it talks to Mailgun.
   */
  async function appModeContext() {
    await setSetting("mailgun.replies", "app");
    await setSetting("mailgun.fromAddress", null);
    const ctx = await mailgun();
    if (!ctx.connected) throw new Error(ctx.text);
    expect(ctx).toMatchObject({ domain: D, replies: "app" });
    return ctx;
  }
  async function switchToOwnMailbox() {
    await setSetting("mailgun.domain", "new.example");
    await setSetting("mailgun.replies", "own-mailbox");
    await setSetting("mailgun.fromAddress", "contact@new.example");
  }

  it("saved between the context and the mode read: no own-mailbox rows for the old domain, no notice; the round runs again", async () => {
    let calls = 0;
    const flipping = async () => {
      calls++;
      if (calls > 1) return { connected: false as const, reason: "no-domain" as const, text: "Mailgun isn't connected yet." };
      const ctx = await appModeContext();
      await switchToOwnMailbox();
      return ctx;
    };
    const state = await runDomainCheck({ lookups: lookups(zone()), mailgun: flipping, fetchImpl: noFetch });
    // The first round saw the switch and ran again (which found the new state).
    expect(calls).toBe(2);
    expect(state.rows.some((r) => r.key === "from-mx")).toBe(false);
    expect((await storedCheck())?.rows.some((r) => r.key === "from-mx")).toBe(false);
    // No false "example.com's mail servers (MX) point to Mailgun…" notice, and the 24-hour key isn't used up.
    expect(await mxNotes()).toHaveLength(0);
    expect(await db.systemState.findUnique({ where: { key: "notices" } })).toBeNull();
  });

  it("still moved after every rerun: nothing written, nobody told, the stored check returned as it was", async () => {
    const earlier = {
      domain: D,
      region: "US",
      checkedAt: "2026-09-28T08:00:00.000Z",
      lastVerifyAt: null,
      rows: [],
      error: null,
      replies: "app",
    };
    await setState("domain.check", earlier);
    // A context read before the switch, handed to every round.
    const stale = await appModeContext();
    await switchToOwnMailbox();
    let calls = 0;
    const state = await runDomainCheck({
      lookups: lookups(zone()),
      mailgun: async () => {
        calls++;
        return stale;
      },
      fetchImpl: noFetch,
    });
    expect(calls).toBe(3);
    expect(state).toMatchObject({ domain: D, checkedAt: earlier.checkedAt, rows: [], replies: "app" });
    expect(await storedCheck()).toMatchObject({ domain: D, checkedAt: earlier.checkedAt, rows: [] });
    expect(await mxNotes()).toHaveLength(0);
  });

  it("nothing moved: the check writes its rows and tells the Owner as before", async () => {
    const state = await runDomainCheck({ lookups: lookups(zone()), mailgun, fetchImpl: noFetch });
    expect(state).toMatchObject({ domain: D, replies: "own-mailbox" });
    expect(state.rows.find((r) => r.key === "from-mx")?.status).toBe("bad");
    expect(await mxNotes()).toHaveLength(1);
  });
});
