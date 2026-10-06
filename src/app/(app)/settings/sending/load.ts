import "server-only";
import { checkMatchesMode } from "@/core/dns/check-state";
import { catchUpStatusLine, oldDomainLines } from "@/core/mailgun/catch-up-status";
import { effectiveLogRetentionDays } from "@/core/mailgun/plan";
import { validateTestList } from "@/core/reply-test";
import { warmupTable } from "@/core/sending/caps";
import { modeWarnings } from "@/core/sending/mode-gates";
import { TEAM_FROM_TEXTS, teamFromDomainFor } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { restoreReportLines, shortDateTime } from "@/core/sending/restore-report";
import { isWeekdaysOnly, warmupUsePercent } from "@/core/sending/warmup-line";
import { parseWindow } from "@/core/sending/window";
import { parseCatchUpState, parseOutageState, parseRestoreState } from "@/core/system-state-parse";
import { STATE_KEYS, type OutageState, type PauseKind, type PauseState } from "@/core/system-state";
import { plural } from "@/core/text";
import { formatDateTime, formatShortDate, timeAgo } from "@/core/time/format";
import type { SessionUser } from "@/lib/auth/session";
import { db } from "@/server/db";
import { mailgunBaseOverride } from "@/server/mailgun/base-url";
import { NOT_CONNECTED_TEXT } from "@/server/mailgun/context";
import { goLiveViewFrom } from "@/server/services/go-live";
import { loadEffectiveMaxDailyCap } from "@/server/services/mailgun/plan";
import { loadTeamFrom, type TeamFromState } from "@/server/services/mailgun/team-from";
import { loadGateInputs, modeBlockersFor } from "@/server/services/reply-test";
import { outageHoldSummary, type OutageHoldSummary } from "@/server/services/sequences/holds";
import { suggestedSenderName } from "@/server/services/users";
import { secretInfo } from "@/server/secrets";
import { getSettings } from "@/server/settings";
import { readTyped } from "@/server/state-typed";
import { goLiveCardView } from "@/components/settings/sending/go-live-view";
import { CONNECTION_STATUS_TEXTS, modeOptionTexts, testListTexts } from "@/components/settings/sending/texts";
import type {
  ConnectionView,
  FromAddressView,
  GoLiveCardView,
  ModeOptionView,
  PauseView,
  SendingModeKey,
} from "@/components/settings/types";

/**
 * Everything Settings › Sending & Mailgun (M3-DESIGN §5.2, M4-DESIGN §9.9, M6-DESIGN §2.5–§2.7) shows, already worded
 * and formatted in the viewer's time zone, so the client components only render. The gate inputs are loaded once and
 * shared by the mode choices, the test list and the Go live card.
 */

/** One sender whose follow-ups the outage hold keeps back, with "Continue Ali's follow-ups" (M4-DESIGN §9.9). */
export type OutageSenderRow = {
  /** The sender's user id; null = campaigns whose sender account is gone. */
  senderId: number | null;
  /** "Ali · 8 people" / "Ali (switched off) · 3 people". */
  label: string;
  /** "Continue Ali's follow-ups". */
  buttonLabel: string;
  /** "Continue Ali's follow-ups?" */
  dialogTitle: string;
  /** "Only do this after Ali has looked through their inbox for replies that arrived from 3 Oct to 9 Oct. …" */
  dialogText: string;
};

/** The "Check with Mailgun" card's line about a long time the PC was off (M4-DESIGN §9.9). */
export type OutageView = {
  /** "warning" (amber) while follow-ups wait for a hold or a check; "neutral" once nothing is held. */
  tone: "warning" | "neutral";
  line: string;
  senders: OutageSenderRow[];
  /** "First emails to 4 other people at those companies continue once everyone who emailed their company has checked." */
  colleagues: string | null;
};

export type CheckWithMailgunView = {
  line: string;
  failing: boolean;
  detail: string | null;
  /** Older sending domains whose logs couldn't be checked (M6-DESIGN L10, `oldDomainLines`). */
  oldDomains: string[];
  outage: OutageView | null;
};

/** The neutral outage lines stay this long after the outage was found. */
export const OUTAGE_NOTE_DAYS = 7;

/** "Ali's". */
function possessive(name: string): string {
  return `${name}'s`;
}

