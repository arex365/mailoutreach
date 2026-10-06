import "server-only";
import { attentionItems, capAttention, domainChangeEndedGoLive, type AttentionFacts } from "@/core/dashboard/attention";
import { waitingRepliesLine } from "@/core/dashboard/replies";
import { checkMatchesMode } from "@/core/dns/check-state";
import { catchUpFailing, catchUpStatusLine, oldDomainLines } from "@/core/mailgun/catch-up-status";
import { effectiveLogRetentionDays } from "@/core/mailgun/plan";
import { warmupTable } from "@/core/sending/caps";
import { safeZone } from "@/core/sending/capday";
import { isWeekdaysOnly, warmupLine } from "@/core/sending/warmup-line";
import { parseWindow } from "@/core/sending/window";
import {
  parseCatchUpState,
  parseDomainCheckState,
  parseInboxCheckState,
  parseOutageState,
  parseRestoreState,
  parseTunnelState,
} from "@/core/system-state-parse";
import { STATE_KEYS, type CatchUpState } from "@/core/system-state";
import { formatShortDate } from "@/core/time/format";
import type { SessionUser } from "@/lib/auth/session";
import { db } from "@/server/db";
import { publicUrl } from "@/server/env";
import { isFakeMode } from "@/server/mailgun/base-url";
import { getSettings, type SettingValue } from "@/server/settings";
import { readTyped } from "@/server/state-typed";
import { getWorkerStatus } from "@/server/worker-status";
import { loadEffectiveMaxDailyCap, loadPlanLimits } from "@/server/services/mailgun/plan";
import { loadTeamFrom, type TeamFromState } from "@/server/services/mailgun/team-from";
import { getAiPause } from "@/server/services/ai/pause";
import { aiQueueCounts } from "@/server/services/ai/queue";
import { backupStatus, diskLowText } from "@/server/services/backups";
import { countCampaignsByTab, listCampaigns } from "@/server/services/campaigns/queries";
import { buildCompanyWhere, parseCompanyFilters } from "@/server/services/companies/filters";
import { recentTeamActivity } from "@/server/services/dashboard/activity";
import { dryRunLines, loadDryRunSummary } from "@/server/services/dashboard/dry-run";
import { mailgunConfigured } from "@/server/services/dashboard/mailgun";
import { loadPipeline } from "@/server/services/dashboard/pipeline";
import { waitingReplyCountsByUser } from "@/server/services/dashboard/replies";
import { unconfirmedEmails } from "@/server/services/dashboard/unconfirmed";
import { loadHealthView, type HealthView } from "@/server/services/mail-events/deliverability";
import { listWaitingReplies } from "@/server/services/replies/waiting";
import { outageHoldSummary } from "@/server/services/sequences/holds";
import { inboxCheckedToday } from "@/server/services/sending/gates";
import { getPauseState } from "@/server/services/sending/pause";
import { restoreHoldActive } from "@/server/services/sending/restore";
import { getTodayCap } from "@/server/services/sending/usage";
import { getChecksPause } from "@/server/services/verification/pause";
import { pausedText, toCampaignListView } from "@/components/campaigns/format";
import { campaignsMoreHref, healthTileView, sinceText, todayView, warmupTodayFrom } from "@/components/dashboard/format";
import { getStartedView } from "@/components/dashboard/get-started";
import type { DashboardCampaign, DashboardDryRun, DashboardView, HealthTileView } from "@/components/dashboard/types";
import { remoteAccessView } from "@/components/settings/remote-access-card";
import { workerDownText } from "@/components/settings/worker-status-text";

export type { DashboardView } from "@/components/dashboard/types";

