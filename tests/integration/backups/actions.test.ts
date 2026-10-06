import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeUser } from "../campaigns/seed";
import type { SecondFolderDeps } from "@/server/services/backups";

/**
 * Settings › Backups' actions (M6-DESIGN §3.4, §3.8): Back up now for everyone (one queued backup at a time); the
 * second folder for the Owner only, refused for a network path, a whole drive, a mapped network drive, the app's own
 * folder, another installation's folder and in the practice copy; saved with a warning when the web app can't write
 * there yet (EPERM), for OneDrive, a removable and the same drive; saving writes the marker and queues the first copy.
 * The drive types and the file system's permission answers are stand-ins: nothing here asks Windows.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
/** What checkSecondFolder gets in these tests (the real function, with these stand-ins). */
const folderDeps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction,
    requireOwnerAction: async () => {
      const user = await requireUserAction();
      if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
      return user;
    },
  };
});
vi.mock("@/server/services/backups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/backups")>();
  return {
    ...actual,
    checkSecondFolder: (input: string) => actual.checkSecondFolder(input, folderDeps.current as SecondFolderDeps),
  };
});

const t = await createTestDb("backups-actions");
const { db, dbWrite } = await import("@/server/db");
const { getSetting, setSetting } = await import("@/server/settings");
const { setState } = await import("@/server/state");
const backups = await import("@/server/services/backups");
const actions = await import("@/app/(app)/settings/backups/actions");

let owner: TestUser;
let member: TestUser;
const tempDirs: string[] = [];
const T = backups.SECOND_FOLDER_TEXTS;
const appRoot = path.resolve(".");

function tempDir(...sub: string[]): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-backup-actions-"));
  tempDirs.push(base);
  const dir = path.join(base, ...sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const letterOf = (p: string) => /^([a-zA-Z]):/.exec(path.resolve(p))?.[1]?.toUpperCase() ?? "C";
const asUser = (u: { id: number; email: string; name: string; role: "OWNER" | "MEMBER" }): TestUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  timeZone: "Europe/Berlin",
  sessionId: 1,
});
/** A fixed drive and an app folder on another drive: no warning unless a test asks for one. */
const plain = (): SecondFolderDeps => ({ driveTypeOf: async () => "fixed", appRoot: "Q:\\Outreach", dbBytes: 64 * 1024 * 1024 });
const backupJobs = () => db.job.findMany({ where: { type: "backup.run" }, orderBy: { id: "asc" } });

beforeAll(async () => {
  owner = asUser(await makeUser("Arslan", { role: "OWNER", email: "arslan@polygonparadise.test" }));
  member = asUser(await makeUser("Ali", { email: "ali@polygonparadise.test" }));
  await setState("instance", { dbPath: "c:/outreach/data/app.db", id: "this-install", firstSeenAt: "2026-09-01T00:00:00.000Z" });
});

beforeEach(async () => {
  auth.user = owner;
  folderDeps.current = plain();
  await setSetting("backups.secondFolder", null, null);
  await setSetting("practice.copy", false, null);
  await dbWrite(async (c) => {
    await c.job.deleteMany({});
    await c.activityLog.deleteMany({});
  });
});

afterAll(async () => {
  await db.$disconnect();
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  t.cleanup();
});

describe("backUpNowAction (everyone)", () => {
  it("a Member queues one backup; a second click returns the same job", async () => {
    auth.user = member;
    const first = await actions.backUpNowAction();
    expect(first).toMatchObject({ ok: true, data: { workerRunning: false } });
    const second = await actions.backUpNowAction();
    expect(second.ok && first.ok && second.data.jobId === first.data.jobId).toBe(true);
    const jobs = await backupJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ payload: { kind: "MANUAL" }, createdById: member.id, activeDedupeKey: "backup:manual" });
  });

  it("asks a signed-out visitor to sign in again", async () => {
    auth.user = null;
    expect(await actions.backUpNowAction()).toMatchObject({ ok: false, error: "Your session has ended. Please sign in again." });
  });
});