/**
 * Own-mailbox mode's outage line (review REPLIES-09/SCREENS-07): what a gap longer than Mailgun keeps its logs costs in
 * this mode. `window`: "from 3 Oct to 5 Oct" (the part the app couldn't read), or null; `from`: the own From, or null
 * while none fits.
 */
export function ownOutageLine(window: string | null, logRetentionDays: number, from: string | null): string {
  const reports = window ? `Mailgun's reports ${window}` : "Some of Mailgun's reports";
  return `${reports} (deliveries, bounces, complaints and unsubscribes) couldn't be read: the PC was off for more than ${plural(logRetentionDays, "day", "days")}, and Mailgun keeps them only that long on your plan. Anyone who bounced, complained or unsubscribed then is still stopped, because the app also reads Mailgun's lists. Replies aren't affected: they go straight to ${from ?? "your own mailbox"}, as always.`;
}

/**
 * The outage lines of the "Check with Mailgun" card (M4-DESIGN §9.9), from the outage record and the hold summary
 * (`outageHoldSummary`), dates in the viewer's zone:
 *  - found, hold not applied yet (amber): "The PC was off for more than 5 days, …";
 *  - held, people still held (amber): the window and "Follow-ups of 12 people are on hold until their sender has
 *    checked their inbox:", one row per sender with people held ("Continue Ali's follow-ups"), and the colleagues'
 *    first emails;
 *  - held and nobody left on hold, or nothing was held (neutral, for 7 days after it was found);
 *  - only Mailgun's stored-message retention was passed (neutral, for 7 days): the replies recovered without text.
 * Null when there is nothing to say.
 *
 * Own-mailbox mode (`ctx.ownMailbox`, review REPLIES-09/SCREENS-07): replies never pass through Mailgun there, and
 * nothing is put on hold for a gap (O27), so no line says replies may have been missed or follow-ups wait for a hold.
 * While nobody is held, one neutral line (for 7 days) says what the gap did cost: Mailgun's reports of those days
 * (deliveries, bounces, complaints, unsubscribes; Mailgun keeps them only `logRetentionDays`), that the people who
 * bounced, complained or unsubscribed are still stopped through Mailgun's lists, and that replies are in the own From
 * mailbox as always. People still held from an app-mode hold before a switch keep today's lines (their buttons).
 */
