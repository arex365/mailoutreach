/**
 * OPS-2: the service accounts may read and run the project folder but change only the folders
 * they write to, never the scripts and programs that the owner runs as administrator.
 * M6-DESIGN §3.4: the second backup folder is granted on its own, last; an unplugged or FAT/exFAT stick, or a whole
 * drive, only gives a warning and never stops install-services.bat.
 * Review fix SECURITY-01: the second folder comes from the database (which the web app can write) and is granted as
 * administrator, so a folder inside the app, a Windows or program folder, or a whole profile folder is refused with a
 * warning; a folder an earlier run granted that isn't needed any more loses the grant (run\service-acl.txt).
 * (Nothing here calls icacls for real.)
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACL_RECORD,
  OWN_FOLDER_TEXT,
  SERVICE_ACCOUNTS,
  SERVICE_WRITE_DIRS,
  grantServiceAccess,
  icaclsGrantCommands,
  icaclsRemoveCommand,
  icaclsSecondFolderCommand,
  isDriveRoot,
  profileFolders,
  readAclRecord,
  secondFolderRefusal,
  secondFolderRefusedWarning,
  secondFolderWarning,
  serviceWriteFolders,
  staleGrants,
  systemFolders,
} from "../../../scripts/lib/service-acl.mjs";

const root = path.resolve("C:/Users/owner/Pictures/outreach");
const appFolders = SERVICE_WRITE_DIRS.map((d) => path.join(root, d));

/** A usual Windows environment for the owner "polyg" (an elevated install-services.bat window). */
const WINDOWS_ENV = {
  WINDIR: "C:\\WINDOWS",
  SystemRoot: "C:\\WINDOWS",
  SystemDrive: "C:",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramW6432: "C:\\Program Files",
  ProgramData: "C:\\ProgramData",
  PUBLIC: "C:\\Users\\Public",
  USERPROFILE: "C:\\Users\\polyg",
  OneDrive: "C:\\Users\\polyg\\OneDrive",
};
const appRoot = path.resolve("C:/Outreach");

describe("serviceWriteFolders", () => {
  it("is data, backups, logs, run and .next, never the project folder itself", () => {
    const { folders, secondFolder } = serviceWriteFolders({ root, databaseFile: path.join(root, "data", "app.db") });
    expect(folders).toEqual(appFolders);
    expect(secondFolder).toBeNull();
    expect(SERVICE_WRITE_DIRS).toEqual(["data", "backups", "logs", "run", ".next"]);
    for (const f of folders) expect(path.resolve(f).toLowerCase()).not.toBe(root.toLowerCase());
    // Where the scripts live stays read-only.
    for (const readOnly of ["scripts", "tools", "node_modules", "dist", "src", "worker"]) {
      expect(folders.map((f: string) => path.basename(f))).not.toContain(readOnly);
    }
  });

  it("adds the database's folder when .env points elsewhere, and gives the second backup folder separately", () => {
    const { folders, secondFolder } = serviceWriteFolders({
      root,
      databaseFile: "D:/OutreachData/app.db",
      secondBackupFolder: "E:\\Backups\\Outreach",
    });
    expect(folders).toContain(path.resolve("D:/OutreachData"));
    expect(folders).not.toContain(path.resolve("E:/Backups/Outreach"));
    expect(secondFolder).toBe(path.resolve("E:/Backups/Outreach"));
  });

  it("never offers a network share or a relative path; any other second folder is passed on, to be granted or refused", () => {
    for (const second of ["\\\\office-nas\\backups", "relative\\folder", "  "]) {
      expect(serviceWriteFolders({ root, secondBackupFolder: second }), second).toEqual({ folders: appFolders, secondFolder: null });
    }
    // A whole drive, a folder above the project and one inside it reach grantServiceAccess, which says why it refuses them.
    for (const second of ["D:\\", "C:\\Users\\owner", path.join(root, "scripts")]) {
      expect(serviceWriteFolders({ root, secondBackupFolder: second }), second).toEqual({ folders: appFolders, secondFolder: path.resolve(second) });
    }
    // A database file sitting directly in the project folder doesn't open the project folder up.
    expect(serviceWriteFolders({ root, databaseFile: path.join(root, "app.db") }).folders).toEqual(appFolders);
  });

  it("lists a folder only once, whatever its spelling", () => {
    const { folders } = serviceWriteFolders({
      root,
      databaseFile: path.join(root, "DATA", "app.db"),
      secondBackupFolder: path.join(root, "backups"),
    });
    expect(folders).toHaveLength(SERVICE_WRITE_DIRS.length);
  });

  it("knows a whole drive when it sees one", () => {
    expect(isDriveRoot("D:\\")).toBe(true);
    expect(isDriveRoot("d:/")).toBe(true);
    expect(isDriveRoot("D:\\Backups")).toBe(false);
  });
});