/**
 * Everything the dashboard shows (M6-DESIGN §4), for one viewer, already worded and formatted in their time zone.
 *
 * The dashboard only reads (§0.2 rule 8): no writes, no call to Mailgun, never `getMailgunContext` (it decrypts keys
 * and may write), `loadGateInputs` or `loadGoLiveView`. Go-live comes from the settings and "Mailgun set up" from
 * `mailgunConfigured()` (a setting and whether a Secret row exists). Every list has a `take` (paused campaigns 3,
 * active campaigns 5, replies 5, activity 8) and every number is a count or a groupBy.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.9, `loadTeamFrom().replies`): the inbox-check facts (the day's check, the live
 * follow-ups due within 24 hours), the replies tile's own empty state, go-live's evidence From, the go-live rows of that
 * mode, stored checklist rows only of the mode they were checked in (`checkMatchesMode`), the outage sentences' days
 * (`effectiveLogRetentionDays`) and the warm-up line from the effective maximum (`loadEffectiveMaxDailyCap()`).
 *
 * All sources start at once (`Promise.allSettled`). A source that fails drops only its own tile (`null`: the screen
 * says it couldn't be loaded) or attention item, and logs `[dashboard] <key>: <error>`; the page itself only fails
 * when the session does. A page-level loader (§0.2 rule 12): it combines server services with component wording
 * (`workerDownText`, `pausedText`, `remoteAccessView`, `toCampaignListView`).
 */

/**
 * The settings the dashboard reads: go-live (and the From address it was switched on with, SHARED-FROM-DESIGN §3.8),
 * the practice copy, the current domain, the second backup folder, and the warm-up's table, sending days and minimum
 * use (for the warm-up line; its maximum is `loadEffectiveMaxDailyCap()`'s). Today's shared From address comes from
 * `loadTeamFrom()` (settings only), never raw. The cap day's zone (the inbox check) and the saved log retention (the
 * outage sentences).
 */
const SETTING_KEYS = [
  "practice.copy",
  "sending.goLive",
  "sending.goLiveAt",
  "sending.goLiveDomain",
  "sending.goLiveFrom",
  "mailgun.domain",
  "backups.secondFolder",
  "sending.window",
  "warmup.startCap",
  "warmup.steps",
  "warmup.minUsePercent",
  "sending.capDayTimeZone",
  "mailgun.logRetentionDays",
] as const;

type DashboardSettings = { [K in (typeof SETTING_KEYS)[number]]: SettingValue<K> };

/** Paused campaigns named one by one in the attention list; the rest are "2 more paused campaigns". */
const PAUSED_SHOWN = 3;
/** Active campaigns shown in their tile (running first, then scheduled). */
const CAMPAIGNS_SHOWN = 5;
/** The viewer's waiting replies shown (§4.2a). */
const REPLIES_SHOWN = 5;
/** Team activity rows shown (§4.3). */
const ACTIVITY_SHOWN = 8;

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** Awaits every task at once; a failed one becomes `null` and a `[dashboard] <key>: <error>` line. */
async function settleAll<T extends Record<string, Promise<unknown>>>(tasks: T): Promise<{ [K in keyof T]: Awaited<T[K]> | null }> {
  const keys = Object.keys(tasks) as Array<keyof T & string>;
  const results = await Promise.allSettled(keys.map((k) => tasks[k]));
  const out = {} as { [K in keyof T]: Awaited<T[K]> | null };
  results.forEach((r, i) => {
    const key = keys[i]!;
    if (r.status === "fulfilled") {
      out[key] = r.value as Awaited<T[typeof key]>;
    } else {
      out[key] = null;
      console.error(`[dashboard] ${key}: ${errorText(r.reason)}`);
    }
  });
  return out;
}

const trimmed = (v: string | null | undefined): string | null => (v ?? "").trim() || null;

/** Live on real data (Setting "sending.goLive"; the practice copy never goes live). */
function isLive(s: DashboardSettings): boolean {
  return s["practice.copy"] !== true && s["sending.goLive"] === true;
}

/**
 * The dashboard for `viewer` at `now` (M6-DESIGN §4.7). Owner-only links and the Owner's "Get started" steps follow
 * `viewer.role`; dates are written in `viewer.timeZone`.
 */
