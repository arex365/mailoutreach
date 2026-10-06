import { describe, expect, it } from "vitest";
import {
  CHECKLIST_ROW_TITLES,
  GO_LIVE_RECOMMENDATION_TEXTS as R,
  GO_LIVE_ROW_KEYS,
  GO_LIVE_TEAM_FROM_ROW_KEYS,
  MODE_GATE_TEXTS as T,
  goLiveBlockers,
  goLiveRecommendations,
  goLiveRowKeys,
  liveLaunchBlockers,
  liveModeBlockers,
  replyTestBlockers,
} from "@/core/sending/mode-gates";
import { GO_LIVE_COPY, goLiveDialogItems, type GoLiveWarmup } from "@/core/sending/go-live-copy";
import { checklistTitle } from "@/core/dns/checklist";
import type { CheckStatus, ChecklistRow, ChecklistRowKey } from "@/core/system-state";

/**
 * The shared From address's gate and go-live contract code (docs/dev/SHARED-FROM-DESIGN.md §3.2–§3.3, §7.5): every new
 * input is optional and, when absent, the sentences are exactly those of before.
 */

/** Today's 20 rows (per-person mode): the keys of before, without the two shared-From rows. */
const PER_PERSON_KEYS = (Object.keys(CHECKLIST_ROW_TITLES) as ChecklistRowKey[]).filter((k) => k !== "from-mx" && k !== "from-spf");

function row(key: ChecklistRowKey, status: CheckStatus, title?: string): ChecklistRow {
  return { key, group: "dns", status, title: title ?? `Row ${key}`, text: "", fix: null, records: [], detail: null };
}

/** Every per-person row green, plus the from-* rows given (absent unless named). */
function rows(changes: Partial<Record<ChecklistRowKey, CheckStatus | "absent">> = {}): ChecklistRow[] {
  const keys = [...PER_PERSON_KEYS, "from-mx" as const, "from-spf" as const];
  return keys.flatMap((key) => {
    const fallback = key === "from-mx" || key === "from-spf" ? "absent" : "ok";
    const status = changes[key] ?? fallback;
    return status === "absent" ? [] : [row(key, status)];
  });
}

const connected = { connected: true, practiceCopy: false, testListSize: 2 };

describe("row keys and titles", () => {
  it("keeps the 16 go-live rows of before and adds from-mx in shared-From mode, in checklist order", () => {
    expect(PER_PERSON_KEYS).toHaveLength(20);
    expect(GO_LIVE_ROW_KEYS).toHaveLength(16);
    expect(GO_LIVE_ROW_KEYS).not.toContain("from-mx");
    expect(GO_LIVE_TEAM_FROM_ROW_KEYS).toEqual(["from-mx"]);
    expect(goLiveRowKeys(false)).toBe(GO_LIVE_ROW_KEYS);
    const team = goLiveRowKeys(true);
    expect(team).toHaveLength(17);
    expect(team[team.indexOf("dmarc") + 1]).toBe("from-mx");
    expect(team.filter((k) => k !== "from-mx")).toEqual([...GO_LIVE_ROW_KEYS]);
  });

  it("titles the two new rows with the From domain, and generically before a check", () => {
    expect(checklistTitle("from-mx", "polygonparadise.com")).toBe("Mail for polygonparadise.com stays with your mail provider (MX)");
    expect(checklistTitle("from-spf", "polygonparadise.com")).toBe("polygonparadise.com's SPF record (your everyday email)");
    expect(CHECKLIST_ROW_TITLES["from-mx"]).toBe("Mail for your main domain stays with your mail provider (MX)");
    expect(CHECKLIST_ROW_TITLES["from-spf"]).toBe("Your main domain's SPF record (your everyday email)");
    // The rows of before keep their titles.
    expect(checklistTitle("mx", "send.example.com")).toBe("Replies reach the app (MX)");
    expect(checklistTitle("spf", "send.example.com")).toBe("Mailgun may send for send.example.com (SPF)");
  });
});

