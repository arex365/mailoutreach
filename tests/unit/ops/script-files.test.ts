/**
 * The double-click scripts must be plain ASCII with Windows (CRLF) line endings: cmd.exe
 * misreads LF-only batch files, and Windows PowerShell 5.1 misreads non-ASCII .ps1 files.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(".");

const BAT_FILES = [
  "setup.bat",
  "start.bat",
  "stop.bat",
  "update.bat",
  "restore.bat",
  "status.bat",
  "reset-password.bat",
  "start-demo.bat",
  "install-services.bat",
  "uninstall-services.bat",
  "setup-pc.bat",
];

const PS1_FILES = [
  "scripts/status.ps1",
  "scripts/install-services.ps1",
  "scripts/uninstall-services.ps1",
  "scripts/setup-pc.ps1",
  "scripts/get-nssm.ps1",
  "scripts/lib/ops-common.ps1",
];

function check(file: string) {
  const bytes = fs.readFileSync(path.join(ROOT, file));
  let loneLf = 0;
  let nonAscii = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i - 1] !== 0x0d) loneLf++;
    if (bytes[i]! > 0x7f) nonAscii++;
  }
  return { text: bytes.toString("latin1"), loneLf, nonAscii, endsWithCrlf: bytes.at(-2) === 0x0d && bytes.at(-1) === 0x0a };
}

describe("batch files", () => {
  it.each(BAT_FILES)("%s is ASCII with CRLF line endings and starts in its own folder", (file) => {
    const r = check(file);
    expect(r.loneLf).toBe(0);
    expect(r.nonAscii).toBe(0);
    expect(r.endsWithCrlf).toBe(true);
    expect(r.text.startsWith("@echo off\r\n")).toBe(true);
    expect(r.text).toContain('cd /d "%~dp0"');
  });

  it.each(["install-services.bat", "uninstall-services.bat", "setup-pc.bat", "update.bat", "restore.bat", "start.bat", "stop.bat"])(
    "%s can ask Windows for administrator rights",
    (file) => {
      const text = check(file).text;
      expect(text).toContain("net session >nul 2>&1");
      expect(text).toContain("-Verb RunAs");
    },
  );

  it("runs PowerShell without profiles and with the execution policy bypassed", () => {
    for (const file of BAT_FILES) {
      const text = check(file).text;
      for (const line of text.split("\r\n").filter((l) => /^powershell .*-File /i.test(l))) {
        expect(line).toMatch(/^powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\[a-z-]+\.ps1$/);
      }
    }
  });

  it("never relies on npm's PowerShell shim", () => {
    for (const file of BAT_FILES) expect(check(file).text).not.toMatch(/npm\.ps1/i);
  });

  it("pauses at the end of every double-click script", () => {
    for (const file of BAT_FILES) {
      expect(check(file).text, file).toContain("pause >nul");
    }
  });

  it("setup.bat keeps its window open when Node.js fails before setup.mjs can say anything", () => {
    const text = check("setup.bat").text;
    // setup.mjs never waits for a key itself; the window does, also after a crash (non-zero exit).
    expect(text).toContain("node scripts\\setup.mjs -- %* --no-pause");
    expect(text).toContain('set "PP_CODE=%errorlevel%"');
    expect(text).toContain("Setup didn't finish.");
    expect(text).toMatch(/if \/i "%%~A"=="--no-pause" set "PP_PAUSE="/);
    expect(text).toMatch(/:end\r\nif not defined PP_PAUSE exit \/b %PP_CODE%\r\n[\s\S]*pause >nul\r\nexit \/b %PP_CODE%\r\n$/);
  });

  it("never pastes its own path or the arguments into the PowerShell command (spaces and apostrophes break it)", () => {
    for (const file of BAT_FILES) {
      for (const line of check(file).text.split("\r\n").filter((l) => /^powershell .*-Command /i.test(l))) {
        expect(line, file).not.toMatch(/%~?[0-9f*]|%\*/);
        expect(line, file).toContain("$env:PP_SELF");
      }
    }
    // Each argument travels in its own environment variable (SECURITY-02 below).
    const restore = check("restore.bat").text;
    expect(restore).toContain('set "PP_RESTORE_ARG%PP_RESTORE_ARGC%=%~1"');
    expect(restore).toContain("[Environment]::GetEnvironmentVariable('PP_RESTORE_ARG' + $i)");
  });
});