export function buildOutageView(
  summary: OutageHoldSummary,
  state: Pick<OutageState, "detectedAt">,
  ctx: { zone: string; now: Date; logRetentionDays: number; ownMailbox?: { from: string | null } },
): OutageView | null {
  if (!summary.detected) return null;
  const date = (d: string) => formatShortDate(d, ctx.zone, ctx.now);
  const detected = state.detectedAt ? Date.parse(state.detectedAt) : Number.NaN;
  const recent = Number.isFinite(detected) && ctx.now.getTime() - detected <= OUTAGE_NOTE_DAYS * 86_400_000;
  if (ctx.ownMailbox && summary.total === 0) {
    // No stored reply is ever recovered in this mode (no route), so "replies recovered without their text" can't apply.
    if (!recent || summary.textOnly) return null;
    const window = summary.from && summary.to ? `from ${date(summary.from)} to ${date(summary.to)}` : null;
    return { tone: "neutral", line: ownOutageLine(window, ctx.logRetentionDays, ctx.ownMailbox.from), senders: [], colleagues: null };
  }
  if (summary.textOnly) {
    return recent
      ? {
          tone: "neutral",
          line: "Some replies were recovered without their text, because the PC was off longer than Mailgun keeps received messages. They're on Replies waiting for an answer as possible replies.",
          senders: [],
          colleagues: null,
        }
      : null;
  }
  if (!summary.applied) {
    return {
      tone: "warning",
      line: `The PC was off for more than ${plural(ctx.logRetentionDays, "day", "days")}, so the app can't be sure it saw every reply. Follow-ups are waiting while the app puts them on hold.`,
      senders: [],
      colleagues: null,
    };
  }
  const window = summary.from && summary.to ? `from ${date(summary.from)} to ${date(summary.to)}` : null;
  const followUps = summary.bySender.reduce((n, s) => n + s.held, 0);
  const firstEmails = summary.bySender.reduce((n, s) => n + s.firstEmailsWaiting, 0);
  if (followUps + firstEmails === 0) {
    if (!recent) return null;
    return {
      tone: "neutral",
      line: `${window ? `Replies ${window} may have been missed while the PC was off` : "The PC was off too long to check for replies"}. No follow-ups are on hold now.`,
      senders: [],
      colleagues: null,
    };
  }
  const when = window ?? "while the PC was off";
  const senders: OutageSenderRow[] = summary.bySender
    .filter((s) => s.held > 0)
    .map((s) => {
      const people = plural(s.held, "person", "people");
      if (s.userId === null) {
        return {
          senderId: null,
          label: `Campaigns whose sender account is gone · ${people}`,
          buttonLabel: "Continue these follow-ups",
          dialogTitle: "Continue these follow-ups?",
          dialogText: `Only do this after someone has looked through the inbox of these campaigns for replies that arrived ${when}. Anyone who replied must not get a follow-up.`,
        };
      }
      return {
        senderId: s.userId,
        label: `${s.name}${s.active ? "" : " (switched off)"} · ${people}`,
        buttonLabel: `Continue ${possessive(s.name)} follow-ups`,
        dialogTitle: `Continue ${possessive(s.name)} follow-ups?`,
        dialogText: `Only do this after ${s.name} has looked through their inbox for replies that arrived ${when}. Anyone who replied must not get a follow-up.`,
      };
    });
  const held =
    followUps > 0
      ? ` Follow-ups of ${plural(followUps, "person", "people")} are on hold until their sender has checked their inbox:`
      : "";
  return {
    tone: "warning",
    // The window is the part the app couldn't check (the replies that may have been missed), not the PC's off-time.
    line: `${window ? `Replies ${window} may have been missed while the PC was off.` : "The PC was off too long to check for replies, so replies may have been missed."}${held}`,
    senders,
    colleagues:
      firstEmails > 0
        ? `First emails to ${plural(firstEmails, followUps > 0 ? "other person" : "person", followUps > 0 ? "other people" : "people")} at those companies continue once everyone who emailed their company has checked.`
        : null,
  };
}

/**
 * The From address card (SHARED-FROM-DESIGN §3.1). "Connected" here means a sending domain is saved: the From address
 * only has to fit it (a disconnected key doesn't stop the Owner from clearing a From address). `problem` is the card's
 * own misfit sentence ("…Change it or clear it below."). The Owner's display name falls back to the suggested one.
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.2): `replies` picks the card's own texts and rules, and the misfit sentence is
 * `OWN_MAILBOX_TEXTS.misfitHere`.
 */
export function fromAddressView(
  team: TeamFromState,
  ctx: { practiceCopy: boolean; goLive: boolean; testList: string[]; owner: { name: string; senderDisplayName: string | null } | null },
): FromAddressView {
  const domain = team.domain;
  const display = ctx.owner ? ctx.owner.senderDisplayName?.trim() || suggestedSenderName(ctx.owner.name) : "";
  const own = team.replies === "own-mailbox";
  return {
    practiceCopy: ctx.practiceCopy,
    connected: domain !== null,
    sendingDomain: domain,
    mainDomain: teamFromDomainFor(domain),
    saved: team.saved,
    problem:
      team.problem && team.saved && domain
        ? own
          ? OWN_MAILBOX_TEXTS.misfitHere(team.saved, domain)
          : TEAM_FROM_TEXTS.misfitHere(team.saved, domain)
        : null,
    goLive: ctx.goLive,
    ownerDisplayName: display,
    testList: ctx.testList,
    replies: team.replies,
  };
}