describe("secondFolderRefusal (SECURITY-01: the same folders Settings › Backups refuses)", () => {
  const refusal = (dir: string, env: Record<string, string | undefined> = WINDOWS_ENV, r: string | null = appRoot) =>
    secondFolderRefusal(dir, { root: r, env });

  it("refuses the app's folder, anything inside it (the scripts and programs the scripts run as administrator) and a folder above it", () => {
    expect(refusal(appRoot)).toBe("it is the app's folder or a folder inside it");
    for (const inside of ["scripts", "tools", "node_modules", "backups", "backups\\demo"]) {
      expect(refusal(path.join(appRoot, inside)), inside).toBe("it is the app's folder or a folder inside it");
    }
    // Case and a trailing backslash don't matter.
    expect(refusal("c:\\OUTREACH\\Scripts\\")).toBe("it is the app's folder or a folder inside it");
    // An app folder under Pictures: the folders above it are refused too.
    const inPictures = path.resolve("C:/Users/polyg/Pictures/outreach");
    expect(refusal("C:\\Users\\polyg\\Pictures", WINDOWS_ENV, inPictures)).toBe("it contains the app's folder");
    expect(refusal(path.join(inPictures, "scripts"), WINDOWS_ENV, inPictures)).toBe("it is the app's folder or a folder inside it");
    // A folder next to the app's (C:\Outreach backups) is fine.
    expect(refusal("C:\\Outreach backups")).toBeNull();
  });

  it("refuses Windows' and the programs' folders and everything inside them", () => {
    for (const dir of [
      "C:\\Windows",
      "C:\\Windows\\System32",
      "C:\\Program Files",
      "C:\\Program Files\\nodejs",
      "c:\\program files (x86)\\cloudflared",
      "C:\\ProgramData",
      "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp",
    ]) {
      expect(refusal(dir), dir).toBe("it is a Windows or program folder");
    }
    // A folder whose name only starts the same way is fine.
    expect(refusal("C:\\Program Files backups")).toBeNull();
  });

  it("reads Windows' folders from the environment, with the usual places as fallbacks", () => {
    const moved = { ...WINDOWS_ENV, WINDIR: "D:\\Win", SystemRoot: "D:\\Win", ProgramFiles: "D:\\Programs", ProgramW6432: "D:\\Programs" };
    expect(refusal("D:\\Win\\Temp", moved)).toBe("it is a Windows or program folder");
    expect(refusal("D:\\Programs\\nodejs", moved)).toBe("it is a Windows or program folder");
    // Environment names in any case (Windows ignores it).
    expect(refusal("E:\\Apps\\x", { windir: "E:\\Apps" })).toBe("it is a Windows or program folder");
    // Nothing in the environment: the usual places still count; a whole drive is never taken as Windows' folder.
    expect(refusal("C:\\Windows\\Temp", {})).toBe("it is a Windows or program folder");
    expect(refusal("C:\\Program Files (x86)\\x", {})).toBe("it is a Windows or program folder");
    expect(refusal("D:\\Backups", { WINDIR: "D:\\" })).toBeNull();
    expect(systemFolders({}).map((p: string) => p.toLowerCase())).toEqual(
      ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"].map((p) => path.resolve(p).toLowerCase()),
    );
  });

  it("refuses a whole profile folder, but a new folder inside one is fine", () => {
    expect(refusal("C:\\Users")).toBe("it holds every user's own folders");
    expect(refusal("C:\\Users\\polyg")).toBe("it is a whole user folder");
    expect(refusal("C:\\Users\\someone-else")).toBe("it is a whole user folder");
    expect(refusal("C:\\Users\\polyg\\OneDrive")).toBe("it is a whole OneDrive folder");
    expect(refusal("c:\\users\\POLYG\\onedrive\\")).toBe("it is a whole onedrive folder");
    expect(refusal("C:\\Users\\polyg\\OneDrive - Polygon Paradise")).toBe("it is a whole OneDrive - Polygon Paradise folder");
    for (const name of ["Documents", "Desktop", "Pictures", "Downloads"]) {
      expect(refusal(`C:\\Users\\polyg\\${name}`), name).toBe(`it is a whole ${name} folder`);
    }
    // OneDrive's folder backup puts Documents, Desktop and Pictures inside the OneDrive folder: whole folders there too.
    expect(refusal("C:\\Users\\polyg\\OneDrive\\Documents")).toBe("it is a whole Documents folder");
    expect(refusal("C:\\Users\\polyg\\OneDrive - Polygon Paradise\\Desktop")).toBe("it is a whole Desktop folder");
    expect(refusal("C:\\Users\\polyg\\OneDrive\\Pictures\\Outreach backups")).toBeNull();
    // The design's own example and other folders of their own.
    expect(refusal("C:\\Users\\polyg\\OneDrive\\Outreach backups")).toBeNull();
    expect(refusal("C:\\Users\\polyg\\OneDrive - Polygon Paradise\\Backups")).toBeNull();
    expect(refusal("C:\\Users\\polyg\\Documents\\Outreach backups")).toBeNull();
    expect(refusal("D:\\Backups")).toBeNull();
    expect(refusal("E:\\Outreach backups")).toBeNull();
  });

  it("finds the profiles folder from the environment, and OneDrive where %OneDrive% says it is", () => {
    const env = { PUBLIC: "D:\\Profiles\\Public", USERPROFILE: "D:\\Profiles\\polyg", OneDrive: "E:\\OneDrive" };
    expect(refusal("D:\\Profiles\\polyg", env)).toBe("it is a whole user folder");
    expect(refusal("D:\\Profiles\\polyg\\Desktop", env)).toBe("it is a whole Desktop folder");
    expect(refusal("E:\\OneDrive", env)).toBe("it is a whole OneDrive folder");
    expect(refusal("E:\\OneDrive\\Outreach backups", env)).toBeNull();
    expect(refusal("E:\\OneDrive\\Pictures", env)).toBe("it is a whole Pictures folder");
    // C:\Users always counts; a service's own profile (inside Windows' folder) never names the profiles folder.
    expect(profileFolders({ USERPROFILE: "C:\\WINDOWS\\system32\\config\\systemprofile" }).map((p: string) => p.toLowerCase())).toEqual([
      path.resolve("C:\\Users").toLowerCase(),
    ]);
    // A profile directly on a drive never turns the whole drive into "the profiles folder".
    expect(refusal("D:\\Backups", { USERPROFILE: "D:\\polyg", PUBLIC: "D:\\Public" })).toBeNull();
  });

  it("the warning says why and what to do, in the words Settings › Backups uses", () => {
    expect(OWN_FOLDER_TEXT).toBe(
      "Pick a folder of its own, for example a new folder on a USB stick or in OneDrive (not a Windows, program or whole-profile folder).",
    );
    expect(secondFolderRefusedWarning("C:\\Users\\polyg\\OneDrive", "it is a whole OneDrive folder")).toBe(
      `Didn't give the background sender access to the second backup folder (C:\\Users\\polyg\\OneDrive): it is a whole OneDrive folder. ${OWN_FOLDER_TEXT} Save it in Settings › Backups, then run install-services.bat again.`,
    );
  });
});

