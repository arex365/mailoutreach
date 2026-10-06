import type { PauseState } from "@/core/system-state";

/**
 * The always-visible top-bar label (PLAN A6, B6.5, M3-DESIGN §4.1.5). It never says less than what is really going
 * out: each campaign keeps the mode it was launched with, so the label takes the "strongest" of the Setting
 * "sending.mode" and the campaigns still able to send through Mailgun. Only A6's four labels are used: "Dry run",
 * "Test list only", "Sending live" and "Paused: …" ("Paused by <name>" for a pause by hand). Mailgun's test mode
 * reads "Test list only" (B6.5), before and after go-live: Test mode only ever emails the test list (M6-DESIGN G3), so
 * the label stays true. Going live changes no rule here (G6): Live mode, or a live campaign launched after go-live
 * still running, reads "Sending live" (one launched before go-live only ever reaches the test list, G2). Pure.
 */

export type SendingLabel = {
  kind: "dry-run" | "test-list" | "live" | "paused";
  text: string;
  /** Tooltip: one or two full sentences. */
  title: string;
  /** neutral = grey, success = green, danger = red. Never orange. */
  tone: "neutral" | "success" | "danger";
};

function campaigns(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * A pause in words, after a prefix: "Paused: 7 of the last 200 emails bounced", or "Paused by Arslan" when the reason
 * names who paused it (Pause all sending without a reason stores "by <name>"), and "Paused by the Owner" without any
 * reason. The same rule for the top bar ("Paused"), the pause card ("Sending is paused") and every other place that
 * prints the pause, so none of them reads "Paused: by Arslan".
 */
export function pausedWithReason(prefix: string, reason: string | null | undefined): string {
  const r = (reason ?? "").trim().replace(/\.+$/, "");
  if (!r) return `${prefix} by the Owner`;
  return /^by\s/i.test(r) ? `${prefix} ${r}` : `${prefix}: ${r}`;
}

/**
 * Picks the label (first match wins): paused; after go-live with live sending (the setting, or a live campaign
 * launched after go-live); Live before go-live; Mailgun's test mode (test list only, before and after go-live); dry
 * run while campaigns still send through Mailgun; dry run.
 *
 * A live campaign launched before go-live stays test-list only for good (M6-DESIGN G2), so after go-live it doesn't
 * make the label "Sending live" (review GOLIVE-03): with Test mode or Dry run set it reads "Test list only", and the
 * tooltip still says it sends real email to the test list.
 */
export function sendingLabel(input: {
  pause: PauseState;
  mode: "DRY_RUN" | "TEST" | "LIVE";
  goLive: boolean;
  /**
   * Campaigns still able to send through Mailgun (status RUNNING or SCHEDULED), by launch mode: `live` counts every
   * live one, `liveAfterGoLive` those launched after go-live (`Campaign.launchedGoLive`), the only ones that can reach
   * anyone. Missing `liveAfterGoLive` counts every live campaign as launched after go-live (never says less).
   */
  activeRealCampaigns: { live: number; test: number; liveAfterGoLive?: number };
  /**
   * Own-mailbox mode (MAIN-DOMAIN-DESIGN, review SCREENS-11): "Send me a test" goes to the inbox for test emails, not a
   * reply inbox. Absent = app mode, unchanged.
   */
  ownMailbox?: boolean;
}): SendingLabel {
  const { pause, mode, goLive } = input;
  const live = Math.max(0, Math.floor(input.activeRealCampaigns.live) || 0);
  const test = Math.max(0, Math.floor(input.activeRealCampaigns.test) || 0);
  const given = input.activeRealCampaigns.liveAfterGoLive;
  const liveAfterGoLive = given === undefined ? live : Math.min(live, Math.max(0, Math.floor(given) || 0));
  const liveTestList = live - liveAfterGoLive;

  if (pause.paused) {
    const fix = pause.fixText?.trim();
    return {
      kind: "paused",
      text: pausedWithReason("Paused", pause.reason),
      title: fix ? `Sending is paused. ${fix}` : "Sending is paused.",
      tone: "danger",
    };
  }

  if (goLive && (mode === "LIVE" || liveAfterGoLive > 0)) {
    const alsoTestList = liveTestList > 0 ? ` (and ${liveTestList.toLocaleString("en-US")} more to your test list only)` : "";
    const title =
      mode === "LIVE"
        ? "Campaigns send real email."
        : `New campaigns use ${mode === "TEST" ? "test mode" : "dry run"}; ${campaigns(liveAfterGoLive, "live campaign")} still ${liveAfterGoLive === 1 ? "sends" : "send"} real email${alsoTestList}. Pause ${live === 1 ? "it" : "them"}, or use Pause all sending.`;
    return { kind: "live", text: "Sending live", title, tone: "success" };
  }

  if (mode === "LIVE") {
    return {
      kind: "test-list",
      text: "Test list only",
      title: `Real emails go only to the addresses on your test list, and to ${input.ownMailbox ? "your inbox for test emails" : "your own reply inbox"} when you click Send me a test.`,
      tone: "neutral",
    };
  }

  if (mode === "TEST") {
    // Live campaigns launched before the switch still deliver real email to the test list: say so.
    return {
      kind: "test-list",
      text: "Test list only",
      title:
        live > 0
          ? `New campaigns use Mailgun's test mode; ${campaigns(live, "live campaign")} still ${live === 1 ? "sends" : "send"} real email to your test list. Pause ${live === 1 ? "it" : "them"}, or use Pause all sending.`
          : "New campaigns use Mailgun's test mode: emails to your test list are accepted but never delivered.",
      tone: "neutral",
    };
  }

  const viaMailgun = live + test;
  if (viaMailgun > 0) {
    return {
      kind: "test-list",
      text: "Test list only",
      title: `New campaigns use dry run; ${campaigns(viaMailgun, "campaign")} still ${viaMailgun === 1 ? "sends" : "send"} through Mailgun. Pause ${viaMailgun === 1 ? "it" : "them"}, or use Pause all sending.`,
      tone: "neutral",
    };
  }

  return {
    kind: "dry-run",
    text: "Dry run",
    title: "Nothing is sent: campaigns only fill the dry-run outbox.",
    tone: "neutral",
  };
}