export type SendingPageData = {
  practiceCopy: boolean;
  fakeBanner: string | null;
  pause: PauseView | null;
  connection: ConnectionView;
  /** The From address card, right after the connection (SHARED-FROM-DESIGN §3.1). */
  fromAddress: FromAddressView;
  checkWithMailgun: CheckWithMailgunView | null;
  mode: SendingModeKey;
  modeOptions: ModeOptionView[];
  activeCampaigns: Array<{ name: string; mode: string }>;
  /** Setting "sending.goLive" (the mode and test-list words change with it, M6-DESIGN §2.7). */
  goLiveOn: boolean;
  testList: string[];
  testListWarnings: string[];
  /** The Test list card's description and hint, before or after go-live. */
  testListDescription: string;
  testListHint: string;
  /** The Test list card's empty state (review SCREENS-11: own-mailbox mode's words, `testListTexts`). */
  testListEmpty: string;
  /** The "Go live" card (M6-DESIGN §2.5). */
  goLive: GoLiveCardView;
  webhookUrl: string | null;
  /** Null in own-mailbox mode too: no route ever stores a reply there (MAIN-DOMAIN-DESIGN O8). */
  inboundUrl: string | null;
  /** MAIN-DOMAIN-DESIGN O1: the saved "How the app sends" is own-mailbox mode (the "For Mailgun" card's wording). */
  ownMailbox: boolean;
};

const HEALTH: ReadonlySet<PauseKind> = new Set(["health-bounce", "health-complaint"]);

async function pauseView(pause: PauseState, zone: string, now: Date): Promise<PauseView | null> {
  if (!pause.paused) return null;
  const kinds = [...(pause.kind ? [pause.kind] : []), ...pause.also.map((a) => a.kind)];
  const by = pause.byUserId ? await db.user.findUnique({ where: { id: pause.byUserId }, select: { name: true } }) : null;
  const sinceText = `Paused ${pause.since ? timeAgo(pause.since, now) : "just now"} by ${by?.name ?? "the app"}.`;
  const details: string[] = [];
  if (pause.detail?.mailgunMessage) details.push(`Mailgun said: ${pause.detail.mailgunMessage}`);
  if (pause.detail?.until) details.push(`Mailgun says until ${formatDateTime(pause.detail.until, zone)}.`);
  for (const a of pause.also) {
    details.push(`Also: ${a.reason}${a.at ? ` (${timeAgo(a.at, now)})` : ""}.`);
    if (a.detail?.mailgunMessage) details.push(`Mailgun said: ${a.detail.mailgunMessage}`);
  }

  const healthKind = kinds.find((k) => HEALTH.has(k)) ?? null;
  const healthLink =
    healthKind === "health-bounce"
      ? { href: "/settings/deliverability#bounces", label: "Bounces counted now" }
      : healthKind === "health-complaint"
        ? { href: "/settings/deliverability#complaints", label: "Complaints counted now" }
        : null;

  let restoreText: string | null = null;
  let risk = false;
  let running = false;
  let restoredFrom: string | null = null;
  if (kinds.includes("restore")) {
    const restore = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
    const r = restoreReportLines(restore, zone, now);
    restoreText = r.text;
    risk = r.risk;
    running = r.running;
    details.push(...r.details);
    restoredFrom = restore.restoredFrom;
  }

  const dialog: string[] = [];
  if (risk) dialog.push("The app couldn't check Mailgun for emails sent after the backup.");
  else if (running) {
    dialog.push(
      "The restore check is still running. Resume now and dry runs continue; emails through Mailgun wait until the check has finished. If the check fails, sending pauses again and asks you to confirm.",
    );
  }
  if (healthKind) {
    const cause = pause.kind === healthKind ? pause.reason : (pause.also.find((a) => a.kind === healthKind)?.reason ?? pause.reason);
    const what = healthKind === "health-bounce" ? "bounces" : "complaints";
    // The dialog's title already asks "Resume sending?", so the body starts with the cause.
    dialog.push(`${cause.replace(/\.$/, "")}. Resuming starts a fresh count: only new ${what} count toward the limit.`);
  }
  if (kinds.includes("copied-database")) {
    dialog.push("Resume only if you moved the app on purpose. A copy of the real database would send the same emails again.");
  }
  if (dialog.length === 0) dialog.push("If the problem is still there, sending pauses again.");

  return {
    reason: pause.reason || "by the Owner",
    fixText: pause.fixText,
    sinceText,
    details,
    healthLink,
    restoreText,
    dialog,
    confirmLabel: risk
      ? `I understand that emails sent after ${restoredFrom ? shortDateTime(restoredFrom, zone, now) : "the backup was made"} may go out a second time.`
      : null,
  };
}

