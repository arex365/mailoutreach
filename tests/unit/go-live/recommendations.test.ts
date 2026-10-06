import { describe, expect, it } from "vitest";
import { GO_LIVE_RECOMMENDATION_TEXTS as R, goLiveRecommendations } from "@/core/sending/mode-gates";
import type { CheckStatus, ChecklistRow, ChecklistRowKey } from "@/core/system-state";

/**
 * "Recommended first:" on the go-live card (M6-DESIGN §2.4, G10): each line appears only under its condition, in the
 * design's order, and none ever blocks. The last two (templates, the AI model) always show before go-live.
 */

const NOW = new Date("2026-09-23T08:30:00Z");
const HOUR = 3_600_000;

function row(key: ChecklistRowKey, status: CheckStatus): ChecklistRow {
  return { key, group: "optional", status, title: key, text: "", fix: null, records: [], detail: null };
}

/** Everything done: only the two "always" lines remain. */
const done: Parameters<typeof goLiveRecommendations>[0] = {
  rows: [row("domain-age", "ok"), row("monthly-limit", "ok")],
  checksTried: true,
  secondFolder: "D:\\Backups",
  newestBackupAt: new Date(NOW.getTime() - 2 * HOUR),
  accessOff: false,
  riskyFolder: null,
  restoreDone: true,
  now: NOW,
};

describe("goLiveRecommendations", () => {
  it("always recommends reading the templates and testing the AI model, last", () => {
    expect(goLiveRecommendations(done)).toEqual([
      "Read your master template and follow-ups once: they go to real prospects from now on (Templates).",
      "Test the AI model once (Settings › AI).",
    ]);
  });

  it("names each item only under its condition", () => {
    const only = (over: Partial<typeof done>) => goLiveRecommendations({ ...done, ...over }).slice(0, -2);
    expect(only({ rows: [row("domain-age", "warn"), row("monthly-limit", "ok")] })).toEqual([
      "Your sending domain is less than 30 days old. Wait before real campaigns (Domain checklist › Domain age).",
    ]);
    // No purchase date yet ("info"): its age is unknown, so no "less than 30 days" claim.
    expect(only({ rows: [row("domain-age", "info"), row("monthly-limit", "ok")] })).toEqual([]);
    expect(only({ rows: [row("domain-age", "ok"), row("monthly-limit", "warn")] })).toEqual(["Set Mailgun's monthly safety limit (Mailgun guide, step 9)."]);
    expect(only({ rows: [row("monthly-limit", "unknown")] })).toEqual([R.monthlyLimit]);
    // Rows never checked recommend nothing (the blockers already say the checklist needs checking).
    expect(only({ rows: [] })).toEqual([]);
    expect(only({ checksTried: false })).toEqual([
      "Try address checks once (Settings › Deliverability): after going live, live campaigns only email checked addresses.",
    ]);
    expect(only({ secondFolder: null })).toEqual([
      "Choose a second backup folder in Settings › Backups, so a copy survives if this PC's disk fails.",
    ]);
    expect(only({ secondFolder: "  " })).toEqual([R.secondFolder]);
    expect(only({ newestBackupAt: null })).toEqual(["Make a first backup in Settings › Backups."]);
    expect(only({ newestBackupAt: new Date(NOW.getTime() - 37 * HOUR) })).toEqual([
      "Make a backup first: the newest is more than 36 hours old (Settings › Backups).",
    ]);
    expect(only({ newestBackupAt: new Date(NOW.getTime() - 36 * HOUR) })).toEqual([]);
    expect(only({ accessOff: true })).toEqual(["Cloudflare Access is off, so anyone who finds the address sees the app's sign-in page."]);
    expect(only({ riskyFolder: "Pictures" })).toEqual([
      "The app folder is inside Pictures, which OneDrive, a sync program or Windows' ransomware protection can take over. Move it to C:\\Outreach first (Going-live guide, step 4).",
    ]);
    expect(only({ restoreDone: false })).toEqual(["Try a practice restore before you go live (Going-live guide, step 5)."]);
  });

  it("hides the practice-restore line once a restore was resumed", () => {
    expect(goLiveRecommendations({ ...done, restoreDone: false })).toContain(R.restore);
    expect(goLiveRecommendations({ ...done, restoreDone: true })).not.toContain(R.restore);
  });

  it("lists everything in the design's order", () => {
    const all = goLiveRecommendations({
      rows: [row("domain-age", "warn"), row("monthly-limit", "warn")],
      checksTried: false,
      secondFolder: null,
      newestBackupAt: new Date(NOW.getTime() - 40 * HOUR),
      accessOff: true,
      riskyFolder: "OneDrive - Firma",
      restoreDone: false,
      now: NOW,
    });
    expect(all).toEqual([
      R.domainAge,
      R.monthlyLimit,
      R.checks,
      R.secondFolder,
      R.backupOld,
      R.accessOff,
      R.appFolder("OneDrive - Firma"),
      R.restore,
      R.templates,
      R.aiModel,
    ]);
  });
});

describe("goLiveRecommendations with a shared From address (SHARED-FROM-DESIGN §3.3, F12)", () => {
  const only = (over: Partial<typeof done>) => goLiveRecommendations({ ...done, ...over }).slice(0, -2);

  it("the reply test's spam placements, after the monthly-limit line", () => {
    expect(only({ spamPlacements: ["Outlook.com (tess@outlook.com)"] })).toEqual([
      "The reply test's email landed in spam at Outlook.com (tess@outlook.com). Emails from your From address may land in spam there at first: start with small campaigns and watch the replies.",
    ]);
    expect(only({ spamPlacements: ["Outlook.com (a@outlook.com)", "Gmail (b@gmail.com)"] })).toEqual([
      R.spamPlacement("Outlook.com (a@outlook.com), Gmail (b@gmail.com)"),
    ]);
    expect(only({ rows: [row("monthly-limit", "warn")], checksTried: false, spamPlacements: ["Gmail (b@gmail.com)"] })).toEqual([
      R.monthlyLimit,
      R.spamPlacement("Gmail (b@gmail.com)"),
      R.checks,
    ]);
  });

  it("Google Postmaster for the main domain, after the address-checks line, until the postmaster row is ok", () => {
    expect(only({ teamFrom: "contact@example.com" })).toEqual([
      "Add example.com to Google Postmaster Tools, so you can watch how Gmail rates the domain your everyday email shares (Mailgun guide, step 16).",
    ]);
    expect(only({ teamFrom: "contact@example.com", rows: [...done.rows, row("postmaster", "ok")] })).toEqual([]);
    expect(only({ teamFrom: "contact@example.com", checksTried: false, secondFolder: null })).toEqual([
      R.checks,
      R.postmasterTeam("example.com"),
      R.secondFolder,
    ]);
  });

  it("absent or empty: exactly today's list", () => {
    expect(goLiveRecommendations({ ...done, teamFrom: null, spamPlacements: [] })).toEqual(goLiveRecommendations(done));
  });
});