describe("liveModeBlockers with teamFrom (§3.3)", () => {
  it("adds nothing in per-person mode, whatever the from-mx row says", () => {
    expect(liveModeBlockers(rows(), connected)).toEqual([]);
    expect(liveModeBlockers(rows(), { ...connected, teamFrom: false })).toEqual([]);
    expect(liveModeBlockers(rows({ "from-mx": "bad" }), connected)).toEqual([]);
    expect(liveModeBlockers([], connected)).toEqual([T.dns, T.trackingOff, T.unsubscribe, T.webhooks, T.signingKey, T.sendingAllowed]);
  });

  it("asks for a check while the from-mx row is missing, and names a bad one, right after the DNS sentence", () => {
    const team = { ...connected, teamFrom: true };
    expect(liveModeBlockers(rows(), team)).toEqual([
      "The Domain checklist hasn't checked your main domain's mail servers (MX) yet. Click Check again on the Domain checklist.",
    ]);
    expect(liveModeBlockers(rows({ "from-mx": "bad" }), team)).toEqual([
      "Mail for your main domain points to Mailgun or is missing. It must stay with your mail provider, never Mailgun (Domain checklist).",
    ]);
    for (const status of ["ok", "warn", "unknown", "info", "off"] as const) {
      expect(liveModeBlockers(rows({ "from-mx": status }), team)).toEqual([]);
    }
    expect(liveModeBlockers(rows({ "from-mx": "bad", "from-spf": "bad" }), team)).toEqual([T.fromMx]);
    expect(liveModeBlockers([], team)).toEqual([T.dns, T.fromMxUnchecked, T.trackingOff, T.unsubscribe, T.webhooks, T.signingKey, T.sendingAllowed]);
    expect(liveModeBlockers(rows({ webhooks: "bad", "from-mx": "bad" }), team)).toEqual([T.fromMx, T.webhooks]);
    // Connect and the practice copy still come alone.
    expect(liveModeBlockers([], { ...team, connected: false })).toEqual([T.connect]);
    expect(liveModeBlockers([], { ...team, practiceCopy: true })).toEqual([T.practiceCopy]);
  });

  it("reaches a LIVE launch and the reply test through their own context", () => {
    const launch = { ...connected, setup: "A" as const, replyTestPassedOnDomain: true };
    expect(liveLaunchBlockers(rows(), launch)).toEqual([]);
    expect(liveLaunchBlockers(rows({ "from-mx": "bad" }), { ...launch, teamFrom: true })).toEqual([T.fromMx]);
    const replyTest = { mode: "TEST" as const, ...connected, ownerRouteOk: true, publicAddressOk: true, setup: "A" as const };
    expect(replyTestBlockers(rows(), replyTest)).toEqual([]);
    expect(replyTestBlockers(rows(), { ...replyTest, teamFrom: true })).toEqual([T.fromMxUnchecked]);
  });
});

describe("goLiveBlockers with teamFrom and checkBeforeFromChange (§3.3)", () => {
  const ready = { replyTestPassed: true, paused: false, practiceCopy: false, sendersWithoutRoute: [] as string[] };

  it("needs the from-mx row ok in shared-From mode, with the row's own title", () => {
    expect(goLiveBlockers(rows(), ready)).toEqual([]);
    expect(goLiveBlockers(rows(), { ...ready, teamFrom: false })).toEqual([]);
    expect(goLiveBlockers(rows(), { ...ready, teamFrom: true })).toEqual([
      "Mail for your main domain stays with your mail provider (MX): not done yet (Domain checklist).",
    ]);
    const titled = [...rows(), row("from-mx", "bad", checklistTitle("from-mx", "example.com"))];
    expect(goLiveBlockers(titled, { ...ready, teamFrom: true })).toEqual([
      "Mail for example.com stays with your mail provider (MX): not done yet (Domain checklist).",
    ]);
    expect(goLiveBlockers(rows({ "from-mx": "ok" }), { ...ready, teamFrom: true })).toEqual([]);
    expect(goLiveBlockers(rows({ "from-mx": "warn" }), { ...ready, teamFrom: true })).toEqual([
      "Row from-mx: needs attention (Domain checklist).",
    ]);
    // from-spf never blocks going live.
    expect(goLiveBlockers(rows({ "from-mx": "ok", "from-spf": "bad" }), { ...ready, teamFrom: true })).toEqual([]);
    // In checklist order: right after the DMARC row.
    expect(goLiveBlockers(rows({ dmarc: "bad", "tracking-off": "bad" }), { ...ready, teamFrom: true })).toEqual([
      "Row dmarc: not done yet (Domain checklist).",
      "Mail for your main domain stays with your mail provider (MX): not done yet (Domain checklist).",
      "Row tracking-off: not done yet (Domain checklist).",
    ]);
    expect(goLiveBlockers([], { ...ready, teamFrom: true })).toHaveLength(17);
    expect(goLiveBlockers([], ready)).toHaveLength(16);
  });

  it("says the check predates the From change instead of the hour rule, only when told so", () => {
    const allMet = { ...ready, connected: true, setup: "A" as const, liveTest: "delivered" as const, workerRunning: true };
    expect(goLiveBlockers(rows(), { ...allMet, checkFresh: false })).toEqual([T.checkStale]);
    expect(goLiveBlockers(rows(), { ...allMet, checkFresh: false, checkBeforeFromChange: false })).toEqual([T.checkStale]);
    expect(goLiveBlockers(rows(), { ...allMet, checkFresh: false, checkBeforeFromChange: true })).toEqual([
      // Review SETTING-1: a sending-domain change (a region-only move too) restarts evidence like a From change.
      "The Domain checklist was checked before the From address or the sending domain changed. Click Check again on the Domain checklist, then come back.",
    ]);
    expect(goLiveBlockers(rows(), { ...allMet, checkFresh: true, checkBeforeFromChange: true })).toEqual([]);
  });
});

