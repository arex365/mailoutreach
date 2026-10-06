import { checkMatchesMode } from "@/core/dns/check-state";
import { normalizeEmail } from "@/core/email-address";
import { effectiveLogRetentionDays, type PlanLimits } from "@/core/mailgun/plan";
import { publicAddressProblem } from "@/core/mailgun/routes";
import { threadIds } from "@/core/replies/link-ids";
import {
  currentOriginal,
  evaluateReplyTest,
  mergeReplyTestAnswers,
  parseTestOriginal,
  providerLabel,
  providerOf,
  readReplyTestPastes,
  REPLY_TEST_TEXTS,
  replyTestPassedFor,
  replyTestRoundChanged,
  reportsGoneBefore,
  teamFromDomainOf,
  validateTestList,
  type MailboxFacts,
  type ParsedTestOriginal,
  type ReplyTestAnswersInput,
  type ReplyTestRound,
  type ReplyTestVerdict,
} from "@/core/reply-test";
import { riskyAppFolder } from "@/core/sending/app-folder";
import { capDayOf, safeZone } from "@/core/sending/capday";
import { senderAddressWords } from "@/core/sending/from-address";
import {
  goLiveBlockers,
  goLiveRecommendations,
  liveModeBlockers,
  MODE_GATE_TEXTS,
  replyTestBlockers,
  testModeBlockers,
} from "@/core/sending/mode-gates";
import { OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS, type RepliesMode } from "@/core/sending/own-mailbox";
import {
  DEFAULT_UNSUBSCRIBE_TEST,
  type ReplyTestMailbox,
  type ReplyTestOriginal,
  type UnsubscribeTestSetting,
} from "@/core/setting-types";
import {
  parseCapOverride,
  parseDomainCheckState,
  parsePauseState,
  parseRestoreState,
  parseTunnelState,
  parseUnsubscribeTest,
} from "@/core/system-state-parse";
import { STATE_KEYS, type ChecklistRow, type DomainCheckState, type PauseState } from "@/core/system-state";
import { realProviderSet } from "@/core/verification/policy";
import { logActivity } from "../activity";
import { db, dbTx, dbWrite } from "../db";
import { publicUrl } from "../env";
import { enqueueJob } from "../jobs";
import { isFakeMode } from "../mailgun/base-url";
import { getMailgunContext } from "../mailgun/context";
import { getSettings, setSetting, setSettingIn } from "../settings";
import { readTyped } from "../state-typed";
import { getWorkerStatus } from "../worker-status";
import { loadPlanLimits } from "./mailgun/plan";
import { loadTeamFrom } from "./mailgun/team-from";

/**
 * The reply test and the mode gates' inputs (PLAN A4.5, B6.5, B6.8, M3-DESIGN §1.5, §4.5.6, §4.5.7), including what the
 * go-live switch decides on (M6-DESIGN §2.4: the live test, the checklist's freshness, the background sender, and the
 * facts behind "Recommended first:").
 *
 * The facts come from rows the app writes anyway (TestSend, MailEvent, InboundMessage); the Owner's answers live in
 * Setting "mailgun.unsubscribeTest". A stored pass belongs to one sending domain: on any other domain it counts as
 * "not tested yet". Only the Owner's actions write the setting, so no save can overwrite the worker's.
 *
 * Shared From address (SHARED-FROM-DESIGN §3.4, F12, F25, F26): a stored pass also belongs to one From address
 * (`replyTestPassedFor`); the reply test and the live test count only evidence sent with today's From address after it
 * last changed; the test emails carry the team headers; a pasted original proves the return address; the go-live
 * inputs carry the From address, its misfit sentence, the spam placements and the checklist's freshness against the
 * last From change. With no From address ever saved, nothing here changes.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O13–O15, O21, O36, §3.4, §3.5; `loadTeamFrom().replies`): the gates use the
 * own-mailbox rows (no reply route, no public address needed, DMARC first), stored rows of the other mode are ignored,
 * evidence belongs to the own From (`evidenceFrom`: the reply test's emails, its pass, the live test with no Reply-To),
 * the reply test is by hand (no reply is looked for; the unsubscribe-by-email answer `mailtoArrived` is kept) and its
 * decision records the mode. App mode reads exactly today's fields.
 *
 * Own-mailbox review fixes: a reply-test or live-test report older than the logs the app can read (1 day on Free) is
 * named as gone, with "send again" (REPLIES-08: `MailboxFacts.reportGone`, the verdict's `unsubscribeGone`,
 * `GateInputs.liveTestReportGone`); an unreadable `mailto:` is stored as such (SECURITY-03); and `setLeaveOutMailto` is
 * the last resort when the mail provider can't catch Mailgun's `u+…@` address (REPLIES-03).
 */

/** A plain refusal of a reply-test action (shown as it is). */
export class ReplyTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyTestError";
  }
}

export type GateInputs = {
  now: Date;
  mode: "DRY_RUN" | "TEST" | "LIVE";
  goLive: boolean;
  practiceCopy: boolean;
  /** Mailgun connected (domain and a usable key saved); `connectionText` says why not. */
  connected: boolean;
  connectionText: string | null;
  fakeMode: boolean;
  domain: string | null;
  region: "EU" | "US";
  /** SystemState "domain.check" as the domain check (P4) last wrote it. */
  check: DomainCheckState;
  /** Its rows, only when they belong to the current domain (older rows mean "never checked"). */
  rows: ChecklistRow[];
  testList: string[];
  setting: UnsubscribeTestSetting;
  replyTestPassedOnDomain: boolean;
  owner: { id: number; name: string; email: string; inbox: string | null; senderDisplayName: string | null; signature: string } | null;
  ownerAddress: { id: number; address: string; routeStatus: string | null; routeError: string | null } | null;
  ownerRouteOk: boolean;
  publicUrl: string | null;
  publicAddressOk: boolean;
  pause: PauseState;
  /** Active teammates whose sending address has no working reply route. */
  sendersWithoutRoute: string[];
  // ── go live (M6-DESIGN §2.4) ──
  /** Setting "sending.goLiveAt" (ISO) and "sending.goLiveDomain": when and on which domain the Owner last went live. */
  goLiveAt: string | null;
  goLiveDomain: string | null;
  /**
   * The Domain checklist was checked for the current domain within the last hour, without an error, and not before
   * the Owner last changed the Cloudflare Access choice (so the remote-access row reflects it).
   */
  checkFresh: boolean;
  /** The live test (§0.3): a SENT LIVE email on the current domain to a current test-list address, and whether Mailgun delivered it. */
  liveTest: "none" | "sent" | "delivered";
  /** The background sender's heartbeat is fresh (getWorkerStatus(now).running). */
  workerRunning: boolean;
  /** Setting "remoteAccess.accessOff" ("We don't use Cloudflare Access") and when that row last changed (null: never saved). */
  accessOff: boolean;
  accessOffChangedAt: Date | null;
  /** Setting "backups.secondFolder" (null when empty). */
  secondFolder: string | null;
  /** The newest app backup (a `Backup` row: Daily or Back up now), or null when there is none. */
  newestBackupAt: Date | null;
  /** A restore was resumed or acknowledged at least once (the practice restore of the going-live guide). */
  restoreDone: boolean;
  /** At least one address check with a Mailgun result exists (a count, no decryption). */
  checksTried: boolean;
  /** The app's folder (`process.cwd()`), for the app-folder recommendation. */
  appFolder: string;
  /** Today's hand-set limit (Setting "sending.capOverride" for today's cap day), which going live removes; else null. */
  capOverrideToday: number | null;
  // ── the shared From address (SHARED-FROM-DESIGN §3.3, §3.4) ──
  /** The shared From address when it is saved and fits the sending domain (loadTeamFrom().address); null = per-person. */
  teamFrom: string | null;
  /** What is saved in Setting "mailgun.fromAddress" (lowercase), even when it doesn't fit; null = nothing saved. */
  teamFromSaved: string | null;
  /** The saved From address doesn't fit the sending domain (loadTeamFrom().problem): test and live refuse with it. */
  teamFromProblem: string | null;
  /**
   * `loadTeamFrom().changedAt`: when the From address or the sending domain (its region too) last changed (null: never;
   * review SETTING-1). Evidence and checks from before it don't count.
   */
  teamFromChangedAt: Date | null;
  /** Shared-From mode: the current test-list mailboxes whose test email landed in spam, "Outlook.com (tess@outlook.com)". */
  spamPlacements: string[];
  /** The checklist is fresh by the hour rule but was checked before the From address or the sending domain last changed. */
  checkBeforeFromChange: boolean;
  /** Setting "sending.goLiveFrom": the shared From address at the last go-live (null: per-person, or never live). */
  goLiveFrom: string | null;
  // ── own-mailbox mode (MAIN-DOMAIN-DESIGN §3.4, §8 P4) ──
  /** How the app sends (`loadTeamFrom().replies`); "app" = per-person or shared-From mode. */
  replies: RepliesMode;
  /** Own-mailbox mode: the saved From when it fits (`loadTeamFrom().ownFrom`); else null. */
  ownFrom: string | null;
  /** The From this way of sending uses (`loadTeamFrom().evidenceFrom`: the shared From or the own From); null per-person. */
  evidenceFrom: string | null;
  /** A public address (APP_PUBLIC_URL) is set: in own-mailbox mode the webhooks and remote-access rows then count (O21). */
  publicAddressSet: boolean;
  /** The Mailgun plan limits in force (`loadPlanLimits()`), or null (app mode with no plan chosen). */
  planLimits: PlanLimits | null;
  /** The https-links row (of this domain and mode) is "ok"; otherwise own-mailbox going live needs the http-links tick. */
  httpsLinksOk: boolean;
  /**
   * Own-mailbox mode only (review REPLIES-08): the live test is "sent" and every email of it without a report was sent
   * before `reportsGoneBefore` (the days of Mailgun's logs the app can read, plus an hour), so its report can never
   * arrive: the go-live card says to send the live test again. Absent in app mode.
   */
  liveTestReportGone?: boolean;
};

