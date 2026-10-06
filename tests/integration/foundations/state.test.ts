import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/** SystemState foundations (M3-DESIGN §4.2.7): the casState create race, readTyped/updateTyped, shouldSendNotice. */

const t = await createTestDb("foundations-state");
const { db, dbWrite } = await import("@/server/db");
const { casState, getState } = await import("@/server/state");
const { readTyped, updateTyped, shouldSendNotice, StateConflictError, NOTICE_EVERY_MS } = await import("@/server/state-typed");
const { parseNotices, parsePauseState, parseWarmupState } = await import("@/core/system-state-parse");
const { STATE_KEYS } = await import("@/core/system-state");

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("casState create race (§4.2.7 fix)", () => {
  it("two creates at once: exactly one true, no throw", async () => {
    const results = await Promise.all([casState("race.a", null, { n: 1 }), casState("race.a", null, { n: 2 })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getState("race.a"))?.version).toBe(1);
  });

  it("a create that loses to the other process (unique violation) returns false instead of throwing", async () => {
    await casState("race.b", null, { first: true });
    // Pretend the row wasn't there when we looked: the create then hits the unique key, as when the web process
    // and the worker create it at the same moment.
    const spy = vi.spyOn(db.systemState, "findUnique").mockResolvedValue(null as never);
    await expect(casState("race.b", null, { second: true })).resolves.toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect((await getState<{ first?: boolean }>("race.b"))?.value).toEqual({ first: true });
  });

  it("two processes creating the same rows: one winner per row, nobody throws", async () => {
    const keys = Array.from({ length: 25 }, (_, i) => `race.proc.${i}`);
    const startAt = Date.now() + 2500;
    const run = () =>
      new Promise<{ pid: number; results: Record<string, boolean | string> }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", path.join("tests", "integration", "foundations", "cas-child.ts"), String(startAt), keys.join(",")],
          { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: t.url }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("exit", (code) => {
          const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
          if (code === 0 && line) resolve(JSON.parse(line));
          else reject(new Error(`child exited ${code}: ${err || out}`));
        });
      });
    const [a, b] = await Promise.all([run(), run()]);
    for (const key of keys) {
      const ra = a.results[key];
      const rb = b.results[key];
      expect(typeof ra, `${key}: ${String(ra)}`).toBe("boolean");
      expect(typeof rb, `${key}: ${String(rb)}`).toBe("boolean");
      expect([ra, rb].filter((x) => x === true), key).toHaveLength(1);
    }
    const rows = await db.systemState.findMany({ where: { key: { startsWith: "race.proc." } } });
    expect(rows).toHaveLength(25);
  }, 60_000);
});

