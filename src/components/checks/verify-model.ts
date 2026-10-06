import { aboutUsd, formatUsd, roundUsd } from "@/core/money";
import { testListOnly } from "@/core/rules/mode";
import { plural } from "@/core/text";
import type { CheckRunCounts } from "@/core/verification/types";
import { MAX_CHECKS_PER_RUN } from "@/core/verification/types";
import { checkCostLine, checkRunDoneLines, usdAmountText } from "@/core/verification/words";
import type { CheckLeftOut } from "@/server/services/verification/runs";
import type { CampaignCheckView } from "@/server/services/verification/select";
import { deferredRunText, PAUSED_FALLBACK_TEXT, runProgressText, stopRunText } from "./run-text";

/**
 * The wizard's step 4 "Verify" (M5-DESIGN §6.1) as a model: which cards show and every sentence on them, from the
 * check services' CampaignCheckView, the run as the poll last saw it and the campaign's last finished run. Pure and
 * browser-safe, so every state of §6.1 is unit-tested; `verify-step.tsx` only draws it.
 */

export const VERIFY_INTRO = {
  title: "Check the addresses",
  description: "Every address is checked before a live campaign emails it, so fewer emails bounce.",
} as const;

/** The refusal of Continue while the campaign's checks run (continueAction from the Verify step). */
export const CHECKS_STILL_RUNNING_TEXT = "The address checks are still running. Wait for them to finish, or stop them first.";

/** The run of the Verify step as the page loaded it, updated by the poll (GET /api/jobs/:id). */
export type VerifyRunInfo = {
  jobId: number;
  status: string;
  done: number;
  total: number;
  summary: string | null;
  waitingUntil: string | null;
  /** Queued and due, but another check run is going on. */
  blockedByOtherRun: boolean;
};

/** The campaign's latest run once it has finished (read with checkRunView). */
export type VerifyLastRun = {
  status: "DONE" | "FAILED" | "CANCELLED";
  counts: CheckRunCounts | null;
  /** The plain sentence of a failed run. */
  error: string | null;
};

export type VerifyModelInput = {
  view: CampaignCheckView;
  /** `view.run`, or the poll's newer data for the same job. */
  run: VerifyRunInfo | null;
  lastRun: VerifyLastRun | null;
  isOwner: boolean;
  /** Setting "verification.maxAgeDays". */
  maxAgeDays: number;
  timeZone: string;
  now: Date;
};

/** A queued or running check run of this campaign. */
export type VerifyActiveCard = {
  jobId: number;
  state: "paused" | "waiting" | "queued" | "running";
  heading: string | null;
  text: string;
  /** Running: "You can leave this page…". */
  note: string | null;
  progress: { done: number; total: number } | null;
  /** The "Stop checking?" dialog's body. */
  stopText: string;
};

/**
 * The step's main card when no run is going on. "before-go-live" is the test-list-only card: a live campaign before
 * go-live, and Test mode always (M6-DESIGN §2.7).
 */
export type VerifyMainCard = {
  kind: "before-go-live" | "dry-run" | "nothing" | "needs" | "not-ready";
  heading: string | null;
  lines: string[];
  costLine: string | null;
  /** Muted lines: already checked, waiting for their second check. */
  notes: string[];
  /** Why the check button is off: the monthly limit (Owner and Member wording). */
  blocker: string | null;
  /** "Check 40 addresses" (primary, in the footer) or "Check them anyway" (outline, in the card). */
  check: { count: number; label: string; primary: boolean; disabled: boolean } | null;
};

export type VerifyModel = {
  active: VerifyActiveCard | null;
  /** Checks are paused and no run of this campaign is going on (the amber card above the main one). */
  pause: { text: string } | null;
  done: { heading: string; lines: string[]; error: string | null } | null;
  main: VerifyMainCard | null;
  /** "Who is left out (6)" (only while no run is going on). */
  leftOut: CheckLeftOut[];
  /** "Continue without checking" and how many people it leaves out (0: a due second check only, no dialog). */
  continueWithout: { leaveOut: number } | null;
  /** "continue": the footer's own Continue; "check": Continue without checking, then the check button. */
  footer: "continue" | "check";
};

const num = (v: number): string => Math.max(0, Math.floor(v)).toLocaleString("en-US");