describe("saveSecondFolderAction (Owner only)", () => {
  async function refused(folder: string, deps: SecondFolderDeps = plain()) {
    folderDeps.current = deps;
    const res = await actions.saveSecondFolderAction({ folder });
    expect(res.ok, folder).toBe(false);
    expect(await getSetting("backups.secondFolder")).toBeNull();
    expect(await backupJobs()).toEqual([]);
    return res.ok ? "" : res.error;
  }

  it("is refused for a Member, and changes nothing", async () => {
    auth.user = member;
    const dir = tempDir();
    const res = await actions.saveSecondFolderAction({ folder: dir });
    expect(res).toMatchObject({ ok: false, error: "Only the Owner can do this." });
    expect(await getSetting("backups.secondFolder")).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a network path, a whole drive, a mapped network drive and the app's own folder, with the fix", async () => {
    expect(await refused("\\\\office-nas\\backups")).toBe(T.network);
    expect(await refused("E:\\")).toBe("Pick a folder on that drive, for example E:\\Outreach backups.");
    expect(await refused("Z:\\Backups", { ...plain(), driveTypeOf: async (l) => (l === "Z" ? "remote" : "fixed") })).toBe(T.mappedDrive);
    expect(await refused(path.join(appRoot, "backups", "copies"), { ...plain(), appRoot })).toBe(T.insideApp);
  });

  it("refuses another installation's folder", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, backups.SECOND_FOLDER_MARKER), JSON.stringify({ instanceId: "another-install" }));
    expect(await refused(dir)).toBe(T.otherInstall);
  });

  it("is refused in the practice copy", async () => {
    await setSetting("practice.copy", true, null);
    expect(await refused(tempDir())).toBe("The practice copy doesn't copy its backups to a second folder.");
  });

  it("saves a good folder: the marker names this installation, the first copy is queued, and the change is logged", async () => {
    const dir = tempDir();
    const res = await actions.saveSecondFolderAction({ folder: dir });
    expect(res).toEqual({
      ok: true,
      data: { folder: path.resolve(dir), warning: null },
      message:
        "Saved. The first copy is being made now; this page shows whether it worked. If the app runs as a Windows service, run install-services.bat on the office PC so the background sender may write there.",
    });
    expect(await getSetting("backups.secondFolder")).toBe(path.resolve(dir));
    expect(await backups.readSecondFolderMarker(dir)).toMatchObject({ instanceId: "this-install" });
    const jobs = await backupJobs();
    expect(jobs.map((j) => [j.payload, j.activeDedupeKey, j.createdById])).toEqual([[{ kind: "MANUAL" }, "backup:manual", owner.id]]);
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" } })).summary).toBe(
      `Arslan set the second backup folder to ${path.resolve(dir)}`,
    );
  });

  it("saves a folder the web app can't write to yet (EPERM), without a marker, saying to run install-services.bat", async () => {
    const dir = tempDir();
    folderDeps.current = { ...plain(), fs: { stat: async () => Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" })) } };
    const res = await actions.saveSecondFolderAction({ folder: dir });
    expect(res).toMatchObject({ ok: true, data: { warning: T.cantWriteYet } });
    // The warning already says to run install-services.bat: it isn't said twice.
    expect(res.ok && res.message).toBe(`Saved. The first copy is being made now; this page shows whether it worked. ${T.cantWriteYet}`);
    expect(await getSetting("backups.secondFolder")).toBe(path.resolve(dir));
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await backupJobs()).toHaveLength(1);
  });

  it("saves OneDrive, removable and same-drive folders with their warning in the message", async () => {
    const oneDrive = tempDir("OneDrive", "Outreach backups");
    const a = await actions.saveSecondFolderAction({ folder: oneDrive });
    expect(a.ok && a.message).toContain(
      "OneDrive keeps an online copy only while it is signed in and syncing on this PC. 14 daily and 5 Back up now backups need about 1.2 GB of OneDrive space.",
    );

    folderDeps.current = { ...plain(), driveTypeOf: async () => "removable" };
    const b = await actions.saveSecondFolderAction({ folder: tempDir() });
    expect(b.ok && b.message).toContain("Copies fail while the stick is unplugged; the dashboard tells you.");

    const same = tempDir();
    folderDeps.current = { ...plain(), appRoot: `${letterOf(same)}:\\Outreach` };
    const c = await actions.saveSecondFolderAction({ folder: same });
    expect(c).toMatchObject({ ok: true, data: { warning: T.sameDrive(letterOf(same)) } });
    expect(c.ok && c.message).toContain("If the app runs as a Windows service, run install-services.bat");
    // Each save queues the first copy, one at a time.
    expect(await backupJobs()).toHaveLength(1);
  });

  it("clearSecondFolderAction stops copying (Owner only)", async () => {
    await setSetting("backups.secondFolder", "D:\\Backups", owner.id);
    auth.user = member;
    expect(await actions.clearSecondFolderAction()).toMatchObject({ ok: false, error: "Only the Owner can do this." });
    expect(await getSetting("backups.secondFolder")).toBe("D:\\Backups");
    auth.user = owner;
    expect(await actions.clearSecondFolderAction()).toMatchObject({ ok: true, message: "Backups are no longer copied to a second folder." });
    expect(await getSetting("backups.secondFolder")).toBeNull();
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" } })).summary).toBe("Arslan stopped copying backups to D:\\Backups");
  });
});