describe("readTyped / updateTyped", () => {
  it("reads a missing row as its default with version null", async () => {
    expect(await readTyped(STATE_KEYS.warmup, parseWarmupState)).toEqual({
      value: { domain: null, step: 0, lastEvaluatedCapDay: null, startedCapDay: null, history: [] },
      version: null,
    });
  });

  it("reads a damaged row as the default", async () => {
    await dbWrite((c) => c.systemState.create({ data: { key: STATE_KEYS.pause, value: "garbage", version: 4 } }));
    const r = await readTyped(STATE_KEYS.pause, parsePauseState);
    expect(r.value.paused).toBe(false);
    expect(r.version).toBe(4);
    await dbWrite((c) => c.systemState.delete({ where: { key: STATE_KEYS.pause } }));
  });

  it("writes through compare-and-set; null means no write", async () => {
    const w = await updateTyped(STATE_KEYS.warmup, parseWarmupState, (cur) => ({ ...cur, step: cur.step + 1, domain: "send.example.com" }));
    expect(w).toMatchObject({ written: true, value: { step: 1 } });
    const same = await updateTyped(STATE_KEYS.warmup, parseWarmupState, () => null);
    expect(same).toMatchObject({ written: false, value: { step: 1 } });
    // created by the first write (version 1); the "no write" left it alone
    expect((await readTyped(STATE_KEYS.warmup, parseWarmupState)).version).toBe(1);
    await updateTyped(STATE_KEYS.warmup, parseWarmupState, (cur) => ({ ...cur, step: cur.step + 1 }));
    expect(await readTyped(STATE_KEYS.warmup, parseWarmupState)).toMatchObject({ version: 2, value: { step: 2 } });
  });

  it("re-reads and retries when others write at the same time", async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        updateTyped(STATE_KEYS.sendingDay, (v) => ({ n: typeof (v as { n?: unknown })?.n === "number" ? (v as { n: number }).n : 0 }), (cur) => ({ n: cur.n + 1 }), 50),
      ),
    );
    expect((await getState<{ n: number }>(STATE_KEYS.sendingDay))?.value).toEqual({ n: 10 });
  });

  it("gives up with StateConflictError when it never wins", async () => {
    const parse = (v: unknown) => ({ n: typeof (v as { n?: unknown })?.n === "number" ? (v as { n: number }).n : 0 });
    let calls = 0;
    // Each change call bumps the row behind our back (a stand-in for the other process), so the CAS always loses.
    const err = await updateTyped(STATE_KEYS.outage, parse, (cur) => {
      calls += 1;
      void dbWrite((c) =>
        c.systemState.upsert({
          where: { key: STATE_KEYS.outage },
          create: { key: STATE_KEYS.outage, value: { n: 100 }, version: 1 },
          update: { version: { increment: 1 } },
        }),
      );
      return { n: cur.n + 1 };
    }, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateConflictError);
    expect(calls).toBe(3);
  });
});

describe("shouldSendNotice", () => {
  const t0 = new Date("2026-09-23T10:00:00Z");

  it("allows one notice per key per 24 h", async () => {
    expect(await shouldSendNotice("mailgun-auth", t0)).toBe(true);
    expect(await shouldSendNotice("mailgun-auth", new Date(t0.getTime() + 60_000))).toBe(false);
    expect(await shouldSendNotice("tunnel-down", new Date(t0.getTime() + 60_000))).toBe(true);
    expect(await shouldSendNotice("mailgun-auth", new Date(t0.getTime() + NOTICE_EVERY_MS - 1))).toBe(false);
    expect(await shouldSendNotice("mailgun-auth", new Date(t0.getTime() + NOTICE_EVERY_MS))).toBe(true);
  });

  it("takes a custom interval", async () => {
    expect(await shouldSendNotice("webhook-rejected", t0, 60_000)).toBe(true);
    expect(await shouldSendNotice("webhook-rejected", new Date(t0.getTime() + 30_000), 60_000)).toBe(false);
    expect(await shouldSendNotice("webhook-rejected", new Date(t0.getTime() + 60_000), 60_000)).toBe(true);
  });

  it("gives exactly one true when both processes ask at once", async () => {
    const at = new Date("2026-10-01T10:00:00Z");
    const results = await Promise.all(Array.from({ length: 6 }, () => shouldSendNotice("email-duplicate", at)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("isn't blocked for days when the PC clock went back", async () => {
    const future = new Date("2027-01-01T00:00:00Z");
    expect(await shouldSendNotice("cert-expired", future)).toBe(true);
    expect(await shouldSendNotice("cert-expired", new Date("2026-12-30T00:00:00Z"))).toBe(true);
  });

  it("forgets notices older than 30 days when it writes", async () => {
    await shouldSendNotice("old-one", new Date("2026-01-01T00:00:00Z"));
    await shouldSendNotice("new-one", new Date("2026-12-31T00:00:00Z"));
    const notices = (await readTyped(STATE_KEYS.notices, parseNotices)).value;
    expect(notices["old-one"]).toBeUndefined();
    expect(notices["new-one"]).toBe("2026-12-31T00:00:00.000Z");
  });
});