export async function loadDashboard(viewer: SessionUser, now: Date = new Date()): Promise<DashboardView> {
  const zone = viewer.timeZone;
  // Shared by several tiles and items: a task that needs them fails with them (and logs its own line).
  const settingsP: Promise<DashboardSettings> = getSettings(SETTING_KEYS);
  const teamP: Promise<TeamFromState> = loadTeamFrom();
  const configuredP = mailgunConfigured();
  // Declared before the object below, so their types are inferred on their own (not from its Promise<unknown> bound).
  const restoreP = loadRestoreChecking();
  const catchUpP: Promise<CatchUpState> = readTyped(STATE_KEYS.catchUp, parseCatchUpState).then(({ value }) => value);
  // Domain health and the warm-up line share one health count (the costliest read at post-go-live volumes).
  const healthViewP = loadHealthView(zone, now);
  const healthP: Promise<HealthTileView> = healthViewP.then(healthTileView);
  const dryRunP: Promise<DashboardDryRun | null> = loadDryRunSummary(now).then((d) => (d ? { ...d, lines: dryRunLines(d) } : null));

  const r = await settleAll({
    settings: settingsP,
    "team-from": teamP,
    configured: configuredP,
    "sending-paused": getPauseState(),
    "worker-down": getWorkerStatus(now),
    "restore-check": restoreP,
    backups: backupStatus(now),
    "replies-waiting": waitingReplyCountsByUser(),
    "ai-lines": aiQueueCounts(),
    "paused-campaigns": listCampaigns("paused", { pageSize: PAUSED_SHOWN }),
    unconfirmed: unconfirmedEmails(),
    "outage-hold": loadOutage(settingsP),
    "missing-emails": db.company.count({ where: buildCompanyWhere(parseCompanyFilters({ view: "missing-email" })) }),
    "tunnel-down": loadTunnel(zone, now),
    "catch-up": catchUpP,
    checklist: loadChecklistRows(settingsP, teamP),
    "inbox-check": loadOwnMailbox(now, settingsP, teamP),
    "checks-paused": getChecksPause(now),
    "ai-paused": getAiPause(now),
    "get-started": loadGetStarted(viewer, now, settingsP, configuredP),
    replies: listWaitingReplies(viewer, { scope: "mine", take: REPLIES_SHOWN, now }),
    pipeline: loadPipeline(now),
    today: loadToday(now, settingsP, configuredP, healthViewP),
    health: healthP,
    campaigns: loadCampaigns(zone, now),
    activity: recentTeamActivity(now, ACTIVITY_SHOWN),
    "dry-run": dryRunP,
  });

  const s = r.settings;
  const practiceCopy = s?.["practice.copy"] === true;
  const live = s !== null && isLive(s);
  const currentDomain = s ? trimmed(s["mailgun.domain"]) : null;
  // Today's evidence From (the shared From, or the own From; MAIN-DOMAIN-DESIGN O15): left out when it couldn't be read,
  // so the From-change item and the from-mx row drop.
  const team = r["team-from"];
  const ownMailbox = team?.replies === "own-mailbox";
  const goLiveFacts: AttentionFacts["goLive"] = s
    ? {
        live,
        currentDomain,
        liveDomain: trimmed(s["sending.goLiveDomain"]),
        liveAt: trimmed(s["sending.goLiveAt"]),
        liveFrom: trimmed(s["sending.goLiveFrom"]),
        ...(team ? { currentFrom: team.evidenceFrom } : {}),
      }
    : null;
  const ended = goLiveFacts && !practiceCopy ? domainChangeEndedGoLive(goLiveFacts) : null;

  const backup = r.backups;
  const catchUp = r["catch-up"];
  const pause = r["sending-paused"];
  const paused = r["paused-campaigns"];
  const checksPause = r["checks-paused"];
  const aiPause = r["ai-paused"];
  const facts: AttentionFacts = {
    practiceCopy,
    goLive: goLiveFacts,
    pause: pause ? { paused: pause.paused, reason: pause.reason, fixText: pause.fixText } : null,
    workerDown: r["worker-down"] ? workerDownText(r["worker-down"], now, zone) : null,
    restoreChecking: r["restore-check"]?.checking ?? null,
    backup: backup
      ? {
          age: backup.age,
          newestDay: backup.newest ? formatShortDate(backup.newest.at, zone, now) : null,
          lastCopyFailed: backup.lastCopyFailed,
          secondFolder: backup.secondFolder,
          diskLowText: backup.diskLow && backup.freeBytes !== null ? diskLowText(backup.freeBytes) : null,
        }
      : null,
    secondFolderSet: s ? trimmed(s["backups.secondFolder"]) !== null : null,
    waitingLine: r["replies-waiting"] ? waitingRepliesLine(r["replies-waiting"], viewer.id) : null,
    aiWaiting: r["ai-lines"]?.waiting ?? null,
    pausedCampaigns: paused
      ? {
          items: paused.items.map((c) => ({ id: c.id, name: c.name, pausedLine: pausedText(c.pausedAt, c.pauseReason, zone) })),
          total: paused.total,
        }
      : null,
    unconfirmed: r.unconfirmed,
    outage: r["outage-hold"],
    missingEmails: r["missing-emails"],
    tunnel: r["tunnel-down"],
    mailgunConfigured: r.configured,
    catchUp: catchUp
      ? {
          failing: catchUpFailing(catchUp),
          line: catchUpStatusLine(catchUp, zone, now).line,
          lastSuccessAt: catchUp.lastSuccessAt,
          lastStartedAt: catchUp.lastStartedAt,
          failingSince: catchUp.failingSince ?? null,
        }
      : null,
    oldDomainLines: catchUp ? oldDomainLines(catchUp, zone, now) : null,
    // Own-mailbox rows are judged with that mode's go-live keys, which come with the inbox-check facts: without them the
    // item drops rather than using app mode's keys.
    checklistRows: ownMailbox && !r["inbox-check"] ? null : r.checklist,
    checksPause: checksPause ? { paused: checksPause.paused, text: checksPause.text } : null,
    aiPause: aiPause ? { paused: aiPause.paused, text: aiPause.text } : null,
    ownMailbox: r["inbox-check"],
  };
  const attention = capAttention(attentionItems(facts, { id: viewer.id, role: viewer.role }, now));

  return {
    practiceCopy,
    goLive: {
      live,
      at: live && s ? trimmed(s["sending.goLiveAt"]) : null,
      domain: currentDomain,
      endedOnDomain: ended ? ended.was : null,
    },
    getStarted: r["get-started"],
    attention: attention.items,
    attentionMore: attention.more,
    replies: r.replies ? { rows: r.replies.rows, total: r.replies.total } : null,
    ...(ownMailbox && team ? { ownFrom: team.ownFrom ?? team.saved } : {}),
    pipeline: r.pipeline,
    today: r.today,
    health: r.health,
    campaigns: r.campaigns,
    activity: r.activity,
    dryRun: r["dry-run"],
  };
}