describe("goLiveRecommendations with teamFrom and spamPlacements (§3.3)", () => {
  const base = {
    rows: rows({ "monthly-limit": "warn", postmaster: "info" }),
    checksTried: false,
    secondFolder: "D:\\Backups",
    newestBackupAt: new Date("2026-09-27T10:00:00Z"),
    accessOff: false,
    riskyFolder: null,
    restoreDone: true,
    now: new Date("2026-09-27T12:00:00Z"),
  };

  it("is unchanged without the new inputs", () => {
    expect(goLiveRecommendations(base)).toEqual([R.monthlyLimit, R.checks, R.templates, R.aiModel]);
    expect(goLiveRecommendations({ ...base, teamFrom: null, spamPlacements: [] })).toEqual(goLiveRecommendations(base));
  });

  it("adds the spam placements after the monthly limit and Postmaster for the main domain after the address checks", () => {
    const out = goLiveRecommendations({
      ...base,
      teamFrom: "contact@example.com",
      spamPlacements: ["Outlook.com (tess@outlook.com)", "  ", "Gmail (tess@gmail.com)"],
    });
    expect(out).toEqual([
      R.monthlyLimit,
      "The reply test's email landed in spam at Outlook.com (tess@outlook.com), Gmail (tess@gmail.com). Emails from your From address may land in spam there at first: start with small campaigns and watch the replies.",
      R.checks,
      "Add example.com to Google Postmaster Tools, so you can watch how Gmail rates the domain your everyday email shares (Mailgun guide, step 16).",
      R.templates,
      R.aiModel,
    ]);
    // A verified Postmaster row needs no reminder; placements alone work in per-person mode too.
    const verified = { ...base, rows: rows({ "monthly-limit": "ok", postmaster: "ok" }), checksTried: true };
    expect(goLiveRecommendations({ ...verified, teamFrom: "contact@example.com" })).toEqual([R.templates, R.aiModel]);
    expect(goLiveRecommendations({ ...verified, spamPlacements: ["Outlook.com (tess@outlook.com)"] })).toEqual([
      R.spamPlacement("Outlook.com (tess@outlook.com)"),
      R.templates,
      R.aiModel,
    ]);
  });
});

describe("the go-live dialog's From line and the new copy (§3.3, F21)", () => {
  const warmup: GoLiveWarmup = { startCap: 50, maxCap: 1000, steps: 20 };
  const input = { capOverrideToday: null, drafts: { items: [], more: 0 }, warmup };

  it("is exactly the list of before without `from`", () => {
    const before = goLiveDialogItems(input);
    expect(before).toHaveLength(6);
    expect(goLiveDialogItems({ ...input, from: null })).toEqual(before);
    expect(goLiveDialogItems({ ...input, from: { team: null, ownExample: null } })).toEqual(before);
  });

  it("puts the From item third, after the warm-up item: the team's in shared-From mode, else the Owner's own line", () => {
    const before = goLiveDialogItems(input);
    const team = goLiveDialogItems({ ...input, from: { team: { from: "contact@polygonparadise.com", org: "polygonparadise.com" }, ownExample: "x" } });
    expect(team).toEqual([
      before[0],
      before[1],
      "Every email shows From contact@polygonparadise.com. Complaints about them count against polygonparadise.com, the domain your everyday email uses.",
      ...before.slice(2),
    ]);
    const own = goLiveDialogItems({
      ...input,
      from: { team: null, ownExample: "Arslan from Polygon Paradise <arslan@mail.polygonparadise.com>" },
    });
    expect(own[2]).toBe(
      "Every email shows From the sender's own address, for example Arslan from Polygon Paradise <arslan@mail.polygonparadise.com>.",
    );
    expect(own).toHaveLength(7);
  });

  it("has the card, dialog and toast sentences of §3.1 and §3.3", () => {
    expect(GO_LIVE_COPY.liveFromLine("contact@example.com")).toBe("Emails show From contact@example.com; replies go to each sender's own address.");
    expect(GO_LIVE_COPY.descriptionAfterFromChange(null, "contact@example.com")).toBe(
      "You were live with each person's own address as the From address. After the change to contact@example.com, live campaigns only reach your test list until you run the reply test and go live again.",
    );
    expect(GO_LIVE_COPY.descriptionAfterFromChange("contact@example.com", null)).toBe(
      "You were live with contact@example.com as the From address. After the change to each person's own address, live campaigns only reach your test list until you run the reply test and go live again.",
    );
    expect(GO_LIVE_COPY.endedByFromChange).toBe(
      "Going live ended: go live again once the reply test has passed with the new From address (Settings › Sending & Mailgun › Go live).",
    );
    expect(GO_LIVE_COPY.spamPlacementTick("Outlook.com (tess@outlook.com)")).toBe(
      "I know the reply test's email landed in spam at Outlook.com (tess@outlook.com). Go live anyway: fewer people there may see our emails at first.",
    );
    expect(GO_LIVE_COPY.spamPlacementRequired).toBe("Tick the box about the spam folder first.");
  });
});
