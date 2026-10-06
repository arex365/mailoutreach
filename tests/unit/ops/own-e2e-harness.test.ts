import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../../fake-mailgun/cli";
import { startFakeMailgun, type FakeMailgun } from "../../fake-mailgun/server";
import { createWorld, snapshot } from "../../fake-mailgun/state";
import { E2E_INSTANCES, E2E_OWN_DOMAIN, fakeMailgunArgs, fakeOwnMailboxProblem } from "../../playwright/instances";

/**
 * The own state's screen checks run against a fake Mailgun that agrees with the seed (review SCREENS-12, SECURITY-01,
 * REPLIES-11): the seed records a finished "Apply recommended settings" (tracking off, unsubscribe handling on), so the
 * fake starts that way (`--settings-applied`). Otherwise the worker's first catch-up finds tracking "switched back on",
 * pauses sending, and every own screenshot shows the paused app, with the go-live switch disabled and its dialog never
 * checked. A fake already running without it is refused before any test. Only loopback addresses; nothing real.
 */

const OWN = E2E_INSTANCES.own;
let fake: FakeMailgun | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe("the own instance's fake Mailgun agrees with the seeded Apply run", () => {
  it("starts with --settings-applied, next to the Free plan and the MX elsewhere", () => {
    expect(OWN.fakeArgs).toBe(`--domain ${E2E_OWN_DOMAIN} --region US --plan free --mx-elsewhere --settings-applied`);
    expect(fakeMailgunArgs("own")).toBe(`--app http://127.0.0.1:3105 ${OWN.fakeArgs}`);
    expect(parseCliArgs(OWN.fakeArgs!.split(" "))).toMatchObject({
      domain: E2E_OWN_DOMAIN,
      region: "US",
      plan: "free",
      receivesMail: false,
      settingsApplied: true,
    });
  });

  it("--settings-applied is a flag without a value; without it the fake is today's", () => {
    expect(() => parseCliArgs(["--settings-applied=yes"])).toThrow(/--settings-applied takes no value/);
    expect(parseCliArgs(["--settings-applied"]).settingsApplied).toBe(true);
    expect(parseCliArgs([]).settingsApplied).toBeUndefined();
    const plain = createWorld({ domain: E2E_OWN_DOMAIN }, new Date());
    expect(plain.tracking.open.active).toBe(true);
    expect(plain.tracking.click.active).toBe(true);
    expect(plain.tracking.unsubscribe.active).toBe(false);
  });

  it("the domain starts as Apply leaves it, also after a reset, and Mailgun's tracking API says so", async () => {
    fake = await startFakeMailgun({ ...parseCliArgs(OWN.fakeArgs!.split(" ")), port: 0 });
    const expected = {
      open: { active: false, placeAtTheTop: false },
      click: { active: false },
      unsubscribe: { active: true, htmlFooter: "", textFooter: "" },
    };
    expect(fake.state().tracking).toMatchObject(expected);
    fake.reset();
    expect(fake.state().tracking).toMatchObject(expected);
    // What the catch-up's drift check reads (GET /v3/domains/{d}/tracking): nothing "switched back on".
    const res = await fetch(`${fake.origin}/v3/domains/${E2E_OWN_DOMAIN}/tracking`, {
      headers: { authorization: "Basic " + Buffer.from(`api:${fake.options.apiKey}`).toString("base64") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracking: { open: { active: boolean }; click: { active: boolean }; unsubscribe: { active: boolean } } };
    expect(body.tracking.open.active).toBe(false);
    expect(body.tracking.click.active).toBe(false);
    expect(body.tracking.unsubscribe.active).toBe(true);
  });
});

describe("a fake that already runs is checked before any own test (tests/playwright/fake-check.ts)", () => {
  const plan = { receivesMail: false, plan: "free" as const, dailyLimit: 100, authorizedRecipients: null };

  it("accepts a Free-plan fake with its MX elsewhere and the tracking Apply leaves", () => {
    const world = createWorld({ domain: E2E_OWN_DOMAIN, settingsApplied: true }, new Date());
    expect(fakeOwnMailboxProblem("own", snapshot(world, new Date(), plan))).toBeNull();
  });

  it("refuses one started without --settings-applied (tracking on, unsubscribe handling off), naming the flags", () => {
    const world = createWorld({ domain: E2E_OWN_DOMAIN }, new Date());
    expect(fakeOwnMailboxProblem("own", snapshot(world, new Date(), plan))).toBe(
      "The fake Mailgun on 4013 wasn't started with --plan free --mx-elsewhere --settings-applied. Stop it and run again.",
    );
    // Only one of the three off: still refused.
    const half = createWorld({ domain: E2E_OWN_DOMAIN, settingsApplied: true }, new Date());
    half.tracking.click.active = true;
    expect(fakeOwnMailboxProblem("own", snapshot(half, new Date(), plan))).not.toBeNull();
    // A reply-receiving or non-Free fake, as before.
    const applied = createWorld({ domain: E2E_OWN_DOMAIN, settingsApplied: true }, new Date());
    expect(fakeOwnMailboxProblem("own", snapshot(applied, new Date(), { ...plan, receivesMail: true }))).not.toBeNull();
    expect(fakeOwnMailboxProblem("own", snapshot(applied, new Date(), { ...plan, plan: "foundation" }))).not.toBeNull();
    expect(fakeOwnMailboxProblem("own", null)).not.toBeNull();
  });

  it("the other states are never asked about it", () => {
    for (const state of ["empty", "busy", "ready", "live"] as const) expect(fakeOwnMailboxProblem(state, null)).toBeNull();
  });
});
