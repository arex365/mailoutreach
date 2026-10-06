import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * The second backup folder's rules (M6-DESIGN §3.4), in their order, on real temporary folders with the drive type,
 * this installation's id, the app's folder and (for the permission cases) the file system replaced. Nothing here
 * runs PowerShell or touches the database.
 */

// Only the folder checks are tested here: keep the real database client out of it.
vi.mock("@/server/db", () => ({ db: {}, dbWrite: vi.fn(), dbTx: vi.fn(), withWriteLock: vi.fn() }));

const { SECOND_FOLDER_MARKER, SECOND_FOLDER_TEXTS: T, checkSecondFolder, driveTypeOf, readSecondFolderMarker, writeSecondFolderMarker } =
  await import("@/server/services/backups");

type Deps = NonNullable<Parameters<typeof checkSecondFolder>[1]>;

const tempDirs: string[] = [];
function tempDir(...sub: string[]): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-second-folder-"));
  tempDirs.push(base);
  const dir = path.join(base, ...sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const appRoot = path.resolve(".");
const letterOf = (p: string) => /^([a-zA-Z]):/.exec(path.resolve(p))?.[1]?.toUpperCase() ?? "C";
/** A fixed drive, this installation "mine", the app's real folder, a 64 MB database. */
const base: Deps = { driveTypeOf: async () => "fixed", instanceId: "mine", appRoot, dbBytes: 64 * 1024 * 1024 };
const withErr = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code });

async function refusal(input: string, deps: Deps = base): Promise<string> {
  const res = await checkSecondFolder(input, deps);
  if (res.ok) throw new Error(`"${input}" was accepted`);
  return res.error;
}