/** Own-mailbox mode (MAIN-DOMAIN-DESIGN O1): read only from the gate's `replies` (absent in older test doubles = app). */
function ownMailboxOf(gate: Pick<GateInputs, "replies">): boolean {
  return gate.replies === "own-mailbox";
}

/** A checklist check older than this is too old to go live on (M6-DESIGN §2.4 blocker 1). */
export const GO_LIVE_CHECK_MAX_AGE_MS = 60 * 60_000;

/**
 * The go-live checklist's freshness (M6-DESIGN §2.4 blocker 1): checked for this domain, without an error, within the
 * last hour, and not before the Access choice last changed. SHARED-FROM-DESIGN §3.3: with `fromChangedAt`, also not
 * before the From address last changed. MAIN-DOMAIN-DESIGN O36: with `replies`, also checked for that way of sending
 * (`checkMatchesMode`; a check stored before the field counts as app mode).
 */
export function isCheckFresh(
  check: Pick<DomainCheckState, "domain" | "checkedAt" | "error" | "replies">,
  domain: string | null,
  accessOffChangedAt: Date | null,
  now: Date,
  fromChangedAt: Date | null = null,
  replies?: RepliesMode,
): boolean {
  if (!domain || check.domain !== domain || check.error) return false;
  if (replies !== undefined && !checkMatchesMode(check, replies)) return false;
  const at = check.checkedAt ? Date.parse(check.checkedAt) : Number.NaN;
  if (!Number.isFinite(at) || now.getTime() - at > GO_LIVE_CHECK_MAX_AGE_MS) return false;
  if (fromChangedAt !== null && at < fromChangedAt.getTime()) return false;
  return accessOffChangedAt === null || at >= accessOffChangedAt.getTime();
}

/**
 * The live test (M6-DESIGN §0.3, §2.4): "delivered" when a SENT LIVE email of a campaign on the current sending domain,
 * to an address on the current test list, has a `delivered` event and no permanent failure; "sent" when such emails
 * exist but none is delivered yet (or it bounced); "none" otherwise (dry runs and Mailgun's test mode never count, nor
 * another domain's campaigns or an address no longer on the list). Two indexed queries, the newest 20 emails.
 *
 * SHARED-FROM-DESIGN F26 (`opts`): only campaigns with today's From count — shared-From mode (`teamFrom` set): a
 * Reply-To and `fromAddress` = the shared address; per-person mode: no Reply-To — and, with `since` (the last From
 * change), only campaigns launched at or after it. Without `opts` (or with a per-person From that never changed) the
 * query is today's.
 *
 * MAIN-DOMAIN-DESIGN O15 (`opts.ownFrom` given, own-mailbox mode): only campaigns with no Reply-To and `fromAddress` =
 * the own From, launched at or after `since`; "none" while no own From fits (null).
 */
export async function loadLiveTest(
  domainId: number | null,
  testList: readonly string[],
  opts: { teamFrom?: string | null; since?: Date | null; ownFrom?: string | null } = {},
): Promise<"none" | "sent" | "delivered"> {
  return (await loadLiveTestFacts(domainId, testList, opts)).state;
}

/**
 * `loadLiveTest` with one more fact (review REPLIES-08): `newestUnreportedAt`, when the newest of those emails that has
 * neither a `delivered` nor a permanent `failed` event was sent (null when every one has a report, or there is none).
 */
export async function loadLiveTestFacts(
  domainId: number | null,
  testList: readonly string[],
  opts: { teamFrom?: string | null; since?: Date | null; ownFrom?: string | null } = {},
): Promise<{ state: "none" | "sent" | "delivered"; newestUnreportedAt: Date | null }> {
  const none = { state: "none" as const, newestUnreportedAt: null };
  if (domainId === null || testList.length === 0) return none;
  const own = opts.ownFrom !== undefined;
  const ownFrom = (opts.ownFrom ?? "").trim().toLowerCase() || null;
  if (own && ownFrom === null) return none;
  const teamFrom = (opts.teamFrom ?? "").trim().toLowerCase() || null;
  const since = opts.since ?? null;
  const campaign = own
    ? { sendingDomainId: domainId, replyTo: null, fromAddress: ownFrom!, ...(since ? { launchedAt: { gte: since } } : {}) }
    : teamFrom !== null || since !== null
      ? {
          sendingDomainId: domainId,
          replyTo: teamFrom ? { not: null } : null,
          ...(teamFrom ? { fromAddress: teamFrom } : {}),
          ...(since ? { launchedAt: { gte: since } } : {}),
        }
      : { sendingDomainId: domainId };
  const emails = await db.outboundEmail.findMany({
    where: { mode: "LIVE", status: "SENT", toNorm: { in: [...testList] }, campaign },
    orderBy: { id: "desc" },
    take: 20,
    select: { id: true, sentAt: true },
  });
  if (emails.length === 0) return none;
  const events = await db.mailEvent.findMany({
    where: {
      outboundEmailId: { in: emails.map((e) => e.id) },
      OR: [
        { type: "delivered", isTestMode: false },
        { type: "failed", severity: "permanent" },
      ],
    },
    select: { outboundEmailId: true, type: true },
  });
  const delivered = new Set<number>();
  const failed = new Set<number>();
  for (const e of events) {
    if (e.outboundEmailId === null) continue;
    (e.type === "delivered" ? delivered : failed).add(e.outboundEmailId);
  }
  let newestUnreportedAt: Date | null = null;
  for (const e of emails) {
    if (delivered.has(e.id) || failed.has(e.id) || !e.sentAt) continue;
    if (!newestUnreportedAt || e.sentAt > newestUnreportedAt) newestUnreportedAt = e.sentAt;
  }
  return { state: emails.some((e) => delivered.has(e.id) && !failed.has(e.id)) ? "delivered" : "sent", newestUnreportedAt };
}

