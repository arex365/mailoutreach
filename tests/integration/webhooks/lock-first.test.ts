import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeMailgun } from "../helpers/mailgun";
import { postInbound } from "../helpers/replies";
import { makeInbound, makeUser } from "../stops-holds/world";

/**
 * Transactions that read before they write, against a second process that writes (DATA-01, DATA-02, DATA-03): the
 * worker (a child process here) holds SQLite's write lock, or writes back to back like an import commit, while this
 * process (the web app) marks replies Answered and receives signed reply webhooks.
 *
 * Before the fix `dbTx` started with the adapter's plain BEGIN, so a transaction that read first failed at its first
 * write at once whenever the worker held the lock or had just committed ("the old way" below still shows it): replies
 * were answered with a 500 (Mailgun retries 10 minutes later) and "Answered" said nothing was saved. Now `dbTx` takes
 * the write lock with its first statement and waits its turn, a lock statement that waited longer than the busy
 * timeout (P2010) is retried, and long runs of chunk transactions pause between chunks (`pauseForOtherWriters`) so the
 * waiting process's busy handler finds a gap.
 */

const t = await createTestDb("lock-first");
const mg = await connectFakeMailgun();
const { db, dbTx, withDbRetry, withWriteLock, isRetryableDbError } = await import("@/server/db");
const { markReplyAnswered } = await import("@/server/services/replies/actions");
type Tx = import("@/server/db").Tx;

/** How `dbTx` worked before the fix: the same lock and retries, but the transaction starts with a plain BEGIN only. */
function theOldWay<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withDbRetry(() => withWriteLock(() => db.$transaction((tx) => fn(tx))));
}

/** The shape of every read-first decision (answer(), the webhook): read the row, then a compare-and-set on it. */
function answerLike(id: number) {
  return async (tx: Tx) => {
    const row = await tx.inboundMessage.findUnique({ where: { id }, select: { answeredAt: true } });
    if (!row || row.answeredAt) throw new Error(`reply #${id} isn't waiting`);
    const res = await tx.inboundMessage.updateMany({ where: { id, answeredAt: null }, data: { answeredAt: new Date(), answerOutcome: "answered" } });
    return res.count;
  };
}

type Child = { send: (cmd: string) => void; next: (timeoutMs?: number) => Promise<string>; exited: Promise<number | null> };

function startWorker(): Child {
  const child = spawn(process.execPath, ["--import", "tsx", path.join("tests", "integration", "webhooks", "lock-first-child.ts")], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: t.url, OUTREACH_PROCESS: "worker" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  return {
    send: (cmd) => child.stdin.write(`${cmd}\n`),
    next: (timeoutMs = 60_000) =>
      new Promise<string>((resolve, reject) => {
        const line = lines.shift();
        if (line !== undefined) return resolve(line);
        const timer = setTimeout(() => reject(new Error(`The worker child said nothing for ${timeoutMs} ms.\n${stderr}`)), timeoutMs);
        waiters.push((l) => {
          clearTimeout(timer);
          resolve(l);
        });
      }),
    exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))),
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - t0, value };
  } catch (error) {
    return { ms: Date.now() - t0, error };
  }
}

let worker: Child;
let actor: { id: number; name: string; role: "OWNER" | "MEMBER" };
let seq = 0;

/** The worker takes the write lock and keeps it for `ms`; resolves once it has it. */
async function workerHolds(ms: number): Promise<void> {
  worker.send(`hold ${ms}`);
  expect(await worker.next()).toBe("locked");
}

async function workerReleased(): Promise<void> {
  expect(await worker.next()).toBe("released");
}

function aReply() {
  seq += 1;
  return { from: `anna${seq}@firma${seq}.de`, to: "ali@send.example.com", subject: "Re: 3D models for your shop", text: "Yes please, send your prices." };
}

async function waitingReply(): Promise<number> {
  return (await makeInbound({ kind: "REPLY", assigneeId: actor.id, replyScope: "real" })).id;
}

beforeAll(async () => {
  const owner = await makeUser("Arslan", { role: "OWNER" });
  actor = { id: owner.id, name: owner.name, role: "OWNER" };
  worker = startWorker();
}, 60_000);

afterAll(async () => {
  worker.send("exit");
  await worker.exited;
  await mg.stop();
  await db.$disconnect();
  t.cleanup();
});

