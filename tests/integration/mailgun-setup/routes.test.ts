import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun, type FakeConnection } from "../helpers/mailgun";
import { addSenderAddress, fastMailgun, makeUser } from "./helpers";

const t = await createTestDb("mg-routes");
const mg: FakeConnection = await connectFakeMailgun();
const { db, dbWrite } = await import("@/server/db");
const { getMailgunContext } = await import("@/server/mailgun/context");
const routes = await import("@/server/services/mailgun/routes");
const { PUBLIC_ADDRESS_TEXTS } = await import("@/core/mailgun/routes");
const { syncRoutesJob } = await import("../../../worker/jobs/mailgun-sync-routes");

const PUB = "http://127.0.0.1:3999";
const NOTIFY = `${PUB}/api/webhooks/mailgun/inbound`;
const D = mg.domain;
const previousPub = process.env.APP_PUBLIC_URL;
let owner: { id: number };
let ali: { id: number };
let sara: { id: number };

type FakeRoute = { id: string; priority: number; description: string; expression: string; actions: string[] };
const fakeRoutes = () => mg.fake.state().routes as unknown as FakeRoute[];
const routeFor = (senderAddressId: number) => fakeRoutes().find((r) => r.description === `outreach-app:sender:${senderAddressId}`);
const address = (id: number) => db.senderAddress.findUniqueOrThrow({ where: { id } });
const sync = (extra: Partial<Parameters<typeof routes.syncRoutes>[0]> = {}) => routes.syncRoutes({ mailgun: fastMailgun, ...extra });

beforeAll(async () => {
  process.env.APP_PUBLIC_URL = PUB;
  owner = await makeUser("Arslan", { role: "OWNER", replyInbox: "arslan.owner@gmail.com" });
  ali = await makeUser("Ali", { replyInbox: "ali.khan@gmail.com" });
  sara = await makeUser("Sara", { replyInbox: "sara.b@outlook.com" });
});

beforeEach(async () => {
  mg.fake.reset();
  routes.resetRouteFailureCounts();
  await dbWrite(async (c) => {
    await c.senderAddress.deleteMany({});
    await c.sendingDomain.updateMany({ data: { catchAllRouteId: null, dmarcRouteId: null } });
    await c.user.updateMany({ where: { id: sara.id }, data: { active: true } });
    await c.user.update({ where: { id: ali.id }, data: { replyInbox: "ali.khan@gmail.com" } });
  });
});

