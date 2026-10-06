import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_ATTEMPT_KEY, clearSetupCodeAttempts } from "../../../scripts/lib/setup-code.mjs";
import { createTestDb } from "../helpers/test-db";

// lib/auth modules are web-only ("server-only"); in tests they run in plain Node.
vi.mock("server-only", () => ({}));

const t = await createTestDb("login");
const { db, dbWrite } = await import("@/server/db");
const { checkSignIn, changeOwnPasswordChecked } = await import("@/lib/auth/login");
const throttle = await import("@/lib/auth/throttle");
const { LOGIN_MISMATCH_MESSAGE } = await import("@/lib/auth/throttle-rules");
const { hashPassword, verifyPassword } = await import("@/lib/auth/password");
const { FIELDS_NEED_FIXING, TeamError } = await import("@/server/services/users");

const OWNER_PASSWORD = "owner password 123";
const ALI_PASSWORD = "ali's password 12";
let ownerId = 0;
let aliId = 0;

async function seedFailures(emailNorm: string, sourceKey: string, secondsAgo: number[]) {
  await dbWrite((c) =>
    c.loginAttempt.createMany({
      data: secondsAgo.map((s) => ({ emailNorm, sourceKey, success: false, at: new Date(Date.now() - s * 1000) })),
    }),
  );
}

const failures = (emailNorm: string) => db.loginAttempt.count({ where: { emailNorm, success: false } });

beforeAll(async () => {
  const owner = await dbWrite(async (c) =>
    c.user.create({
      data: { email: "owner@example.com", name: "Arslan", role: "OWNER", passwordHash: await hashPassword(OWNER_PASSWORD) },
    }),
  );
  const ali = await dbWrite(async (c) =>
    c.user.create({ data: { email: "ali@example.com", name: "Ali", passwordHash: await hashPassword(ALI_PASSWORD) } }),
  );
  ownerId = owner.id;
  aliId = ali.id;
});

