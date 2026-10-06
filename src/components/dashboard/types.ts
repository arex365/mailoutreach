import type { AttentionItem } from "@/core/dashboard/attention";
import type { TeamActivityRow } from "@/server/services/dashboard/activity";
import type { DryRunSummary } from "@/server/services/dashboard/dry-run";
import type { PipelineView } from "@/server/services/dashboard/pipeline";
import type { WaitingReplyView } from "@/server/services/replies/waiting";
import type { CampaignListView } from "@/components/campaigns/format";
import type { HealthMeter } from "@/components/settings/deliverability/health-card";

/**
 * What the dashboard shows (M6-DESIGN §4.7), loaded by `loadDashboard` (`src/app/(app)/dashboard/load.ts`) and drawn by
 * `DashboardScreen`. Plain data only (strings, numbers, booleans, arrays), already worded and formatted in the
 * viewer's time zone. A tile that is `null` couldn't be loaded (the screen says so); `dryRun: null` hides its tile.
 */

export type GetStartedStepKey = "import" | "team" | "mailgun" | "protect" | "go-live";

/** One "Get started" step (§4.4): its title (the done text once done), text, link and state. */
export type GetStartedStep = {
  key: GetStartedStepKey;
  title: string;
  text: string;
  done: boolean;
  href: string | null;
  /** Nothing to do here for this person (the practice copy's Mailgun step, a Member's Mailgun step). */
  muted: boolean;
  /** The first step not done yet: the card's one orange link. */
  primary: boolean;
};

export type GetStartedView = { description: string; steps: GetStartedStep[] };

/** The Today tile (§4.3): sent today against the limit, and the lines under it in order. */
export type TodayView = {
  used: number;
  cap: number;
  /** used / cap, 0–100, for the neutral bar. */
  percent: number;
  /** Test sends, a hand-set limit, a reached limit, the warm-up line(s): each only when it applies. */
  lines: string[];
  /** Real data without Mailgun set up: "Nothing goes through Mailgun yet: …" (the Owner also gets Connect Mailgun). */
  notConfigured: string | null;
};

/** The Domain health tile (§4.3): the two meters of Settings › Deliverability, without the emails behind them. */
export type HealthTileView = {
  /** No sends to measure yet: the sentence shown instead of the meters; else null. */
  empty: string | null;
  bounce: HealthMeter;
  complaint: HealthMeter;
  sinceNote: string | null;
};

/** One row of Active campaigns: the Campaigns list's labels plus the sender's plain name ("Ali · Live"). */
export type DashboardCampaign = CampaignListView & { senderName: string | null };

/** The dry-run tile's numbers (P4) and its lines (`dryRunLines`). */
export type DashboardDryRun = DryRunSummary & { lines: string[] };

export type DashboardView = {
  practiceCopy: boolean;
  /**
   * Go-live from the settings (never from `loadGoLiveView`): live on real data, since when (ISO), the current sending
   * domain, and the domain go-live was on when a domain change ended it (G8).
   */
  goLive: { live: boolean; at: string | null; domain: string | null; endedOnDomain: string | null };
  getStarted: GetStartedView | null;
  /** The first 15 items (§4.2). */
  attention: AttentionItem[];
  /** Items beyond the 15 ("and 3 more"). */
  attentionMore: number;
  /** The viewer's own waiting replies, oldest first, at most 5 (§4.2a), and how many there are in all. */
  replies: { rows: WaitingReplyView[]; total: number } | null;
  /**
   * MAIN-DOMAIN-DESIGN §3.9: own-mailbox mode, the mailbox replies go to (the own From, else what is saved), so the
   * replies tile's empty state says so (`OWN_MAILBOX_TEXTS.repliesEmpty`). Null or absent = app mode (today's text).
   */
  ownFrom?: string | null;
  pipeline: PipelineView | null;
  today: TodayView | null;
  health: HealthTileView | null;
  /** Running then scheduled, at most 5; `more` the rest, `moreHref` the tab they are on (`campaignsMoreHref`). */
  campaigns: { items: DashboardCampaign[]; more: number; moreHref: string } | null;
  activity: TeamActivityRow[] | null;
  dryRun: DashboardDryRun | null;
};
