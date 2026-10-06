import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nssmFingerprintMatches, parseScQuery } from "../../../scripts/lib/services.mjs";

const dir = path.join(path.resolve("."), "data", "test", `services-${process.pid}-${Date.now()}`);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("nssmFingerprintMatches (checked before every elevated use of tools\\nssm.exe)", () => {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, "nssm.exe");
  const sha = path.join(dir, "nssm.sha256");
  const content = Buffer.from("pretend this is nssm.exe");
  const hash = crypto.createHash("sha256").update(content).digest("hex");

  it("accepts the recorded file (upper or lower case, with a file name after the hash)", () => {
    fs.writeFileSync(exe, content);
    fs.writeFileSync(sha, `${hash.toUpperCase()}\r\n`);
    expect(nssmFingerprintMatches(exe, sha)).toBe(true);
    fs.writeFileSync(sha, `${hash}  nssm.exe\n`);
    expect(nssmFingerprintMatches(exe, sha)).toBe(true);
  });

  it("refuses a changed file, a missing file and a broken fingerprint file", () => {
    fs.writeFileSync(sha, hash);
    fs.writeFileSync(exe, Buffer.concat([content, Buffer.from("!")]));
    expect(nssmFingerprintMatches(exe, sha)).toBe(false);
    expect(nssmFingerprintMatches(path.join(dir, "missing.exe"), sha)).toBe(false);
    fs.writeFileSync(exe, content);
    fs.writeFileSync(sha, "");
    expect(nssmFingerprintMatches(exe, sha)).toBe(false);
    expect(nssmFingerprintMatches(exe, path.join(dir, "missing.sha256"))).toBe(false);
  });
});

const RUNNING = `
SERVICE_NAME: OutreachWeb
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
`;

const STOPPED = RUNNING.replace("4  RUNNING", "1  STOPPED");
const STARTING = RUNNING.replace("4  RUNNING", "2  START_PENDING");

const MISSING = `[SC] EnumQueryServicesStatus:OpenService FAILED 1060:

The specified service does not exist as an installed service.
`;

describe("parseScQuery", () => {
  it("reads the state of an installed service", () => {
    expect(parseScQuery(RUNNING, 0)).toEqual({ installed: true, state: "RUNNING" });
    expect(parseScQuery(STOPPED, 0)).toEqual({ installed: true, state: "STOPPED" });
    expect(parseScQuery(STARTING, 0)).toEqual({ installed: true, state: "START_PENDING" });
  });

  it("knows error 1060 means 'not installed' (by exit code or by text)", () => {
    expect(parseScQuery(MISSING, 1060)).toEqual({ installed: false, state: null });
    expect(parseScQuery(MISSING, 1)).toEqual({ installed: false, state: null });
    expect(parseScQuery("", 1060)).toEqual({ installed: false, state: null });
  });

  it("uses the state number, so a translated state word doesn't matter", () => {
    expect(parseScQuery("        STATE              : 4  LAEUFT\n", 0)).toEqual({ installed: true, state: "RUNNING" });
  });

  it("reports other failures without claiming the service exists", () => {
    const r = parseScQuery("[SC] OpenSCManager FAILED 5:\n\nAccess is denied.", 5);
    expect(r.installed).toBe(false);
    expect(r.error).toContain("Access is denied");
  });

  it("treats a successful query without a state line as installed", () => {
    expect(parseScQuery("SERVICE_NAME: OutreachWeb", 0)).toEqual({ installed: true, state: "UNKNOWN" });
  });
});
