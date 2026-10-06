/// <reference types="node" />
/**
 * reset-password.bat → node --import tsx scripts/reset-password.ts
 *
 * Works only on the PC itself (PLAN.md B10): lists the accounts, makes a 24-hour reset link
 * for the chosen person, clears their wrong-password lockout and signs them out everywhere.
 * The person then opens the link and chooses a new password (the /reset page).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { lanUrls } from "./lib/lan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const envFile = path.join(ROOT, ".env");
if (!fs.existsSync(envFile)) {
  console.log("  [x]  The settings file (.env) is missing. Double-click setup.bat first.");
  process.exit(1);
}
// Load .env before the database module reads DATABASE_URL.
dotenv.config({ path: envFile, quiet: true });

const { db, dbTx } = await import("@/server/db");
const { randomToken, sha256 } = await import("@/lib/auth/tokens");
const { logActivity } = await import("@/server/activity");

const RESET_HOURS = 24;
const PORT = 3000;

function line(text = "") {
  console.log(text);
}

async function main(): Promise<number> {
  line("");
  line("Polygon Paradise Outreach: reset a password");
  line("===========================================");

  const users = await db.user.findMany({
    select: { id: true, name: true, email: true, role: true, active: true },
  });
  if (users.length === 0) {
    line("");
    line("  There are no accounts yet. Double-click start.bat, open http://localhost:3000 and create the");
    line("  Owner account with the setup code from setup.bat.");
    return 0;
  }
  users.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "OWNER" ? -1 : 1));

  line("");
  users.forEach((u, i) => {
    const role = u.role === "OWNER" ? "Owner" : "Member";
    const state = u.active ? "active" : "switched off";
    line(`  ${String(i + 1).padStart(2)}.  ${u.name} (${u.email})  ${role}, ${state}`);
  });
  line("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    line("");
    line("  Cancelled. Nothing was changed.");
    process.exit(130);
  });
  let chosen: (typeof users)[number] | null = null;
  try {
    for (;;) {
      let answer: string;
      try {
        answer = (await rl.question("  Type the number of the person, or press Enter to cancel: ")).trim();
      } catch {
        answer = "";
      }
      if (!answer) break;
      const n = Number.parseInt(answer, 10);
      if (Number.isInteger(n) && n >= 1 && n <= users.length) {
        chosen = users[n - 1]!;
        break;
      }
      line(`  Type a number from 1 to ${users.length}.`);
    }
  } finally {
    rl.close();
  }
  if (!chosen) {
    line("  Cancelled. Nothing was changed.");
    return 0;
  }

  const user = chosen;
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_HOURS * 3_600_000);
  await dbTx(async (tx) => {
    // Older unused reset links for this person stop working.
    await tx.accessLink.updateMany({
      where: { userId: user.id, purpose: "RESET", usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.accessLink.create({
      data: { userId: user.id, purpose: "RESET", tokenHash: sha256(token), expiresAt, createdById: null },
    });
    // Clear the wrong-password lockout and sign them out everywhere.
    await tx.loginAttempt.deleteMany({ where: { emailNorm: user.email.toLowerCase(), success: false } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await logActivity(
      {
        actorId: null,
        type: "user.passwordReset",
        summary: `A password reset link for ${user.name} was made on the PC`,
        data: { via: "reset-password.bat", userId: user.id },
      },
      tx,
    );
  });

  line("");
  line(`  Done. ${user.name} is signed out everywhere and the wrong-password lockout is cleared.`);
  line(`  This link works once, for ${RESET_HOURS} hours:`);
  line("");
  line(`  Open this link on this PC: http://localhost:${PORT}/reset/${token}`);
  const lan = lanUrls(PORT);
  if (lan.length) line(`  Or on another office computer: ${lan[0]!.url}/reset/${token}`);
  const publicUrl = (process.env.APP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (publicUrl) line(`  Or from anywhere: ${publicUrl}/reset/${token}`);
  line("");
  line("  The app must be running (status.bat shows it) for the link to open.");
  if (!user.active) {
    line("  Note: this account is switched off. After choosing a password they still can't sign in");
    line("  until the Owner clicks Switch back on for it in Settings › Team.");
  }
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.log("");
  console.log("  [x]  Couldn't make a reset link. Is setup finished (setup.bat)?");
  console.log(`       Details: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await db.$disconnect().catch(() => undefined);
}
process.exit(code);
