import { sendingLabel, type SendingLabel } from "@/core/sending/label";
import { parsePauseState } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { db } from "./db";
import { loadTeamFrom } from "./services/mailgun/team-from";
import { getSettings } from "./settings";

/** What the top-bar label shows (the four A6 labels). Kept in the Milestone 2 shape. */
export type SendingState =
  | { kind: "dry-run" }
  | { kind: "test-list" }
  | { kind: "live" }
  | { kind: "paused"; reason: string };

/**
 * Campaigns still able to send through Mailgun (Running or Scheduled), by launch mode; `liveAfterGoLive` = the live
 * ones launched after go-live (`Campaign.launchedGoLive`), the only ones that can reach anyone (M6-DESIGN G2).
 */
export type ActiveRealCampaigns = { live: number; test: number; liveAfterGoLive: number };

export type SendingLabelInfo = {
  state: SendingState;
  label: SendingLabel;
  activeRealCampaigns: ActiveRealCampaigns;
};

/**
 * The label and its inputs (PLAN A6, B6.5, M3-DESIGN §4.1.5): the pause (SystemState
 * "sending.pause"), Settings "sending.mode"/"sending.goLive", and the active TEST/LIVE campaigns
 * counted with one groupBy (by mode and launch flag). The label never says less than what is really going out: each
 * campaign keeps its launch mode, so a live campaign still running after switching back to dry run shows
 * "Test list only" (or "Sending live" after go-live, when it was launched after go-live; review GOLIVE-03).
 */
export async function getSendingLabel(): Promise<SendingLabelInfo> {
  const [pauseRow, s, groups, team] = await Promise.all([
    db.systemState.findUnique({ where: { key: STATE_KEYS.pause } }),
    getSettings(["sending.mode", "sending.goLive"] as const),
    db.campaign.groupBy({
      by: ["mode", "launchedGoLive"],
      where: { status: { in: ["RUNNING", "SCHEDULED"] }, mode: { in: ["TEST", "LIVE"] } },
      _count: { _all: true },
    }),
    // Review SCREENS-11: only the tooltip's words depend on the way of sending, so a failed read keeps app mode's words.
    loadTeamFrom().catch(() => null),
  ]);
  const pause = parsePauseState(pauseRow?.value ?? null);
  const mode = s["sending.mode"] === "TEST" || s["sending.mode"] === "LIVE" ? s["sending.mode"] : "DRY_RUN";
  const sum = (keep: (g: (typeof groups)[number]) => boolean) => groups.filter(keep).reduce((n, g) => n + g._count._all, 0);
  const activeRealCampaigns: ActiveRealCampaigns = {
    live: sum((g) => g.mode === "LIVE"),
    test: sum((g) => g.mode === "TEST"),
    liveAfterGoLive: sum((g) => g.mode === "LIVE" && g.launchedGoLive === true),
  };
  const label = sendingLabel({
    pause,
    mode,
    goLive: s["sending.goLive"] === true,
    activeRealCampaigns,
    ownMailbox: team?.replies === "own-mailbox",
  });
  const state: SendingState =
    label.kind === "paused" ? { kind: "paused", reason: pause.reason.trim() || "by the Owner" } : { kind: label.kind };
  return { state, label, activeRealCampaigns };
}

/**
 * The top-bar label's kind: paused, live, test list only or dry run, counting the TEST/LIVE
 * campaigns that are still running or scheduled (a dry-run setting with a live campaign still
 * sending reads "test list only"). The full label with its tooltip is getSendingLabel().
 */
export async function getSendingState(): Promise<SendingState> {
  return (await getSendingLabel()).state;
}