function modeOf(v: unknown): "DRY_RUN" | "TEST" | "LIVE" {
  return v === "TEST" || v === "LIVE" ? v : "DRY_RUN";
}

/** The normalised test list (Setting "sending.testList"). */
export function normaliseTestList(v: unknown): string[] {
  const out: string[] = [];
  for (const a of Array.isArray(v) ? v : []) {
    const n = typeof a === "string" ? normalizeEmail(a) : null;
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Everything the mode gates, the reply test, the go-live switch and the settings pages decide on, read once. It calls
 * getMailgunContext (which decrypts keys and may write), so only the settings pages, their actions and goLive() use
 * it, never the dashboard (M6-DESIGN §0.2 rule 8).
 */
export async function loadGateInputs(now: Date = new Date()): Promise<GateInputs> {
  const s = await getSettings([
    "sending.mode",
    "sending.goLive",
    "sending.goLiveAt",
    "sending.goLiveDomain",
    "sending.goLiveFrom",
    "sending.testList",
    "sending.capOverride",
    "sending.capDayTimeZone",
    "practice.copy",
    "mailgun.domain",
    "mailgun.region",
    "mailgun.unsubscribeTest",
    "remoteAccess.accessOff",
    "backups.secondFolder",
    "mailgun.logRetentionDays",
  ] as const);
  const practiceCopy = s["practice.copy"] === true;
  const domain = (s["mailgun.domain"] ?? "").trim().toLowerCase() || null;
  const fakeMode = isFakeMode();

  let connected = false;
  let connectionText: string | null = null;
  try {
    const ctx = await getMailgunContext();
    connected = ctx.connected;
    connectionText = ctx.connected ? null : ctx.text;
  } catch (err) {
    connectionText = err instanceof Error ? err.message : "Mailgun isn't connected yet. Open Settings › Sending & Mailgun.";
  }

  // The From address and how the app sends (SHARED-FROM-DESIGN §3.3, F26; MAIN-DOMAIN-DESIGN O1): read through
  // loadTeamFrom, never raw.
  const team = await loadTeamFrom();
  const own = team.replies === "own-mailbox";
  const check = (await readTyped(STATE_KEYS.domainCheck, parseDomainCheckState)).value;
  // Rows of another domain, or (O36) of the other way of sending, mean "never checked".
  const rows = domain && check.domain === domain && checkMatchesMode(check, team.replies) ? check.rows : [];
  const setting = parseUnsubscribeTest(s["mailgun.unsubscribeTest"]);
  const pause = (await readTyped(STATE_KEYS.pause, parsePauseState)).value;
  const tunnel = (await readTyped(STATE_KEYS.tunnel, parseTunnelState)).value;

  const ownerRow = await db.user.findFirst({
    where: { role: "OWNER", active: true },
    orderBy: { id: "asc" },
    select: { id: true, name: true, email: true, replyInbox: true, senderDisplayName: true, signature: true },
  });
  const owner = ownerRow
    ? {
        id: ownerRow.id,
        name: ownerRow.name,
        email: ownerRow.email,
        inbox: normalizeEmail(ownerRow.replyInbox || ownerRow.email),
        senderDisplayName: ownerRow.senderDisplayName,
        signature: ownerRow.signature,
      }
    : null;

  const domainRow = domain ? await db.sendingDomain.findUnique({ where: { name: domain }, select: { id: true, active: true } }) : null;
  const current = domainRow
    ? await db.senderAddress.findMany({
        where: { domainId: domainRow.id, retiredAt: null, user: { active: true } },
        orderBy: { id: "desc" },
        select: { id: true, userId: true, address: true, routeStatus: true, routeError: true, user: { select: { name: true } } },
      })
    : [];
  const ownerCurrent = owner ? current.find((a) => a.userId === owner.id) : undefined;
  const ownerAddress = ownerCurrent
    ? { id: ownerCurrent.id, address: ownerCurrent.address, routeStatus: ownerCurrent.routeStatus, routeError: ownerCurrent.routeError }
    : null;
  const seen = new Set<number>();
  const sendersWithoutRoute: string[] = [];
  for (const a of current) {
    if (seen.has(a.userId)) continue;
    seen.add(a.userId);
    // Own-mailbox mode (O9): nobody needs a reply route.
    if (a.routeStatus !== "ok" && !own) sendersWithoutRoute.push(a.user.name);
  }

  const pub = publicUrl();
  const publicAddressOk = fakeMode
    ? publicAddressProblem(pub, true) === null
    : publicAddressProblem(pub, false) === null && tunnel.publicCheck?.ok === true;

  // Go live (M6-DESIGN §2.4): the switch's other inputs, each one cheap read.
  const testList = normaliseTestList(s["sending.testList"]);
  const accessRow = await db.setting.findUnique({ where: { key: "remoteAccess.accessOff" }, select: { updatedAt: true } });
  const accessOffChangedAt = accessRow?.updatedAt ?? null;
  const restore = (await readTyped(STATE_KEYS.restore, parseRestoreState)).value;
  const newestBackup = await db.backup.findFirst({
    where: { kind: { in: ["AUTO", "MANUAL"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true },
  });
  const checkRow = await db.verificationCheck.findFirst({
    where: { provider: { in: [...realProviderSet(fakeMode)] } },
    select: { id: true },
  });
  const override = parseCapOverride(s["sending.capOverride"]);
  const capDay = capDayOf(now, safeZone(s["sending.capDayTimeZone"]));
  const secondFolder = typeof s["backups.secondFolder"] === "string" ? s["backups.secondFolder"].trim() : "";

  const teamFrom = team.address;
  const fromChangedAt = team.changedAt;
  const freshByHour = isCheckFresh(check, domain, accessOffChangedAt, now, null, team.replies);
  const checkFresh = isCheckFresh(check, domain, accessOffChangedAt, now, fromChangedAt, team.replies);
  const goLiveFrom = typeof s["sending.goLiveFrom"] === "string" ? s["sending.goLiveFrom"].trim().toLowerCase() || null : null;
  // Evidence belongs to one way of sending (MAIN-DOMAIN-DESIGN O15): the own From in own-mailbox mode.
  const evidenceFrom = own ? team.ownFrom : teamFrom;
  const planLimits = await loadPlanLimits();
  const live = own
    ? await loadLiveTestFacts(domainRow?.id ?? null, testList, { since: fromChangedAt, ownFrom: team.ownFrom })
    : { state: await loadLiveTest(domainRow?.id ?? null, testList, { teamFrom, since: fromChangedAt }), newestUnreportedAt: null };
  // Review REPLIES-08 (own-mailbox mode, 1 day of logs on Free): a live test report that fell into a gap never arrives.
  const goneBefore = reportsGoneBefore(now, effectiveLogRetentionDays(s["mailgun.logRetentionDays"], planLimits));
  const liveTestReportGone = live.state === "sent" && live.newestUnreportedAt !== null && live.newestUnreportedAt < goneBefore;

  return {
    now,
    mode: modeOf(s["sending.mode"]),
    goLive: s["sending.goLive"] === true,
    practiceCopy,
    connected,
    connectionText,
    fakeMode,
    domain,
    region: s["mailgun.region"] === "US" ? "US" : "EU",
    check,
    rows,
    testList,
    setting,
    replyTestPassedOnDomain: own
      ? replyTestPassedFor(setting, domain, team.ownFrom, { ownMailbox: true })
      : replyTestPassedFor(setting, domain, teamFrom),
    owner,
    ownerAddress,
    ownerRouteOk: ownerAddress?.routeStatus === "ok",
    publicUrl: pub,
    publicAddressOk,
    pause,
    sendersWithoutRoute,
    goLiveAt: typeof s["sending.goLiveAt"] === "string" && s["sending.goLiveAt"] ? s["sending.goLiveAt"] : null,
    goLiveDomain: typeof s["sending.goLiveDomain"] === "string" && s["sending.goLiveDomain"] ? s["sending.goLiveDomain"].trim().toLowerCase() : null,
    checkFresh,
    liveTest: live.state,
    workerRunning: (await getWorkerStatus(now)).running,
    accessOff: s["remoteAccess.accessOff"] === true,
    accessOffChangedAt,
    secondFolder: secondFolder || null,
    newestBackupAt: newestBackup?.createdAt ?? null,
    restoreDone: (restore.resumedAt ?? null) !== null || restore.acknowledgedAt !== null,
    checksTried: checkRow !== null,
    appFolder: process.cwd(),
    capOverrideToday: override && override.capDay === capDay ? override.cap : null,
    teamFrom,
    teamFromSaved: team.saved,
    teamFromProblem: team.problem,
    teamFromChangedAt: fromChangedAt,
    spamPlacements: spamPlacementsOf(setting, testList, evidenceFrom),
    checkBeforeFromChange: freshByHour && !checkFresh,
    goLiveFrom,
    replies: team.replies,
    ownFrom: team.ownFrom,
    evidenceFrom,
    publicAddressSet: pub !== null,
    planLimits,
    httpsLinksOk: rows.find((r) => r.key === "https-links")?.status === "ok",
    ...(own ? { liveTestReportGone } : {}),
  };
}

/**
 * The reply test's spam placements (SHARED-FROM-DESIGN F12): in shared-From mode, the current test-list mailboxes whose
 * stored placement answer is No, as "Outlook.com (tess@outlook.com)". Empty in per-person mode.
 */
export function spamPlacementsOf(setting: UnsubscribeTestSetting, testList: readonly string[], teamFrom: string | null): string[] {
  if (!teamFrom) return [];
  const listed = new Set(testList.map((a) => a.trim().toLowerCase()));
  return setting.mailboxes
    .filter((m) => m.placementOk === false && listed.has(m.address.trim().toLowerCase()))
    .map((m) => `${providerLabel(providerOf(m.address))} (${m.address.trim().toLowerCase()})`);
}

/** "Add your sending address first in Settings › My profile." / "Add your reply address first …" (§3.6). */
export function ownerAddressMissingText(teamFrom: boolean): string {
  return `Add your ${senderAddressWords(teamFrom).lower} first in Settings › My profile.`;
}

/** Puts the saved From address's misfit sentence first (fail closed, §2.4); nothing in the practice copy. */
function withTeamFromProblem(gate: GateInputs, list: string[]): string[] {
  if (gate.practiceCopy || !gate.teamFromProblem) return list;
  return [gate.teamFromProblem, ...list.filter((t) => t !== gate.teamFromProblem)];
}

/**
 * What a mode needs before it can be chosen in Settings › Sending & Mailgun (§4.5.7). Empty = allowed. Own-mailbox mode
 * (MAIN-DOMAIN-DESIGN §3.4): Live mode's own-mailbox rows (no `mx`, the from-mx guard, no public address needed).
 */
export function modeBlockersFor(mode: "DRY_RUN" | "TEST" | "LIVE", gate: GateInputs): string[] {
  if (mode === "DRY_RUN") return [];
  if (mode === "TEST") return withTeamFromProblem(gate, testModeBlockers({ connected: gate.connected, practiceCopy: gate.practiceCopy }));
  const own = ownMailboxOf(gate);
  return withTeamFromProblem(
    gate,
    liveModeBlockers(gate.rows, {
      connected: gate.connected,
      practiceCopy: gate.practiceCopy,
      testListSize: gate.testList.length,
      teamFrom: gate.teamFrom !== null,
      ...(own ? { ownMailbox: true } : {}),
    }),
  );
}

/**
 * "Before going live:" (M6-DESIGN §2.4): what still stops the go-live switch. Empty = ready. Own-mailbox mode
 * (MAIN-DOMAIN-DESIGN O14, §3.4): the own-mailbox rows (webhooks and remote-access only with a public address), and
 * nobody needs a reply route.
 */
export function goLiveBlockersFor(gate: GateInputs): string[] {
  const own = ownMailboxOf(gate);
  const list = withTeamFromProblem(
    gate,
    goLiveBlockers(gate.rows, {
      replyTestPassed: gate.replyTestPassedOnDomain,
      paused: gate.pause.paused,
      practiceCopy: gate.practiceCopy,
      sendersWithoutRoute: own ? [] : gate.sendersWithoutRoute,
      connected: gate.connected,
      checkFresh: gate.checkFresh,
      setup: gate.setting.setup,
      liveTest: gate.liveTest,
      workerRunning: gate.workerRunning,
      teamFrom: gate.teamFrom !== null,
      checkBeforeFromChange: gate.checkBeforeFromChange,
      ...(own ? { ownMailbox: true, publicAddress: gate.publicAddressSet === true } : {}),
    }),
  );
  // Review REPLIES-08: waiting can't help once the live test's report is gone; say to send it again.
  return own && gate.liveTestReportGone === true ? list.map((t) => (t === MODE_GATE_TEXTS.liveTestSent ? OWN_MAILBOX_TEXTS.liveTestGone : t)) : list;
}

/**
 * "Recommended first:" (M6-DESIGN §2.4, G10): never blocking; nothing in the practice copy (it never goes live) or once
 * live. The app folder is checked against the Windows user's folders and OneDrive (`USERPROFILE`, `OneDrive`).
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.4): the own From stands for the From, and the plan's daily limit adds the
 * Free-plan lines.
 */
export function goLiveRecommendationsFor(gate: GateInputs, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  if (gate.practiceCopy || gate.goLive) return [];
  const own = ownMailboxOf(gate);
  return goLiveRecommendations({
    rows: gate.rows,
    checksTried: gate.checksTried,
    secondFolder: gate.secondFolder,
    newestBackupAt: gate.newestBackupAt,
    accessOff: gate.accessOff,
    riskyFolder: riskyAppFolder(gate.appFolder, { USERPROFILE: env.USERPROFILE, OneDrive: env.OneDrive }),
    restoreDone: gate.restoreDone,
    now: gate.now,
    teamFrom: own ? gate.evidenceFrom : gate.teamFrom,
    spamPlacements: gate.spamPlacements,
    ...(own ? { ownMailbox: true, planDailyLimit: gate.planLimits?.dailyLimit ?? null } : {}),
  });
}

/** Per-person mode's sentence (kept for existing callers); shared-From mode says "reply address" (ownerAddressMissingText). */
export const OWNER_ADDRESS_MISSING_TEXT = ownerAddressMissingText(false);

/**
 * §1.5 step 0: what the reply test needs before its emails may go out. Shared-From mode (SHARED-FROM-DESIGN §3.3): the
 * from-mx row too, and a saved From address that doesn't fit the sending domain comes first. Own-mailbox mode
 * (MAIN-DOMAIN-DESIGN O9, O38): no reply route and no public address, the DMARC row first, and a missing or misfit own
 * From first.
 */
export function replyTestBlockersFor(gate: GateInputs): string[] {
  const team = gate.teamFrom !== null;
  const own = ownMailboxOf(gate);
  const list = replyTestBlockers(gate.rows, {
    mode: gate.mode,
    connected: gate.connected,
    practiceCopy: gate.practiceCopy,
    testListSize: gate.testList.length,
    ownerRouteOk: gate.ownerRouteOk,
    publicAddressOk: gate.publicAddressOk,
    setup: gate.setting.setup,
    teamFrom: team,
    ...(own ? { ownMailbox: true } : {}),
  });
  // Without a sending (reply) address there is no route to fix: say what to do first.
  const missing = ownerAddressMissingText(team);
  return withTeamFromProblem(gate, gate.ownerAddress ? list : list.map((t) => (t === MODE_GATE_TEXTS.ownerRoute ? missing : t)));
}

// ───────────────────────── test sends left SENDING ─────────────────────────

export const STALE_TEST_SEND_MS = 2 * 60_000;
export const TEST_SEND_UNKNOWN_TEXT = "Mailgun didn't answer in time, so the test may or may not arrive.";

/**
 * TestSend rows still SENDING after 2 minutes (the web process stopped mid-send) become UNKNOWN; a later Mailgun event
 * for them turns them SENT (§4.4.2). One cheap update, run by the reply-test page load.
 */
export async function markStaleTestSends(now: Date = new Date()): Promise<number> {
  const res = await dbWrite((c) =>
    c.testSend.updateMany({
      where: { status: "SENDING", sentAt: { lt: new Date(now.getTime() - STALE_TEST_SEND_MS) } },
      data: { status: "UNKNOWN", error: TEST_SEND_UNKNOWN_TEXT },
    }),
  );
  return res.count;
}

// ───────────────────────── the reply test ─────────────────────────

export type ReplyTestData = {
  setting: UnsubscribeTestSetting;
  currentDomain: string | null;
  /** Per current test-list address. */
  facts: Map<string, MailboxFacts>;
  unsubscribeSeen: boolean;
  verdict: ReplyTestVerdict;
  blockers: string[];
  ownerAddress: string | null;
  testList: string[];
  /**
   * The stored decision, only when it belongs to the current domain and (SHARED-FROM-DESIGN F12) the current From
   * address (else the page shows "Not tested yet").
   */
  decided: { status: "passed" | "failed"; at: string | null; byUserId: number | null } | null;
  gate: GateInputs;
  /** The shared From address the test runs with (gate.teamFrom); null = per-person mode. */
  teamFrom: string | null;
  /** Shared-From mode: the stored pasted original, when it belongs to today's domain and From and one of the counted emails. */
  original: ReplyTestOriginal | null;
  /** The ids of the reply-test emails that count (F26: today's From, sent since the last From change). */
  countedTestSendIds: number[];
  /** MAIN-DOMAIN-DESIGN O13: the by-hand reply test of own-mailbox mode (gate.replies). */
  ownMailbox: boolean;
  /** MAIN-DOMAIN-DESIGN O15: the From the test runs with (the shared From, or the own From); null per-person. */
  evidenceFrom: string | null;
};

/** Whether a reply-test TestSend counts as evidence for today's From address (SHARED-FROM-DESIGN F26). */
function countsForToday(row: { teamFrom: string | null; sentAt: Date }, teamFrom: string | null, since: Date | null): boolean {
  const rowFrom = (row.teamFrom ?? "").trim().toLowerCase() || null;
  return rowFrom === teamFrom && (since === null || row.sentAt.getTime() >= since.getTime());
}

/**
 * Everything the Reply test section shows: per mailbox the latest reply-test email on the current domain (TestSend
 * whose Message-ID ends with "@<domain>"), whether Mailgun delivered it, whether a reply from that mailbox to the
 * Owner's sending address arrived after it was sent; whether Mailgun reported a real unsubscribe from one of these
 * reply-test emails after the first test; the live verdict and what still blocks sending the test. Pass `preloaded` gate inputs when the caller
 * already has them (the Domain checklist page).
 *
 * SHARED-FROM-DESIGN F26: only reply-test emails sent with today's From address (`TestSend.teamFrom`, null = per-person)
 * and at or after the From address last changed count, and their unsubscribes; a mailbox whose only emails don't count
 * shows `olderSent`. In shared-From mode a reply counts only when its thread names one of those emails (REPLIES-01).
 * The verdict runs in shared-From mode when a From address is saved and fits.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O13, O15): the emails of today's own From count (`evidenceFrom`); no reply is
 * looked for (replies land in the own mailbox, never the app); the verdict is the by-hand one; a stored decision shows
 * only when it was decided in this mode.
 */
export async function loadReplyTest(now: Date = new Date(), preloaded?: GateInputs): Promise<ReplyTestData> {
  await markStaleTestSends(now);
  const gate = preloaded ?? (await loadGateInputs(now));
  const { testList, domain } = gate;
  const own = ownMailboxOf(gate);
  // The From today's evidence belongs to (O15): the shared From in app mode (null per-person), the own From here.
  const evidence = own ? (gate.evidenceFrom ?? null) : gate.teamFrom;
  const ownerAddress = gate.ownerAddress?.address ?? null;
  const facts = new Map<string, MailboxFacts>();
  for (const a of testList) facts.set(a, { testSendId: null, sentAt: null, delivered: false, replyStored: false, status: null, error: null });

  let unsubscribeSeen = false;
  let unsubscribeGone = false;
  let countedTestSendIds: number[] = [];
  // Review REPLIES-08 (own-mailbox mode: 1 day of logs on Free): Mailgun's reports from before this are gone for good.
  const goneBefore = own
    ? reportsGoneBefore(now, effectiveLogRetentionDays((await getSettings(["mailgun.logRetentionDays"] as const))["mailgun.logRetentionDays"], gate.planLimits))
    : null;
  if (domain && testList.length > 0) {
    const all = await db.testSend.findMany({
      where: { purpose: "REPLY_TEST", to: { in: testList }, messageId: { endsWith: `@${domain}` } },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      select: { id: true, to: true, sentAt: true, status: true, error: true, teamFrom: true, messageId: true, providerId: true },
    });
    const sends = all.filter((row) => countsForToday(row, evidence, gate.teamFromChangedAt));
    countedTestSendIds = sends.map((s) => s.id);
    for (const row of all) {
      if (countsForToday(row, evidence, gate.teamFromChangedAt) || sends.some((s) => s.to === row.to)) continue;
      const f = facts.get(row.to);
      if (f) f.olderSent = true;
    }
    const latest = new Map<string, (typeof sends)[number]>();
    for (const row of sends) {
      const prev = latest.get(row.to);
      if (!prev || (prev.status === "FAILED" && row.status !== "FAILED")) latest.set(row.to, row);
    }
    const ids = [...latest.values()].map((r) => r.id);
    const delivered = new Set(
      (
        await db.mailEvent.findMany({ where: { testSendId: { in: ids }, type: "delivered" }, select: { testSendId: true } })
      ).map((e) => e.testSendId),
    );
    // Own-mailbox mode (O13): replies land in the own mailbox, never the app; the Owner answers for them.
    const replies = ownerAddress && !own
      ? await db.inboundMessage.findMany({
          where: { fromEmail: { in: testList }, toAddress: ownerAddress },
          select: { fromEmail: true, receivedAt: true, inReplyTo: true, references: true },
        })
      : [];
    // Shared-From mode (REPLIES-01, F26): a reply counts only when it answers one of this mailbox's emails that count
    // (its In-Reply-To or References names that email's Message-ID, or the id Mailgun gave it). The Owner's own address
    // is both the old per-person From and today's Reply-To, so a reply to an older email would otherwise count too.
    // Per-person mode keeps the time rule alone, as before.
    const answersCounted = (address: string, reply: (typeof replies)[number]): boolean => {
      if (gate.teamFrom === null) return true;
      const ids = new Set<string>();
      for (const s of sends) {
        if (s.to !== address) continue;
        if (s.messageId) ids.add(s.messageId.toLowerCase());
        if (s.providerId) ids.add(s.providerId.toLowerCase());
      }
      return threadIds({ inReplyTo: reply.inReplyTo, references: reply.references }).some((id) => ids.has(id));
    };
    for (const [address, row] of latest) {
      const isDelivered = delivered.has(row.id);
      // Review REPLIES-08: not delivered and sent before the logs the app can still read → its report never arrives.
      const reportGone = goneBefore !== null && !isDelivered && row.status !== "FAILED" && row.sentAt.getTime() < goneBefore.getTime();
      facts.set(address, {
        testSendId: row.id,
        sentAt: row.sentAt,
        delivered: isDelivered,
        replyStored: replies.some(
          (r) => r.fromEmail === address && r.receivedAt.getTime() >= row.sentAt.getTime() && answersCounted(address, r),
        ),
        status: row.status,
        error: row.error,
        ...(reportGone ? { reportGone: true } : {}),
      });
    }
    const earliest = [...latest.values()].reduce<Date | null>((min, r) => (!min || r.sentAt < min ? r.sentAt : min), null);
    if (earliest) {
      // Only a real click on a reply-test email of this domain proves that Mailgun's unsubscribe link works here: events
      // matched to one of these TestSend rows, reported by Mailgun (webhook or Logs, never a dry run's Simulate, never
      // test mode), after the test was sent. Unsubscribes of campaign emails or of an older domain don't count.
      unsubscribeSeen =
        (await db.mailEvent.count({
          where: {
            type: "unsubscribed",
            testSendId: { in: sends.map((s) => s.id) },
            source: { in: ["WEBHOOK", "LOGS"] },
            isTestMode: false,
            occurredAt: { gte: earliest },
          },
        })) > 0;
      // Review REPLIES-08: Mailgun's unsubscribes list brought a click on a test mailbox (no Message-ID, so it never
      // links to a test email) from before the logs the app can still read: its own report is gone for good.
      if (!unsubscribeSeen && goneBefore !== null) {
        const listed = await db.mailEvent.findFirst({
          where: {
            type: "unsubscribed",
            testSendId: null,
            dedupeKey: { startsWith: "sup:unsubscribes:" },
            recipient: { in: testList },
            occurredAt: { gte: earliest, lt: goneBefore },
          },
          select: { id: true },
        });
        unsubscribeGone = listed !== null;
      }
    }
  }

  const teamFrom = gate.teamFrom;
  const onDomain = domain !== null && gate.setting.domain === domain;
  const sameFrom = ((gate.setting.from ?? "").trim().toLowerCase() || null) === evidence;
  // A decision belongs to the way of sending it was made in (O13): an own-mailbox pass never shows in app mode.
  const sameMode = (gate.setting.replies === "own-mailbox") === own;
  const decided =
    onDomain && sameFrom && sameMode && gate.setting.status !== "untested"
      ? { status: gate.setting.status, at: gate.setting.decidedAt, byUserId: gate.setting.decidedById }
      : null;
  // The pasted original counts only for today's domain and From, and only while its email is one that counts (F26).
  const stored = evidence ? currentOriginal(gate.setting, domain, evidence) : null;
  const original = stored && countedTestSendIds.includes(stored.testSendId) ? stored : null;
  const forVerdict: UnsubscribeTestSetting = evidence ? { ...gate.setting, original } : gate.setting;
  const verdict = gate.teamFromProblem
    ? { status: "incomplete" as const, missing: [gate.teamFromProblem] }
    : own
      ? evaluateReplyTest(forVerdict, facts, unsubscribeSeen, { teamFrom: evidence, sendingDomain: domain, ownMailbox: true, unsubscribeGone })
      : teamFrom
        ? evaluateReplyTest(forVerdict, facts, unsubscribeSeen, { teamFrom, sendingDomain: domain })
        : evaluateReplyTest(gate.setting, facts, unsubscribeSeen);
  return {
    setting: gate.setting,
    currentDomain: domain,
    facts,
    unsubscribeSeen,
    verdict,
    blockers: replyTestBlockersFor(gate),
    ownerAddress,
    testList,
    decided,
    gate,
    teamFrom,
    original,
    countedTestSendIds,
    ownMailbox: own,
    evidenceFrom: evidence,
  };
}

export type { ReplyTestAnswersInput, ReplyTestRound } from "@/core/reply-test";

/**
 * Saves the Owner's answers for the current test-list mailboxes (answers for other addresses are dropped;
 * `mergeReplyTestAnswers`). A field that is absent keeps its saved answer: the page sends only the answer that changed,
 * so a save never overwrites another mailbox's answers with what an older page held (REPLIES-03). Pasted headers are
 * read with parseAuthResults and set "dkim/arc pass?" when they say pass or fail; the pasted text itself is never
 * stored. Doesn't change the stored result (decideReplyTest does).
 *
 * Shared-From mode (SHARED-FROM-DESIGN §3.4): the placement and DMARC answers are saved when given (left as they were
 * when absent); a pasted original for the DMARC question is read with parseDmarcResult for the From domain and sets the
 * answer when it says pass or fail (`dmarcFromHeaders`), never stored. A DMARC answer read from a pasted original is
 * changed only by a click on a page that showed it (SECURITY-1), and answers given for another round (`input.round`:
 * another From address, sending domain or setup) are refused (REPLIES-03). Both refuse with a ReplyTestError and
 * write nothing. The pasted texts are read before the transaction, which re-reads the setting and the From address, so
 * a pasted original stored meanwhile ("Read the original") is never overwritten. Per-person answers keep exactly
 * today's shape.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.5): the round and the DMARC pastes belong to the own From (`evidenceFrom`),
 * and the unsubscribe-by-email answer (`input.mailtoArrived`) is kept; in app mode it is ignored.
 */
export async function saveReplyTestAnswers(
  actor: { id: number; name: string },
  input: ReplyTestAnswersInput,
): Promise<{ authFromHeaders: Record<string, "pass" | "fail" | null>; dmarcFromHeaders: Record<string, "pass" | "fail" | null> }> {
  const before = await loadTeamFrom();
  const fromDomain = teamFromDomainOf(before.evidenceFrom);
  const reads = readReplyTestPastes(input, fromDomain);
  return dbTx(async (tx) => {
    const team = await loadTeamFrom(tx);
    const own = team.replies === "own-mailbox";
    const rows = await tx.setting.findMany({
      where: { key: { in: ["sending.testList", "mailgun.unsubscribeTest"] } },
      select: { key: true, value: true },
    });
    const setting = parseUnsubscribeTest(rows.find((r) => r.key === "mailgun.unsubscribeTest")?.value ?? null);
    const testList = normaliseTestList(rows.find((r) => r.key === "sending.testList")?.value);
    const since = team.changedAt?.toISOString() ?? null;
    if (replyTestRoundChanged(input.round, { domain: team.domain, from: team.evidenceFrom, setup: setting.setup, since })) {
      throw new ReplyTestError(REPLY_TEST_TEXTS.roundChanged);
    }
    // The way of sending changed since the pastes were read (MAIN-DOMAIN-DESIGN O2): another round.
    if (team.replies !== before.replies) throw new ReplyTestError(REPLY_TEST_TEXTS.roundChanged);
    // A DMARC paste was read for the From domain of a moment ago: refuse rather than store it for another one.
    if (reads.dmarc.size > 0 && teamFromDomainOf(team.evidenceFrom) !== fromDomain) throw new ReplyTestError(REPLY_TEST_TEXTS.roundChanged);
    const { mailtoArrived, ...rest } = input;
    const merged = mergeReplyTestAnswers(setting, testList, own && mailtoArrived !== undefined ? { ...rest, mailtoArrived } : rest, reads);
    if (!merged.ok) throw new ReplyTestError(merged.error);
    await setSettingIn(tx, "mailgun.unsubscribeTest", merged.setting, actor.id);
    return { authFromHeaders: merged.authFromHeaders, dmarcFromHeaders: merged.dmarcFromHeaders };
  });
}

/**
 * Shared-From mode (SHARED-FROM-DESIGN F25): reads one pasted original of a reply-test email with parseTestOriginal and
 * stores what it read (never the text) as `mailgun.unsubscribeTest.original`, with today's domain and From address, and
 * sets that mailbox's DMARC answer from it. Refused (ReplyTestError) without a shared From address, when its Message-ID
 * isn't one of the reply-test emails that count (F26: today's From, sent since the last change; `address`, when given,
 * must be that email's mailbox), or when it shows another From address. One transaction re-reads the setting and checks
 * the From address and domain are still what the paste was checked against.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.5, O13): the same with the own From (`evidenceFrom`), whose domain is the
 * sending domain; the stored original also keeps the unsubscribe link's scheme and the whole `mailto:` address, and a
 * new `mailto:` address clears the unsubscribe-by-email answer. `ownMailbox` says which lines to show.
 */
export async function saveReplyTestOriginal(
  actor: { id: number; name: string },
  input: { pasted: string; address?: string | null },
  now: Date = new Date(),
): Promise<{ original: ReplyTestOriginal; parsed: ParsedTestOriginal; ownMailbox: boolean }> {
  const team = await loadTeamFrom();
  if (team.problem) throw new ReplyTestError(team.problem);
  const own = team.replies === "own-mailbox";
  const teamFrom = team.evidenceFrom;
  const domain = team.domain;
  if (!teamFrom || !domain) {
    throw new ReplyTestError("The pasted original is only needed with a From address (Settings › Sending & Mailgun).");
  }
  const org = own ? domain : (teamFromDomainOf(teamFrom) ?? "");
  const parsed = parseTestOriginal(input.pasted ?? "", { sendingDomain: domain, fromDomain: org });
  const notCurrent = REPLY_TEST_TEXTS.notCurrentOriginal(teamFrom);
  if (!parsed.messageId) throw new ReplyTestError(notCurrent);
  const testList = normaliseTestList((await getSettings(["sending.testList"] as const))["sending.testList"]);
  const send = await db.testSend.findUnique({
    where: { messageId: parsed.messageId },
    select: { id: true, to: true, purpose: true, teamFrom: true, sentAt: true },
  });
  const wanted = normalizeEmail(input.address ?? "") ?? null;
  if (
    !send ||
    send.purpose !== "REPLY_TEST" ||
    !parsed.messageId.endsWith(`@${domain}`) ||
    !testList.includes(send.to) ||
    !countsForToday(send, teamFrom, team.changedAt) ||
    (wanted !== null && wanted !== send.to)
  ) {
    throw new ReplyTestError(notCurrent);
  }
  if (parsed.from !== teamFrom) throw new ReplyTestError(REPLY_TEST_TEXTS.originalFromWrong(parsed.from ?? "no address", teamFrom));

  const original: ReplyTestOriginal = {
    domain,
    from: teamFrom,
    address: send.to,
    testSendId: send.id,
    returnPathDomain: parsed.returnPathDomain,
    returnPathOk: parsed.returnPathOk,
    dmarc: parsed.dmarc,
    dkimSigner: parsed.dkimSigner,
    mailtoDomain: parsed.mailtoDomain,
    mailtoOk: parsed.mailtoOk,
    readAt: now.toISOString(),
    // Own-mailbox mode only (§3.5, O13): app mode keeps today's stored shape. A mailto: whose address couldn't be read
    // is kept as a flag, so the test fails closed instead of reading "not offered" (review SECURITY-03).
    ...(own ? { unsubscribeScheme: parsed.unsubscribeScheme, mailtoAddress: parsed.mailtoAddress } : {}),
    ...(own && parsed.mailtoUnreadable === true ? { mailtoUnreadable: true } : {}),
  };
  await dbTx(async (tx) => {
    const again = await loadTeamFrom(tx);
    if (again.saved !== team.saved || again.domain !== domain || again.replies !== team.replies) {
      throw new ReplyTestError(REPLY_TEST_TEXTS.changedWhileDeciding);
    }
    const row = await tx.setting.findUnique({ where: { key: "mailgun.unsubscribeTest" }, select: { value: true } });
    const setting = parseUnsubscribeTest(row?.value ?? null);
    const mailboxes = [...setting.mailboxes];
    if (parsed.dmarc) {
      const at = mailboxes.findIndex((m) => m.address.trim().toLowerCase() === send.to);
      const base: ReplyTestMailbox =
        at >= 0 ? mailboxes[at]! : { address: send.to, provider: providerOf(send.to), inboxOk: null, authOk: null, authFromHeaders: false };
      const updated: ReplyTestMailbox = { ...base, dmarcOk: parsed.dmarc, dmarcFromHeaders: true };
      if (at >= 0) mailboxes[at] = updated;
      else mailboxes.push(updated);
    }
    const next: UnsubscribeTestSetting = { ...setting, mailboxes, original };
    // A new unsubscribe-by-email address needs a new answer (O13): the old one was about another address.
    if (own && (setting.original?.mailtoAddress ?? null) !== (original.mailtoAddress ?? null)) next.mailtoArrived = null;
    await setSettingIn(tx, "mailgun.unsubscribeTest", next, actor.id);
  });
  return { original, parsed, ownMailbox: own };
}

/**
 * What a verdict is computed from in the setting (the answers, the setup, the pasted original and, in own-mailbox mode,
 * the unsubscribe-by-email answer), for a compare.
 */
function answersOf(s: UnsubscribeTestSetting): string {
  return JSON.stringify([s.setup, s.mailboxes, s.headersOk, s.original ?? null, s.mailtoArrived ?? null, s.leaveOutMailto === true]);
}

/**
 * "Save the result": stores passed or failed (never "incomplete") with the setup letter, the current sending domain,
 * who and when, and logs `replyTest.decided`. Returns the verdict either way.
 *
 * SHARED-FROM-DESIGN §3.4: also stores the From address the verdict belongs to (`from`, null = per-person) and is a
 * compare-and-set: its transaction re-reads "mailgun.fromAddress" and "mailgun.domain" and refuses (ReplyTestError,
 * nothing written) when either differs from what the verdict was computed with. It also refuses when the page decided
 * for another round (`opts.round`, REPLIES-03) and when the stored answers changed after the verdict read them (so a
 * pasted original stored meanwhile is never overwritten with the older answers).
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O13, O15): `from` is the own From and the decision records `replies:
 * "own-mailbox"` (a decision made in app mode drops it); the compare-and-set also re-reads the way of sending; the
 * activity's data names the mode.
 */
export async function decideReplyTest(
  actor: { id: number; name: string },
  now: Date = new Date(),
  opts: { round?: ReplyTestRound | null } = {},
): Promise<ReplyTestVerdict> {
  const data = await loadReplyTest(now);
  const own = data.ownMailbox;
  const since = data.gate.teamFromChangedAt?.toISOString() ?? null;
  if (replyTestRoundChanged(opts.round, { domain: data.currentDomain, from: data.evidenceFrom, setup: data.setting.setup, since })) {
    throw new ReplyTestError(REPLY_TEST_TEXTS.roundChanged);
  }
  const verdict = data.verdict;
  if (verdict.status === "incomplete" || !data.currentDomain) return verdict;
  const domain = data.currentDomain;
  const teamFrom = data.evidenceFrom;
  const { replies: _decidedIn, ...setting } = data.setting;
  const next: UnsubscribeTestSetting = {
    ...setting,
    status: verdict.status,
    domain,
    from: teamFrom,
    decidedAt: now.toISOString(),
    decidedById: actor.id,
    note: verdict.status === "failed" ? verdict.missing.join(" ").slice(0, 1000) : null,
    ...(own ? { replies: "own-mailbox" as const } : {}),
  };
  await dbTx(async (tx) => {
    const again = await loadTeamFrom(tx);
    if (again.saved !== data.gate.teamFromSaved || again.domain !== domain || again.replies !== (own ? "own-mailbox" : "app")) {
      throw new ReplyTestError(REPLY_TEST_TEXTS.changedWhileDeciding);
    }
    const row = await tx.setting.findUnique({ where: { key: "mailgun.unsubscribeTest" }, select: { value: true } });
    if (answersOf(parseUnsubscribeTest(row?.value ?? null)) !== answersOf(data.setting)) {
      throw new ReplyTestError(REPLY_TEST_TEXTS.answersChangedWhileDeciding);
    }
    await setSettingIn(tx, "mailgun.unsubscribeTest", next, actor.id);
    await logActivity(
      {
        actorId: actor.id,
        type: "replyTest.decided",
        summary: `${actor.name} saved the reply test result: Setup ${next.setup} ${verdict.status} on ${domain}${
          teamFrom ? ` with the From address ${teamFrom}` : ""
        }`,
        data: { setup: next.setup, status: verdict.status, domain, from: teamFrom, ...(own ? { replies: "own-mailbox" } : {}) },
      },
      tx,
    );
  });
  return verdict;
}

/**
 * "Try Setup B (check only)" / "Back to Setup A": starts the reply test again with the other setup (answers and result
 * cleared) and queues "Apply recommended settings", which switches Mailgun's unsubscribe handling accordingly.
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.5): only Setup A exists there; a switch to B is refused
 * (`OWN_MAILBOX_TEXTS.setupAOnly`, ReplyTestError) and **Back to normal** switches a restored Setup B back to A.
 */
export async function switchUnsubscribeSetup(actor: { id: number; name: string }, setup: "A" | "B"): Promise<void> {
  if (setup === "B" && (await loadTeamFrom()).replies === "own-mailbox") throw new ReplyTestError(OWN_MAILBOX_TEXTS.setupAOnly);
  const next: UnsubscribeTestSetting = { ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes: [], setup };
  await setSetting("mailgun.unsubscribeTest", next, actor.id);
  await logActivity({
    actorId: actor.id,
    type: "settings.updated",
    summary:
      setup === "B"
        ? `${actor.name} switched the reply test to Setup B (check only)`
        : `${actor.name} switched the reply test back to Setup A`,
    data: { key: "mailgun.unsubscribeTest.setup", to: setup },
  });
  const domain = await getSettings(["mailgun.domain", "practice.copy"] as const);
  if (domain["mailgun.domain"] && !domain["practice.copy"]) {
    await enqueueJob({
      type: "mailgun.applySettings",
      payload: { step: "all" },
      dedupeKey: "mailgun:apply",
      priority: 30,
      maxAttempts: 1,
      createdById: actor.id,
    });
  }
}

/**
 * Own-mailbox mode's last resort (review REPLIES-03): "Leave out unsubscribe by email" (`leaveOut` true) or "Offer
 * unsubscribe by email again" (false), for a mail provider that can't catch Mailgun's `u+…@` address. Stores Setting
 * "mailgun.unsubscribeTest"'s `leaveOutMailto` (only when true), which `MailgunClient.sendMessage` reads before every
 * own-mailbox send (the app's own List-Unsubscribe with only Mailgun's link, `WEB_ONLY_LIST_UNSUBSCRIBE`), and starts the
 * proof again: the stored result, the pasted original, the List-Unsubscribe answer and the unsubscribe-by-email answer
 * are cleared, so no pass made with the other header counts (fail closed; the mailbox answers stay). Refused outside
 * own-mailbox mode, for another round, and while a test or live campaign is scheduled, running or paused (its emails
 * would unsubscribe two ways). One transaction; logs `settings.updated`. Nothing to change: nothing written.
 */
export async function setLeaveOutMailto(
  actor: { id: number; name: string },
  input: { leaveOut: boolean; round?: ReplyTestRound | null },
): Promise<{ changed: boolean }> {
  return dbTx(async (tx) => {
    const team = await loadTeamFrom(tx);
    if (team.replies !== "own-mailbox") throw new ReplyTestError(OWN_REPLY_TEST_TEXTS.leaveOutNotOwn);
    const row = await tx.setting.findUnique({ where: { key: "mailgun.unsubscribeTest" }, select: { value: true } });
    const setting = parseUnsubscribeTest(row?.value ?? null);
    const since = team.changedAt?.toISOString() ?? null;
    if (replyTestRoundChanged(input.round, { domain: team.domain, from: team.evidenceFrom, setup: setting.setup, since })) {
      throw new ReplyTestError(REPLY_TEST_TEXTS.roundChanged);
    }
    if ((setting.leaveOutMailto === true) === input.leaveOut) return { changed: false };
    const busy = await tx.campaign.findMany({
      where: { mode: { in: ["TEST", "LIVE"] }, status: { in: ["SCHEDULED", "RUNNING", "PAUSED"] } },
      select: { name: true },
      orderBy: { id: "asc" },
      take: 20,
    });
    if (busy.length > 0) throw new ReplyTestError(OWN_REPLY_TEST_TEXTS.leaveOutBusy(busy.map((c) => c.name).join(", ")));
    const { leaveOutMailto: _before, ...rest } = setting;
    const next: UnsubscribeTestSetting = {
      ...rest,
      status: "untested",
      decidedAt: null,
      decidedById: null,
      note: null,
      headersOk: null,
      original: null,
      mailtoArrived: null,
      ...(input.leaveOut ? { leaveOutMailto: true } : {}),
    };
    await setSettingIn(tx, "mailgun.unsubscribeTest", next, actor.id);
    await logActivity(
      {
        actorId: actor.id,
        type: "settings.updated",
        summary: OWN_REPLY_TEST_TEXTS.leaveOutActivity(actor.name, input.leaveOut),
        data: { key: "mailgun.unsubscribeTest.leaveOutMailto", to: input.leaveOut },
      },
      tx,
    );
    return { changed: true };
  });
}

// ───────────────────────── the test list ─────────────────────────

/**
 * Setting "sending.testList" (§2.1, Settings › Sending & Mailgun): validated with validateTestList against every
 * sending domain and the team's reply inboxes; logs `sending.testList`. Returns the saved list and any warnings.
 * SHARED-FROM-DESIGN F15: the saved shared From address can't be a test mailbox (even when it no longer fits).
 */
export async function saveTestList(
  actor: { id: number; name: string },
  addresses: readonly string[],
): Promise<{ ok: true; value: string[]; warnings: string[] } | { ok: false; error: string }> {
  const s = await getSettings(["mailgun.domain", "sending.testList"] as const);
  const domains = new Set((await db.sendingDomain.findMany({ select: { name: true } })).map((d) => d.name));
  if (s["mailgun.domain"]) domains.add(s["mailgun.domain"].toLowerCase());
  const mates = await db.user.findMany({ where: { active: true }, select: { name: true, email: true, replyInbox: true } });
  const team = await loadTeamFrom();
  const res = validateTestList(addresses, {
    sendingDomains: [...domains],
    teammateInboxes: mates.map((u) => ({ name: u.name, inbox: (u.replyInbox || u.email).toLowerCase() })),
    teamFrom: team.saved,
  });
  if (!res.ok) return res;
  const before = normaliseTestList(s["sending.testList"]);
  const same = before.length === res.value.length && before.every((a, i) => a === res.value[i]);
  if (!same) {
    await setSetting("sending.testList", res.value, actor.id);
    await logActivity({
      actorId: actor.id,
      type: "sending.testList",
      summary: `${actor.name} changed the test list (${res.value.length} address${res.value.length === 1 ? "" : "es"})`,
      data: { added: res.value.filter((a) => !before.includes(a)), removed: before.filter((a) => !res.value.includes(a)) },
    });
  }
  return res;
}
