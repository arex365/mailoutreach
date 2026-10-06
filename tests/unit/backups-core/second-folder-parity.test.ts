import { describe, expect, it, vi } from "vitest";
import { OWN_FOLDER_TEXT, secondFolderRefusal } from "../../../scripts/lib/service-acl.mjs";

/**
 * Review fix SECURITY-01, integration check: Settings › Backups (checkSecondFolder → isSystemOrProfileFolder) and
 * install-services.bat (secondFolderRefusal in scripts/lib/service-acl.mjs) refuse exactly the same second backup
 * folders, so a folder the page saves is never one the elevated script then refuses, and the reverse. Both are run on
 * one table of folders and environments; only the yes/no verdict is compared (the sentences differ by design: the page
 * says "Pick a folder outside the app's folder" for a folder inside the app).
 */

vi.mock("@/server/db", () => ({ db: {}, dbWrite: vi.fn(), dbTx: vi.fn(), withWriteLock: vi.fn() }));
const { SECOND_FOLDER_TEXTS, isSystemOrProfileFolder } = await import("@/server/services/backups");

type Env = Record<string, string | undefined>;

const WINDOWS_ENV: Env = {
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

const ENVS: Record<string, Env> = {
  "an elevated window": WINDOWS_ENV,
  "the web service (service profile, no %PUBLIC% or %OneDrive%)": {
    ...WINDOWS_ENV,
    USERPROFILE: "C:\\WINDOWS\\ServiceProfiles\\OutreachWeb",
    PUBLIC: undefined,
    OneDrive: undefined,
  },
  "nothing in the environment": {},
  "Windows and programs moved to D:": {
    ...WINDOWS_ENV,
    windir: "D:\\Win",
    WINDIR: undefined,
    SystemRoot: "D:\\Win",
    ProgramFiles: "D:\\Programs",
    ProgramW6432: "D:\\Programs64",
    SystemDrive: "D:",
    PUBLIC: "D:\\Profiles\\Public",
    USERPROFILE: "D:\\Profiles\\polyg",
    OneDriveCommercial: "E:\\OneDrive - Polygon Paradise",
  },
  "odd values (a whole drive, a profile on a drive root)": {
    WINDIR: "D:\\",
    ProgramFiles: "relative\\x",
    PUBLIC: "E:\\Public",
    USERPROFILE: "E:\\polyg",
    SystemDrive: "not-a-drive",
    OneDriveConsumer: "F:\\",
  },
};

const ROOTS = ["C:\\Outreach", "C:\\Users\\polyg\\Pictures\\outreach", "D:\\Apps\\Outreach"];

const FOLDERS = [
  // The app's folders and their parents.
  "C:\\Outreach",
  "C:\\Outreach\\scripts",
  "c:\\OUTREACH\\node_modules\\",
  "C:\\Outreach backups",
  "C:\\Users\\polyg\\Pictures",
  "C:\\Users\\polyg\\Pictures\\outreach\\tools",
  "C:\\Users\\polyg\\Pictures\\Outreach backups",
  "D:\\Apps",
  "D:\\Apps2\\Backups",
  // Windows and the programs.
  "C:\\Windows",
  "c:\\windows\\system32\\backups",
  "C:\\Program Files",
  "C:\\Program Files\\nodejs",
  "C:\\PROGRAM FILES (X86)\\cloudflared",
  "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp",
  "C:\\Program Files backups",
  "C:\\Windows backups",
  "D:\\Win",
  "D:\\Win\\Temp",
  "D:\\Programs\\nodejs",
  "D:\\Programs64\\x",
  "D:\\Backups",
  // Profiles.
  "C:\\Users",
  "C:\\Users\\polyg",
  "C:\\Users\\Public",
  "C:\\Users\\someone-else",
  "C:\\Users\\polyg\\Documents",
  "c:\\users\\polyg\\desktop\\",
  "C:\\Users\\polyg\\Downloads",
  "C:\\Users\\polyg\\OneDrive",
  "C:\\Users\\polyg\\OneDrive - Polygon Paradise",
  "C:\\Users\\polyg\\Documents\\..\\Desktop",
  "C:\\Users\\polyg\\OneDrive\\Outreach backups",
  "C:\\Users\\polyg\\OneDrive - Polygon Paradise\\Backups",
  "C:\\Users\\polyg\\Documents\\Outreach backups",
  "C:\\Users\\polyg\\Backups",
  "C:\\Users\\polyg\\Music",
  "D:\\Profiles",
  "D:\\Profiles\\polyg",
  "D:\\Profiles\\polyg\\Desktop",
  "D:\\Profiles\\polyg\\Desktop\\Backups",
  "E:\\polyg",
  "E:\\Public",
  "E:\\Backups",
  // OneDrive's folder backup: Documents, Desktop and Pictures inside the OneDrive folder.
  "C:\\Users\\polyg\\OneDrive\\Documents",
  "C:\\Users\\polyg\\OneDrive\\desktop\\",
  "C:\\Users\\polyg\\OneDrive - Polygon Paradise\\Pictures",
  "C:\\Users\\polyg\\OneDrive\\Documents\\Outreach backups",
  "C:\\Users\\polyg\\OneDrive\\Outreach backups\\Documents",
  "C:\\Users\\polyg\\Dropbox\\Documents",
  // OneDrive where the environment says it is.
  "E:\\OneDrive - Polygon Paradise",
  "E:\\OneDrive - Polygon Paradise\\Outreach backups",
  "E:\\OneDrive - Polygon Paradise\\Documents",
  "F:\\Backups",
  "E:\\Outreach backups",
];

describe("the second-folder refusal list is the same in Settings › Backups and install-services.bat", () => {
  it("uses one sentence for these folders", () => {
    expect(SECOND_FOLDER_TEXTS.systemFolder).toBe(OWN_FOLDER_TEXT);
  });

  for (const [envName, env] of Object.entries(ENVS)) {
    for (const root of ROOTS) {
      it(`${envName}, app in ${root}`, () => {
        const differ: string[] = [];
        for (const folder of FOLDERS) {
          const script = secondFolderRefusal(folder, { root, env }) !== null;
          const page = isSystemOrProfileFolder(folder, root, env);
          if (script !== page) differ.push(`${folder}: install-services.bat ${script ? "refuses" : "accepts"}, Settings ${page ? "refuses" : "accepts"}`);
        }
        expect(differ).toEqual([]);
      });
    }
  }

  it("still accepts the design's own examples and still refuses the review's", () => {
    for (const ok of ["C:\\Users\\polyg\\OneDrive\\Outreach backups", "E:\\Outreach backups", "D:\\Backups"]) {
      expect(isSystemOrProfileFolder(ok, "C:\\Outreach", WINDOWS_ENV), ok).toBe(false);
    }
    for (const bad of [
      "C:\\Outreach\\scripts",
      "C:\\Program Files\\nodejs",
      "C:\\Users\\polyg\\OneDrive",
      "C:\\Users\\polyg\\Documents",
      "C:\\Users\\polyg\\OneDrive\\Documents",
    ]) {
      expect(isSystemOrProfileFolder(bad, "C:\\Outreach", WINDOWS_ENV), bad).toBe(true);
    }
  });
});