afterAll(async () => {
  if (previousPub === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previousPub;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("syncRoutes", () => {
  it("creates an anchored, escaped route per sender plus the catch-all and dmarc@, and verifies each by route id", async () => {
    const a = await addSenderAddress(owner.id, mg.domainId, "arslan");
    const b = await addSenderAddress(ali.id, mg.domainId, "ali.b");
    const res = await sync({ byUserId: owner.id });
    expect(res).toMatchObject({ ok: true, created: 4, updated: 0, deleted: 0, problems: [], senders: 2 });

    const r = routeFor(b.id)!;
    expect(r).toMatchObject({
      priority: 10,
      expression: 'match_recipient("^ali\\.b@send\\.example\\.com$")',
      actions: ['forward("ali.khan@gmail.com")', `store(notify="${NOTIFY}")`, "stop()"],
    });
    const catchAll = fakeRoutes().find((x) => x.description === `outreach-app:catchall:${D}`)!;
    expect(catchAll).toMatchObject({ priority: 100, expression: 'match_recipient("^.*@send\\.example\\.com$")' });
    expect(catchAll.actions[0]).toBe('forward("arslan.owner@gmail.com")');
    const dmarc = fakeRoutes().find((x) => x.description === `outreach-app:dmarc:${D}`)!;
    expect(dmarc).toMatchObject({ priority: 50, actions: ['forward("arslan.owner@gmail.com")', "stop()"] });

    for (const row of [await address(a.id), await address(b.id)]) {
      expect(row.routeStatus).toBe("ok");
      expect(row.routeError).toBeNull();
      expect(row.routeCheckedAt).not.toBeNull();
      expect(row.mailgunRouteId).toBe(routeFor(row.id)!.id);
    }
    expect((await address(b.id)).forwardTo).toBe("ali.khan@gmail.com");
    const domain = await db.sendingDomain.findUniqueOrThrow({ where: { id: mg.domainId } });
    expect(domain).toMatchObject({ catchAllRouteId: catchAll.id, dmarcRouteId: dmarc.id });

    const matched = mg.fake.requests.filter((q) => q.path === "/v3/routes/match").map((q) => q.query.address?.[0]);
    expect(matched).toEqual(expect.arrayContaining([`arslan@${D}`, `ali.b@${D}`, `dmarc@${D}`, expect.stringMatching(/^pp-route-check-[0-9a-f]+@send\.example\.com$/)]));
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "mailgun.routesSynced" }, orderBy: { id: "desc" } });
    expect(log).toMatchObject({ actorId: owner.id, summary: "Reply routes updated: 4 created, 0 changed, 0 removed" });
  });

  it("changes nothing the second time; an inbox change PUTs every field while the route stays ok", async () => {
    const b = await addSenderAddress(ali.id, mg.domainId, "ali");
    await sync();
    expect(await sync()).toMatchObject({ ok: true, created: 0, updated: 0, deleted: 0 });

    await dbWrite((c) => c.user.update({ where: { id: ali.id }, data: { replyInbox: "ali.new@outlook.com" } }));
    const seen: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "PUT" && url.includes("/v3/routes/")) seen.push((await address(b.id)).routeStatus ?? "null");
      return fetch(input, init);
    };
    const res = await sync({ mailgun: () => getMailgunContext({ retryDelayMs: () => 0, fetchImpl: spy }) });
    expect(res).toMatchObject({ ok: true, updated: 1, created: 0 });
    expect(seen).toEqual(["ok"]);
    const put = mg.fake.requests.find((q) => q.method === "PUT" && q.path.startsWith("/v3/routes/"))!;
    expect(put.body).toMatchObject({
      priority: ["10"],
      description: [`outreach-app:sender:${b.id}`],
      expression: ['match_recipient("^ali@send\\.example\\.com$")'],
      action: ['forward("ali.new@outlook.com")', `store(notify="${NOTIFY}")`, "stop()"],
    });
    expect(await address(b.id)).toMatchObject({ routeStatus: "ok", forwardTo: "ali.new@outlook.com" });
  });

  it("keeps an ok route ok when Mailgun fails once, and turns it red only on the third sync in a row", async () => {
    const b = await addSenderAddress(ali.id, mg.domainId, "ali");
    await sync();
    await dbWrite((c) => c.user.update({ where: { id: ali.id }, data: { replyInbox: "ali.other@gmail.com" } }));
    for (let i = 1; i <= 3; i++) {
      // The client tries a PUT four times (three retries) before giving up.
      mg.fake.failNext("PUT /v3/routes/:id", { kind: "status", status: 500, body: { message: "Internal Server Error" } }, 4);
      const res = await sync();
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(true);
      const row = await address(b.id);
      if (i < 3) expect(row.routeStatus).toBe("ok");
      else {
        expect(row.routeStatus).toBe("error");
        expect(row.routeError).toContain("3 times in a row");
      }
    }
    expect(await sync()).toMatchObject({ ok: true, updated: 1 });
    expect(await address(b.id)).toMatchObject({ routeStatus: "ok", routeError: null });
  });

  it("marks mismatch only when /match names another route, and never touches routes that aren't the app's", async () => {
    const b = await addSenderAddress(ali.id, mg.domainId, "ali");
    const ctx = await fastMailgun();
    if (!ctx.connected) throw new Error(ctx.text);
    const foreign = await ctx.client.createRoute({
      priority: 1,
      description: "Someone's own route",
      expression: 'match_recipient("^ali@send\\.example\\.com$")',
      actions: ['forward("someone@example.org")'],
    });
    const res = await sync();
    expect(res.ok).toBe(false);
    expect(await address(b.id)).toMatchObject({ routeStatus: "mismatch", routeError: routes.routeMismatchText(`ali@${D}`) });
    expect(fakeRoutes().some((r) => r.id === foreign.id)).toBe(true);
    await ctx.client.deleteRoute(foreign.id);
    expect((await sync()).ok).toBe(true);
    expect((await address(b.id)).routeStatus).toBe("ok");
  });

  it("deletes the app's routes nobody needs, keeps a retired address's route, and a new address starts pending", async () => {
    const old = await addSenderAddress(ali.id, mg.domainId, "ali");
    await sync();
    const oldRoute = routeFor(old.id)!;
    await dbWrite((c) => c.senderAddress.update({ where: { id: old.id }, data: { retiredAt: new Date() } }));
    const fresh = await addSenderAddress(ali.id, mg.domainId, "ali.khan");
    expect(fresh.routeStatus).toBe("pending");
    const ctx = await fastMailgun();
    if (!ctx.connected) throw new Error(ctx.text);
    await ctx.client.createRoute({ priority: 10, description: "outreach-app:sender:99999", expression: 'match_recipient("^x@y\\.com$")', actions: ["stop()"] });
    await ctx.client.createRoute({ priority: 100, description: "outreach-app:catchall:gone.example.com", expression: 'match_recipient("^.*@gone\\.example\\.com$")', actions: ["stop()"] });

    const res = await sync();
    expect(res).toMatchObject({ ok: true, created: 1, deleted: 2 });
    expect(fakeRoutes().some((r) => r.id === oldRoute.id)).toBe(true);
    expect(fakeRoutes().some((r) => r.description === "outreach-app:sender:99999")).toBe(false);
    expect(fakeRoutes().some((r) => r.description.includes("gone.example.com"))).toBe(false);
    expect((await address(fresh.id)).routeStatus).toBe("ok");
  });

  it("a new address whose route /match can't confirm stays pending, the sync isn't ok, and the job tries again", async () => {
    const a = await addSenderAddress(owner.id, mg.domainId, "arslan");
    // Mailgun doesn't answer /match (the client tries four times).
    mg.fake.failNext("GET /v3/routes/match", { kind: "status", status: 503, body: { message: "Service Unavailable" } }, 4);
    const res = await sync();
    expect(res).toMatchObject({ ok: false, retryable: true, created: 3 });
    expect(res.problems).toEqual([routes.routeUnconfirmedText(`arslan@${D}`)]);
    expect(routes.routeUnconfirmedText(`arslan@${D}`)).toBe(`Couldn't confirm the reply route for arslan@${D} yet. The app checks again in a few minutes.`);
    expect((await address(a.id)).routeStatus).toBe("pending");

    // /match answers but doesn't find the route yet (just created): the same, and still worth another try, so the job
    // throws and the runner tries again later.
    mg.fake.failNext("GET /v3/routes/match", { kind: "status", status: 404, body: { message: "Route not found" } });
    const notYet = await sync();
    expect(notYet).toMatchObject({ ok: false, retryable: true, problems: [routes.routeUnconfirmedText(`arslan@${D}`)] });
    expect((await address(a.id)).routeStatus).toBe("pending");
    mg.fake.failNext("GET /v3/routes/match", { kind: "status", status: 404, body: { message: "Route not found" } });
    await expect(
      syncRoutesJob.handler({}, { jobId: 2, createdById: owner.id, signal: new AbortController().signal, progress: async () => undefined }),
    ).rejects.toThrow(routes.routeUnconfirmedText(`arslan@${D}`));
    expect((await address(a.id)).routeStatus).toBe("pending");

    // A later sync that can ask Mailgun turns it ok.
    expect(await sync()).toMatchObject({ ok: true, problems: [] });
    expect((await address(a.id)).routeStatus).toBe("ok");

    // Once working, one unanswered check keeps it ok and doesn't count as a problem.
    mg.fake.failNext("GET /v3/routes/match", { kind: "status", status: 503, body: { message: "Service Unavailable" } }, 4);
    expect(await sync()).toMatchObject({ ok: true, retryable: true });
    expect((await address(a.id)).routeStatus).toBe("ok");
  });

  it("a catch-all Mailgun can't be asked about right after creating it isn't counted as set up", async () => {
    await addSenderAddress(owner.id, mg.domainId, "arslan");
    let matches = 0;
    const flaky: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // The sender's own check works; the catch-all probe (pp-route-check-…) times out.
      if (url.includes("/v3/routes/match") && url.includes("pp-route-check-")) {
        matches++;
        throw new TypeError("fetch failed");
      }
      return fetch(input, init);
    };
    const res = await sync({ mailgun: () => getMailgunContext({ retryDelayMs: () => 0, fetchImpl: flaky }) });
    expect(matches).toBeGreaterThan(0);
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.problems).toEqual([`Couldn't confirm the route for unknown addresses on ${D} yet. The app checks again in a few minutes.`]);
    // Known from the last sync: one unanswered check isn't a problem.
    const again = await sync({ mailgun: () => getMailgunContext({ retryDelayMs: () => 0, fetchImpl: flaky }) });
    expect(again).toMatchObject({ ok: true, retryable: true, problems: [] });
  });

  it("points a switched-off teammate's route at the Owner's inbox", async () => {
    const s = await addSenderAddress(sara.id, mg.domainId, "sara");
    await dbWrite((c) => c.user.update({ where: { id: sara.id }, data: { active: false } }));
    expect((await sync()).ok).toBe(true);
    expect(routeFor(s.id)!.actions[0]).toBe('forward("arslan.owner@gmail.com")');
    expect((await address(s.id)).forwardTo).toBe("arslan.owner@gmail.com");
  });

  it("refuses a reply inbox on the sending domain: error, and no route that could loop", async () => {
    const bo = await makeUser("Bo", { replyInbox: `bo@${D}` });
    const s = await addSenderAddress(bo.id, mg.domainId, "bo");
    const res = await sync();
    expect(res.ok).toBe(false);
    expect(res.problems).toContain(routes.routeLoopText(`bo@${D}`));
    expect(await address(s.id)).toMatchObject({ routeStatus: "error", routeError: routes.routeLoopText(`bo@${D}`) });
    expect(routeFor(s.id)).toBeUndefined();
    await dbWrite((c) => c.user.update({ where: { id: bo.id }, data: { active: false } }));
  });

  it("an inbox on Mailgun's bounce list: error with the Remove-it wording, and one notice to the Owner", async () => {
    const b = await addSenderAddress(ali.id, mg.domainId, "ali");
    mg.fake.addSuppression("bounces", "ali.khan@gmail.com");
    const res = await sync();
    expect(res.ok).toBe(false);
    const text = "Mailgun won't forward replies to ali.khan@gmail.com: it's on Mailgun's bounce list.";
    expect(await address(b.id)).toMatchObject({ routeStatus: "error", routeError: text });
    expect(text.startsWith(routes.SUPPRESSED_INBOX_PREFIX)).toBe(true);
    const notes = await db.notification.findMany({ where: { type: "system.replyRoute" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: owner.id, title: "Mailgun won't forward replies to ali.khan@gmail.com", link: "/settings/domain" });
    await sync();
    expect(await db.notification.count({ where: { type: "system.replyRoute" } })).toBe(1);
  });

  it("needs a public address, and says so without calling Mailgun", async () => {
    process.env.APP_PUBLIC_URL = "";
    try {
      const res = await sync();
      expect(res).toMatchObject({ ok: false, problems: [PUBLIC_ADDRESS_TEXTS.missing] });
      expect(mg.fake.requests).toHaveLength(0);
    } finally {
      process.env.APP_PUBLIC_URL = PUB;
    }
  });

  it("the job syncs and sums up", async () => {
    await addSenderAddress(ali.id, mg.domainId, "ali");
    const out = (await syncRoutesJob.handler({}, { jobId: 1, createdById: owner.id, signal: new AbortController().signal, progress: async () => undefined })) as {
      summary: string;
    };
    expect(out.summary).toBe("Reply routes are set up for 1 sender, plus a catch-all.");
  });
});