/** A restore is being checked with Mailgun: TEST/LIVE emails wait (restoreHoldActive) and the check is still running. */
async function loadRestoreChecking(): Promise<{ checking: boolean }> {
  const state = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  return { checking: restoreHoldActive(state) && (state.status === "pending" || state.status === "scanning") };
}

/**
 * The long-outage hold (M4-DESIGN §2.8.3): the outage record first, and the held people (outageHoldSummary) only when
 * an outage was found, so the usual case costs one read. `days` for "more than N days": the days of Mailgun logs the
 * app counts on (`effectiveLogRetentionDays`, MAIN-DOMAIN-DESIGN O26; 5 with the default setting and no plan).
 */
async function loadOutage(settingsP: Promise<DashboardSettings>): Promise<NonNullable<AttentionFacts["outage"]>> {
  const state = (await readTyped(STATE_KEYS.outage, parseOutageState)).value;
  if (state.from === null && !state.beyondMessageRetention) return { detected: false, applied: state.handledAt !== null, people: 0 };
  const [summary, s, limits] = await Promise.all([outageHoldSummary(), settingsP, loadPlanLimits()]);
  return {
    detected: summary.detected,
    applied: summary.applied,
    people: summary.total,
    days: effectiveLogRetentionDays(s["mailgun.logRetentionDays"], limits),
  };
}