/**
 * Review fix SECURITY-02: restore.bat asks Windows for administrator rights by starting itself again. It used to pass
 * on only the first argument, so `restore.bat <backup> --db <test database>` restored into the real database. Now every
 * argument reaches the new window, each one quoted again.
 */
describe("restore.bat passes every argument on when it asks for administrator rights", () => {
  const text = check("restore.bat").text;
  const lines = text.split("\r\n");
  const psLine = lines.find((l) => l.startsWith('powershell -NoProfile -Command "$n = '))!;

  it("collects every argument, one environment variable each, before asking", () => {
    expect(text).not.toContain('set "PP_RESTORE_ARG=%~1"');
    const at = (needle: string) => {
      const i = lines.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('set "PP_SELF=%~f0"'),
      at('set "PP_RESTORE_ARGC=0"'),
      at(":nextarg"),
      at("if [%1]==[] goto collected"),
      at("set /a PP_RESTORE_ARGC+=1"),
      at('set "PP_RESTORE_ARG%PP_RESTORE_ARGC%=%~1"'),
      at("shift"),
      at("goto nextarg"),
      at(":collected"),
      at('if "%PP_RESTORE_ARGC%"=="0" goto elevatenoargs'),
      lines.indexOf(psLine),
      at(":elevatenoargs"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The elevated window (and a window that already has the rights) runs restore.mjs with all of them.
    expect(text).toContain("node scripts\\restore.mjs %*");
    // The PowerShell command itself never contains a path or an argument, only the variables' names.
    expect(psLine).not.toMatch(/%/);
    expect(psLine).toContain("-FilePath $env:PP_SELF");
    expect(psLine).toContain("-ArgumentList ($list -join ' ')");
    expect(psLine).toContain("-Verb RunAs");
  });

  it.runIf(process.platform === "win32")("gives the new window every argument, quoted, with a trailing backslash kept", { timeout: 30_000 }, async () => {
    const { spawnSync } = await import("node:child_process");
    const inner = psLine.slice(psLine.indexOf('"') + 1, -1);
    // Start-Process is replaced by a function that prints what it was given (a function wins over the cmdlet), so
    // nothing is started and nobody is asked for permission.
    const stub =
      "function Start-Process { param($FilePath, $ArgumentList, $Verb) Write-Output ('FILE=' + $FilePath); Write-Output ('ARGS=' + $ArgumentList); Write-Output ('VERB=' + $Verb) }; ";
    const args = ["backups\\m6-live\\app-2026-09-27-101500-ab12.db", "--db", "D:\\it's & mine\\m6-live.db", "--backups-dir", "backups\\m6-live\\"];
    const env: NodeJS.ProcessEnv = { ...process.env, PP_SELF: "C:\\Out reach\\restore.bat", PP_RESTORE_ARGC: String(args.length) };
    args.forEach((a, i) => (env[`PP_RESTORE_ARG${i + 1}`] = a));
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stub + inner], { env, encoding: "utf8", windowsHide: true });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout.split(/\r?\n/);
    expect(out).toContain("FILE=C:\\Out reach\\restore.bat");
    expect(out).toContain("VERB=RunAs");
    expect(out).toContain(
      'ARGS="backups\\m6-live\\app-2026-09-27-101500-ab12.db" "--db" "D:\\it\'s & mine\\m6-live.db" "--backups-dir" "backups\\m6-live\\\\"',
    );
  });
});

