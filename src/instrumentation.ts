/**
 * Runs once when the web app's server starts (Next.js instrumentation hook).
 * Node ABI guard (PLAN.md B11): after a Node.js update the native parts (SQLite driver, password
 * hasher) no longer load, so refuse to start with a plain message. start.bat checks this itself;
 * this covers the Windows service, which starts `next start` directly. Skipped during `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { exitIfNodeAbiChanged } = await import("@/server/node-abi");
  exitIfNodeAbiChanged();
}