/** "That would pass this month's check limit of $100 ($91.20 used so far)." + what to do (§6.1: Owner / Member). */
export function verifyMonthlyText(m: { limitUsd: number; spentUsd: number }, isOwner: boolean): string {
  const start = `That would pass this month's check limit of ${usdAmountText(m.limitUsd)} (${formatUsd(m.spentUsd)} used so far).`;
  return isOwner
    ? `${start} Raise the limit in Settings › Deliverability, or check fewer addresses.`
    : `${start} Ask the Owner to raise the limit in Settings › Deliverability.`;
}

/** The lines under "40 addresses need a check" (non-zero only). */
export function needLines(need: CampaignCheckView["need"], maxAgeDays: number): string[] {
  const lines: string[] = [];
  if (need.notChecked > 0) lines.push(need.notChecked === 1 ? "1 was never checked" : `${num(need.notChecked)} were never checked`);
  if (need.tooOld > 0) lines.push(`${need.tooOld === 1 ? "1 was" : `${num(need.tooOld)} were`} checked more than ${num(maxAgeDays)} days ago`);
  if (need.testChecker > 0) {
    lines.push(`${need.testChecker === 1 ? "1 was" : `${num(need.testChecker)} were`} only checked by the test checker`);
  }
  if (need.secondCheck > 0) {
    lines.push(
      need.secondCheck === 1
        ? "1 needs its second check (the first got no answer)"
        : `${num(need.secondCheck)} need their second check (the first got no answer)`,
    );
  }
  return lines;
}

/** "112 addresses are already checked." and "2 addresses wait for their second check; …" (non-zero only). */
function readyNotes(view: CampaignCheckView): string[] {
  const notes: string[] = [];
  if (view.fine > 0) notes.push(`${plural(view.fine, "address is", "addresses are")} already checked.`);
  if (view.waiting > 0) {
    notes.push(
      view.waiting === 1
        ? "1 address waits for its second check; it's checked again after launch."
        : `${num(view.waiting)} addresses wait for their second check; they're checked again after launch.`,
    );
  }
  return notes;
}

/** "The 39 people with unchecked addresses will be left out of this campaign. You can check them later from Contacts." */
export function continueWithoutText(leaveOut: number): string {
  return `The ${plural(leaveOut, "person with an unchecked address", "people with unchecked addresses")} will be left out of this campaign. You can check them later from Contacts.`;
}

const ACTIVE = new Set(["QUEUED", "RUNNING"]);

function activeCard(run: VerifyRunInfo, view: CampaignCheckView, input: VerifyModelInput): VerifyActiveCard {
  const stopText = stopRunText(run.done, run.total);
  const base = { jobId: run.jobId, stopText };
  if (view.pause.paused) {
    return { ...base, state: "paused", heading: null, text: view.pause.text || PAUSED_FALLBACK_TEXT, note: null, progress: null };
  }
  if (run.status === "QUEUED" && run.waitingUntil) {
    return {
      ...base,
      state: "waiting",
      heading: null,
      text: deferredRunText({ waitingUntil: run.waitingUntil, summary: run.summary }, input.timeZone, input.now),
      note: null,
      progress: run.total > 0 ? { done: run.done, total: run.total } : null,
    };
  }
  if (run.status === "QUEUED" && run.blockedByOtherRun) {
    return {
      ...base,
      state: "queued",
      heading: null,
      text: "Waiting to start: another address check run is going on.",
      note: null,
      progress: null,
    };
  }
  return {
    ...base,
    state: "running",
    heading: "Checking addresses",
    text: runProgressText(run.done, run.total),
    note: "You can leave this page. The checks keep running, and you get a notification when they're done.",
    progress: { done: run.done, total: run.total },
  };
}

function doneCard(last: VerifyLastRun): VerifyModel["done"] {
  const heading = last.status === "DONE" ? "Checks finished" : last.status === "CANCELLED" ? "Checks stopped" : "Checks didn't finish";
  const error =
    last.status === "FAILED" ? last.error || "The address checks stopped because of a problem. Start them again when you're ready." : null;
  return { heading, lines: last.counts ? checkRunDoneLines(last.counts) : [], error };
}

/**
 * The test-list card's line (M6-DESIGN §2.7): Test mode only ever emails the test list (G3), before and after go-live;
 * a live campaign does so only before go-live.
 */
export const TEST_LIST_ONLY_LINES = {
  TEST: "Test mode only emails your test list, and those addresses count as checked.",
  LIVE: "Until you go live, only your test-list addresses get email, and they count as checked.",
} as const;