/**
 * M6-DESIGN §6.6: nodejs.org's "LTS" button moves to Node.js 26, which the app refuses, so every script text that says
 * where to get Node.js names the 24.x download folder and the installer file, never the front page or one fixed version.
 */
describe("Node.js download texts", () => {
  const NODE_FOLDER = "https://nodejs.org/dist/latest-v24.x/";
  /** The .bat files that tell the owner how to install Node.js when Windows can't find it. */
  const NO_NODE_FILES = ["setup.bat", "start.bat", "stop.bat", "update.bat", "restore.bat", "reset-password.bat", "start-demo.bat"];

  it.each(NO_NODE_FILES)("%s names Node.js 24 (not 26), the 24.x folder and the -x64.msi file", (file) => {
    const lines = check(file).text.split("\r\n");
    const nodeLines = lines.filter((l) => /nodejs\.org/i.test(l));
    expect(nodeLines.length, file).toBeGreaterThan(0);
    for (const line of nodeLines) {
      expect(line, file).toMatch(/^echo {2}/);
      expect(line, file).toContain(`Node.js 24 (not 26) from ${NODE_FOLDER} (the file ending in -x64.msi)`);
    }
  });

  it("no .bat or PowerShell file points at nodejs.org's front page or asks for Node.js 24.21.0", () => {
    for (const file of [...BAT_FILES, ...PS1_FILES]) {
      const text = check(file).text;
      expect(text, file).not.toMatch(/https:\/\/nodejs\.org(?!\/dist\/latest-v24\.x\/)/);
      expect(text, file).not.toContain("Node.js 24.21.0");
    }
  });

  it("install-services.ps1 says the same, and to uninstall a newer Node.js first", () => {
    const text = check("scripts/install-services.ps1").text;
    const nodeLines = text.split("\r\n").filter((l) => /nodejs\.org/i.test(l));
    expect(nodeLines).toHaveLength(2);
    for (const line of nodeLines) expect(line).toContain(`Install Node.js 24 (not 26) from ${NODE_FOLDER} (the file ending in -x64.msi`);
    expect(nodeLines[1]).toContain("uninstall a newer Node.js first");
  });

  it("setup.mjs and update.mjs name the 24.x folder when a native part doesn't work", () => {
    for (const file of ["scripts/setup.mjs", "scripts/update.mjs"]) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(text, file).toMatch(/[Ii]nstall Node\.js 24 \(not 26\) from https:\/\/nodejs\.org\/dist\/latest-v24\.x\/ \(the file ending in -x64\.msi\)/);
      expect(text, file).not.toMatch(/https:\/\/nodejs\.org(?!\/dist\/latest-v24\.x\/)/);
    }
  });

  it("reset-password says how to see that the app runs (status.bat), not start.bat", () => {
    const text = fs.readFileSync(path.join(ROOT, "scripts/reset-password.ts"), "utf8");
    expect(text).toContain("The app must be running (status.bat shows it) for the link to open.");
    expect(text).not.toContain("The app must be running (start.bat)");
  });
});

describe("PowerShell files", () => {
  it.each(PS1_FILES)("%s is ASCII with CRLF line endings", (file) => {
    const r = check(file);
    expect(r.loneLf).toBe(0);
    expect(r.nonAscii).toBe(0);
  });

  it("never turns hibernation off or touches battery power settings", () => {
    const text = check("scripts/setup-pc.ps1").text;
    expect(text).not.toMatch(/hibernate\s+off/i);
    expect(text).not.toMatch(/-dc\b|setdcvalueindex/i);
  });
});

describe(".gitattributes", () => {
  it("keeps CRLF for .bat and .ps1 files", () => {
    const text = fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
    expect(text).toMatch(/^\*\.bat\s+text\s+eol=crlf$/m);
    expect(text).toMatch(/^\*\.ps1\s+text\s+eol=crlf$/m);
  });
});