describe("checkSecondFolder: refusals, in order", () => {
  it("empty, too long, a network path, not a full path", async () => {
    expect(await refusal("   ")).toBe(T.empty);
    expect(await refusal(`C:\\${"a".repeat(240)}`)).toBe(T.tooLong);
    expect(await refusal("\\\\office-nas\\backups")).toBe(T.network);
    expect(await refusal("//office-nas/backups")).toBe(T.network);
    expect(await refusal("Backups")).toBe(T.notAbsolute);
    expect(await refusal("C:Backups")).toBe(T.notAbsolute);
  });

  it("a whole drive, named in the example", async () => {
    expect(await refusal("E:\\")).toBe("Pick a folder on that drive, for example E:\\Outreach backups.");
    expect(await refusal("d:/")).toBe("Pick a folder on that drive, for example D:\\Outreach backups.");
  });

  it("the app's own folder and anything inside it (the backups folder too)", async () => {
    expect(await refusal(appRoot)).toBe(T.insideApp);
    expect(await refusal(path.join(appRoot, "backups"))).toBe(T.insideApp);
    expect(await refusal(`"${path.join(appRoot, "data", "copies")}"`)).toBe(T.insideApp);
  });

  describe("a Windows, program or whole-profile folder, or one containing the app's (review SECURITY-01)", () => {
    // The Settings page refuses what install-services.bat would refuse (it gives both services change rights).
    const env = {
      windir: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramData: "C:\\ProgramData",
      SystemDrive: "C:",
      PUBLIC: "C:\\Users\\Public",
      USERPROFILE: "C:\\Users\\polyg",
    };
    /** Any folder "exists" and can be written to: only the rules decide. */
    const anyFolder: Deps["fs"] = {
      stat: async () => ({ isDirectory: () => true }),
      writeFile: async () => undefined,
      unlink: async () => undefined,
      readFile: async () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    };
    const deps: Deps = { ...base, appRoot: "D:\\Apps\\Outreach", env, fs: anyFolder };

    it("refuses them, whatever the letter case, with one sentence", async () => {
      expect(T.systemFolder).toBe(
        "Pick a folder of its own, for example a new folder on a USB stick or in OneDrive (not a Windows, program or whole-profile folder).",
      );
      for (const folder of [
        "C:\\Windows",
        "c:\\windows\\system32\\backups",
        "C:\\Program Files\\nodejs",
        "C:\\PROGRAM FILES (X86)\\Something",
        "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp",
        "C:\\Users",
        "C:\\Users\\polyg",
        "C:\\Users\\Public",
        "C:\\Users\\someone-else",
        "C:\\Users\\polyg\\Documents",
        "c:\\users\\polyg\\desktop",
        "C:\\Users\\polyg\\Pictures",
        "C:\\Users\\polyg\\Downloads",
        "C:\\Users\\polyg\\OneDrive",
        "C:\\Users\\polyg\\OneDrive - Polygon Paradise",
        "C:\\Users\\polyg\\Documents\\..\\Desktop\\",
        // OneDrive's folder backup puts Documents, Desktop and Pictures inside the OneDrive folder.
        "C:\\Users\\polyg\\OneDrive\\Documents",
        "C:\\Users\\polyg\\OneDrive - Polygon Paradise\\Pictures",
        // A folder that contains the app's own folder (its parent).
        "D:\\Apps",
      ]) {
        expect(await refusal(folder, deps), folder).toBe(T.systemFolder);
      }
      // Inside the app's folder keeps its own sentence.
      expect(await refusal("D:\\Apps\\Outreach\\scripts", deps)).toBe(T.insideApp);
    });

    it("accepts a folder of its own inside them (a OneDrive or Documents subfolder, another drive)", async () => {
      for (const folder of [
        "C:\\Users\\polyg\\OneDrive\\Outreach backups",
        "C:\\Users\\polyg\\OneDrive\\Documents\\Outreach backups",
        "C:\\Users\\polyg\\Documents\\Outreach backups",
        "C:\\Users\\polyg\\Backups",
        "E:\\Outreach backups",
        "D:\\Apps2\\Backups",
        "C:\\Windows backups",
      ]) {
        const res = await checkSecondFolder(folder, deps);
        expect(res.ok, folder).toBe(true);
      }
    });

    it("uses the usual places when the environment doesn't say (and the environment's when it does)", async () => {
      const bare: Deps = { ...deps, env: {} };
      for (const folder of ["C:\\Windows\\Temp", "C:\\Program Files\\x", "C:\\Program Files (x86)\\x", "C:\\ProgramData\\x", "C:\\Users\\polyg"]) {
        expect(await refusal(folder, bare), folder).toBe(T.systemFolder);
      }
      const elsewhere: Deps = { ...deps, env: { ...env, windir: "D:\\Win", SystemRoot: "D:\\Win", SystemDrive: "D:", PUBLIC: "D:\\Profiles\\Public" } };
      expect(await refusal("D:\\Win\\Backups", elsewhere)).toBe(T.systemFolder);
      expect(await refusal("D:\\Profiles\\polyg", elsewhere)).toBe(T.systemFolder);
      // The web service runs with a service profile inside Windows' folder: the profiles are still found in C:\Users.
      const service: Deps = { ...deps, env: { ...env, USERPROFILE: "C:\\Windows\\ServiceProfiles\\OutreachWeb", PUBLIC: undefined } };
      expect(await refusal("C:\\Users\\polyg\\OneDrive", service)).toBe(T.systemFolder);
      expect((await checkSecondFolder("C:\\Users\\polyg\\OneDrive\\Outreach backups", service)).ok).toBe(true);
    });
  });

  it("a mapped network drive, asked before the folder is even looked at", async () => {
    const asked: string[] = [];
    const deps: Deps = { ...base, driveTypeOf: async (l) => (asked.push(l), l === "Z" ? "remote" : "fixed") };
    expect(await refusal("z:\\Backups", deps)).toBe(T.mappedDrive);
    expect(asked).toEqual(["Z"]);
  });

  it("a missing folder or a file", async () => {
    const dir = tempDir();
    expect(await refusal(path.join(dir, "nope"))).toBe(T.missing);
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "x");
    expect(await refusal(file)).toBe(T.isFile);
    expect(T.isFile).toContain("D:\\Backups");
    expect(T.missing).not.toContain("\\\\");
  });

  it("another installation's folder (its marker names another id)", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, SECOND_FOLDER_MARKER), JSON.stringify({ instanceId: "someone-else", host: "OLD-PC" }));
    expect(await refusal(dir)).toBe(T.otherInstall);
    // Ours: fine. A marker that isn't ours to read (not JSON, no id) counts as none.
    expect((await checkSecondFolder(dir, { ...base, instanceId: "someone-else" })).ok).toBe(true);
    fs.writeFileSync(path.join(dir, SECOND_FOLDER_MARKER), "{ half");
    expect((await checkSecondFolder(dir, base)).ok).toBe(true);
  });

  it("a folder the app isn't allowed to write to for another reason (a read-only stick)", async () => {
    const dir = tempDir();
    const res = await checkSecondFolder(dir, { ...base, fs: { writeFile: async () => Promise.reject(withErr("EROFS")) } });
    expect(res).toEqual({ ok: false, error: T.notAllowed });
  });
});