describe("icaclsGrantCommands", () => {
  it("replaces any older grant on the project folder with read-and-run, and gives change rights only below", () => {
    const folders = [path.join(root, "data"), path.join(root, "logs")];
    const commands = icaclsGrantCommands({ root, folders });
    expect(commands[0]).toEqual([root, "/grant:r", ...SERVICE_ACCOUNTS.map((a) => `${a}:(OI)(CI)RX`), "/Q"]);
    expect(commands.slice(1)).toEqual(folders.map((f) => [f, "/grant:r", ...SERVICE_ACCOUNTS.map((a) => `${a}:(OI)(CI)M`), "/Q"]));
    expect(SERVICE_ACCOUNTS).toEqual(["NT SERVICE\\OutreachWeb", "NT SERVICE\\OutreachWorker"]);
    // Nothing grants "change" (M) or "full" (F) on the project folder itself.
    expect(commands.filter((c: string[]) => c[0] === root).flat().join(" ")).not.toMatch(/:\(OI\)\(CI\)(M|F)\b/);
    expect(icaclsSecondFolderCommand("E:\\Backups")).toEqual(["E:\\Backups", "/grant:r", ...SERVICE_ACCOUNTS.map((a) => `${a}:(OI)(CI)M`), "/Q"]);
  });
});

