import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { replyInput } from "../helpers/replies";
import { writeDomainCheck } from "../mailgun-setup/helpers";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { PRESET_TARGETS, presetInbound, findSentMessage } from "../../fake-mailgun/inbound-presets";
import { parseCliArgs } from "../../fake-mailgun/cli";

/**
 * The shared From address's step-C pieces that need a database or the fake Mailgun (docs/dev/SHARED-FROM-DESIGN.md
 * §7.1, §7.5, §7.8): the two new settings, loadTeamFrom, the fake's real preset targets and "outside" deliveries, its
 * DKIM authority, and the test helpers (connectFakeMailgun, writeDomainCheck, replyInput). Per-person behaviour of the
 * fake and the helpers is unchanged.
 */

const t = await createTestDb("shared-from-contracts");
const { db, dbTx } = await import("@/server/db");
const { getSetting, setSetting, SETTING_DEFAULTS } = await import("@/server/settings");
const { loadTeamFrom } = await import("@/server/services/mailgun/team-from");
const { parseDomainCheckState } = await import("@/core/system-state-parse");
const { getState } = await import("@/server/state");

const AUTH = "Basic " + Buffer.from("api:key-fake-api").toString("base64");
const D = "send.example.com";
const fakes: FakeMailgun[] = [];

afterAll(async () => {
  for (const f of fakes) await f.close();
  await db.$disconnect();
  t.cleanup();
});

async function fake(opts: Parameters<typeof startFakeMailgun>[0] = {}): Promise<FakeMailgun> {
  const f = await startFakeMailgun({ domain: D, ...opts });
  fakes.push(f);
  return f;
}