/** Why Mailgun isn't connected, worded for this page (the form to fix it is right below). */
function connectionStatusHere(text: string | null): string {
  switch (text) {
    case NOT_CONNECTED_TEXT["no-key"]:
      return CONNECTION_STATUS_TEXTS.noKey;
    case NOT_CONNECTED_TEXT.mismatch:
      return CONNECTION_STATUS_TEXTS.mismatch;
    case NOT_CONNECTED_TEXT.unreadable:
      return CONNECTION_STATUS_TEXTS.unreadable;
    case null:
    case NOT_CONNECTED_TEXT["no-domain"]:
      return CONNECTION_STATUS_TEXTS.notYet;
    default:
      return text;
  }
}

/** The outage lines, read fresh (the record and the people still held). `team`: own-mailbox mode's words (REPLIES-09). */
async function loadOutageView(zone: string, now: Date, logRetentionDays: number, team: TeamFromState): Promise<OutageView | null> {
  const outage = (await readTyped(STATE_KEYS.outage, parseOutageState)).value;
  const ownMailbox = team.replies === "own-mailbox" ? { from: team.ownFrom } : undefined;
  return buildOutageView(await outageHoldSummary(), outage, { zone, now, logRetentionDays, ownMailbox });
}

/**
 * The catch-up's status line and the old-domain lines (worded in @/core/mailgun/catch-up-status) and the outage lines.
 * Null (no card) when Mailgun isn't connected and there is nothing to say.
 */
async function checkWithMailgunView(
  zone: string,
  now: Date,
  connected: boolean,
  outage: OutageView | null,
): Promise<CheckWithMailgunView | null> {
  const state = (await readTyped(STATE_KEYS.catchUp, parseCatchUpState)).value;
  const oldDomains = oldDomainLines(state, zone, now);
  if (!connected && !outage && oldDomains.length === 0) return null;
  return { ...catchUpStatusLine(state, zone, now), oldDomains, outage };
}