describe("while the worker holds the write lock", () => {
  it("the old way a transaction that reads first fails without waiting; dbTx waits its turn", async () => {
    await workerHolds(1_500);
    const old = await timed(() =>
      theOldWay(async (tx) => {
        await tx.webhookToken.findUnique({ where: { token: "old-way" } });
        return tx.webhookToken.create({ data: { token: "old-way" } });
      }),
    );
    // Every one of its 5 tries failed at once (no busy wait), well before the worker let go.
    expect(old.error).toBeDefined();
    expect(isRetryableDbError(old.error)).toBe(true);
    expect(old.ms).toBeLessThan(1_450);
    await workerReleased();
    expect(await db.webhookToken.count({ where: { token: "old-way" } })).toBe(0);

    await workerHolds(1_500);
    const now = await timed(() =>
      dbTx(async (tx) => {
        await tx.webhookToken.findUnique({ where: { token: "lock-first" } });
        return tx.webhookToken.create({ data: { token: "lock-first" } });
      }),
    );
    expect(now.error).toBeUndefined();
    // It waited for the worker's lock instead of failing.
    expect(now.ms).toBeGreaterThan(800);
    await workerReleased();
    expect(await db.webhookToken.count({ where: { token: "lock-first" } })).toBe(1);
  }, 60_000);

  it("stores a reply from the signed webhook (200, never a 500 that Mailgun only retries 10 minutes later)", async () => {
    await workerHolds(1_500);
    const posted = await timed(() => postInbound(mg.fake, aReply()));
    await workerReleased();
    expect(posted.error).toBeUndefined();
    expect(posted.value).toMatchObject({ status: 200 });
    expect(posted.value!.id).not.toBeNull();
    expect(posted.ms).toBeGreaterThan(800);
  }, 60_000);

  it("marks a reply Answered (the decision reads the reply before its compare-and-set)", async () => {
    const id = await waitingReply();
    await workerHolds(1_500);
    const answered = await timed(() => markReplyAnswered(actor, id));
    await workerReleased();
    expect(answered.error).toBeUndefined();
    expect(answered.value).toEqual({ message: "Marked as answered." });
    expect(await db.inboundMessage.findUniqueOrThrow({ where: { id }, select: { answerOutcome: true } })).toEqual({ answerOutcome: "answered" });
  }, 60_000);

  it("retries when the lock is held longer than the web app's busy timeout (the lock statement's P2010)", async () => {
    await workerHolds(2_600);
    const res = await timed(() => dbTx((tx) => tx.webhookToken.create({ data: { token: "long-hold" } })));
    await workerReleased();
    expect(res.error).toBeUndefined();
    // The first try gave up after the 2 s busy timeout; the retry got the lock once the worker let go.
    expect(res.ms).toBeGreaterThan(2_000);
    expect(await db.webhookToken.count({ where: { token: "long-hold" } })).toBe(1);
  }, 60_000);
});

describe("while the worker writes back to back like an import commit", () => {
  it("before the fix most read-first decisions failed; now every Answered and every reply webhook goes through", async () => {
    const ROUNDS = 12;
    const mine: number[] = [];
    const oldOnes: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      mine.push(await waitingReply());
      oldOnes.push(await waitingReply());
    }
    // Each request arrives at a random moment of the worker's work, not right after this process's own last commit
    // (the worker's busy handler is then still asleep, which would flatter either way).
    const arrive = () => new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 160)));
    const text = (err: unknown) => (err instanceof Error ? err.message.slice(0, 200) : String(err));
    // A chunk of 250 import rows writes companies, people, lists, tags and the rows themselves: about 1,000 statements.

    // Before: the old dbTx against the old import (only a setImmediate between chunks).
    worker.send("import 1000 old");
    expect(await worker.next()).toBe("importing");
    let oldWayFailed = 0;
    for (const id of oldOnes) {
      await arrive();
      if ((await timed(() => theOldWay(answerLike(id)))).error !== undefined) oldWayFailed += 1;
    }
    worker.send("stop");
    const before = JSON.parse(await worker.next()) as { chunks: number; errors: number; ms: number };
    expect(before.errors).toBe(0);

    // Now: dbTx takes the lock first, and the import pauses between chunks.
    worker.send("import 1000");
    expect(await worker.next()).toBe("importing");
    const failures = { answered: [] as string[], webhook: [] as string[] };
    const waits: number[] = [];
    for (const id of mine) {
      await arrive();
      const answered = await timed(() => markReplyAnswered(actor, id));
      waits.push(answered.ms);
      if (answered.error !== undefined) failures.answered.push(text(answered.error));
      await arrive();
      const posted = await timed(() => postInbound(mg.fake, aReply()));
      waits.push(posted.ms);
      if (posted.error !== undefined) failures.webhook.push(text(posted.error));
      else if (posted.value!.status !== 200 || posted.value!.id === null) failures.webhook.push(`answered ${posted.value!.status}`);
    }
    worker.send("stop");
    const load = JSON.parse(await worker.next()) as { chunks: number; errors: number; ms: number };

    const avg = Math.round(waits.reduce((a, b) => a + b, 0) / waits.length);
    console.info(
      `[lock-first] before: ${before.chunks} import chunks in ${before.ms} ms, ${oldWayFailed} of ${ROUNDS} read-first decisions failed; ` +
        `now: ${load.chunks} chunks in ${load.ms} ms, ${failures.answered.length} of ${ROUNDS} Answered and ` +
        `${failures.webhook.length} of ${ROUNDS} webhooks failed (average ${avg} ms, longest ${Math.max(...waits)} ms)`,
    );
    // The worker really was writing the whole time, and its own writes never failed either.
    expect(load.chunks).toBeGreaterThanOrEqual(ROUNDS);
    expect(load.errors).toBe(0);
    // Before the fix this load broke most read-first decisions (so the numbers below mean something) …
    expect(oldWayFailed).toBeGreaterThanOrEqual(ROUNDS / 2);
    // … and now none fails. (How long they wait is only reported: it depends on how busy the test machine is. On an idle
    // one it was 100–450 ms on average; with a flat 10 ms pause after every chunk it was over a second.)
    expect(failures.answered).toEqual([]);
    expect(failures.webhook).toEqual([]);
    expect(await db.inboundMessage.count({ where: { id: { in: mine }, answerOutcome: "answered" } })).toBe(ROUNDS);
  }, 180_000);
});