/** Sends one email through the fake's messages endpoint, as the app's client does. */
async function send(f: FakeMailgun, fields: Record<string, string>): Promise<string> {
  const res = await fetch(`${f.origin}/v3/${D}/messages`, { method: "POST", headers: { authorization: AUTH }, body: new URLSearchParams(fields) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id.replace(/^<|>$/g, "");
}

async function admin(f: FakeMailgun, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${f.origin}/__fake/inbound`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const EMAIL = { to: "Anna Berg <anna@firma.de>", subject: "3D models for your shop", text: "Hi Anna" };
/** Per-person mode: From = the sender's own address, no Reply-To (what the app sends today). */
const OWN_EMAIL = { ...EMAIL, from: "Ali from Polygon Paradise <ali@send.example.com>", "h:Message-Id": "<pp.own1@send.example.com>" };
/** Shared-From mode: From = the shared address, Reply-To = the sender's own address. */
const TEAM_EMAIL = {
  ...EMAIL,
  from: "Ali from Polygon Paradise <contact@example.com>",
  "h:Reply-To": "ali@send.example.com",
  "h:Message-Id": "<pp.team1@send.example.com>",
};

/** The rows of SystemState "domain.check", parsed. */
async function checkRows() {
  return parseDomainCheckState((await getState("domain.check"))?.value ?? null).rows;
}

describe("settings (§7.1)", () => {
  it("both new settings default to null (per-person mode)", async () => {
    expect(SETTING_DEFAULTS["mailgun.fromAddress"]).toBeNull();
    expect(SETTING_DEFAULTS["sending.goLiveFrom"]).toBeNull();
    expect(await getSetting("mailgun.fromAddress")).toBeNull();
    expect(await getSetting("sending.goLiveFrom")).toBeNull();
  });
});

describe("loadTeamFrom (§7.5)", () => {
  it("is per-person mode on a fresh database", async () => {
    // MAIN-DOMAIN-DESIGN §7.5: app mode (the default) with no own From and no evidence From.
    expect(await loadTeamFrom()).toEqual({
      address: null,
      saved: null,
      domain: null,
      problem: null,
      changedAt: null,
      replies: "app",
      ownFrom: null,
      evidenceFrom: null,
    });
  });

  it("reads a saved address that fits, with when it changed; inside a transaction too", async () => {
    await setSetting("mailgun.domain", "Send.Example.com", null);
    await setSetting("mailgun.fromAddress", " Contact@Example.com ", null);
    const row = await db.setting.findUniqueOrThrow({ where: { key: "mailgun.fromAddress" } });
    const team = await loadTeamFrom();
    expect(team).toEqual({
      address: "contact@example.com",
      saved: "contact@example.com",
      domain: D,
      problem: null,
      changedAt: row.updatedAt,
      replies: "app",
      ownFrom: null,
      evidenceFrom: "contact@example.com",
    });
    expect(await dbTx((tx) => loadTeamFrom(tx))).toEqual(team);
  });

  it("fails closed when the saved address no longer fits, or there is no sending domain", async () => {
    await setSetting("mailgun.fromAddress", "contact@other.com", null);
    expect(await loadTeamFrom()).toMatchObject({
      address: null,
      saved: "contact@other.com",
      domain: D,
      problem: "The From address contact@other.com doesn't fit your sending domain send.example.com. Change or clear it in Settings › Sending & Mailgun.",
    });
    await setSetting("mailgun.domain", null, null);
    expect(await loadTeamFrom()).toMatchObject({
      address: null,
      saved: "contact@other.com",
      domain: null,
      problem: "Connect Mailgun first: the From address must fit your sending domain.",
    });
  });

  it("an empty or cleared value is per-person mode", async () => {
    await setSetting("mailgun.domain", D, null);
    await setSetting("mailgun.fromAddress", "  ", null);
    expect(await loadTeamFrom()).toMatchObject({ address: null, saved: null, problem: null });
    await setSetting("mailgun.fromAddress", null, null);
    expect(await loadTeamFrom()).toMatchObject({ address: null, saved: null, domain: D, problem: null });
    expect((await loadTeamFrom()).changedAt).toBeInstanceOf(Date);
  });
});

describe("the fake's preset targets (§7.8)", () => {
  it("per-person email: every preset still goes to the sender's own address and is stored", async () => {
    const f = await fake();
    const id = await send(f, OWN_EMAIL);
    const message = findSentMessage(f.messages, id)!;
    for (const preset of Object.keys(PRESET_TARGETS) as Array<keyof typeof PRESET_TARGETS>) {
      expect(presetInbound(preset, message).to, preset).toBe("ali@send.example.com");
      const res = await admin(f, { preset, inReplyTo: id });
      expect(res.json, preset).toMatchObject({ ok: true, stored: true, deliveredTo: "mailgun", to: "ali@send.example.com" });
      expect(typeof res.json.storageKey).toBe("string");
    }
    expect(f.state().stored).toHaveLength(6);
  });

  it("shared-From email: replies go to the Reply-To; a new email and a bounce notice go to the From, outside the fake", async () => {
    const f = await fake();
    const id = await send(f, TEAM_EMAIL);
    const message = findSentMessage(f.messages, id)!;
    expect(presetInbound("reply", message)).toMatchObject({ to: "ali@send.example.com", target: "reply-to", text: expect.stringMatching(/^Hi Ali,/) });
    expect(presetInbound("out-of-office", message)).toMatchObject({ to: "ali@send.example.com", target: "reply-to" });
    expect(presetInbound("new-email", message)).toMatchObject({ to: "contact@example.com", target: "from" });
    expect(presetInbound("bounce-notice", message)).toMatchObject({ to: "contact@example.com", target: "from" });
    expect(presetInbound("reply", message, { to: "from" })).toMatchObject({ to: "contact@example.com", target: "from" });

    expect((await admin(f, { preset: "reply", inReplyTo: id })).json).toMatchObject({ stored: true, to: "ali@send.example.com" });
    const events = f.state().logEvents.length;
    const outside = await admin(f, { preset: "new-email", inReplyTo: id, notify: true });
    expect(outside).toEqual({ status: 200, json: { ok: true, stored: false, deliveredTo: "outside", to: "contact@example.com" } });
    expect((await admin(f, { preset: "bounce-notice", inReplyTo: id })).json).toMatchObject({ stored: false, deliveredTo: "outside" });
    expect((await admin(f, { preset: "reply", inReplyTo: id, to: "from" })).json).toMatchObject({ stored: false, to: "contact@example.com" });
    expect((await admin(f, { preset: "new-email", inReplyTo: id, to: "reply-to" })).json).toMatchObject({ stored: true, to: "ali@send.example.com" });
    // An explicit address still overrides the target (on the fake's domain: stored).
    expect((await admin(f, { preset: "new-email", inReplyTo: id, to: "sara@send.example.com" })).json).toMatchObject({ stored: true, to: "sara@send.example.com" });
    expect(f.state().stored).toHaveLength(3);
    expect(f.state().logEvents.length).toBe(events + 2);
    // Plain receive() (no preset) keeps taking any recipient.
    expect((await admin(f, { from: "a@b.test", to: "contact@example.com", subject: "s", text: "t" })).json).toMatchObject({ stored: true });
  });

  it("receivePreset: the same targets and the outside answer, from code", async () => {
    const f = await fake({ otherDomains: ["old.example.com"] });
    const id = await send(f, TEAM_EMAIL);
    const reply = f.receivePreset("reply", id);
    expect(reply).toMatchObject({ ok: true, stored: true, deliveredTo: "mailgun", to: "ali@send.example.com", target: "reply-to" });
    expect(reply.stored && reply.fields.recipient).toBe("ali@send.example.com");
    expect(f.receivePreset("new-email", "<pp.team1@send.example.com>")).toEqual({
      ok: true,
      stored: false,
      deliveredTo: "outside",
      to: "contact@example.com",
      target: "from",
    });
    expect(f.receivePreset("new-email", id, { to: "reply-to", overrides: { subject: "Hello" } })).toMatchObject({ stored: true });
    expect(f.receivePreset("reply", id, { overrides: { to: "x@old.example.com" } })).toMatchObject({ stored: true, to: "x@old.example.com" });
    expect(f.receivePreset("reply", id, { overrides: { to: "x@mail.old.example.com" } })).toMatchObject({ stored: true });
    expect(() => f.receivePreset("reply", "nope@x")).toThrow(/has no sent message nope@x/);
    expect(f.state().stored).toHaveLength(4);
  });
});

describe("the fake's DKIM authority (§7.8)", () => {
  async function dkimName(f: FakeMailgun): Promise<string> {
    const res = await fetch(`${f.origin}/v4/domains/${D}`, { headers: { authorization: AUTH } });
    const body = (await res.json()) as { sending_dns_records: Array<{ name: string }> };
    return body.sending_dns_records.map((r) => r.name).find((n) => n.includes("._domainkey."))!;
  }

  it("names the DKIM record after the domain by default, and after the authority when given", async () => {
    const plain = await fake();
    expect(plain.dkimAuthority).toBe(D);
    expect(plain.state().dkimAuthority).toBe(D);
    expect(await dkimName(plain)).toBe("pdk1._domainkey.send.example.com");
    const signed = await fake({ dkimAuthority: "Example.com" });
    expect(signed.dkimAuthority).toBe("example.com");
    expect(await dkimName(signed)).toBe("pdk1._domainkey.example.com");
    signed.reset();
    expect(await dkimName(signed)).toBe("pdk1._domainkey.example.com");
  });

  it("takes --dkim-authority on the command line", () => {
    expect(parseCliArgs(["--dkim-authority", "Example.com."]).dkimAuthority).toBe("example.com");
    expect(parseCliArgs(["--dkim-authority=example.co.uk"]).dkimAuthority).toBe("example.co.uk");
    expect(parseCliArgs([]).dkimAuthority).toBeUndefined();
    expect(() => parseCliArgs(["--dkim-authority", "not a domain"])).toThrow(/must be a domain name/);
    expect(() => parseCliArgs(["--dkim-authority"])).toThrow(/needs a value/);
  });
});

describe("test helpers (§7.8)", () => {
  it("connectFakeMailgun writes the From address when given and passes the DKIM authority", async () => {
    const mg = await connectFakeMailgun({ fromAddress: "contact@example.com", dkimAuthority: "example.com" });
    try {
      expect(await getSetting("mailgun.fromAddress")).toBe("contact@example.com");
      expect(mg.dkimAuthority).toBe("example.com");
      expect(mg.fake.state().dkimAuthority).toBe("example.com");
      expect((await loadTeamFrom()).address).toBe("contact@example.com");
    } finally {
      await mg.stop();
    }
    const again = await connectFakeMailgun();
    try {
      // Left out: the setting isn't touched, and the DKIM authority is the domain.
      expect(await getSetting("mailgun.fromAddress")).toBe("contact@example.com");
      expect(again.dkimAuthority).toBe(D);
    } finally {
      await again.stop();
    }
    const cleared = await connectFakeMailgun({ fromAddress: null });
    try {
      expect(await getSetting("mailgun.fromAddress")).toBeNull();
      expect((await loadTeamFrom()).address).toBeNull();
    } finally {
      await cleared.stop();
    }
  });

  it("writeDomainCheck writes today's 20 rows, and the from-* rows only when asked, right after dmarc", async () => {
    await writeDomainCheck(D);
    const plain = await checkRows();
    expect(plain).toHaveLength(20);
    expect(plain.some((r) => r.key === "from-mx" || r.key === "from-spf")).toBe(false);
    await writeDomainCheck(D, { "from-mx": "bad" });
    const team = await checkRows();
    expect(team).toHaveLength(21);
    const keys = team.map((r) => r.key);
    expect(keys[keys.indexOf("dmarc") + 1]).toBe("from-mx");
    expect(team.find((r) => r.key === "from-mx")).toMatchObject({ group: "dns", status: "bad", fix: "Fix from-mx" });
    await writeDomainCheck(D, { "from-mx": "ok", "from-spf": "info" });
    const both = (await checkRows()).map((r) => r.key);
    expect(both.slice(both.indexOf("dmarc"), both.indexOf("dmarc") + 3)).toEqual(["dmarc", "from-mx", "from-spf"]);
  });

  it("replyInput answers to the Reply-To when the email had one, else to the From address", () => {
    const email = { toEmail: "anna@firma.de", fromAddress: "Ali <contact@example.com>", subject: "Hi", messageId: "pp.1@send.example.com" };
    expect(replyInput({ ...email, replyTo: "ali@send.example.com" }).to).toBe("ali@send.example.com");
    expect(replyInput({ ...email, replyTo: null }).to).toBe("contact@example.com");
    expect(replyInput({ ...email, fromAddress: "Ali <ali@send.example.com>" }).to).toBe("ali@send.example.com");
  });
});