/** The page's data, for the signed-in Owner. */
export async function loadSendingPage(user: SessionUser, now: Date = new Date()): Promise<SendingPageData> {
  const zone = user.timeZone;
  const gate = await loadGateInputs(now);
  const s = await getSettings(["mailgun.logRetentionDays", "mailgun.messageRetentionDays"] as const);
  const key = await secretInfo("mailgun.apiKey");
  const sendingKey = await secretInfo("mailgun.sendingKey");
  const logRetentionDays = Number(s["mailgun.logRetentionDays"]) || 5;
  const messageRetentionDays = Number(s["mailgun.messageRetentionDays"]) || 1;
  // MAIN-DOMAIN-DESIGN O1, O22, O23, O26: the mode, the plan in force, and the maximum daily limit it allows.
  const team = await loadTeamFrom();
  const own = team.replies === "own-mailbox";
  const { maxCap, limits } = await loadEffectiveMaxDailyCap();

  let statusLine: string;
  if (gate.practiceCopy) statusLine = "The practice copy never talks to Mailgun.";
  else if (gate.connected && gate.domain) {
    // A check of the other mode (right after a switch) isn't this setup's check (O36).
    const checked =
      gate.check.domain === gate.domain && checkMatchesMode(gate.check, team.replies) && gate.check.checkedAt
        ? ` · checked ${timeAgo(gate.check.checkedAt, now)}`
        : "";
    const mode = own ? OWN_MAILBOX_TEXTS.statusSuffix : "";
    statusLine = `Connected to ${gate.domain} (${gate.region})${mode}${key.set ? ` · key ending …${key.last4}` : ""}${checked}`;
  } else if (gate.domain) statusLine = connectionStatusHere(gate.connectionText);
  else statusLine = "Not connected yet.";

  const pause = await pauseView(gate.pause, zone, now);
  const connection: ConnectionView = {
    connected: gate.connected,
    statusLine,
    region: gate.region,
    domain: gate.domain ?? "",
    keyLast4: key.set ? key.last4 : null,
    hasSendingKey: sendingKey.set,
    logRetentionDays,
    messageRetentionDays,
    primary: !gate.connected && !gate.pause.paused && !gate.practiceCopy,
    replies: team.replies,
    // A plan assumed in own-mailbox mode isn't a chosen one: the select shows "Not sure" with the assumed line.
    plan: limits && !limits.assumed ? limits.plan : null,
    planAssumed: limits?.assumed === true,
  };

  const optionTexts = modeOptionTexts(gate.goLive);
  const modeOptions: ModeOptionView[] = (["DRY_RUN", "TEST", "LIVE"] as const).map((k) => ({
    key: k,
    title: optionTexts[k].title,
    text: optionTexts[k].text,
    blockers: modeBlockersFor(k, gate),
    warnings: modeWarnings(k, { testListSize: gate.testList.length, goLive: gate.goLive }),
  }));

  const active = await db.campaign.findMany({
    where: { mode: { in: ["TEST", "LIVE"] }, status: { in: ["SCHEDULED", "RUNNING"] } },
    select: { name: true, mode: true },
    orderBy: { id: "asc" },
    take: 20,
  });

  const mates = await db.user.findMany({ where: { active: true }, select: { name: true, email: true, replyInbox: true } });
  const checkedList = validateTestList(gate.testList, {
    sendingDomains: [],
    teammateInboxes: mates.map((u) => ({ name: u.name, inbox: (u.replyInbox || u.email).toLowerCase() })),
    // The From this way of sending uses (the shared From, or the own From in own-mailbox mode, O15).
    teamFrom: team.evidenceFrom,
  });
  const ownerRow = await db.user.findUnique({ where: { id: user.id }, select: { name: true, senderDisplayName: true } });
  const fromAddress = fromAddressView(team, {
    practiceCopy: gate.practiceCopy,
    goLive: gate.goLive,
    testList: gate.testList,
    owner: ownerRow ?? { name: user.name, senderDisplayName: null },
  });

  const pub = gate.publicUrl;
  const override = mailgunBaseOverride();
  // People held after the PC was off can be continued here even while Mailgun isn't connected. The days are the ones
  // the app may count on: never more than the plan keeps (O26).
  const outage = gate.practiceCopy
    ? null
    : await loadOutageView(zone, now, effectiveLogRetentionDays(s["mailgun.logRetentionDays"], limits), team);
  // The dialog's warm-up sentence names the ramp in use: its first and last limits and how many steps it has, and how
  // a step is earned in the Owner's settings (review SCREENS-10: the minimum use, and whether sending days are Mon–Fri).
  // The top of the ramp is the maximum daily limit the plan allows (O23, `loadEffectiveMaxDailyCap`).
  const w = await getSettings(["warmup.startCap", "warmup.steps", "warmup.minUsePercent", "sending.window"] as const);
  const table = warmupTable(Number(w["warmup.startCap"]), maxCap, Number(w["warmup.steps"]));
  const goLive = goLiveCardView(await goLiveViewFrom(gate), {
    timeZone: zone,
    warmup: {
      startCap: table[0] ?? 50,
      maxCap: table[table.length - 1] ?? 1000,
      steps: table.length || 20,
      minUsePercent: warmupUsePercent(w["warmup.minUsePercent"]),
      weekdaysOnly: isWeekdaysOnly(parseWindow(w["sending.window"]).days),
    },
  });
  // Review SCREENS-11: own-mailbox mode has no reply inbox; "Send me a test" goes to the inbox for test emails.
  const listTexts = testListTexts(gate.goLive, { ownMailbox: own });
  return {
    practiceCopy: gate.practiceCopy,
    fakeBanner: override
      ? `Test server: Mailgun calls go to ${override} (OUTREACH_MAILGUN_BASE_URL). Nothing reaches the real Mailgun.`
      : null,
    pause,
    connection,
    fromAddress,
    checkWithMailgun: gate.practiceCopy ? null : await checkWithMailgunView(zone, now, gate.connected, outage),
    mode: gate.mode,
    modeOptions,
    activeCampaigns: active.map((c) => ({ name: c.name, mode: c.mode ?? "DRY_RUN" })),
    goLiveOn: gate.goLive,
    testList: gate.testList,
    testListWarnings: checkedList.ok ? checkedList.warnings : [],
    testListDescription: listTexts.description,
    testListHint: listTexts.hint,
    testListEmpty: listTexts.empty,
    goLive,
    webhookUrl: pub ? `${pub}/api/webhooks/mailgun/events` : null,
    inboundUrl: pub && !own ? `${pub}/api/webhooks/mailgun/inbound` : null,
    ownMailbox: own,
  };
}