/** Everything the Verify step shows, for one moment. */
export function verifyStepModel(input: VerifyModelInput): VerifyModel {
  const { view } = input;
  const run = input.run && ACTIVE.has(input.run.status) ? input.run : null;
  // Only the test list gets email (its addresses count as checked): Test mode always, Live before go-live.
  const listOnly = testListOnly(view.mode, view.goLive);

  if (run) {
    return {
      active: activeCard(run, view, input),
      pause: null,
      done: null,
      main: null,
      leftOut: [],
      continueWithout: null,
      footer: "continue",
    };
  }

  const pause = view.pause.paused ? { text: view.pause.text || PAUSED_FALLBACK_TEXT } : null;
  const done = input.lastRun && !listOnly ? doneCard(input.lastRun) : null;
  const base: Omit<VerifyModel, "main" | "footer" | "continueWithout"> = { active: null, pause, done, leftOut: view.leftOutByChecks };

  if (listOnly) {
    return {
      ...base,
      pause: null,
      leftOut: [],
      main: {
        kind: "before-go-live",
        heading: "Nothing to check yet.",
        lines: [view.mode === "TEST" ? TEST_LIST_ONLY_LINES.TEST : TEST_LIST_ONLY_LINES.LIVE],
        costLine: null,
        notes: [],
        blocker: null,
        check: null,
      },
      continueWithout: null,
      footer: "continue",
    };
  }

  if (view.mode === "DRY_RUN") {
    const lines = ["This campaign is a dry run, so addresses don't need checking."];
    let costLine: string | null = null;
    let check: VerifyMainCard["check"] = null;
    let blocker: string | null = null;
    const optional = view.optional;
    if (optional && optional.count > 0) {
      const one = optional.count === 1;
      const intro =
        `${plural(optional.count, "address here was", "addresses here were")} never checked or ${one ? "was" : "were"} checked ` +
        `long ago. You can check ${one ? "it" : "them"} now, so ${one ? "it's" : "they're"} ready for a live campaign later`;
      if (view.practiceCopy) {
        lines.push(`${intro}.`, "The practice copy uses the free test checker.");
      } else if (optional.estimate.aboutUsd > 0) {
        lines.push(`${intro}: ${aboutUsd(optional.estimate.aboutUsd)}.`);
      } else {
        lines.push(`${intro}.`);
        costLine = checkCostLine(optional.estimate);
      }
      const about = optional.estimate.aboutUsd;
      const wouldPass = about > 0 && roundUsd(view.monthly.spentUsd + about) > view.monthly.limitUsd;
      if (view.notReady) blocker = view.notReady;
      else if (wouldPass) blocker = verifyMonthlyText(view.monthly, input.isOwner);
      check = {
        count: Math.min(optional.count, MAX_CHECKS_PER_RUN),
        label: "Check them anyway",
        primary: false,
        disabled: blocker !== null || pause !== null,
      };
    }
    return {
      ...base,
      pause: check ? pause : null,
      main: { kind: "dry-run", heading: null, lines, costLine, notes: [], blocker, check },
      continueWithout: null,
      footer: "continue",
    };
  }

  const need = view.need;
  if (need.total === 0) {
    return {
      ...base,
      pause: null,
      // After a run the "Checks finished" card says it all.
      main: done
        ? null
        : { kind: "nothing", heading: "No addresses need a check now", lines: [], costLine: null, notes: readyNotes(view), blocker: null, check: null },
      continueWithout: null,
      footer: "continue",
    };
  }

  const heading = `${plural(need.total, "address needs", "addresses need")} a check`;
  const continueWithout = { leaveOut: Math.max(0, need.total - need.secondCheck) };

  if (view.notReady) {
    return {
      ...base,
      main: { kind: "not-ready", heading, lines: [view.notReady], costLine: null, notes: [], blocker: null, check: null },
      continueWithout,
      footer: "check",
    };
  }

  const lines = needLines(need, input.maxAgeDays);
  if (view.tooMany) {
    lines.push(`That's ${num(need.total)} addresses. Check ${num(MAX_CHECKS_PER_RUN)} now and the rest in a second run.`);
  }
  const count = Math.min(need.total, MAX_CHECKS_PER_RUN);
  const blocker = view.monthly.wouldPass ? verifyMonthlyText(view.monthly, input.isOwner) : null;
  return {
    ...base,
    main: {
      kind: "needs",
      heading,
      lines,
      costLine: checkCostLine(view.estimate),
      notes: readyNotes(view),
      blocker,
      check: {
        count,
        label: `Check ${plural(count, "address", "addresses")}`,
        primary: true,
        disabled: blocker !== null || pause !== null,
      },
    },
    continueWithout,
    footer: "check",
  };
}