/**
 * Own-mailbox mode's inbox-check facts (MAIN-DOMAIN-DESIGN §3.9); null in app mode. `followUpsDue`: LIVE follow-ups
 * (step ≥ 1) still QUEUED and due now or within the next 24 hours, of campaigns running or paused (a resumed campaign's
 * overdue follow-ups wait for the check too). One state read and one count.
 */
async function loadOwnMailbox(
  now: Date,
  settingsP: Promise<DashboardSettings>,
  teamP: Promise<TeamFromState>,
): Promise<NonNullable<AttentionFacts["ownMailbox"]> | null> {
  const team = await teamP;
  if (team.replies !== "own-mailbox") return null;
  const [s, check, followUpsDue] = await Promise.all([
    settingsP,
    readTyped(STATE_KEYS.inboxCheck, parseInboxCheckState),
    db.outboundEmail.count({
      where: {
        mode: "LIVE",
        status: "QUEUED",
        step: { gte: 1 },
        dueAt: { lte: new Date(now.getTime() + 24 * 3_600_000) },
        campaign: { status: { in: ["RUNNING", "PAUSED"] } },
      },
    }),
  ]);
  const capZone = safeZone(typeof s["sending.capDayTimeZone"] === "string" ? s["sending.capDayTimeZone"] : null);
  return {
    from: team.ownFrom ?? team.saved,
    // The gate's and the Notifications card's own rule (review SECURITY-02: a check stamped ahead of the clock never counts).
    inboxCheckedToday: inboxCheckedToday(check.value.at, now, capZone),
    followUpsDue,
    publicAddress: Boolean(publicUrl()),
  };
}

/**
 * Remote access is down: a public address is set and the tunnel is down or not running, or the public address check
 * failed (the Remote access card's own rules, `remoteAccessView`). `since` = when the tunnel went down, in `zone`.
 */
async function loadTunnel(zone: string, now: Date): Promise<NonNullable<AttentionFacts["tunnel"]>> {
  const pub = publicUrl();
  if (!pub) return { down: false, since: null };
  const t = (await readTyped(STATE_KEYS.tunnel, parseTunnelState)).value;
  const view = remoteAccessView(t, pub, now, zone, isFakeMode());
  const tunnelDown = view.status.tone === "bad";
  const down = tunnelDown || t.publicCheck?.ok === false;
  return { down, since: tunnelDown && t.downSince ? sinceText(t.downSince, zone, now) : null };
}

/**
 * The Domain checklist's rows for the current sending domain and way of sending (rows of the other mode are ignored,
 * `checkMatchesMode`, MAIN-DOMAIN-DESIGN O36), read only while live (the `checklist` item's rule).
 */
async function loadChecklistRows(
  settingsP: Promise<DashboardSettings>,
  teamP: Promise<TeamFromState>,
): Promise<NonNullable<AttentionFacts["checklistRows"]>> {
  const s = await settingsP;
  if (!isLive(s)) return [];
  const domain = trimmed(s["mailgun.domain"]);
  const [check, team] = await Promise.all([readTyped(STATE_KEYS.domainCheck, parseDomainCheckState).then((c) => c.value), teamP]);
  if (!checkMatchesMode(check, team.replies)) return [];
  return domain && (check.domain ?? "").trim().toLowerCase() === domain.toLowerCase() ? check.rows : [];
}

/**
 * "Get started" (§4.4): whether it shows for this viewer and which steps are done. The Owner's team step is done with
 * another active user or an invite link that can still be used.
 */
