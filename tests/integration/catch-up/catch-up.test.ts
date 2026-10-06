import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { makeOwner, seedEmail, setSetting, setState, type SeededEmail } from "../mail-events/seed";

const t = await createTestDb("catch-up");
const mg = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const { runCatchUp, checkCatchUpAge, CURSOR_LAG_MS, isOwnSend, logsWindow } = await import("@/server/services/mailgun/catch-up");
const { normalizeLogItem } = await import("@/core/mailgun/events");
const { createCatchUpJob } = await import("../../../worker/jobs/mailgun-catch-up");
const { getPauseState } = await import("@/server/services/sending/pause");

const mailgun = () => getMailgunContext({ retryDelayMs: () => 0 });
const HOUR = 3_600_000;
let ownerId: number;

function rfc2822(d: Date): string {
  return d.toUTCString().slice(0, 25) + " -0000";
}

async function resetApp() {
  await dbWrite(async (c) => {
    await c.systemState.deleteMany({ where: { key: { in: ["sending.pause", "mailgun.catchUp", "catchup.outage", "notices", "mailgun.setup"] } } });
    await c.syncCursor.deleteMany({});
  });
}

beforeAll(async () => {
  ownerId = (await makeOwner()).id;
});

beforeEach(async () => {
  mg.fake.reset();
  await resetApp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

/** Sends one seeded email through the fake Mailgun, so its Logs show an `accepted` event. */
async function sendThroughFake(s: SeededEmail) {
  const ctx = await mailgun();
  if (!ctx.connected) throw new Error(ctx.text);
  await ctx.sendClient.sendMessage(ctx.domain, {
    from: "Arslan <arslan@send.example.com>",
    to: s.toNorm,
    subject: "Hello",
    text: "Hi",
    html: "<p>Hi</p>",
    messageId: s.messageId,
    tags: ["outreach", "step-0"],
    variables: { send_id: s.sendId, campaign_id: String(s.campaignId), step: "0" },
    purpose: "campaign",
    guard: { goLive: true, testList: new Set() },
    // M6-DESIGN §2.3: a campaign launched after go-live (the client guard fails closed without the flag).
    testListOnly: false,
  });
}

function logsQueries() {
  return mg.fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/analytics/logs");
}

describe("runCatchUp: the Logs", () => {
  it("applies every event since the start (first run: the whole retention) and moves the cursor 30 minutes behind", async () => {
    const a = await seedEmail({ createdById: ownerId, status: "UNKNOWN", followUp: false, providerId: null });
    const b = await seedEmail({ createdById: ownerId });
    await sendThroughFake(a);
    await sendThroughFake(b);
    mg.fake.deliver(a.messageId);
    mg.fake.bounce(b.messageId);
    const now = new Date();
    const summary = await runCatchUp({ reason: "manual", now, mailgun });
    expect(summary.domains).toEqual([mg.domain]);
    expect(summary.eventsApplied).toBe(4);
    // Proof of sending: the UNKNOWN row is recorded as sent.
    expect(await db.outboundEmail.findUniqueOrThrow({ where: { id: a.emailId } })).toMatchObject({ status: "SENT", deliveredAt: expect.any(Date) });
    expect((await db.campaignRecipient.findUniqueOrThrow({ where: { id: b.recipientId } })).state).toBe("STOPPED");
    const first = logsQueries().find((r) => (r.body as { events: string[] }).events.includes("delivered"))!;
    expect((first.body as { start: string }).start).toBe(rfc2822(new Date(now.getTime() - 5 * 24 * HOUR + HOUR)));
    const cursor = await db.syncCursor.findUniqueOrThrow({ where: { key: `${mg.domain}:logs` } });
    expect(cursor.value).toBe(new Date(now.getTime() - CURSOR_LAG_MS).toISOString());
    const state = (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
    expect(state).toMatchObject({ lastSuccessAt: now.toISOString(), lastError: null, lastReason: "manual" });
    // No older domain had a problem: the state looks exactly as before M6 (no `oldDomains` field).
    expect(state).not.toHaveProperty("oldDomains");
  });

  it("reads from cursor − 1 h next time, never moves the cursor backwards, and is idempotent", async () => {
    const s = await seedEmail({ createdById: ownerId });
    await sendThroughFake(s);
    mg.fake.deliver(s.messageId);
    const now = new Date();
    await runCatchUp({ reason: "startup", now, mailgun });
    const later = new Date(now.getTime() + HOUR);
    mg.fake.requests.length = 0;
    const second = await runCatchUp({ reason: "hourly", now: later, mailgun });
    expect(second.eventsApplied).toBe(0);
    const q = logsQueries().find((r) => (r.body as { events: string[] }).events.includes("delivered"))!;
    expect((q.body as { start: string }).start).toBe(rfc2822(new Date(now.getTime() - CURSOR_LAG_MS - HOUR)));
    const key = `${mg.domain}:logs`;
    expect((await db.syncCursor.findUniqueOrThrow({ where: { key } })).value).toBe(new Date(later.getTime() - CURSOR_LAG_MS).toISOString());
    await runCatchUp({ reason: "manual", now, mailgun });
    expect((await db.syncCursor.findUniqueOrThrow({ where: { key } })).value).toBe(new Date(later.getTime() - CURSOR_LAG_MS).toISOString());
    expect(await db.mailEvent.count({ where: { outboundEmailId: s.emailId } })).toBe(2);
  });

  it("records the gap when the PC was off longer than Mailgun keeps its logs", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 10 * 24 * HOUR);
    await dbWrite((c) => c.syncCursor.create({ data: { key: `${mg.domain}:logs`, value: old.toISOString() } }));
    await runCatchUp({ reason: "startup", now, mailgun });
    const outage = (await db.systemState.findUniqueOrThrow({ where: { key: "catchup.outage" } })).value as Record<string, unknown>;
    expect(outage).toMatchObject({
      from: old.toISOString(),
      to: new Date(now.getTime() - 5 * 24 * HOUR + HOUR).toISOString(),
      beyondLogRetention: true,
      detectedAt: now.toISOString(),
    });
  });

  it("records no gap when the cursor is still inside Mailgun's log retention (only the overlap is trimmed)", async () => {
    const now = new Date();
    const floor = new Date(now.getTime() - 5 * 24 * HOUR + HOUR);
    // Off for about 4 days 22.5 hours: the cursor is 30 minutes inside the window, so nothing was missed.
    const cursor = new Date(floor.getTime() + 30 * 60_000);
    await dbWrite((c) => c.syncCursor.create({ data: { key: `${mg.domain}:logs`, value: cursor.toISOString() } }));
    await runCatchUp({ reason: "startup", now, mailgun });
    expect(await db.systemState.findUnique({ where: { key: "catchup.outage" } })).toBeNull();
    const q = logsQueries().find((r) => (r.body as { events: string[] }).events.includes("delivered"))!;
    expect((q.body as { start: string }).start).toBe(rfc2822(floor));

    // The window itself: start = max(cursor − 1 h, floor); a gap only for a cursor before the floor, never from > to.
    const retention = 5 * 24 * HOUR;
    expect(logsWindow(null, now, retention)).toEqual({ start: floor, gap: null });
    expect(logsWindow(cursor, now, retention)).toEqual({ start: floor, gap: null });
    const recent = new Date(now.getTime() - 2 * HOUR);
    expect(logsWindow(recent, now, retention)).toEqual({ start: new Date(recent.getTime() - HOUR), gap: null });
    expect(logsWindow(floor, now, retention)).toEqual({ start: floor, gap: null });
    const old = new Date(floor.getTime() - 1);
    expect(logsWindow(old, now, retention)).toEqual({ start: floor, gap: { from: old, to: floor } });
  });

  it("applies at most 20 events per transaction", async () => {
    const emails: SeededEmail[] = [];
    for (let i = 0; i < 23; i++) emails.push(await seedEmail({ createdById: ownerId, followUp: false }));
    for (const e of emails) {
      await sendThroughFake(e);
      mg.fake.deliver(e.messageId);
    }
    const perTx: number[] = [];
    const original = db.$transaction.bind(db) as (fn: unknown, opts?: unknown) => Promise<unknown>;
    vi.spyOn(db, "$transaction").mockImplementation(((fn: unknown, opts?: unknown) => {
      if (typeof fn !== "function") return original(fn, opts);
      return original(async (tx: Record<string, unknown>) => {
        let created = 0;
        const counting = new Proxy(tx, {
          get(target, prop) {
            const value = target[prop as string];
            if (prop !== "mailEvent") return value;
            return new Proxy(value as Record<string, unknown>, {
              get(me, p) {
                const fnv = me[p as string];
                if (p !== "create" || typeof fnv !== "function") return fnv;
                return (...args: unknown[]) => {
                  created += 1;
                  return (fnv as (...a: unknown[]) => unknown).apply(me, args);
                };
              },
            });
          },
        });
        const r = await (fn as (tx: unknown) => Promise<unknown>)(counting);
        perTx.push(created);
        return r;
      }, opts);
    }) as never);
    const summary = await runCatchUp({ reason: "manual", mailgun });
    vi.restoreAllMocks();
    expect(summary.eventsApplied).toBe(46);
    expect(Math.max(...perTx)).toBeLessThanOrEqual(20);
    expect(perTx.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(46);
  });

  it("reports a Message-ID Mailgun accepted twice", async () => {
    const s = await seedEmail({ createdById: ownerId, followUp: false });
    await sendThroughFake(s);
    await sendThroughFake(s);
    const summary = await runCatchUp({ reason: "manual", mailgun });
    expect(summary.duplicatesFound).toBe(1);
    const act = await db.activityLog.findFirstOrThrow({ where: { type: "email.duplicate", campaignId: s.campaignId } });
    expect(act.summary).toBe("Mailgun accepted this email twice");
    const note = await db.notification.findFirstOrThrow({ where: { title: "An email may have gone out twice" } });
    expect(note.body).toBe(`Mailgun accepted the email to ${s.toNorm} twice. Please tell us: this shouldn't happen.`);
    // Found again in the overlap next hour: no second activity.
    await runCatchUp({ reason: "hourly", now: new Date(Date.now() + 60_000), mailgun });
    expect(await db.activityLog.count({ where: { type: "email.duplicate", campaignId: s.campaignId } })).toBe(1);
  });

  it("never reports a Message-ID that isn't one of the app's emails (a reply forwarded by two routes)", async () => {
    const ctx = await mailgun();
    if (!ctx.connected) throw new Error(ctx.text);
    // Two `accepted` events with the prospect's own Message-ID (forwarded to two of our addresses), no email of ours.
    // Mailgun's routes make these, never the app: they go straight to the fake's messages endpoint, because the app's
    // own client refuses a From outside the sending domain before any request (SHARED-FROM-DESIGN §2.4, F8).
    const auth = "Basic " + Buffer.from(`api:${mg.apiKey}`).toString("base64");
    for (const to of ["arslan.inbox@gmail.com", "ali.inbox@gmail.com"]) {
      const res = await fetch(`${mg.fake.origin}/v3/${mg.domain}/messages`, {
        method: "POST",
        headers: { authorization: auth },
        body: new URLSearchParams({
          from: "Anna <anna@firma.de>",
          to,
          subject: "Re: Hello",
          text: "Sounds good",
          html: "<p>Sounds good</p>",
          "h:Message-Id": "<cafe123@mail.gmail.com>",
        }),
      });
      expect(res.status).toBe(200);
    }
    // Also one of our own Message-IDs that no campaign email has (nothing to report either).
    for (let i = 0; i < 2; i++) {
      await ctx.sendClient.sendMessage(ctx.domain, {
        from: "Arslan <arslan@send.example.com>",
        to: "someone@studio.de",
        subject: "Hello",
        text: "Hi",
        html: "<p>Hi</p>",
        messageId: `pp.nobody@${mg.domain}`,
        tags: [],
        variables: {},
        purpose: "campaign",
        guard: { goLive: true, testList: new Set() },
        testListOnly: false,
      });
    }
    const notesBefore = await db.notification.count({ where: { title: "An email may have gone out twice" } });
    const activitiesBefore = await db.activityLog.count({ where: { type: "email.duplicate" } });
    const summary = await runCatchUp({ reason: "manual", mailgun });
    expect(summary.duplicatesFound).toBe(0);
    expect(await db.notification.count({ where: { title: "An email may have gone out twice" } })).toBe(notesBefore);
    expect(await db.activityLog.count({ where: { type: "email.duplicate" } })).toBe(activitiesBefore);
  });

  it("counts only the app's own sends, never a routed (forwarded) message", () => {
    const item = (over: Record<string, unknown>) =>
      normalizeLogItem({ id: "e1", event: "accepted", "@timestamp": new Date().toISOString(), message: { headers: { "message-id": "<x@y>" } }, ...over })!;
    const ours = item({ message: { headers: { "message-id": `<pp.abc@${mg.domain}>` } } });
    expect(isOwnSend(ours, mg.domain)).toBe(true);
    expect(isOwnSend(ours, "other.example.com")).toBe(false);
    expect(isOwnSend(item({}), mg.domain)).toBe(false);
    // Mailgun rewrote our Message-ID: our send_id still says it's ours.
    expect(isOwnSend(item({ "user-variables": JSON.stringify({ send_id: "abc" }) }), mg.domain)).toBe(true);
    expect(isOwnSend(item({ "user-variables": JSON.stringify({ test_send_id: "12" }) }), mg.domain)).toBe(true);
    expect(isOwnSend({ ...ours, raw: { ...(ours.raw as object), flags: { "is-routed": true } } }, mg.domain)).toBe(false);
  });
});

describe("runCatchUp: stored replies", () => {
  it("fetches a reply whose notification never arrived, once", async () => {
    mg.fake.receive({ from: "Anna Berg <anna@firma.de>", to: "arslan@send.example.com", subject: "Re: Hello", text: "Sounds good." });
    const summary = await runCatchUp({ reason: "startup", mailgun });
    expect(summary.inboundStored).toBe(1);
    const row = await db.inboundMessage.findFirstOrThrow({ where: { fromEmail: "anna@firma.de" } });
    expect(row).toMatchObject({ source: "CATCHUP", snippet: "Sounds good.", subject: "Re: Hello", processedAt: null, toAddress: "arslan@send.example.com" });
    expect((await runCatchUp({ reason: "hourly", mailgun })).inboundStored).toBe(0);
    expect(await db.inboundMessage.count({ where: { fromEmail: "anna@firma.de" } })).toBe(1);
  });

  it("records a reply whose body expired from the log alone, and notes the gap", async () => {
    const received = new Date();
    mg.fake.receive({ from: "late@firma.de", to: "arslan@send.example.com", subject: "Re: Old", text: "Gone by now", at: received });
    const later = new Date(received.getTime() + 2 * 24 * HOUR);
    mg.fake.setNow(() => later);
    try {
      const summary = await runCatchUp({ reason: "startup", now: later, mailgun });
      expect(summary.inboundStored).toBe(1);
    } finally {
      mg.fake.setNow(() => new Date());
    }
    const row = await db.inboundMessage.findFirstOrThrow({ where: { fromEmail: "late@firma.de" } });
    expect(row).toMatchObject({ source: "CATCHUP", snippet: "", subject: "Re: Old" });
    expect(row.storageKey).toEqual(expect.any(String));
    const outage = (await db.systemState.findUniqueOrThrow({ where: { key: "catchup.outage" } })).value as Record<string, unknown>;
    expect(outage.beyondMessageRetention).toBe(true);
  });

  it("records a reply from the log alone when its storage URL keeps refusing it (400), and still succeeds", async () => {
    mg.fake.receive({ from: "refused@firma.de", to: "arslan@send.example.com", subject: "Re: Refused", text: "Body" });
    mg.fake.failNext("GET /v3/domains/:d/messages/:key", { kind: "status", status: 400, body: { message: "Bad request" } }, 20);
    const now = new Date();
    const summary = await runCatchUp({ reason: "startup", now, mailgun });
    expect(summary.inboundStored).toBe(1);
    const row = await db.inboundMessage.findFirstOrThrow({ where: { fromEmail: "refused@firma.de" } });
    expect(row).toMatchObject({ source: "CATCHUP", snippet: "", subject: "Re: Refused" });
    const state = (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
    expect(state).toMatchObject({ lastSuccessAt: now.toISOString(), lastError: null });
    expect((await db.syncCursor.findUniqueOrThrow({ where: { key: `${mg.domain}:stored` } })).value).toBe(new Date(now.getTime() - CURSOR_LAG_MS).toISOString());
  });

  it("a 401/403 from a storage URL is that email's problem, never a key pause, when a normal call proves the key", async () => {
    mg.fake.receive({ from: "forbidden@firma.de", to: "arslan@send.example.com", subject: "Re: Forbidden", text: "Body" });
    mg.fake.failNext("GET /v3/domains/:d/messages/:key", { kind: "status", status: 403, body: { message: "Forbidden" } }, 20);
    const summary = await runCatchUp({ reason: "startup", mailgun });
    expect(summary.inboundStored).toBe(1);
    expect(await db.inboundMessage.findFirstOrThrow({ where: { fromEmail: "forbidden@firma.de" } })).toMatchObject({ snippet: "" });
    expect((await getPauseState()).paused).toBe(false);
    // The key was checked with a normal API call (the account check's call, then one more for the storage answer).
    expect(mg.fake.requests.filter((r) => r.method === "GET" && r.path === `/v3/domains/${mg.domain}/sending_queues`)).toHaveLength(2);
  });

  it("a 401/403 from a storage URL pauses sending only when the key really is bad", async () => {
    mg.fake.receive({ from: "badkey@firma.de", to: "arslan@send.example.com", subject: "Re: Bad key", text: "Body" });
    let storageRefused = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/messages/")) {
        storageRefused = true;
        return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      // The key was revoked in the meantime: the checking call is refused too.
      if (storageRefused && url.includes("/sending_queues")) {
        return new Response(JSON.stringify({ message: "Invalid private key" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return fetch(input, init);
    };
    const withFetch = () => getMailgunContext({ retryDelayMs: () => 0, fetchImpl });
    await expect(runCatchUp({ reason: "startup", mailgun: withFetch })).rejects.toThrow(/API key/);
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-auth" });
    expect(await db.inboundMessage.count({ where: { fromEmail: "badkey@firma.de" } })).toBe(0);
  });

  it("a reply that can't be fetched right now doesn't stop the others; it's fetched on the next run", async () => {
    const t0 = new Date();
    mg.fake.receive({ from: "flaky@firma.de", to: "arslan@send.example.com", subject: "Re: Flaky", text: "First", at: new Date(t0.getTime() - 2 * HOUR) });
    mg.fake.receive({ from: "fine@firma.de", to: "arslan@send.example.com", subject: "Re: Fine", text: "Second", at: new Date(t0.getTime() - HOUR) });
    // The first reply's GET fails with 503 on every try (1 + 3 retries); the second one is answered normally.
    mg.fake.failNext("GET /v3/domains/:d/messages/:key", { kind: "status", status: 503, body: { message: "Service Unavailable" } }, 4);
    await expect(runCatchUp({ reason: "startup", now: t0, mailgun })).rejects.toThrow(/Mailgun had a problem/);
    expect(await db.inboundMessage.findFirst({ where: { fromEmail: "fine@firma.de" } })).toMatchObject({ snippet: "Second" });
    expect(await db.inboundMessage.count({ where: { fromEmail: "flaky@firma.de" } })).toBe(0);
    let state = (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
    // A passing problem: the catch-up gate's 15-minute fallback still applies, and nothing is paused.
    expect(state).toMatchObject({ lastErrorKind: "server", lastSuccessAt: null });
    expect((await getPauseState()).paused).toBe(false);
    // The stored-replies cursor waits at the reply that couldn't be fetched.
    const cursor = await db.syncCursor.findUniqueOrThrow({ where: { key: `${mg.domain}:stored` } });
    expect(Date.parse(cursor.value)).toBeLessThanOrEqual(t0.getTime() - 2 * HOUR + 1000);

    const t1 = new Date(t0.getTime() + 60_000);
    const second = await runCatchUp({ reason: "hourly", now: t1, mailgun });
    expect(second.inboundStored).toBe(1);
    expect(await db.inboundMessage.findFirst({ where: { fromEmail: "flaky@firma.de" } })).toMatchObject({ snippet: "First" });
    state = (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
    expect(state).toMatchObject({ lastSuccessAt: t1.toISOString() });
  });

  it("a passing problem with a reply whose body Mailgun no longer keeps records it from the log alone", async () => {
    const received = new Date();
    mg.fake.receive({ from: "gone@firma.de", to: "arslan@send.example.com", subject: "Re: Gone", text: "Old", at: received });
    const later = new Date(received.getTime() + 2 * 24 * HOUR);
    mg.fake.setNow(() => later);
    mg.fake.failNext("GET /v3/domains/:d/messages/:key", { kind: "status", status: 503, body: { message: "Service Unavailable" } }, 4);
    try {
      const summary = await runCatchUp({ reason: "startup", now: later, mailgun });
      expect(summary.inboundStored).toBe(1);
    } finally {
      mg.fake.setNow(() => new Date());
    }
    expect(await db.inboundMessage.findFirstOrThrow({ where: { fromEmail: "gone@firma.de" } })).toMatchObject({ snippet: "", subject: "Re: Gone" });
  });
});

describe("runCatchUp: account checks", () => {
  it("pauses when Mailgun stopped accepting emails", async () => {
    mg.fake.disableQueue("You have too many messages in queue");
    await runCatchUp({ reason: "manual", mailgun });
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "mailgun-queue", reason: "Mailgun stopped accepting emails" });
    expect(pause.fixText).toBe(
      `Mailgun has stopped accepting emails from ${mg.domain}: You have too many messages in queue. Check Mailgun's dashboard, then click Resume.`,
    );
  });

  it("pauses when tracking drifted from what Apply set, not before Apply ever ran", async () => {
    // The fake starts with open/click tracking on and unsubscribe handling off; Apply hasn't run.
    await runCatchUp({ reason: "manual", mailgun });
    expect((await getPauseState()).paused).toBe(false);
    await setState("mailgun.setup", {
      runAt: new Date().toISOString(),
      steps: ["tracking-open", "tracking-click", "unsubscribe"].map((key) => ({ key, ok: true, text: "", detail: null, at: new Date().toISOString() })),
    });
    await runCatchUp({ reason: "manual", mailgun });
    const pause = await getPauseState();
    expect(pause).toMatchObject({ paused: true, kind: "mailgun-settings", reason: "tracking is on in Mailgun" });
    expect(pause.fixText).toBe(
      `Open or click tracking was switched on for ${mg.domain} in Mailgun. Click Apply recommended settings in Settings › Domain checklist, then click Resume.`,
    );
    // The second cause (unsubscribe handling off) was already notified by the pause; it lands in the same pause.
    expect(await db.notification.count({ where: { type: "sending.paused" } })).toBeGreaterThanOrEqual(1);
  });
});

describe("runCatchUp: failures", () => {
  it("records the error kind and never sets lastSuccessAt; auth pauses sending", async () => {
    mg.fake.failNext("GET /v3/domains/:d/sending_queues", { kind: "status", status: 401, body: { message: "Invalid private key" } });
    await expect(runCatchUp({ reason: "manual", mailgun })).rejects.toThrow(/API key/);
    let state = (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
    expect(state).toMatchObject({ lastErrorKind: "auth", lastSuccessAt: null });
    expect(await getPauseState()).toMatchObject({ paused: true, kind: "mailgun-auth" });

    await resetApp();
    mg.fake.failNext("GET /v3/domains/:d/sending_queues", { kind: "status", status: 503, body: { message: "Service Unavailable" } }, 4);
    await expect(runCatchUp({ reason: "manual", mailgun })).rejects.toThrow();
    state = (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
    expect(state).toMatchObject({ lastErrorKind: "server", lastSuccessAt: null, lastError: expect.stringMatching(/Mailgun had a problem/) });

    await resetApp();
    const previous = process.env.OUTREACH_MAILGUN_BASE_URL;
    process.env.OUTREACH_MAILGUN_BASE_URL = "http://127.0.0.1:19"; // nothing listens there: connection refused
    try {
      await expect(runCatchUp({ reason: "manual", mailgun })).rejects.toThrow();
    } finally {
      process.env.OUTREACH_MAILGUN_BASE_URL = previous;
    }
    state = (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
    expect(state).toMatchObject({ lastErrorKind: "network", lastSuccessAt: null });
  });

  it("an old domain Mailgun no longer has never fails the catch-up; the app stops checking it", async () => {
    const yesterday = new Date(Date.now() - 24 * HOUR);
    const old = await dbWrite((c) =>
      c.sendingDomain.create({ data: { name: "old.example.com", region: "EU", active: false, lastLiveSendAt: yesterday } }),
    );
    try {
      const onSuccess = vi.fn(async () => undefined);
      const job = createCatchUpJob({ onSuccess, mailgun });
      const ctx = { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => undefined };
      const now = new Date();
      const res = (await job.handler({ reason: "startup" }, ctx)) as { summary: string; domains: string[] };
      expect(res.domains).toEqual([mg.domain]);
      expect(res.summary).toContain("The old domain old.example.com is no longer in your Mailgun account, so the app stopped checking it.");
      expect(onSuccess).toHaveBeenCalledTimes(1);
      const state = (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
      expect(state).toMatchObject({ lastError: null, lastErrorKind: null });
      expect(Date.parse(String(state.lastSuccessAt))).toBeGreaterThanOrEqual(now.getTime() - 1000);
      // M6 (L10): a gone domain isn't kept as a problem (the app stopped checking it); no problem, no field.
      expect(state).not.toHaveProperty("oldDomains");
      // Never a pause, and never the wrong-region advice meant for the active domain.
      expect((await getPauseState()).paused).toBe(false);
      // Forgotten: the next run doesn't ask Mailgun about it again.
      expect((await db.sendingDomain.findUniqueOrThrow({ where: { id: old.id } })).lastLiveSendAt).toBeNull();
      mg.fake.requests.length = 0;
      const again = await runCatchUp({ reason: "hourly", mailgun });
      expect(again.oldDomainProblems).toEqual([]);
      expect(mg.fake.requests.some((r) => r.path.includes("old.example.com"))).toBe(false);
    } finally {
      await dbWrite((c) => c.sendingDomain.delete({ where: { id: old.id } }));
    }
  });

  it("an old domain that can't be checked right now doesn't block the active domain's success", async () => {
    const old = await dbWrite((c) =>
      c.sendingDomain.create({ data: { name: "older.example.com", region: "EU", active: false, lastLiveSendAt: new Date(Date.now() - 24 * HOUR) } }),
    );
    const fetchImpl: typeof fetch = async (input, init) =>
      String(input).includes("older.example.com")
        ? new Response(JSON.stringify({ message: "Service Unavailable" }), { status: 503, headers: { "content-type": "application/json" } })
        : fetch(input, init);
    try {
      const now = new Date();
      const res = await runCatchUp({ reason: "hourly", now, mailgun: () => getMailgunContext({ retryDelayMs: () => 0, fetchImpl }) });
      expect(res.domains).toEqual([mg.domain]);
      expect(res.oldDomainProblems).toEqual([
        {
          domain: "older.example.com",
          gone: false,
          text: "Couldn't check the old domain older.example.com this time: Mailgun had a problem on its side. The next check tries again.",
        },
      ]);
      const state = (await db.systemState.findUniqueOrThrow({ where: { key: "mailgun.catchUp" } })).value as Record<string, unknown>;
      expect(state).toMatchObject({ lastSuccessAt: now.toISOString(), lastError: null });
      // M6 (L10): kept in the state with since when, for Settings › Sending & Mailgun and the dashboard.
      expect(state.oldDomains).toEqual([
        {
          domain: "older.example.com",
          since: now.toISOString(),
          lastAt: now.toISOString(),
          text: "Couldn't check the old domain older.example.com this time: Mailgun had a problem on its side. The next check tries again.",
        },
      ]);
      // Kept: it is checked again next time.
      expect((await db.sendingDomain.findUniqueOrThrow({ where: { id: old.id } })).lastLiveSendAt).not.toBeNull();
    } finally {
      await dbWrite((c) => c.sendingDomain.delete({ where: { id: old.id } }));
    }
  });

  it("calls onSuccess only after a complete run", async () => {
    const onSuccess = vi.fn(async () => undefined);
    const job = createCatchUpJob({ onSuccess, mailgun });
    const ctx = { jobId: 1, createdById: null, signal: new AbortController().signal, progress: async () => undefined };
    const ok = await job.handler({ reason: "startup" }, ctx);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect((ok as { summary: string }).summary).toMatch(/^Checked with Mailgun \(send\.example\.com\)/);
    expect(await db.systemState.findUnique({ where: { key: "task.mailgun.catchUp.hourly" } })).not.toBeNull();

    mg.fake.failNext("GET /v3/domains/:d/tracking", { kind: "status", status: 500, body: { message: "boom" } }, 4);
    await expect(job.handler({ reason: "hourly" }, ctx)).rejects.toThrow();
    expect(onSuccess).toHaveBeenCalledTimes(1);

    const failing = createCatchUpJob({ onSuccess: async () => { throw new Error("warm-up broke"); }, mailgun });
    await expect(failing.handler({ reason: "manual" }, ctx)).resolves.toMatchObject({ domains: [mg.domain] });
  });

  it("tells the Owner once when no catch-up succeeded for 3 hours", async () => {
    const now = new Date();
    await setState("mailgun.catchUp", { lastSuccessAt: new Date(now.getTime() - 4 * HOUR).toISOString(), lastStartedAt: now.toISOString() });
    expect(await checkCatchUpAge({ now, mailgun })).toBe(true);
    expect(await checkCatchUpAge({ now, mailgun })).toBe(false);
    const note = await db.notification.findFirstOrThrow({ where: { title: "The app can't check with Mailgun" } });
    expect(note.body).toMatch(/^The app hasn't been able to check Mailgun since \d{2}:\d{2}\. Bounces and unsubscribes may be late\. Open Settings › Sending & Mailgun and click Check with Mailgun now\.$/);
    expect(note.link).toBe("/settings/sending");

    await resetApp();
    await setState("mailgun.catchUp", { lastSuccessAt: new Date(now.getTime() - 2 * HOUR).toISOString() });
    expect(await checkCatchUpAge({ now, mailgun })).toBe(false);
    await setSetting("practice.copy", true);
    await setState("mailgun.catchUp", { lastSuccessAt: new Date(now.getTime() - 9 * HOUR).toISOString() });
    expect(await checkCatchUpAge({ now })).toBe(false);
    await setSetting("practice.copy", false);
  });
});
