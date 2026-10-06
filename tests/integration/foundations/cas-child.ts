/**
 * Child process for state.test.ts: races casState(key, null, …) creates against another process on the same
 * database. Usage: node --import tsx cas-child.ts <startAtMs> <key1,key2,…>. Prints one JSON line with the results.
 * DATABASE_URL comes from the parent.
 */
const [, , startAtRaw, keysRaw] = process.argv;
const startAt = Number(startAtRaw);
const keys = (keysRaw ?? "").split(",").filter(Boolean);

const { casState } = await import("@/server/state");
const { db } = await import("@/server/db");

await db.systemState.count(); // open the connection before the start line
while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 1));

const results: Record<string, boolean | string> = {};
await Promise.all(
  keys.map(async (key) => {
    try {
      results[key] = await casState(key, null, { by: process.pid });
    } catch (err) {
      results[key] = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }),
);
console.log(JSON.stringify({ pid: process.pid, results }));
await db.$disconnect();

export {};