describe("checkSecondFolder: saved, with at most one warning", () => {
  it("can't see or write there yet (EPERM/EACCES): saved, saying to run install-services.bat", async () => {
    const dir = tempDir();
    for (const deps of [
      { ...base, fs: { stat: async () => Promise.reject(withErr("EPERM")) } },
      { ...base, fs: { stat: async () => Promise.reject(withErr("EACCES")) } },
      { ...base, fs: { writeFile: async () => Promise.reject(withErr("EACCES")) } },
      { ...base, fs: { readFile: async () => Promise.reject(withErr("EPERM")) } },
    ] satisfies Deps[]) {
      expect(await checkSecondFolder(dir, deps)).toEqual({ ok: true, folder: path.resolve(dir), warning: T.cantWriteYet });
    }
    expect(T.cantWriteYet).toContain("install-services.bat");
  });

  it("a OneDrive folder: the space 14 daily and 5 Back up now backups need", async () => {
    for (const name of ["OneDrive", "OneDrive - Polygon Paradise"]) {
      const dir = tempDir(name, "Outreach backups");
      const res = await checkSecondFolder(dir, base);
      expect(res).toEqual({
        ok: true,
        folder: path.resolve(dir),
        warning:
          "OneDrive keeps an online copy only while it is signed in and syncing on this PC. 14 daily and 5 Back up now backups need about 1.2 GB of OneDrive space.",
      });
    }
  });

  it("a removable drive, and a folder on the app's own drive", async () => {
    const dir = tempDir();
    expect(await checkSecondFolder(dir, { ...base, driveTypeOf: async () => "removable" })).toEqual({
      ok: true,
      folder: path.resolve(dir),
      warning: "Copies fail while the stick is unplugged; the dashboard tells you.",
    });
    const letter = letterOf(dir);
    expect(await checkSecondFolder(dir, { ...base, appRoot: `${letter}:\\Outreach` })).toEqual({
      ok: true,
      folder: path.resolve(dir),
      warning: `This folder is on the same drive as the app (${letter}:). A copy there doesn't help if this drive fails.`,
    });
  });

  it("another fixed drive: no warning, and the write test leaves nothing behind", async () => {
    const dir = tempDir();
    const other = letterOf(dir) === "Q" ? "R" : "Q";
    expect(await checkSecondFolder(`  "${dir}"  `, { ...base, appRoot: `${other}:\\Outreach` })).toEqual({
      ok: true,
      folder: path.resolve(dir),
      warning: null,
    });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("the second folder's marker file", () => {
  it("is written through a temporary name, never creates a folder, and reads back", async () => {
    const dir = tempDir();
    const now = new Date("2026-09-27T10:00:00Z");
    await writeSecondFolderMarker(dir, "abc123", now);
    expect(fs.readdirSync(dir)).toEqual([SECOND_FOLDER_MARKER]);
    expect(await readSecondFolderMarker(dir)).toEqual({ instanceId: "abc123", host: os.hostname(), savedAt: now.toISOString() });
    const missing = path.join(dir, "unplugged");
    await expect(writeSecondFolderMarker(missing, "abc123", now)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fs.existsSync(missing)).toBe(false);
    expect(await readSecondFolderMarker(missing)).toBeNull();
  });
});

describe("driveTypeOf", () => {
  it("answers unknown for anything that isn't a drive letter, without asking Windows", async () => {
    expect(await driveTypeOf("")).toBe("unknown");
    expect(await driveTypeOf("1")).toBe("unknown");
    expect(await driveTypeOf("C:")).toBe("unknown");
    expect(await driveTypeOf("ab")).toBe("unknown");
  });
});