beforeEach(async () => {
  await dbWrite((c) => c.loginAttempt.deleteMany({}));
  await dbWrite((c) => c.notification.deleteMany({}));
  await dbWrite((c) => c.user.update({ where: { id: aliId }, data: { active: true } }));
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("sign-in checks", () => {
  it("signs in with the right password (any case / spacing of the email) and clears earlier failures", async () => {
    await seedFailures("ali@example.com", "lan:10.0.0.7", [300, 200]);
    const res = await checkSignIn({ email: "  ALI@Example.com ", password: ALI_PASSWORD, sourceKey: "lan:10.0.0.7" });
    expect(res).toEqual({ ok: true, userId: aliId });
    expect(await failures("ali@example.com")).toBe(0);
    expect(await db.loginAttempt.count({ where: { emailNorm: "ali@example.com", success: true } })).toBe(1);
  });

  it("gives the same message for an unknown email, a wrong password and a switched-off account (SECURITY-8)", async () => {
    const unknown = await checkSignIn({ email: "nobody@example.com", password: "whatever 12345", sourceKey: "lan:1" });
    const wrong = await checkSignIn({ email: "owner@example.com", password: "not it at all", sourceKey: "lan:1" });
    await dbWrite((c) => c.user.update({ where: { id: aliId }, data: { active: false } }));
    const offRight = await checkSignIn({ email: "ali@example.com", password: ALI_PASSWORD, sourceKey: "lan:1" });
    await dbWrite((c) => c.loginAttempt.deleteMany({ where: { emailNorm: "ali@example.com" } })); // skip the 1 s wait
    const offWrong = await checkSignIn({ email: "ali@example.com", password: "not it at all", sourceKey: "lan:1" });
    for (const r of [unknown, wrong, offRight, offWrong]) expect(r).toEqual({ ok: false, error: LOGIN_MISMATCH_MESSAGE });
    // Unknown emails are throttled like real ones, so the throttle doesn't reveal who has an account.
    expect(await failures("nobody@example.com")).toBe(1);
  });

  it("refuses oversized or malformed input before touching the database (SECURITY-4)", async () => {
    const huge = "a".repeat(1_900_000) + "@example.com";
    const cases = [
      { email: huge, password: "x" },
      { email: "not an email", password: "x" },
      { email: "a".repeat(250) + "@x.com", password: "x" },
      { email: "owner@example.com", password: "p".repeat(1025) },
    ];
    for (const c of cases) {
      expect(await checkSignIn({ ...c, sourceKey: "lan:1" })).toEqual({ ok: false, error: LOGIN_MISMATCH_MESSAGE });
    }
    expect(await db.loginAttempt.count()).toBe(0);
  });
});

describe("throttling (SECURITY-2)", () => {
  it("records the try before checking the password, and refuses the next one until the wait is over", async () => {
    const first = await checkSignIn({ email: "owner@example.com", password: "wrong guess 1", sourceKey: "lan:1" });
    expect(first).toEqual({ ok: false, error: LOGIN_MISMATCH_MESSAGE });
    // The right password straight away is refused too (1 s wait): no sleeping, no password check.
    const second = await checkSignIn({ email: "owner@example.com", password: OWNER_PASSWORD, sourceKey: "lan:2" });
    expect(second).toEqual({ ok: false, error: "Too many tries. Wait 1 second and try again." });
    expect(await failures("owner@example.com")).toBe(1);
  });

  it("lets only one of many parallel guesses through, whatever source each claims", async () => {
    const guesses = Array.from({ length: 25 }, (_, i) =>
      checkSignIn({ email: "owner@example.com", password: `guess number ${i}`, sourceKey: `lan:10.9.9.${i}` }),
    );
    const results = await Promise.all(guesses);
    expect(results.filter((r) => !r.ok && r.error === LOGIN_MISMATCH_MESSAGE)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.startsWith("Too many tries."))).toHaveLength(24);
    expect(await failures("owner@example.com")).toBe(1);
  });

  it("serialises through the database too: a try is refused while the growing wait runs", async () => {
    // 6 failures, the newest 10 s ago → the account waits 30 s after it.
    await seedFailures("owner@example.com", "lan:x", [100, 90, 80, 70, 60, 10]);
    const claim = await throttle.claimLoginAttempt("owner@example.com", "lan:fresh");
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.retryInSeconds).toBeGreaterThanOrEqual(19);
    const res = await checkSignIn({ email: "owner@example.com", password: OWNER_PASSWORD, sourceKey: "lan:fresh" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^Too many tries\. Wait (19|20) seconds and try again\.$/);
  });

  it("frees the account again after a check, also when the check fails", async () => {
    const claim = await throttle.claimLoginAttempt("ali@example.com", "lan:1");
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const parallel = await throttle.claimLoginAttempt("ali@example.com", "lan:2");
    expect(parallel).toEqual({ ok: false, retryInSeconds: 1 });
    claim.slot.release();
    claim.slot.release(); // twice is fine
    // Wait over (seed the only failure 2 s back): the next try goes through.
    await dbWrite((c) => c.loginAttempt.updateMany({ where: { emailNorm: "ali@example.com" }, data: { at: new Date(Date.now() - 2000) } }));
    const next = await throttle.claimLoginAttempt("ali@example.com", "lan:2");
    expect(next.ok).toBe(true);
    if (next.ok) next.slot.release();
  });
});

describe("per-source limit is a soft wait, never a lock (SECURITY-5)", () => {
  it("makes one source wait a minute after 5 failures, while other sources and later tries still work", async () => {
    // Someone faking the Owner's own address got the password wrong 5 times, the last 20 s ago.
    await seedFailures("owner@example.com", "lan:192.168.1.10", [60, 50, 40, 30, 20]);
    const fromThere = await checkSignIn({ email: "owner@example.com", password: OWNER_PASSWORD, sourceKey: "lan:192.168.1.10" });
    expect(fromThere.ok).toBe(false);
    if (!fromThere.ok) expect(fromThere.error).toMatch(/^Too many tries\. Wait (39|40) seconds and try again\.$/);
    // Another place isn't slowed by that source's extra wait (only by the account-wide 16 s, already over).
    const elsewhere = await checkSignIn({ email: "owner@example.com", password: OWNER_PASSWORD, sourceKey: "lan:192.168.1.11" });
    expect(elsewhere).toEqual({ ok: true, userId: ownerId });
  });

  it("lets the same source in after the minute, however many failures there were", async () => {
    await seedFailures("owner@example.com", "lan:192.168.1.10", [200, 190, 180, 170, 160, 150, 140, 130, 120, 61]);
    const res = await checkSignIn({ email: "owner@example.com", password: OWNER_PASSWORD, sourceKey: "lan:192.168.1.10" });
    expect(res).toEqual({ ok: true, userId: ownerId });
  });

  it("tells the Owner once when one source reaches 5 wrong passwords for a real account", async () => {
    await seedFailures("ali@example.com", "lan:5", [400, 380, 360, 340]);
    const res = await checkSignIn({ email: "ali@example.com", password: "wrong again 1", sourceKey: "lan:5" });
    expect(res).toEqual({ ok: false, error: LOGIN_MISMATCH_MESSAGE });
    const notes = await db.notification.findMany({ where: { type: "auth.lockout" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.userId).toBe(ownerId);
    expect(notes[0]!.title).toBe("5 wrong passwords for Ali");
    expect(await db.activityLog.count({ where: { type: "auth.lockout" } })).toBeGreaterThanOrEqual(1);
    // Unknown emails never notify anyone.
    await seedFailures("ghost@example.com", "lan:5", [400, 380, 360, 340]);
    await checkSignIn({ email: "ghost@example.com", password: "wrong again 1", sourceKey: "lan:5" });
    expect(await db.notification.count({ where: { type: "auth.lockout" } })).toBe(1);
  });
});

describe("changing your own password in Settings (same gate as signing in)", () => {
  const BEA_PASSWORD = "bea's password 123";
  const bea = { id: 0, email: "bea@example.com", sessionId: null };

  beforeAll(async () => {
    const u = await dbWrite(async (c) =>
      c.user.create({ data: { email: bea.email, name: "Bea", passwordHash: await hashPassword(BEA_PASSWORD) } }),
    );
    bea.id = u.id;
  });

  it("checks only one of many parallel current-password guesses and records it", async () => {
    const newPassword = { password: "a brand new password", confirm: "a brand new password" };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        changeOwnPasswordChecked(bea, { current: `guess number ${i}`, ...newPassword }, `lan:10.1.1.${i}`).catch(
          (err: unknown) => err,
        ),
      ),
    );
    const wrong = results.filter((r) => r instanceof TeamError && r.code === "wrong-password");
    const refused = results.filter(
      (r) => !(r instanceof Error) && (r as { ok: boolean }).ok === false && (r as { error: string }).error.startsWith("Too many tries."),
    );
    expect(wrong).toHaveLength(1);
    expect(refused).toHaveLength(9);
    expect(await failures(bea.email)).toBe(1);
  });

  it("doesn't count a right current password when only the new one needs fixing; a change clears failures", async () => {
    await expect(
      changeOwnPasswordChecked(bea, { current: BEA_PASSWORD, password: "short", confirm: "short" }, "lan:1"),
    ).rejects.toMatchObject({ message: FIELDS_NEED_FIXING });
    expect(await failures(bea.email)).toBe(0);

    await seedFailures(bea.email, "lan:1", [300]);
    const next = "bea's second password";
    expect(await changeOwnPasswordChecked(bea, { current: BEA_PASSWORD, password: next, confirm: next }, "lan:1")).toEqual({ ok: true });
    expect(await failures(bea.email)).toBe(0);
    const stored = await db.user.findUniqueOrThrow({ where: { id: bea.id }, select: { passwordHash: true } });
    expect(await verifyPassword(stored.passwordHash, next)).toBe(true);
  });
});

describe("other password prompts and setup codes", () => {
  it("checkLoginThrottle refuses instead of asking to sleep", async () => {
    expect(await throttle.checkLoginThrottle("ali@example.com", "lan:1")).toEqual({ allowed: true, delayMs: 0 });
    await throttle.recordLoginAttempt("ali@example.com", "lan:1", false);
    const verdict = await throttle.checkLoginThrottle("ali@example.com", "lan:1");
    expect(verdict).toMatchObject({ allowed: false, retryInSeconds: 1, retryInMinutes: 1 });
  });

  it("counts wrong setup codes per source, under the key setup.bat clears (SECURITY-6)", async () => {
    // The app and setup.bat each define the key; they must agree.
    expect(throttle.SETUP_THROTTLE_KEY).toBe("__setup__");
    expect(throttle.SETUP_THROTTLE_KEY).toBe(SETUP_ATTEMPT_KEY);
    for (let i = 0; i < 10; i++) await throttle.recordSetupFailure("lan:10.0.0.66");
    expect(await throttle.setupAttemptsBlocked("lan:10.0.0.66")).toBe(true);
    // Nobody else is blocked, including the PC itself.
    expect(await throttle.setupAttemptsBlocked("lan:::1")).toBe(false);
    expect(await throttle.setupAttemptsBlocked("lan:10.0.0.66", new Date(Date.now() + 61 * 60_000))).toBe(false);
    // What setup.bat does when it prints a new code (the real script helper, on this test database):
    await throttle.recordLoginAttempt("ali@example.com", "lan:10.0.0.66", false);
    expect(await clearSetupCodeAttempts(t.file)).toBe(10);
    expect(await throttle.setupAttemptsBlocked("lan:10.0.0.66")).toBe(false);
    expect(await failures("ali@example.com")).toBe(1); // sign-in failures are left alone
  });
});
