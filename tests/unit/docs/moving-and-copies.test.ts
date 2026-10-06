import { describe, expect, it } from "vitest";
import { APP_BACKUP_PATTERN } from "../../../scripts/lib/backups.mjs";
import { OWN_FOLDER_TEXT } from "../../../scripts/lib/service-acl.mjs";
import { readRel } from "./markdown";

/**
 * Review fixes in the owner's docs (M6 review):
 * - SCREENS-01: "Moving to a new PC" makes the old PC safe BEFORE it is switched off: stop.bat only stops the services
 *   until Windows restarts, so the old PC also runs uninstall-services.bat and removes its Cloudflared service, and
 *   only then may it be switched on again. The scripts table says stop.bat lasts until Windows restarts.
 * - SCREENS-02 / BACKUPS-3: the backup to copy is named exactly (the Back up now backup just made, by its file name or
 *   File Explorer's "Date modified"), never "the top one in backups\" (File Explorer sorts by name: the oldest first),
 *   and restore.bat's "From:" is checked on the new PC.
 * - SCREENS-03: after install-services.bat, a new Back up now shows whether the second copy works ("Copied").
 * - SECURITY-01: the docs name the second folders the app and install-services.bat refuse.
 */

const README = readRel("README.md");
const GO_LIVE = readRel("docs/setup/4-going-live.md");

/** The text from `start` up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const level = /^#+/.exec(heading)![0].length;
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return heading + (next === -1 ? rest : rest.slice(0, next));
}

describe("README: Moving to a new PC", () => {
  const moving = section(README, "### Moving to a new PC");
  const oldPc = moving.slice(moving.indexOf("1. **On the old PC**"), moving.indexOf("2. **On the new PC:**"));

  it("makes the old PC safe before the files are copied and it is switched off (SCREENS-01)", () => {
    const order = ["Back up now", "`stop.bat`", "`uninstall-services.bat`", "service uninstall", "USB stick", "can be switched on safely"].map(
      (needle) => {
        const i = oldPc.indexOf(needle);
        expect(i, needle).toBeGreaterThan(-1);
        return i;
      },
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(oldPc).toContain("Run as administrator");
    expect(oldPc).toContain("Never double-click `start.bat` on it again.");
    // The old PC is never sent back to later: everything happens in step 1.
    expect(moving).not.toMatch(/if the old PC still has it/i);
    expect(moving.slice(moving.indexOf("2. **On the new PC:**"))).not.toContain("service uninstall");
  });

  it("names the backup to copy exactly, never the top file of backups\\ (SCREENS-02)", () => {
    expect(moving).not.toMatch(/top one in/i);
    expect(oldPc).toContain("the backup you just made");
    expect(oldPc).toContain("**File** column of Settings › Backups");
    expect(oldPc).toContain("**Date modified**, newest first");
    expect(oldPc).toContain("`app-pre`");
    // The example is a real app backup name.
    const example = /`(app-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{4}\.db)`/.exec(oldPc)?.[1];
    expect(example).toBeDefined();
    expect(APP_BACKUP_PATTERN.test(example!)).toBe(true);
    // On the new PC, restore.bat's "From:" line is checked before typing yes.
    const step4 = moving.slice(moving.indexOf("4. Copy the backup"), moving.indexOf("5. Double-click"));
    expect(step4).toContain("**From:** is today's date");
    expect(step4.indexOf("**From:**")).toBeLessThan(step4.indexOf("type `yes` again"));
    // restore.bat's "Please check" block has that line (tests/unit/docs/labels.test.ts ties "From:" to restore.mjs).
    expect(readRel("scripts/restore.mjs")).toMatch(/From: +\$\{formatWhen\(/);
  });

  it("the scripts table says stop.bat lasts until Windows restarts, as stop.bat itself says", () => {
    const row = README.split(/\r?\n/).find((l) => l.startsWith("| `stop.bat` |"))!;
    expect(row).toContain("until you start it again or Windows restarts (the services start with Windows)");
    const control = readRel("scripts/service-control.mjs");
    expect(control).toContain("They start again by themselves when Windows restarts");
    expect(control).toContain("double-click uninstall-services.bat");
    const uninstallRow = README.split(/\r?\n/).find((l) => l.startsWith("| `uninstall-services.bat` |"))!;
    expect(uninstallRow).toContain("an old PC you're replacing");
  });
});

describe("the second copy: install-services.bat, then a new Back up now (SCREENS-03)", () => {
  const readmeCopy = section(README, "### The second copy");
  const guideStep5 = GO_LIVE.slice(GO_LIVE.indexOf("## 5."), GO_LIVE.indexOf("**A copy of `.env`**"));

  it.each([
    ["README", readmeCopy],
    ["Going-live guide, step 5", guideStep5],
  ])("%s: save the folder, run install-services.bat, then click Back up now and check the NEW backup", (_name, text) => {
    const from = text.indexOf("**Save folder**");
    expect(from).toBeGreaterThan(-1);
    const order = ["install-services.bat", "Back up now", "**Copied**"].map((needle) => {
      const i = text.indexOf(needle, from);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("new backup says **Copied** under **Second copy** (on a laptop: a phone hides that column)");
    expect(text).not.toContain("the newest backup says **Copied**");
  });

  it("names the folders the app refuses, as install-services.bat does (SECURITY-01)", () => {
    for (const text of [readmeCopy, guideStep5]) {
      expect(text).toContain("Windows or program folder");
      expect(text).toContain("Documents, Desktop, Pictures, Downloads or OneDrive folder itself");
      expect(text).toContain("also the Documents, Desktop or Pictures folder inside OneDrive");
      expect(text).toContain("OneDrive\\Outreach backups");
    }
    // The same kinds of folder as the sentence install-services.bat prints.
    expect(OWN_FOLDER_TEXT).toContain("not a Windows, program or whole-profile folder");
  });

  it("the copy-failed warning says what to do for a folder on this PC", () => {
    const warnings = section(README, "### Warnings");
    expect(warnings).toContain("For a folder on this PC (in OneDrive, for example), double-click `install-services.bat` on the office PC, then click **Back up now**.");
  });
});

describe("Going-live guide, step 8: the Last restore card, before and after the second check (SCREENS-09)", () => {
  const step8 = GO_LIVE.slice(GO_LIVE.indexOf("8. Open **Settings › Backups**."), GO_LIVE.indexOf("If anything goes wrong, run `restore.bat` again"));

  it("quotes what shows first, then what shows about 35 minutes after the restore", () => {
    const order = [
      "Checking Mailgun for emails sent after the backup.",
      "Sending was resumed while the check is still running",
      "About 35 minutes after the restore",
      "Checked Mailgun for sends after the backup",
      "Sending was resumed by <your name> on …",
    ].map((needle) => {
      const i = step8.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
