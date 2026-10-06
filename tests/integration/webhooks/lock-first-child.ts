/**
 * The worker side of lock-first.test.ts (DATA-01/02): a second process on the same temp database that takes SQLite's
 * write lock when the parent asks, through the app's own `dbTx`. Commands, one per stdin line:
 *   hold <ms>  → takes the write lock, prints "locked", keeps it for <ms>, then commits and prints "released";
 *   import [n] [old]
 *              → writes back to back like an import commit (chunk transactions of n statements, default 250, with the
 *                app's pause between them; "old": only a setImmediate between them, as before the fix), prints
 *                "importing" after the first chunk, until
 *   stop       → finishes the current chunk and prints one JSON line {chunks, errors, ms};
 *   exit       → disconnects and exits.
 * Usage: node --import tsx lock-first-child.ts   (DATABASE_URL and APP_ENCRYPTION_KEY come from the parent)
 */
import readline from "node:readline";

process.env.OUTREACH_PROCESS = "worker";

const { db, dbTx, pauseForOtherWriters } = await import("@/server/db");

await db.systemState.count(); // open the connection before the parent starts measuring
const say = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let importing = false;
let importDone: Promise<void> | null = null;

async function importLike(statements: number, oldPause: boolean): Promise<void> {
  let chunks = 0;
  let errors = 0;
  const started = Date.now();
  while (importing) {
    const t0 = Date.now();
    try {
      await dbTx(async (tx) => {
        // Like applyChunk: a read of what the chunk changes, then one statement per row, the lock held until the commit.
        await tx.activityLog.count({ where: { type: "test.load" } });
        for (let i = 0; i < statements; i++) await tx.activityLog.create({ data: { type: "test.load", summary: `Row ${i}` } });
      });
      chunks += 1;
      if (chunks === 1) say("importing");
    } catch (err) {
      errors += 1;
      process.stderr.write(`import chunk failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    // As the import commit does now: a pause that grows with how long the chunk kept the lock.
    if (oldPause) await new Promise((resolve) => setImmediate(resolve));
    else await pauseForOtherWriters(Date.now() - t0);
  }
  say(JSON.stringify({ chunks, errors, ms: Date.now() - started }));
}

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const [cmd, arg, flag] = line.trim().split(/\s+/);
  if (cmd === "hold") {
    const ms = Number(arg);
    await dbTx(async () => {
      // dbTx's first statement already took the write lock.
      say("locked");
      await sleep(ms);
    });
    say("released");
  } else if (cmd === "import") {
    importing = true;
    importDone = importLike(Number(arg) > 0 ? Number(arg) : 250, flag === "old");
  } else if (cmd === "stop") {
    importing = false;
    await importDone;
  } else if (cmd === "exit") {
    break;
  }
}
await db.$disconnect();
process.exit(0);

export {};