describe("grantServiceAccess", () => {
  // A scratch "app folder" and, next to it (never inside it), the folders that stand for a USB stick.
  const tmp = path.join(path.resolve("."), "data", "test", `service-acl-${process.pid}-${Date.now()}`);
  const app = path.join(tmp, "app");
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ok = { status: 0, stdout: "", stderr: "" };
  /** The environment of an elevated window on this PC (Windows' folders), without the project's own folders in it. */
  const env = WINDOWS_ENV;

  it("creates the folders and runs the commands in order, stopping at the first failure", () => {
    const folders = [path.join(app, "data"), path.join(app, "logs")];
    const calls: string[][] = [];
    const res = grantServiceAccess({ root: app, folders, env, previous: [], run: (args: string[]) => (calls.push(args), ok) });
    expect(res).toEqual({ ok: true, folders, secondFolder: null, error: null, warning: null, revoked: [] });
    expect(calls.map((c) => c[0])).toEqual([app, ...folders]);
    for (const f of folders) expect(fs.statSync(f).isDirectory()).toBe(true);

    const failing = grantServiceAccess({
      root: app,
      folders,
      env,
      previous: [],
      run: (args: string[]) => (args[0] === folders[0] ? { status: 5, stdout: "Access is denied.", stderr: "" } : ok),
    });
    expect(failing.ok).toBe(false);
    expect(failing.error).toContain("Access is denied.");
  });

  it("grants the second folder last, on its own (both accounts, change rights), and records it", () => {
    const folders = [path.join(app, "data")];
    const second = path.join(tmp, "usb-backups");
    fs.mkdirSync(second, { recursive: true });
    const calls: string[][] = [];
    const res = grantServiceAccess({ root: app, folders, secondFolder: second, env, previous: [], run: (args: string[]) => (calls.push(args), ok) });
    expect(res).toEqual({ ok: true, folders: [...folders, second], secondFolder: second, error: null, warning: null, revoked: [] });
    expect(calls.map((c) => c[0])).toEqual([app, ...folders, second]);
    expect(calls.at(-1)).toEqual(icaclsSecondFolderCommand(second));
  });

  it("a missing second folder, a whole drive or an icacls failure there is only a warning; the folder isn't created", () => {
    const folders = [path.join(app, "data")];
    const calls: string[][] = [];
    const run = (args: string[]) => (calls.push(args), ok);

    const unplugged = path.join(tmp, "unplugged-stick", "Backups");
    const missing = grantServiceAccess({ root: app, folders, secondFolder: unplugged, env, previous: [], run });
    expect(missing).toEqual({
      ok: true,
      folders,
      secondFolder: null,
      error: null,
      warning: secondFolderWarning(unplugged, "the folder isn't there (is the drive plugged in?)"),
      revoked: [],
    });
    expect(missing.warning).toBe(
      `Couldn't give the background sender access to the second backup folder (${unplugged}): the folder isn't there (is the drive plugged in?). Copies there fail until the drive is plugged in and install-services.bat runs again.`,
    );
    expect(fs.existsSync(unplugged)).toBe(false);
    expect(calls.map((c) => c[0])).not.toContain(unplugged);

    const drive = grantServiceAccess({ root: app, folders, secondFolder: path.resolve("E:\\"), env, previous: [], run });
    expect(drive.ok).toBe(true);
    expect(drive.warning).toMatch(/^Couldn't give the background sender access to the second backup folder \(E:\\\): it is a whole drive/);
    expect(calls.map((c) => c[0])).not.toContain(path.resolve("E:\\"));

    const fat = path.join(tmp, "fat-stick");
    fs.mkdirSync(fat, { recursive: true });
    const failing = grantServiceAccess({
      root: app,
      folders,
      secondFolder: fat,
      env,
      previous: [],
      run: (args: string[]) => (args[0] === fat ? { status: 1332, stdout: "No mapping between account names and security IDs was done.", stderr: "" } : ok),
    });
    expect(failing).toMatchObject({ ok: true, folders, secondFolder: null, error: null });
    expect(failing.warning).toContain("Windows said: No mapping between account names and security IDs was done.");
  });

  it("refuses <root>\\scripts, Program Files and a OneDrive root with a warning, and never calls icacls on them (SECURITY-01)", () => {
    const folders = [path.join(app, "data")];
    const scripts = path.join(app, "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    const cases: Array<[string, string]> = [
      [scripts, "it is the app's folder or a folder inside it"],
      ["C:\\Program Files\\nodejs", "it is a Windows or program folder"],
      ["C:\\Users\\polyg\\OneDrive", "it is a whole OneDrive folder"],
      ["C:\\Users\\someone-else", "it is a whole user folder"],
      [tmp, "it contains the app's folder"],
    ];
    for (const [second, reason] of cases) {
      const calls: string[][] = [];
      const res = grantServiceAccess({ root: app, folders, secondFolder: second, env, previous: [], run: (args: string[]) => (calls.push(args), ok) });
      expect(res, second).toEqual({
        ok: true,
        folders,
        secondFolder: null,
        error: null,
        warning: secondFolderRefusedWarning(second, reason),
        revoked: [],
      });
      // Only the app's own folders were granted: nothing touched the refused folder.
      expect(calls.map((c) => c[0]), second).toEqual([app, ...folders]);
    }
    // A new folder inside OneDrive is a folder of its own (here: a scratch folder standing for it, outside the app).
    const own = path.join(tmp, "OneDrive", "Outreach backups");
    fs.mkdirSync(own, { recursive: true });
    const granted = grantServiceAccess({ root: app, folders, secondFolder: own, env, previous: [], run: () => ok });
    expect(granted).toMatchObject({ ok: true, secondFolder: own, warning: null });
  });

  it("takes an earlier grant back when this run doesn't make it again (a refused or changed second folder, an old data folder)", () => {
    const folders = [path.join(app, "data")];
    const oldSecond = path.join(tmp, "old-usb-backups");
    const refusedInside = path.join(app, "scripts");
    const unplugged = path.join(tmp, "unplugged-old-stick");
    fs.mkdirSync(oldSecond, { recursive: true });
    fs.mkdirSync(refusedInside, { recursive: true });
    const parent = path.dirname(app); // install-services.ps1's own "read attributes" grant above the app: never touched here
    const previous = [...folders, oldSecond, refusedInside.toUpperCase(), unplugged, parent, app];
    const calls: string[][] = [];
    const res = grantServiceAccess({
      root: app,
      folders,
      secondFolder: refusedInside,
      env,
      previous,
      run: (args: string[]) => (calls.push(args), ok),
    });
    expect(res.ok).toBe(true);
    expect(res.warning).toBe(secondFolderRefusedWarning(refusedInside, "it is the app's folder or a folder inside it"));
    // The old second folder and the refused one lose the grant; a folder that isn't there (the unplugged stick) stays in
    // the record for uninstall-services.bat; the app's folder, the folders above it and the current folders are left alone.
    expect(res.revoked.map((p: string) => p.toLowerCase())).toEqual([oldSecond, refusedInside].map((p) => p.toLowerCase()));
    const removeCalls = calls.filter((c) => c[1] === "/remove");
    expect(removeCalls.map((c) => c[0].toLowerCase())).toEqual([oldSecond, refusedInside].map((p) => p.toLowerCase()));
    expect(removeCalls[0]).toEqual(icaclsRemoveCommand(removeCalls[0]![0]!));
    expect(icaclsRemoveCommand("E:\\Backups")).toEqual(["E:\\Backups", "/remove", "NT SERVICE\\OutreachWeb", "NT SERVICE\\OutreachWorker", "/Q"]);

    // A failed removal isn't an error: the grant stays recorded, so uninstall-services.bat tries again.
    const failing = grantServiceAccess({
      root: app,
      folders,
      env,
      previous: [oldSecond],
      run: (args: string[]) => (args[1] === "/remove" ? { status: 5, stdout: "Access is denied.", stderr: "" } : ok),
    });
    expect(failing).toMatchObject({ ok: true, revoked: [], warning: null });
  });

  it("reads the earlier grants from run\\service-acl.txt (install-services.ps1 writes it with a BOM) when none are passed", () => {
    const withRecord = path.join(tmp, "with-record");
    const stale = path.join(tmp, "stale-second-folder");
    fs.mkdirSync(path.join(withRecord, "run"), { recursive: true });
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(withRecord, ACL_RECORD), `\uFEFF${path.join(withRecord, "data")}\r\n${stale}\r\n\r\n`, "utf8");
    expect(readAclRecord(withRecord)).toEqual([path.join(withRecord, "data"), stale]);
    expect(readAclRecord(path.join(tmp, "no-record-here"))).toEqual([]);

    const calls: string[][] = [];
    const res = grantServiceAccess({ root: withRecord, folders: [path.join(withRecord, "data")], env, run: (args: string[]) => (calls.push(args), ok) });
    expect(res.revoked).toEqual([stale]);
    expect(calls.at(-1)).toEqual(icaclsRemoveCommand(stale));
  });
});

