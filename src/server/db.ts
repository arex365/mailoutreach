import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { databaseFilePath } from "./env";

/**
 * One Prisma client per process (web app or worker), with the database rules
 * from PLAN.md B5:
 *  - WAL mode, busy timeout (2 s web / 10 s worker)
 *  - every write goes through dbWrite()/dbTx(): a per-process lock (Prisma shares one
 *    SQLite connection per process, so an open transaction must never interleave
 *    with other writes) plus retries for SQLITE_BUSY (P1008, or P2010 from a raw statement) and friends.
 *  - dbTx takes SQLite's write lock with its first statement, so a transaction that reads before it
 *    writes waits its turn instead of failing when the other process writes (see TAKE_WRITE_LOCK).
 *  - long runs of chunk transactions pause between chunks (pauseForOtherWriters) so the other process
 *    gets the lock too.
 *  - never do network I/O inside dbWrite/dbTx.
 */

const isWorker = process.env.OUTREACH_PROCESS === "worker";

function createClient() {
  const adapter = new PrismaBetterSqlite3({
    url: "file:" + databaseFilePath(),
    timeout: isWorker ? 10_000 : 2_000,
  });
  const client = new PrismaClient({
    adapter,
    transactionOptions: { maxWait: 5_000, timeout: 10_000 },
  });
  // `next build` imports every route module to collect page data. Every page is dynamic, so nothing
  // queries the database then; skipping the PRAGMAs means the build never opens data\app.db (the
  // adapter only connects on the first query).
  if (process.env.NEXT_PHASE === "phase-production-build") return client;
  // journal_mode=WAL is stored in the file; setting it again is cheap and safe.
  void client
    .$queryRawUnsafe("PRAGMA journal_mode = WAL")
    .then(() => client.$queryRawUnsafe("PRAGMA foreign_keys = ON"))
    .then(() => client.$queryRawUnsafe("PRAGMA synchronous = NORMAL"))
    .catch((err: unknown) => console.error("[db] PRAGMA setup failed", err));
  return client;
}

const globalForDb = globalThis as unknown as { __outreachDb?: PrismaClient };

export const db: PrismaClient = globalForDb.__outreachDb ?? createClient();
if (process.env.NODE_ENV !== "production") globalForDb.__outreachDb = db;

export type Tx = Prisma.TransactionClient;
export type DbOrTx = PrismaClient | Tx;

// ───────────────────────── write lock ─────────────────────────

const lockContext = new AsyncLocalStorage<boolean>();
let lockTail: Promise<unknown> = Promise.resolve();

/** Runs fn while holding this process's write lock. Re-entrant within the same async flow. */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (lockContext.getStore()) return fn();
  const run = lockTail.then(() => lockContext.run(true, fn));
  lockTail = run.catch(() => undefined);
  return run;
}

// ───────────────────────── retries ─────────────────────────

const RETRYABLE = new Set(["P1008", "P2028", "P2034"]);
/** SQLite's busy family (SQLITE_BUSY, SQLITE_BUSY_SNAPSHOT, …): the other process has, or just had, the write lock. */
const BUSY = /SQLITE_BUSY|database is locked/i;

/** The driver's own code carried by a Prisma error ("SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", …), when there is one. */
function driverCode(err: Prisma.PrismaClientKnownRequestError): string {
  const meta = err.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const code = meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === "string" ? code : "";
}

/**
 * True for errors that mean "the database is busy, try again": a model query's busy error is P1008 (or a transaction
 * that couldn't start or expired, P2028/P2034); a raw statement's, such as dbTx's lock statement, is P2010
 * "Raw query failed. Code: `SQLITE_BUSY`", recognised by its driver code or text.
 */
export function isRetryableDbError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return RETRYABLE.has(err.code) || BUSY.test(driverCode(err)) || BUSY.test(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return BUSY.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err) || i === attempts - 1) throw err;
      await sleep(50 * 2 ** i + Math.floor(Math.random() * 50));
    }
  }
  throw lastErr;
}

/** Any write (single statement or several) — lock + retry. Keep it short; no network calls inside. */
export function dbWrite<T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> {
  return withDbRetry(() => withWriteLock(() => fn(db)));
}

/**
 * The first statement of every dbTx: a write that changes nothing but takes SQLite's write lock, waiting for it through
 * the normal busy timeout (verified: `UPDATE … WHERE 0` takes the lock). The adapter starts every transaction with a
 * plain (deferred) BEGIN, so without this a transaction that reads before it writes fails at its first write, at once
 * and without waiting, whenever the other process holds the lock or committed after that read (SQLITE_BUSY /
 * SQLITE_BUSY_SNAPSHOT); under a long import in the worker most of the web app's decisions and the reply webhook failed
 * that way. With the lock taken first, every transaction waits its turn whatever order its own statements come in
 * (PLAN B5 "write early"). Patching the adapter's BEGIN to BEGIN IMMEDIATE is not an option: when that BEGIN times out,
 * the adapter never releases its own mutex and every later transaction of the process fails.
 * A plain read by another async flow of this process can still slip in between BEGIN and this statement; the busy error
 * it causes is retried like any other (withDbRetry).
 */
export const TAKE_WRITE_LOCK = `UPDATE "SystemState" SET "key" = "key" WHERE 0`;

/** An interactive transaction under the write lock, with retries. Keep it tiny. It takes SQLite's write lock first. */
export function dbTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withDbRetry(() =>
    withWriteLock(() =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(TAKE_WRITE_LOCK);
        return fn(tx);
      }),
    ),
  );
}

// ───────────────────────── long runs of writes ─────────────────────────

/** The shortest and the longest pause of a long run of write transactions between two of them. */
export const WRITE_PAUSE_MS = 10;
export const WRITE_PAUSE_MAX_MS = 50;

/**
 * The pause between two chunk transactions of a long write (an import, holds and releases, bulk status changes, the
 * daily clean-up). The other process waits for the lock in SQLite's busy handler, which only looks again every few to
 * 100 ms; a setImmediate gap between two transactions is far too short for it ever to get a turn, so under a big import
 * the web app's writes ran out of time. `heldMs` (when known): how long the chunk just written kept the lock. A long
 * chunk pauses a quarter of that (10 to 50 ms), so the other process gets about a fifth of the time and its busy
 * handler finds a gap within a second or so; short chunks pause 10 ms. A 10,000-row import takes about 2 s longer.
 */
export function pauseForOtherWriters(heldMs = 0): Promise<void> {
  const ms = Math.min(WRITE_PAUSE_MAX_MS, Math.max(WRITE_PAUSE_MS, Math.round(heldMs / 4)));
  return new Promise((resolve) => setTimeout(resolve, ms));
}