async function loadGetStarted(
  viewer: SessionUser,
  now: Date,
  settingsP: Promise<DashboardSettings>,
  configuredP: Promise<boolean>,
): Promise<DashboardView["getStarted"]> {
  const owner = viewer.role === "OWNER";
  const [s, configured, companies, others, invites] = await Promise.all([
    settingsP,
    configuredP,
    db.company.count({ where: { deletedAt: null } }),
    owner ? db.user.count({ where: { active: true, id: { not: viewer.id } } }) : Promise.resolve(0),
    owner
      ? db.accessLink.count({ where: { purpose: "INVITE", usedAt: null, revokedAt: null, expiresAt: { gt: now } } })
      : Promise.resolve(0),
  ]);
  const practiceCopy = s["practice.copy"] === true;
  return getStartedView({
    role: viewer.role,
    practiceCopy,
    live: isLive(s),
    companies,
    teamInvited: others + invites > 0,
    mailgun: { practiceCopy, connected: configured, domain: trimmed(s["mailgun.domain"]) },
    secondFolderSet: trimmed(s["backups.secondFolder"]) !== null,
  });
}

/**
 * Today (§4.3): today's limit and its use (`getTodayCap`), and the warm-up line after go-live and in the practice copy:
 * `warmupLine(step, table, today)` with the open day's facts (`warmupTodayFrom`: the values `loadWarmupToday(now)`
 * gives, built from this limit and Domain health's counts, which count from go-live like the warm-up), so "Tomorrow 80"
 * only shows when today qualifies so far. Without the health counts the line keeps its always-true "goes up" form.
 */
async function loadToday(
  now: Date,
  settingsP: Promise<DashboardSettings>,
  configuredP: Promise<boolean>,
  healthViewP: Promise<HealthView>,
): Promise<DashboardView["today"]> {
  const [cap, s, configured] = await Promise.all([getTodayCap(now), settingsP, configuredP]);
  const practiceCopy = s["practice.copy"] === true;
  const live = isLive(s);
  let line: string | null = null;
  if (practiceCopy || live) {
    // The maximum in force: never above the Mailgun plan's daily limit minus the test reserve (MAIN-DOMAIN-DESIGN O23).
    const { maxCap } = await loadEffectiveMaxDailyCap();
    const table = warmupTable(Number(s["warmup.startCap"]), maxCap, Number(s["warmup.steps"]));
    // How a step is earned, in the Owner's settings (review SCREENS-10), also when today's facts couldn't be read.
    const rule = { minUsePercent: Number(s["warmup.minUsePercent"]), weekdaysOnly: isWeekdaysOnly(parseWindow(s["sending.window"]).days) };
    const health = await healthViewP.catch(() => null);
    const today = health
      ? warmupTodayFrom({
          used: cap.used,
          warmupCap: cap.warmupCap,
          capDay: cap.capDay,
          window: s["sending.window"],
          minUsePercent: Number(s["warmup.minUsePercent"]),
          counts: health.counts,
          thresholds: health.thresholds,
        })
      : null;
    line = warmupLine(cap.warmupStep, table, today, rule);
  }
  return todayView({ cap, warmupLine: line, practiceCopy, live, configured });
}

/**
 * Active campaigns (§4.3): the running ones (newest launch first), then scheduled ones to fill up to 5; `more` counts
 * the rest of both (`countCampaignsByTab`), and "+ 3 more" leads to the tab they are on (review DASHBOARD-7:
 * `campaignsMoreHref`, the Campaigns page when they are on both).
 */
async function loadCampaigns(zone: string, now: Date): Promise<DashboardView["campaigns"]> {
  const [counts, running] = await Promise.all([countCampaignsByTab(), listCampaigns("running", { pageSize: CAMPAIGNS_SHOWN })]);
  const room = CAMPAIGNS_SHOWN - running.items.length;
  const scheduled = room > 0 && counts.scheduled > 0 ? (await listCampaigns("scheduled", { pageSize: room })).items : [];
  const items: DashboardCampaign[] = [...running.items, ...scheduled].map((c) => ({
    ...toCampaignListView(c, zone, now),
    senderName: c.senderName,
  }));
  const moreRunning = Math.max(0, counts.running - running.items.length);
  const moreScheduled = Math.max(0, counts.scheduled - scheduled.length);
  return { items, more: moreRunning + moreScheduled, moreHref: campaignsMoreHref(moreRunning, moreScheduled) };
}
