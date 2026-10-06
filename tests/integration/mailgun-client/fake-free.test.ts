import { afterAll, describe, expect, it } from "vitest";
import { parseCliArgs } from "../../fake-mailgun/cli";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";

/**
 * The fake Mailgun's free-plan and own-mailbox behaviour (MAIN-DOMAIN-DESIGN §7.8): `receivesMail: false` (the domain's
 * MX is a mail provider's), the daily limit over a rolling 24 hours, authorized recipients only, one inbound route, no
 * tracking certificate, 1 day of logs; `/__fake/state` reports them; the CLI flags; and today's defaults unchanged.
 * These call the fake over plain HTTP, independent of MailgunClient.
 */

const D = "example.com";
const AUTH = "Basic " + Buffer.from("api:key-fake-api").toString("base64");
const started: FakeMailgun[] = [];

afterAll(async () => {
  await Promise.all(started.map((f) => f.close()));
});

async function fakeWith(opts: Parameters<typeof startFakeMailgun>[0]): Promise<FakeMailgun> {
  const f = await startFakeMailgun({ domain: D, region: "US", ...opts });
  started.push(f);
  return f;
}

async function call(
  fake: FakeMailgun,
  method: string,
  path: string,
  body?: BodyInit,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(fake.origin + path, { method, headers: { authorization: AUTH }, body, redirect: "manual" });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function sendForm(to: string, n: number, testMode = false): FormData {
  const f = new FormData();
  f.append("from", `"Arslan from Polygon Paradise" <contact@${D}>`);
  f.append("to", to);
  f.append("subject", `Hello ${n}`);
  f.append("text", "Hello");
  f.append("h:Message-Id", `<pp.free${n}@${D}>`);
  if (testMode) f.append("o:testmode", "yes");
  return f;
}

function routeForm(expression: string): URLSearchParams {
  const f = new URLSearchParams();
  f.append("priority", "0");
  f.append("description", "test");
  f.append("expression", expression);
  f.append("action", "stop()");
  return f;
}

async function adminState(fake: FakeMailgun): Promise<Record<string, unknown>> {
  return (await (await fetch(`${fake.origin}/__fake/state`)).json()) as Record<string, unknown>;
}

describe("receivesMail: false (the domain's MX isn't Mailgun's)", () => {
  it("makes every preset answer land outside: nothing stored, no stored event, nothing posted", async () => {
    const fake = await fakeWith({ plan: "free", receivesMail: false });
    expect((await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 1))).status).toBe(200);
    const id = `pp.free1@${D}`;
    for (const preset of ["reply", "out-of-office", "unclear", "spam", "new-email", "bounce-notice"] as const) {
      const out = fake.receivePreset(preset, id);
      expect(out).toMatchObject({ ok: true, stored: false, deliveredTo: "outside", to: `contact@${D}` });
    }
    // The admin API honours it too.
    const res = await fetch(`${fake.origin}/__fake/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: "reply", inReplyTo: id }),
    });
    expect(await res.json()).toEqual({ ok: true, stored: false, deliveredTo: "outside", to: `contact@${D}` });
    const state = fake.state();
    expect(state.stored).toEqual([]);
    expect(state.logEvents.filter((e) => e.event === "stored")).toEqual([]);
    expect(state.receivesMail).toBe(false);
  });

  it("reports the receiving (MX) records as unverified, even when the fake's DNS says valid", async () => {
    const fake = await fakeWith({ plan: "free", receivesMail: false });
    fake.setDns("all");
    const res = await call(fake, "GET", `/v4/domains/${D}`);
    const body = res.json as { receiving_dns_records: Array<{ valid: string; value: string }>; sending_dns_records: Array<{ valid: string }> };
    expect(body.receiving_dns_records.map((r) => r.value)).toEqual(["mxa.mailgun.org", "mxb.mailgun.org"]);
    expect(body.receiving_dns_records.every((r) => r.valid === "unverified")).toBe(true);
    expect(body.sending_dns_records.every((r) => r.valid === "valid")).toBe(true);
  });
});

describe("the free plan", () => {
  it("refuses the 101st message in 24 hours with the limit answer (test mode counts), storing and eventing nothing", async () => {
    const now = new Date("2026-09-28T10:00:00Z");
    let clock = now;
    const fake = await fakeWith({ plan: "free", receivesMail: false, now: () => clock });
    for (let i = 0; i < 100; i++) {
      const res = await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", i, i % 2 === 0));
      expect(res.status).toBe(200);
    }
    const eventsBefore = fake.state().logEvents.length;
    const refused = await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 100));
    expect(refused).toEqual({ status: 400, json: { message: `Domain ${D} has reached its daily sending limit of 100 messages.` } });
    expect(fake.messages).toHaveLength(100);
    expect(fake.state().logEvents).toHaveLength(eventsBefore);
    expect(fake.state().sentLast24h).toBe(100);
    // 24 hours after the first one, room opens again.
    clock = new Date(now.getTime() + 24 * 3_600_000 + 1_000);
    expect((await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 101))).status).toBe(200);
    expect(fake.state().sentLast24h).toBe(1);
  });

  it("honours a smaller --daily-limit", async () => {
    const fake = await fakeWith({ plan: "free", dailyLimit: 2 });
    expect((await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 1))).status).toBe(200);
    expect((await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 2))).status).toBe(200);
    expect(await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 3))).toEqual({
      status: 400,
      json: { message: `Domain ${D} has reached its daily sending limit of 2 messages.` },
    });
  });

  it("with authorized recipients, refuses anyone else with the 403 and stores nothing", async () => {
    const fake = await fakeWith({ plan: "free", authorizedRecipients: ["Tess@Gmail.com"] });
    expect((await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 1))).status).toBe(200);
    const refused = await call(fake, "POST", `/v3/${D}/messages`, sendForm("anna@firma.de", 2));
    expect(refused).toEqual({
      status: 403,
      json: {
        message: `Domain ${D} is not allowed to send: Free accounts are for test purposes only. Please upgrade or add the address to authorized recipients in Account Settings.`,
      },
    });
    expect(fake.messages).toHaveLength(1);
    expect(fake.state().logEvents.every((e) => (e.recipient as string) === "tess@gmail.com")).toBe(true);
  });

  it("allows one inbound route: a second POST /v3/routes gets the 400", async () => {
    const fake = await fakeWith({ plan: "free" });
    expect((await call(fake, "POST", "/v3/routes", routeForm('match_recipient("a@example.com")'))).status).toBe(200);
    expect(await call(fake, "POST", "/v3/routes", routeForm('match_recipient("b@example.com")'))).toEqual({
      status: 400,
      json: { message: "You've reached the inbound routes limit of your plan." },
    });
    expect(fake.state().routes).toHaveLength(1);
  });

  it("has no tracking certificate (402, as basic) and keeps 1 day of logs", async () => {
    const fake = await fakeWith({ plan: "free" });
    fake.setDns("all");
    expect((await call(fake, "POST", `/v2/x509/email.${D}`)).status).toBe(402);
    expect((await call(fake, "PUT", `/v2/x509/email.${D}`)).status).toBe(402);
    expect(fake.options.retentionDays).toBe(1);
    expect((await fakeWith({ plan: "free", retentionDays: 3 })).options.retentionDays).toBe(3);
  });

  it("GET /__fake/state reports the plan, the limit, the authorized recipients, receivesMail and sentLast24h", async () => {
    const fake = await fakeWith({ plan: "free", receivesMail: false, authorizedRecipients: ["tess@gmail.com"] });
    await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 1));
    expect(await adminState(fake)).toMatchObject({
      receivesMail: false,
      plan: "free",
      dailyLimit: 100,
      authorizedRecipients: ["tess@gmail.com"],
      sentLast24h: 1,
    });
  });
});

describe("defaults stay as today", () => {
  it("foundation, receives mail, no daily limit, anyone may be sent to, 5 days of logs, routes unlimited", async () => {
    const fake = await fakeWith({});
    expect(fake.options).toMatchObject({ plan: "foundation", receivesMail: true, dailyLimit: null, authorizedRecipients: null, retentionDays: 5 });
    expect(await adminState(fake)).toMatchObject({ receivesMail: true, plan: "foundation", dailyLimit: null, authorizedRecipients: null, sentLast24h: 0 });
    for (let i = 0; i < 3; i++) {
      expect((await call(fake, "POST", "/v3/routes", routeForm(`match_recipient("r${i}@example.com")`))).status).toBe(200);
    }
    await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 1));
    const out = fake.receivePreset("reply", `pp.free1@${D}`);
    expect(out).toMatchObject({ ok: true, stored: true, deliveredTo: "mailgun", to: `contact@${D}` });
    fake.setDns("all");
    const domain = (await call(fake, "GET", `/v4/domains/${D}`)).json as { receiving_dns_records: Array<{ valid: string }> };
    expect(domain.receiving_dns_records.every((r) => r.valid === "valid")).toBe(true);
  });

  it("an explicit daily limit applies on another plan too; basic keeps today's retention", async () => {
    const fake = await fakeWith({ plan: "basic", dailyLimit: 1 });
    expect(fake.options).toMatchObject({ plan: "basic", dailyLimit: 1, retentionDays: 5 });
    expect((await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 1))).status).toBe(200);
    expect((await call(fake, "POST", `/v3/${D}/messages`, sendForm("tess@gmail.com", 2))).status).toBe(400);
  });
});

describe("the command line", () => {
  it("accepts --plan free --mx-elsewhere --daily-limit 5 --authorized a@x,b@y", () => {
    expect(parseCliArgs(["--plan", "free", "--mx-elsewhere", "--daily-limit", "5", "--authorized", "a@x.com,B@y.com"])).toMatchObject({
      plan: "free",
      receivesMail: false,
      dailyLimit: 5,
      authorizedRecipients: ["a@x.com", "b@y.com"],
    });
    expect(parseCliArgs(["--daily-limit=7"]).dailyLimit).toBe(7);
  });

  it("keeps today's defaults and refuses bad values", () => {
    const opts = parseCliArgs([]);
    expect(opts.plan).toBeUndefined();
    expect(opts.receivesMail).toBeUndefined();
    expect(opts.dailyLimit).toBeUndefined();
    expect(opts.authorizedRecipients).toBeUndefined();
    expect(() => parseCliArgs(["--plan", "scale"])).toThrow(/foundation, basic or free/);
    expect(() => parseCliArgs(["--daily-limit", "-1"])).toThrow(/--daily-limit/);
    expect(() => parseCliArgs(["--authorized", "not-an-address"])).toThrow(/--authorized/);
    expect(() => parseCliArgs(["--mx-elsewhere=yes"])).toThrow(/no value/);
  });
});