describe("run\\service-acl.txt keeps every folder ever granted (install-services.ps1, uninstall-services.ps1)", () => {
  const read = (rel: string) => fs.readFileSync(path.join(path.resolve("."), rel), "utf8");

  it("install-services.ps1 adds the earlier entries to the new record, and reads node's answer as UTF-8", () => {
    const text = read("scripts/install-services.ps1");
    const grant = text.indexOf("'scripts\\service-acl.mjs'), 'grant')");
    const readOld = text.indexOf("foreach ($line in @(Get-Content -LiteralPath $aclRecord))");
    const write = text.indexOf("Set-Content -LiteralPath $aclRecord -Value $record -Encoding UTF8");
    expect(grant).toBeGreaterThan(-1);
    expect(readOld).toBeGreaterThan(grant);
    expect(write).toBeGreaterThan(readOld);
    expect(text).toContain("if ($entry -and -not ($record -contains $entry)) { $record += $entry }");
    expect(text).not.toContain("Set-Content -LiteralPath $aclRecord -Value $granted");
    expect(text).toContain("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false");
    // It says which earlier grants were taken back, and prints the refusal like any other second-folder warning.
    expect(text).toContain("foreach ($old in @($grantResult.revoked))");
    expect(text).toContain("if ($grantResult.warning) { Write-Attention ([string]$grantResult.warning) }");
  });

  it("uninstall-services.ps1 keeps the entries it couldn't take the permission off (an unplugged stick)", () => {
    const text = read("scripts/uninstall-services.ps1");
    expect(text).toContain("if ($r.ExitCode -ne 0) { $left += $dir }");
    expect(text).toContain("Set-Content -LiteralPath $aclRecord -Value $left -Encoding UTF8");
    expect(text.indexOf("Remove-Item -LiteralPath $aclRecord")).toBeGreaterThan(text.indexOf("if ($left.Count -gt 0)"));
  });
});

describe("staleGrants", () => {
  it("lists earlier grants this run doesn't make again, once each, never the project folder or a folder above it", () => {
    const current = [path.join(appRoot, "data"), "E:\\Backups"];
    const previous = [
      path.join(appRoot, "DATA"),
      "e:\\backups\\",
      "D:\\Old backups",
      "d:\\OLD BACKUPS",
      path.join(appRoot, "scripts"),
      appRoot,
      "C:\\",
      "\\\\nas\\share",
      "relative",
    ];
    expect(staleGrants({ root: appRoot, previous, current })).toEqual([path.resolve("D:\\Old backups"), path.join(appRoot, "scripts")]);
    expect(staleGrants({ root: appRoot, previous: [], current })).toEqual([]);
  });
});
