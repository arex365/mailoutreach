import type { CampaignRecipient, Prisma, SendMode } from "@/generated/prisma/client";
import { db, dbTx, type Tx } from "@/server/db";
import { logActivity } from "@/server/activity";
import { createNotification } from "@/server/notifications";
import { SETTING_DEFAULTS, getSetting, getSettings } from "@/server/settings";
import { readTyped } from "@/server/state-typed";
import type { MailgunContextResult } from "@/server/mailgun/context";
import { loadTeamFrom, type TeamFromState } from "@/server/services/mailgun/team-from";
import { evaluateCompanies, loadEligibilitySettings, type CompanyEligibility, type PersonEligibility } from "@/server/services/eligibility";
import { releaseDraftReservations, takeReservations, type ReservationHolder } from "@/server/services/reservations";
import { messageIdDomainOf, newMessageId, newSendId, senderSnapshot, type OwnMailboxSnapshot } from "@/server/services/sending/addresses";
import { safeMailgunContext } from "@/server/services/sending/gates";
import { applyPendingPossibleReplyHolds } from "@/server/services/sequences/holds";
import { activeCampaignCheckRun, readVerifyRunPayload } from "@/server/services/verification/runs";
import { normalizeEmail } from "@/core/email-address";
import {
  isNeedsCheckCode,
  readRecipientOverrides,
  type EligibilityCode,
  type EligibilityReason,
  type RecipientFacts,
} from "@/core/rules/eligibility";
import { UNKNOWN_RECHECK_AFTER_MS } from "@/core/verification/types";
import { countsAsEmailed } from "@/core/rules/mode";
import { stepTitle } from "@/core/rules/wording";
import { replyTestPassedFor } from "@/core/reply-test";
import { checkMatchesMode } from "@/core/dns/check-state";
import { LAUNCH_SETTINGS_CHANGED_TEXT, senderAddressWords } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS, repliesOf, type RepliesMode } from "@/core/sending/own-mailbox";
import { liveLaunchBlockers, testModeBlockers } from "@/core/sending/mode-gates";
import { parseDomainCheckState, parseUnsubscribeTest } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { firstSubjectProblem } from "@/core/templates/subject-rules";
import { plural } from "@/core/text";
import type { DbOrTx } from "@/server/db";
import { CAMPAIGN_GONE, CampaignError } from "./errors";

/**
 * Launching a campaign (PLAN.md B6.4 step 6, B6.1, B6.5, M3-DESIGN §4.3.9, M4-DESIGN §2.11):
 *  1. checks the draft: a sender, a first email with subject and text, a first subject (the campaign's and every
 *     person's own, from Review) that doesn't start with "Re:" or "Fwd:", text in every follow-up that is switched
 *     on, and at least one ticked person;
 *  2. fixes the mode from Setting "sending.mode" and checks it can send right now: test mode and
 *     live need Mailgun (never in the practice copy), live needs the domain checklist, Setup A and
 *     the reply test passed on this domain (recomputed here, not only when the mode was saved), and
 *     both need the sender's own sending address; live also needs its reply route working;
 *  3. saves the sender snapshot (display name and From address; in shared-From mode the shared From address and the
 *     sender's own address as Reply-To, SHARED-FROM-DESIGN §2.3);
 *  4. re-checks every ticked person on fresh data: anyone who can't be emailed any more is excluded
 *     with the reason;
 *  5. takes the companies' reservations when the campaign's sends count as "emailed" (live after
 *     go-live, or a dry run in the practice copy; M3-DESIGN §1.7): companies another campaign took
 *     at the same moment are listed;
 *  6. creates one "first email" row per person (waiting to send, due at the start time) and marks
 *     them scheduled; the campaign becomes Scheduled (start ahead) or Running, with every switched-on
 *     follow-up (each one's row is created when the email before it goes out). A dry run keeps the
 *     "Ignore sending hours" choice; test mode and live always follow sending hours. People at a company
 *     with a possible reply nobody has decided yet are put on hold straight away (M4-DESIGN §2.8.2).
 * Address checks (M5-DESIGN §2.8 rule 3, §6.1): a launch waits while the campaign's own check run is queued or
 * running ("checks-running"). A test or live person whose only reason is a first "no answer" (`check-waiting`) is
 * launched like a scheduled one (reserved company, a waiting first-email row) but in RECHECK until the second check
 * 24 hours later decides; people who still need a check are left out "Address not checked", a second "no answer"
 * "Address couldn't be checked". `Campaign.launchedGoLive` keeps whether go-live was on, so the test-list exception is
 * judged at launch (D31), and so are "emailed" and "test-list only" for the campaign's whole life (M6-DESIGN §2.2,
 * §2.3). After go-live, a live launch of a draft made before it needs `confirmMadeBeforeGoLive` (G11).
 * Writes happen in chunks of at most 500 people per transaction. A launch that stopped half-way
 * (power cut) can simply be run again: rows and reservations it already made are reused. A launch
 * that fails (nobody left, or the draft changed) leaves the draft as it was: its reservations are
 * given back and the people it unticked are ticked again. While a launch runs, every change to the
 * draft is refused (isLaunching), and the final flip also checks the sender didn't change, nor the sending domain (its
 * region and the snapshot's domain row included, review SEND-3), the shared From address or go-live
 * (SHARED-FROM-DESIGN F29), nor the way of sending (MAIN-DOMAIN-DESIGN §2.3, `loadTeamFrom().replies`).
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §2.3, O5, O9, O35): the snapshot is From "<display name> <own From>" with no
 * Reply-To, on the sending domain's row, whatever sending address the sender may still have (none is read for it); a
 * dry run without a fitting own From uses the placeholder. Nothing waits on a reply route. Leftover rows of an
 * interrupted launch get a new Message-ID when theirs isn't on the snapshot's Message-ID domain.
 */

export const LAUNCH_CHUNK = 500;

export type LaunchOptions = {
  /**
   * When the first emails are due. Omitted: the campaign's saved start (Campaign.startAt).
   * null, or a time that has already passed: now.
   */
  startAt?: Date | null;
  now?: Date;
  /**
   * Dry runs only: "Ignore sending hours" (Campaign.ignoreWindow). Omitted: true, exactly as
   * Milestone 2 (the wizard sends the Schedule step's choice, see draft.ts). Test mode and live
   * always follow sending hours.
   */
  ignoreWindow?: boolean;
  /**
   * M6-DESIGN §2.3 G11: required for a LIVE launch of a campaign created before sending.goLiveAt (the Schedule step's
   * tick); without it the launch refuses with MADE_BEFORE_GO_LIVE_LAUNCH_TEXT.
   */
  confirmMadeBeforeGoLive?: boolean;
  /** Tests: the Mailgun context. */
  mailgun?: () => Promise<MailgunContextResult>;
  /**
   * Tests only: runs after the last chunk, just before the final transaction (SHARED-FROM-DESIGN F29: a settings change
   * racing the launch).
   */
  beforeFinalize?: () => Promise<void>;
};

/** Why a launch in this mode can't happen right now (codes for the callers). */
export type ModeProblem = {
  code: "practice-copy" | "mailgun-not-connected" | "from-invalid" | "mode-not-ready" | "no-sender-address" | "no-reply-route";
  text: string;
};

export const PRACTICE_COPY_LAUNCH_TEXT =
  "The practice copy never sends real email, so only dry run is available here. Set sending to dry run in Settings › Sending & Mailgun.";
export const MAILGUN_NOT_CONNECTED_LAUNCH_TEXT =
  "Test mode and live sending need Mailgun. Connect it in Settings › Sending & Mailgun, or set sending to dry run.";

/** The sender facts the mode check needs: their current sending address and its reply route. */
export type LaunchSender = { name: string; address: { address: string; routeStatus: string | null } | null };

/**
 * Everything that stops a launch in `mode` right now, in the order the launch checks them
 * (M3-DESIGN §4.3.9): the practice copy; Mailgun not connected; the readiness of the mode
 * (testModeBlockers / liveLaunchBlockers: DNS, tracking off, unsubscribe handling on, Setup A,
 * webhooks, signing key, Mailgun accepting, the reply test passed on this domain, a test list);
 * the sender's sending address; for live, the sender's reply route. Dry runs: none. The wizard
 * shows the whole list (LaunchSummary.modeBlockers); the launch refuses with the first one.
 *
 * Shared From address (SHARED-FROM-DESIGN §2.4, §3.7): a saved From address that doesn't fit the sending domain
 * refuses test and live launches ("from-invalid", right after Mailgun's connection); live needs the reply test passed
 * for this domain AND today's From address (`replyTestPassedFor`) and, in shared-From mode, the main domain's MX row
 * (liveLaunchBlockers' `teamFrom`); the per-person address is called the "reply address" in shared-From mode.
 * `opts.team`: the From address state the caller already read (the launch), else read here. `opts.ctx`: the Mailgun
 * context the caller already loaded (the launch), else loaded here.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §2.3, O9, O13; `team.replies`): a missing or misfit own From is "from-invalid";
 * live needs the by-hand reply test passed for this domain, today's own From and this mode
 * (`replyTestPassedFor(…, { ownMailbox: true })`) and the own-mailbox rows (liveLaunchBlockers' `ownMailbox`); nobody
 * needs a sending address or a reply route, so neither "no-sender-address" nor "no-reply-route" is ever returned.
 * Checklist rows of another domain or of the other way of sending (O36) are ignored.
 */
export async function launchModeProblems(
  mode: SendMode,
  sender: LaunchSender | null,
  opts: { mailgun?: () => Promise<MailgunContextResult>; team?: TeamFromState; ctx?: MailgunContextResult } = {},
): Promise<ModeProblem[]> {
  if (mode === "DRY_RUN") return [];
  const s = await getSettings(["practice.copy", "sending.testList", "mailgun.unsubscribeTest", "mailgun.domain", "sending.goLive"] as const);
  if (s["practice.copy"] === true) return [{ code: "practice-copy", text: PRACTICE_COPY_LAUNCH_TEXT }];
  const ctx = opts.ctx ?? (await safeMailgunContext(opts.mailgun));
  if (!ctx.connected) return [{ code: "mailgun-not-connected", text: MAILGUN_NOT_CONNECTED_LAUNCH_TEXT }];
  const out: ModeProblem[] = [];
  // §2.4 (fail closed): a saved From address that doesn't fit the sending domain stops test and live launches.
  const team = opts.team ?? (await loadTeamFrom());
  if (team.problem) out.push({ code: "from-invalid", text: team.problem });
  const teamFrom = team.address !== null;
  // MAIN-DOMAIN-DESIGN O1: the mode comes from the one reader, never from the From address's domain.
  const ownMailbox = team.replies === "own-mailbox";
  if (mode === "TEST") {
    for (const text of testModeBlockers({ connected: true, practiceCopy: false })) out.push({ code: "mode-not-ready", text });
  } else {
    const check = (await readTyped(STATE_KEYS.domainCheck, parseDomainCheckState)).value;
    // Checklist rows of another (older) domain, or of the other way of sending (O36), say nothing about this one.
    const rows = (check.domain && check.domain !== ctx.domain) || !checkMatchesMode(check, team.replies) ? [] : check.rows;
    const testList = new Set(
      (Array.isArray(s["sending.testList"]) ? s["sending.testList"] : [])
        .map((a) => normalizeEmail(String(a)))
        .filter((a): a is string => Boolean(a)),
    );
    const replyTest = parseUnsubscribeTest(s["mailgun.unsubscribeTest"]);
    const blockers = liveLaunchBlockers(rows, {
      connected: true,
      practiceCopy: false,
      testListSize: testList.size,
      setup: replyTest.setup,
      // A pass counts only for this domain and today's From address (SHARED-FROM-DESIGN F12, F26); in own-mailbox mode
      // only a by-hand pass of this mode with today's own From (MAIN-DOMAIN-DESIGN O13, O15).
      replyTestPassedOnDomain: ownMailbox
        ? replyTestPassedFor(replyTest, ctx.domain, team.ownFrom, { ownMailbox: true })
        : replyTestPassedFor(replyTest, ctx.domain, team.address),
      // M6-DESIGN §2.3: after go-live an empty test list no longer blocks a live launch.
      goLive: s["sending.goLive"] === true,
      teamFrom,
      ownMailbox,
    });
    for (const text of blockers) out.push({ code: "mode-not-ready", text });
  }
  // O9: nobody needs a sending address or a reply route in own-mailbox mode.
  if (sender && !ownMailbox) {
    const who = sender.name.trim() || "The sender";
    if (!sender.address) {
      const words = senderAddressWords(teamFrom);
      out.push({ code: "no-sender-address", text: `${who} has no ${words.lower} yet. ${who} can add one in Settings › My profile.` });
    } else if (mode === "LIVE" && sender.address.routeStatus !== "ok") {
      out.push({
        code: "no-reply-route",
        text: `Replies to ${who} can't reach ${who} yet: the reply route isn't working. Click Apply recommended settings in Settings › Domain checklist.`,
      });
    }
  }
  return out;
}

/**
 * A live launch of a draft made before go-live without the Schedule step's tick (M6-DESIGN §2.3 G11, code
 * "made-before-go-live"). Nothing is launched.
 */
export const MADE_BEFORE_GO_LIVE_LAUNCH_TEXT = "Tick the box to confirm that this draft now sends real email.";

/**
 * Whether a draft created at `createdAt` was made before go-live (M6-DESIGN G11): true only while go-live is on and
 * `goLiveAt` (Setting "sending.goLiveAt", ISO) is a valid instant after the draft's creation. Such a draft ticked its
 * audience while only the test list could get real email (a dry run ticks every eligible prospect), so a live launch
 * needs `confirmMadeBeforeGoLive`. Without a recorded go-live time nothing can be judged: false.
 */
export function madeBeforeGoLive(createdAt: Date, goLive: boolean, goLiveAt: string | null | undefined): boolean {
  if (!goLive || !goLiveAt) return false;
  const at = Date.parse(goLiveAt);
  return Number.isFinite(at) && createdAt.getTime() < at;
}

/** A launch refused because a first subject pretends to be a reply or a forward (M4-DESIGN §2.11, code "re-subject"). */
export const RE_SUBJECT_LAUNCH_TEXT =
  "A first subject starts with “Re:” or “Fwd:” (the campaign's, or one person's edit on the Review step). Change it before launching: Gmail's rules forbid it for emails that aren't real replies.";

/**
 * Where a draft's first subjects break the first-subject rule (M4-DESIGN §2.13, errors only; drafts saved before M4
 * may have one): the campaign's own step-0 subject, and how many people's own first subjects (RecipientEdit, from the
 * Review step) do. Warnings ("Art: …") never block a launch.
 */
export async function firstSubjectErrors(reader: DbOrTx, campaignId: number): Promise<{ campaign: boolean; edits: number }> {
  const [step, edits] = await Promise.all([
    reader.campaignStep.findUnique({ where: { campaignId_step: { campaignId, step: 0 } }, select: { subject: true } }),
    reader.recipientEdit.findMany({
      where: { step: 0, subject: { not: null }, recipient: { campaignId, included: true } },
      select: { subject: true },
    }),
  ]);
  const isError = (s: string | null | undefined) => firstSubjectProblem(s ?? "")?.level === "error";
  return { campaign: isError(step?.subject), edits: edits.filter((e) => isError(e.subject)).length };
}

export type ExclusionSummary = { code: EligibilityCode; text: string; count: number };

export type LaunchResult = {
  campaignId: number;
  status: "SCHEDULED" | "RUNNING";
  mode: SendMode;
  startAt: Date;
  /** First emails now waiting to send. */
  queued: number;
  /** People waiting for the second address check (RECHECK): their first email goes out once it passes. */
  rechecking: number;
  /** People left out at launch because something changed since they were ticked (incl. `lost`). */
  newlyExcluded: number;
  /** Why, grouped (most common first). */
  excludedReasons: ExclusionSummary[];
  /** Everyone in the campaign who won't be emailed (unticked, left out earlier, or at launch). */
  excludedTotal: number;
  /** Companies another campaign reserved at the same moment (for the confirmation screen). */
  lost: Array<{ companyId: number; companyName: string; reason: string }>;
  /** A plain sentence for the confirmation toast. */
  message: string;
};

/**
 * Campaigns being launched right now by this process. Every draft change refuses them
 * (loadDraftForChange / assertStillDraft in ./audience, and per-person edits), so the sender, the
 * message and the audience can't change after the launch has checked them. Kept on globalThis so
 * every copy of this module in the web app's bundles shares one set.
 */
const launching: Set<number> = ((globalThis as { __outreachLaunching?: Set<number> }).__outreachLaunching ??= new Set<number>());

/** Refusal for changes to a draft while it's being launched. */
export const LAUNCHING_TEXT = "This campaign is being launched right now. Wait a moment, then open the campaign page.";

/** True while this campaign's launch is in progress (its status is still Draft until the very end). */
export function isLaunching(campaignId: number): boolean {
  return launching.has(campaignId);
}

type Planned = {
  recipient: Pick<CampaignRecipient, "id" | "companyId" | "personId" | "emailNorm">;
  company: CompanyEligibility;
  person: PersonEligibility | null;
  reason: EligibilityReason | null;
  /** Launched into RECHECK: the second address check is due at this instant (M5-DESIGN §2.8 rule 3). */
  recheckAt: Date | null;
};

/** Why a person who still needs an address check is left out at launch (M5-DESIGN §2.8 rule 3). */
export const LAUNCH_NOT_CHECKED_TEXT = "Address not checked";
/** Why a person whose address got no answer twice is left out at launch. */
export const LAUNCH_COULDNT_CHECK_TEXT = "Address couldn't be checked";

/**
 * The reason a check code leaves someone out after the draft ("Left out: address not checked"): the "needs a check"
 * codes (one reason for all three, so the launch's summary counts them together) and a second "no answer" get the
 * short launch sentences; every other reason keeps its own text. Used by the launch and by the sending loop before a
 * first email (M5-DESIGN §2.8 rules 3 and 6).
 */
export function launchExclusionReason(r: EligibilityReason): EligibilityReason {
  if (isNeedsCheckCode(r.code)) return { ...r, code: "not-checked", text: LAUNCH_NOT_CHECKED_TEXT };
  if (r.code === "check-unknown") return { ...r, text: LAUNCH_COULDNT_CHECK_TEXT };
  return r;
}

/**
 * When a person whose only blocking reason is a first "no answer" (`check-waiting`, test or live) gets the second
 * check: 24 hours after the first one, and never in the past. Null for everyone else.
 */
export function recheckAtFor(person: Pick<PersonEligibility, "blocking" | "verifiedAt">, mode: SendMode, now: Date): Date | null {
  if (mode === "DRY_RUN") return null;
  if (person.blocking.length === 0 || !person.blocking.every((r) => r.code === "check-waiting")) return null;
  const due = person.verifiedAt ? person.verifiedAt.getTime() + UNKNOWN_RECHECK_AFTER_MS : now.getTime();
  return new Date(Math.max(now.getTime(), due));
}

/** The launch refusal while the campaign's own check run is queued or running (M5-DESIGN §6.1, code "checks-running"). */
export function checksRunningText(done: number, total: number): string {
  const n = (v: number) => Math.max(0, Math.floor(v)).toLocaleString("en-US");
  return `Address checks for this campaign are still running (${n(done)} of ${n(total)} done). Launch when they've finished, or stop them on the Verify step.`;
}

const PERSON_GONE: EligibilityReason = {
  code: "person-removed",
  text: "This person is no longer at this company",
  overridable: false,
};

const COMPANY_GONE_REASON: EligibilityReason = {
  code: "company-deleted",
  text: "The company was deleted",
  overridable: false,
};

function summarize(reasons: EligibilityReason[]): ExclusionSummary[] {
  const byCode = new Map<EligibilityCode, ExclusionSummary>();
  for (const r of reasons) {
    const s = byCode.get(r.code);
    if (s) s.count += 1;
    else byCode.set(r.code, { code: r.code, text: r.text, count: 1 });
  }
  return [...byCode.values()].sort((a, b) => b.count - a.count);
}

/**
 * Own-mailbox mode's snapshot input (MAIN-DOMAIN-DESIGN §2.3): the own From (`team.ownFrom`, null while none fits) and
 * the sending domain's row, which must be active: the Mailgun context's for test and live, the saved domain's for a dry
 * run (which never loads Mailgun). `row` is what the launch's last re-check compares (F29 extended). Null without a
 * fitting own From or an active row.
 */
async function ownMailboxSnapshotFor(
  team: TeamFromState,
  ctx: MailgunContextResult | null,
): Promise<{ snapshot: OwnMailboxSnapshot; row: { id: number; name: string; region: string } } | null> {
  if (!team.ownFrom) return null;
  const where: Prisma.SendingDomainWhereUniqueInput | null = ctx?.connected
    ? { id: ctx.domainId }
    : team.domain
      ? { name: team.domain }
      : null;
  if (!where) return null;
  const row = await db.sendingDomain.findUnique({ where, select: { id: true, name: true, region: true, active: true } });
  if (!row || !row.active) return null;
  return {
    snapshot: { from: team.ownFrom, domainId: row.id, domainName: row.name },
    row: { id: row.id, name: row.name, region: row.region },
  };
}

/** Launches a draft campaign. Throws CampaignError with a plain message when it can't. */
export async function launchCampaign(campaignId: number, actorId: number, opts: LaunchOptions = {}): Promise<LaunchResult> {
  if (launching.has(campaignId)) throw new CampaignError(LAUNCHING_TEXT, "busy");
  launching.add(campaignId);
  try {
    return await launch(campaignId, actorId, opts);
  } finally {
    launching.delete(campaignId);
  }
}

async function launch(campaignId: number, actorId: number, opts: LaunchOptions): Promise<LaunchResult> {
  const now = opts.now ?? new Date();

  // ── 1. The draft ──
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: {
      steps: { orderBy: { step: "asc" } },
      sender: {
        select: {
          id: true,
          name: true,
          email: true,
          senderDisplayName: true,
          active: true,
          senderAddresses: {
            where: { retiredAt: null, domain: { active: true } },
            orderBy: { id: "desc" },
            take: 1,
            select: { address: true, domainId: true, routeStatus: true, domain: { select: { name: true, region: true } } },
          },
        },
      },
    },
  });
  if (!campaign) throw new CampaignError(CAMPAIGN_GONE, "not-found");
  if (campaign.status !== "DRAFT") {
    throw new CampaignError(
      campaign.status === "CANCELLED" ? "This campaign was cancelled. Start a new one instead." : "This campaign has already been launched.",
      "not-draft",
    );
  }
  // The Verify step's checks decide who launches: never launch while they are still queued or running.
  const checks = await activeCampaignCheckRun(campaignId, now);
  if (checks) {
    let total = checks.total;
    if (total === 0) {
      const job = await db.job.findUnique({ where: { id: checks.jobId }, select: { payload: true } });
      const payload = readVerifyRunPayload(job?.payload);
      if (payload && "personIds" in payload) total = payload.personIds.length;
    }
    throw new CampaignError(checksRunningText(checks.done, total), "checks-running");
  }
  const sender = campaign.sender;
  if (!sender) throw new CampaignError("Choose who sends this campaign in the Sender step.", "no-sender");
  if (!sender.active) {
    throw new CampaignError(
      `${sender.name}'s account is switched off, so they can't send this campaign. Choose another sender in the Sender step.`,
      "sender-off",
    );
  }
  const first = campaign.steps.find((s) => s.step === 0);
  if (!first || !first.enabled || !(first.subject ?? "").trim() || !first.body.trim()) {
    throw new CampaignError("Write the first email's subject and text in the Message step before launching.", "no-first-email");
  }
  const badSubjects = await firstSubjectErrors(db, campaignId);
  if (badSubjects.campaign || badSubjects.edits > 0) throw new CampaignError(RE_SUBJECT_LAUNCH_TEXT, "re-subject");
  for (const s of campaign.steps) {
    if (s.step > 0 && s.enabled && !s.body.trim()) {
      throw new CampaignError(`${stepTitle(s.step)} has no text. Write it or switch it off in the Message step.`, "empty-follow-up");
    }
  }

  // ── 2. Mode and start ──
  const setting = await getSetting("sending.mode");
  const mode: SendMode = setting === "TEST" || setting === "LIVE" ? setting : "DRY_RUN";
  const address = sender.senderAddresses[0] ?? null;
  // The shared From address this launch uses (SHARED-FROM-DESIGN §2.3), read once: the checks, the snapshot and the
  // last transaction's re-check (F29) all see the same value. The region too: a region-only reconnect is a domain
  // change (F28), so the last re-check compares it (review SEND-3).
  const team = await loadTeamFrom();
  const region = await getSetting("mailgun.region");
  // MAIN-DOMAIN-DESIGN O1: own-mailbox mode, decided by the one reader (read once with the From address above).
  const ownMailbox = team.replies === "own-mailbox";
  // Test and live need Mailgun: its context is loaded once, for the checks and (own-mailbox mode) the snapshot's row.
  const ctx = mode === "DRY_RUN" ? null : await safeMailgunContext(opts.mailgun);
  const problem = (
    await launchModeProblems(
      mode,
      { name: sender.name, address: address ? { address: address.address, routeStatus: address.routeStatus } : null },
      { mailgun: opts.mailgun, team, ...(ctx ? { ctx } : {}) },
    )
  )[0];
  if (problem) throw new CampaignError(problem.text, problem.code);
  // Own-mailbox mode (§2.3): the own From and the sending domain's row (the context's for test and live; the saved
  // domain's for a dry run, which never loads Mailgun). A dry run without a fitting own From takes the placeholder.
  const own = ownMailbox ? await ownMailboxSnapshotFor(team, ctx) : null;
  if (ownMailbox && mode !== "DRY_RUN" && !own) throw new CampaignError(LAUNCH_SETTINGS_CHANGED_TEXT, "changed");
  const ignoreWindow = mode === "DRY_RUN" ? (opts.ignoreWindow ?? true) : false;
  const requested = opts.startAt !== undefined ? opts.startAt : campaign.startAt;
  if (requested && Number.isNaN(requested.getTime())) throw new CampaignError("Choose a valid start date and time.", "bad-start");
  const startAt = requested && requested.getTime() > now.getTime() ? requested : now;
  const status = startAt.getTime() > now.getTime() ? ("SCHEDULED" as const) : ("RUNNING" as const);

  // ── 3. Who is ticked ──
  const recipients = await db.campaignRecipient.findMany({
    where: { campaignId },
    select: { id: true, companyId: true, personId: true, emailNorm: true, included: true, warnings: true },
    orderBy: { id: "asc" },
  });
  const ticked = recipients.filter((r) => r.included);
  if (ticked.length === 0) {
    throw new CampaignError("Nobody is ticked to receive this campaign. Tick at least one person in the Audience step.", "no-recipients");
  }

  // ── 4. Re-check everyone on fresh data ──
  const settings = await loadEligibilitySettings();
  // G11 (M6-DESIGN §2.3): a draft made before go-live ticked its people while only the test list got real email. The
  // go-live read here is the one this launch records (`launchedGoLive`), so the two always agree.
  if (mode === "LIVE" && settings.goLive && opts.confirmMadeBeforeGoLive !== true) {
    if (madeBeforeGoLive(campaign.createdAt, settings.goLive, await getSetting("sending.goLiveAt"))) {
      throw new CampaignError(MADE_BEFORE_GO_LIVE_LAUNCH_TEXT, "made-before-go-live");
    }
  }
  const facts = new Map<number, RecipientFacts>(
    ticked.map((r) => [r.personId, { excludedByHand: false, overrides: readRecipientOverrides(r.warnings) }]),
  );
  const evaluated = await evaluateCompanies(ticked.map((r) => r.companyId), {
    mode,
    campaignId,
    now,
    settings,
    recipients: facts,
    personIds: ticked.map((r) => r.personId),
    senderName: sender.name,
    // Launch only: at send time a broken route is a wait, never a stop (§4.3.2). Own-mailbox mode has no route (O9).
    senderHasReplyRoute: mode === "LIVE" && !ownMailbox ? address?.routeStatus === "ok" : undefined,
  });
  const plan: Planned[] = [];
  for (const r of ticked) {
    const company = evaluated.get(r.companyId);
    if (!company) {
      // The company row itself is gone (never happens through the app: companies are only soft-deleted).
      continue;
    }
    const person = company.people.find((p) => p.personId === r.personId) ?? null;
    // A first "no answer" is the one check reason that waits instead of leaving the person out (§2.8 rule 3).
    const recheckAt = person && !person.eligible ? recheckAtFor(person, mode, now) : null;
    const reason =
      !person ? PERSON_GONE : person.eligible || recheckAt ? null : launchExclusionReason(person.reason ?? COMPANY_GONE_REASON);
    plan.push({ recipient: r, company, person, reason, recheckAt });
  }
  const missingCompanies = ticked.filter((r) => !evaluated.has(r.companyId));

  // Addresses may have changed since the draft was made: keep CampaignRecipient.emailNorm current.
  const heldBy = new Map(recipients.map((r) => [r.emailNorm, r.id]));
  const changing = new Set(
    plan.filter((p) => !p.reason && p.person?.emailNorm && p.person.emailNorm !== p.recipient.emailNorm).map((p) => p.recipient.id),
  );
  for (const p of plan) {
    if (p.reason || !changing.has(p.recipient.id)) continue;
    const holder = heldBy.get(p.person!.emailNorm!);
    if (holder !== undefined && holder !== p.recipient.id && !changing.has(holder)) {
      p.reason = { code: "duplicate", text: "Same address as another person in this campaign", overridable: false };
      changing.delete(p.recipient.id);
    }
  }

  if (!plan.some((p) => !p.reason)) {
    const example = plan.find((p) => p.reason)?.reason?.text;
    throw new CampaignError(
      `None of the ticked people can be emailed any more${example ? ` (for example: ${example})` : ""}. ` +
        "Open the Audience step to see why each one was left out.",
      "nobody-left",
    );
  }

  // Test and live use only a From address that fits (a misfit one was refused above); a dry run shows what is saved.
  // Own-mailbox mode (§2.3): the own From on the sending domain's row, never the sender's address (none is needed).
  const snapshot = ownMailbox
    ? senderSnapshot(sender, mode, null, own ? { ownMailbox: own.snapshot } : {})
    : senderSnapshot(
        sender,
        mode,
        address ? { address: address.address, domainId: address.domainId, domainName: address.domain.name } : null,
        { teamFrom: mode === "DRY_RUN" ? (team.address ?? team.saved) : team.address },
      );
  // The flag this launch writes (`launchedGoLive`) decides "emailed" for the campaign's whole life (M6-DESIGN §2.2).
  const takesReservations = countsAsEmailed(mode, { practiceCopy: settings.practiceCopy, launchedGoLive: settings.goLive });

  if (changing.size > 0) {
    const updates = plan.filter((p) => changing.has(p.recipient.id));
    await dbTx(async (tx) => {
      // Two passes, so two people who swapped addresses never collide on the unique index.
      for (const p of updates) {
        await tx.campaignRecipient.update({ where: { id: p.recipient.id }, data: { emailNorm: `~launch:${p.recipient.id}` } });
      }
      for (const p of updates) {
        await tx.campaignRecipient.update({ where: { id: p.recipient.id }, data: { emailNorm: p.person!.emailNorm! } });
      }
    });
  }

  // ── 5 + 6. Reservations, recipients and first-email rows, in chunks of whole companies ──
  const existingRows = await db.outboundEmail.findMany({
    where: { campaignId, step: 0 },
    select: { id: true, recipientId: true, status: true, messageId: true },
  });
  const rowByRecipient = new Map(existingRows.map((r) => [r.recipientId, r]));

  const byCompany = new Map<number, Planned[]>();
  for (const p of plan) {
    const list = byCompany.get(p.recipient.companyId);
    if (list) list.push(p);
    else byCompany.set(p.recipient.companyId, [p]);
  }
  const chunks: Planned[][] = [];
  let current: Planned[] = [];
  for (const group of byCompany.values()) {
    if (current.length > 0 && current.length + group.length > LAUNCH_CHUNK) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) chunks.push(current);

  const chunkCtx: ChunkContext = {
    campaignId,
    takesReservations,
    now,
    startAt,
    mode,
    senderId: sender.id,
    fromHeader: snapshot.fromHeader,
    replyTo: snapshot.replyTo,
    messageIdDomain: snapshot.messageIdDomain,
    ownMailbox: own !== null,
    rowByRecipient,
  };
  let queued = 0;
  let rechecking = 0;
  const excludedReasons: EligibilityReason[] = [];
  /** People this attempt unticked (their ticks are given back if the launch fails). */
  const excludedIds: number[] = [];
  /** People this attempt put in RECHECK (a failed launch puts them back as they were in the draft). */
  const recheckIds: number[] = [];
  const lost: LaunchResult["lost"] = [];
  let excludedTotal = 0;
  try {
    for (const chunk of chunks) {
      const out = await dbTx((tx) => writeChunk(tx, chunk, chunkCtx));
      queued += out.queued;
      rechecking += out.rechecking.length;
      recheckIds.push(...out.rechecking);
      excludedReasons.push(...out.excluded);
      excludedIds.push(...out.excludedIds);
      lost.push(...out.lost);
    }
    if (queued + rechecking === 0) {
      throw new CampaignError(
        "Nobody could be added: every ticked company is now waiting in another campaign. Open the Audience step to see the details.",
        "nobody-left",
      );
    }
    // ── Final: flip the campaign, tidy up the unticked, log and notify ──
    const actor = await db.user.findUnique({ where: { id: actorId }, select: { name: true } });
    if (opts.beforeFinalize) await opts.beforeFinalize();
    excludedTotal = await dbTx((tx) =>
      finalizeLaunch(tx, {
        campaign: { id: campaignId, name: campaign.name },
        actorId,
        actorName: actor?.name ?? "Someone",
        senderId: sender.id,
        status,
        mode,
        ignoreWindow,
        startAt,
        now,
        fromName: snapshot.fromName,
        fromAddress: snapshot.fromAddress,
        replyTo: snapshot.replyTo,
        sendingDomainId: snapshot.sendingDomainId,
        missingRecipientIds: missingCompanies.map((r) => r.id),
        queued,
        rechecking,
        newlyExcluded: excludedReasons.length,
        launchedGoLive: settings.goLive,
        // F29: what this launch read; the last transaction refuses when any of it changed meanwhile. Review SEND-3: also
        // the region, and the sending domain row of the address the snapshot used (read with the address, before the
        // settings above), so a domain change or region-only reconnect committed in between is caught too.
        expect: {
          domain: team.domain,
          teamFrom: team.saved,
          goLive: settings.goLive,
          region,
          // MAIN-DOMAIN-DESIGN §2.3: the way of sending, and in own-mailbox mode the sending domain's row the snapshot used.
          replies: team.replies,
          sendingDomain: ownMailbox
            ? (own?.row ?? null)
            : address
              ? { id: address.domainId, name: address.domain.name, region: address.domain.region }
              : null,
        },
      }),
    );
  } catch (err) {
    // The draft stays a draft: give back what this attempt reserved, so it holds nothing, and the
    // ticks it removed, so the Audience step shows the selection as it was before.
    if (takesReservations) await releaseDraftReservations(campaignId, now).catch(() => undefined);
    await restoreDraftTicks(campaignId, excludedIds).catch(() => undefined);
    await restoreDraftRechecks(campaignId, recheckIds).catch(() => undefined);
    throw err;
  }

  const newlyExcluded = excludedReasons.length + missingCompanies.length;
  const summary = summarize([...excludedReasons, ...missingCompanies.map(() => COMPANY_GONE_REASON)]);
  const where = mode === "DRY_RUN" ? " to the dry-run outbox" : "";
  const inMode = mode === "DRY_RUN" ? " in dry run" : mode === "TEST" ? " in test mode" : "";
  const paced = ignoreWindow ? "" : " They go out inside each recipient's sending hours, a few minutes apart.";
  let main: string;
  if (queued === 0) {
    main = status === "RUNNING" ? `Launched ${campaign.name}${inMode}.` : `Scheduled ${campaign.name}${inMode}.`;
  } else {
    main =
      status === "RUNNING"
        ? `Launched ${campaign.name}${inMode}. ${plural(queued, "first email is", "first emails are")} on the way${where}.${paced}`
        : `Scheduled ${campaign.name}${inMode}. ${plural(queued, "first email goes", "first emails go")}${where} from the start time you chose.${paced}`;
  }
  const waiting =
    rechecking > 0
      ? ` ${plural(rechecking, "person waits", "people wait")} for a second address check. Their first email goes out once it passes.`
      : "";
  // People left out for their address checks were ticked knowingly (the Verify step said so): say it plainly.
  const unchecked = excludedReasons.filter((r) => r.text === LAUNCH_NOT_CHECKED_TEXT || r.text === LAUNCH_COULDNT_CHECK_TEXT).length;
  const changed = newlyExcluded - unchecked;
  let left = "";
  if (unchecked > 0) {
    left +=
      unchecked === 1
        ? " 1 person was left out because their address wasn't checked."
        : ` ${unchecked.toLocaleString("en-US")} people were left out because their addresses weren't checked.`;
  }
  if (changed > 0) left += ` ${plural(changed, "person was", "people were")} left out because something changed since they were ticked.`;
  return {
    campaignId,
    status,
    mode,
    startAt,
    queued,
    rechecking,
    newlyExcluded,
    excludedReasons: summary,
    excludedTotal,
    lost,
    message: main + waiting + left,
  };
}

// ───────────────────────── writing ─────────────────────────

type ChunkContext = {
  campaignId: number;
  takesReservations: boolean;
  now: Date;
  startAt: Date;
  mode: SendMode;
  senderId: number;
  fromHeader: string;
  /** The snapshot's Reply-To (shared-From mode: the sender's own address), else null (SHARED-FROM-DESIGN §2.3). */
  replyTo: string | null;
  messageIdDomain: string;
  /** MAIN-DOMAIN-DESIGN O35: an own-mailbox snapshot (any launch mode), whose leftover rows' Message-IDs are renewed. */
  ownMailbox: boolean;
  /** Step-0 rows left over from an earlier, interrupted launch of this draft. */
  rowByRecipient: ReadonlyMap<number, { id: number; status: string; messageId: string }>;
};

const RESTORE_CHUNK = 400;

/**
 * A launch that failed after some chunks were written: the people it unticked (can't be emailed
 * any more, or their company was taken by another campaign at that moment) are ticked again, as
 * they were in the draft. Only while the campaign is still a draft. Their stray rows stay cancelled;
 * launching again re-checks everyone and reuses them.
 */
async function restoreDraftTicks(campaignId: number, recipientIds: readonly number[]): Promise<number> {
  if (recipientIds.length === 0) return 0;
  return dbTx(async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (!c || c.status !== "DRAFT") return 0;
    let restored = 0;
    for (let i = 0; i < recipientIds.length; i += RESTORE_CHUNK) {
      const res = await tx.campaignRecipient.updateMany({
        where: { id: { in: recipientIds.slice(i, i + RESTORE_CHUNK) }, campaignId, included: false, state: "EXCLUDED" },
        data: { included: true, state: "PENDING", exclusionReason: null, nextDueAt: null },
      });
      restored += res.count;
    }
    return restored;
  });
}

/**
 * A launch that failed after some chunks were written: the people it put in RECHECK go back to how the draft had
 * them (ticked, waiting for the launch), so nothing re-checks or leaves out a draft's recipient. Their stray rows stay
 * waiting like the scheduled ones'; launching again reuses them.
 */
async function restoreDraftRechecks(campaignId: number, recipientIds: readonly number[]): Promise<number> {
  if (recipientIds.length === 0) return 0;
  return dbTx(async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (!c || c.status !== "DRAFT") return 0;
    let restored = 0;
    for (let i = 0; i < recipientIds.length; i += RESTORE_CHUNK) {
      const res = await tx.campaignRecipient.updateMany({
        where: { id: { in: recipientIds.slice(i, i + RESTORE_CHUNK) }, campaignId, state: "RECHECK" },
        data: { state: "PENDING", recheckAt: null, nextDueAt: null },
      });
      restored += res.count;
    }
    return restored;
  });
}

/**
 * One transaction for up to LAUNCH_CHUNK people (whole companies): reservations, exclusions, the
 * scheduled recipients and their first-email rows. People launched into RECHECK (a first "no answer", M5-DESIGN §2.8
 * rule 3) are handled like scheduled ones (their company is reserved, they get a waiting first-email row due at the
 * start) except for the state: RECHECK with `recheckAt`; the sending gates never pick their rows until the second
 * check releases them.
 */
async function writeChunk(
  tx: Tx,
  chunk: Planned[],
  ctx: ChunkContext,
): Promise<{ queued: number; rechecking: number[]; excluded: EligibilityReason[]; excludedIds: number[]; lost: LaunchResult["lost"] }> {
  const { campaignId, now, startAt } = ctx;
  let queued = 0;
  const rechecking: number[] = [];
  const excluded: EligibilityReason[] = [];
  const excludedIds: number[] = [];
  const lost: LaunchResult["lost"] = [];
  const lostHolder = new Map<number, ReservationHolder>();
  if (ctx.takesReservations) {
    const wanted = [...new Set(chunk.filter((p) => !p.reason).map((p) => p.recipient.companyId))];
    const taken = await takeReservations(tx, campaignId, wanted, now);
    for (const h of taken.lost) lostHolder.set(h.companyId, h);
  }

  const toQueue: Planned[] = [];
  const toExclude = new Map<string, number[]>();
  for (const p of chunk) {
    let reason = p.reason;
    const holder = lostHolder.get(p.recipient.companyId);
    if (!reason && holder) {
      reason = { code: "reserved", text: holder.text, overridable: false };
      if (!lost.some((l) => l.companyId === p.recipient.companyId)) {
        lost.push({ companyId: p.recipient.companyId, companyName: p.company.name, reason: holder.text });
      }
    }
    if (reason) {
      excluded.push(reason);
      excludedIds.push(p.recipient.id);
      const ids = toExclude.get(reason.text);
      if (ids) ids.push(p.recipient.id);
      else toExclude.set(reason.text, [p.recipient.id]);
    } else {
      toQueue.push(p);
    }
  }

  for (const [text, ids] of toExclude) {
    await tx.campaignRecipient.updateMany({
      where: { id: { in: ids } },
      data: { included: false, state: "EXCLUDED", exclusionReason: text, nextDueAt: null },
    });
    // Rows left over from an earlier, interrupted launch must never be sent.
    await tx.outboundEmail.updateMany({
      where: { campaignId, recipientId: { in: ids }, status: "QUEUED" },
      data: { status: "CANCELLED", lastError: text },
    });
  }

  if (toQueue.length === 0) return { queued, rechecking, excluded, excludedIds, lost };
  const scheduled = toQueue.filter((p) => !p.recheckAt);
  if (scheduled.length > 0) {
    await tx.campaignRecipient.updateMany({
      where: { id: { in: scheduled.map((p) => p.recipient.id) } },
      data: { state: "SCHEDULED", currentStep: 0, nextDueAt: startAt, stopReason: null, exclusionReason: null, recheckAt: null },
    });
  }
  for (const p of toQueue) {
    if (!p.recheckAt) continue;
    await tx.campaignRecipient.update({
      where: { id: p.recipient.id },
      data: { state: "RECHECK", recheckAt: p.recheckAt, currentStep: 0, nextDueAt: startAt, stopReason: null, exclusionReason: null },
    });
    rechecking.push(p.recipient.id);
  }
  const create: Prisma.OutboundEmailCreateManyInput[] = [];
  for (const p of toQueue) {
    const waits = p.recheckAt !== null;
    const person = p.person!;
    const row = {
      personId: p.recipient.personId,
      companyId: p.recipient.companyId,
      senderId: ctx.senderId,
      mode: ctx.mode,
      toEmail: person.email!,
      toNorm: person.emailNorm!,
      companyDomain: p.company.domain,
      companyName: p.company.name,
      fromAddress: ctx.fromHeader,
      replyTo: ctx.replyTo,
      dueAt: startAt,
    };
    const existing = ctx.rowByRecipient.get(p.recipient.id);
    if (existing) {
      // Left over from an interrupted launch of this draft (a draft never sends): reuse it. A shared-From email's
      // Message-ID must be on the domain it goes through (SHARED-FROM-DESIGN §2.4): an unsent leftover id made for
      // another domain (an earlier dry run, a domain change) gets a new one. So must an own-mailbox email's
      // (MAIN-DOMAIN-DESIGN O35, any launch mode); per-person mode keeps today's rule (its transport never checks it).
      if (existing.status === "SENT" || existing.status === "SENDING" || existing.status === "UNKNOWN") continue;
      const newId = (ctx.replyTo !== null || ctx.ownMailbox) && messageIdDomainOf(existing.messageId) !== ctx.messageIdDomain;
      await tx.outboundEmail.update({
        where: { id: existing.id },
        data: { ...row, ...(newId ? { messageId: newMessageId(ctx.messageIdDomain) } : {}), status: "QUEUED", claimedAt: null, lastError: null },
      });
      if (!waits) queued += 1;
      continue;
    }
    if (!waits) queued += 1;
    create.push({
      ...row,
      campaignId,
      recipientId: p.recipient.id,
      step: 0,
      subject: "",
      text: "",
      html: "",
      messageId: newMessageId(ctx.messageIdDomain),
      sendId: newSendId(),
      status: "QUEUED",
    });
  }
  if (create.length > 0) await tx.outboundEmail.createMany({ data: create });
  return { queued, rechecking, excluded, excludedIds, lost };
}

/**
 * The sending settings a launch depends on (SHARED-FROM-DESIGN F29): Setting "mailgun.domain" and the saved
 * "mailgun.fromAddress" (both trimmed and lowercase, empty = null) and "sending.goLive". Review SEND-3 adds what a
 * region-only reconnect (F28) changes and what the snapshot actually used; both are optional, and absent means "not
 * compared":
 *  - `region`: Setting "mailgun.region" as the launch read it (a missing row reads as its default);
 *  - `sendingDomain`: the SendingDomain row of the sender's address the snapshot used, with the name and region read
 *    together with the address (null: no address, e.g. a dry run without one); in own-mailbox mode the sending
 *    domain's row the snapshot used (MAIN-DOMAIN-DESIGN §2.3).
 * MAIN-DOMAIN-DESIGN §2.3 (F29 extended) adds `replies`: the way of sending as the launch read it
 * (`loadTeamFrom().replies`); absent = not compared (the launch always passes it).
 */
export type LaunchSettings = {
  domain: string | null;
  teamFrom: string | null;
  goLive: boolean;
  region?: string | null;
  sendingDomain?: { id: number; name: string; region: string } | null;
  replies?: RepliesMode;
};

function settingText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

/** A region as a setting or a SendingDomain row holds it ("EU" / "US"); missing or empty = the setting's default. */
function regionText(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim().toUpperCase() : SETTING_DEFAULTS["mailgun.region"];
}

/**
 * F29, inside the launch's last transaction: re-reads the sending domain, the shared From address and go-live, and throws
 * `CampaignError(LAUNCH_SETTINGS_CHANGED_TEXT, "changed")` when any differs from what the launch used. Review SEND-3:
 * also the region (`expect.region`), and the sending domain row the snapshot used (`expect.sendingDomain`), which must
 * still be active with the same name and region: saveConnection deactivates it on a domain change and changes its
 * region on a region-only reconnect, in the same transaction as the settings. MAIN-DOMAIN-DESIGN §2.3: also the way of
 * sending (`expect.replies`), re-read through the one reader (`loadTeamFrom(tx).replies`, §0.2 rule 5), which
 * saveConnection writes together with the domain.
 */
export async function assertLaunchSettingsUnchanged(tx: Tx, expect: LaunchSettings): Promise<void> {
  const rows = await tx.setting.findMany({
    where: { key: { in: ["mailgun.domain", "mailgun.fromAddress", "sending.goLive", "mailgun.region"] } },
    select: { key: true, value: true },
  });
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  const now: LaunchSettings = {
    domain: settingText(value("mailgun.domain")),
    teamFrom: settingText(value("mailgun.fromAddress")),
    goLive: value("sending.goLive") === true,
  };
  let changed =
    now.domain !== settingText(expect.domain) ||
    now.teamFrom !== settingText(expect.teamFrom) ||
    now.goLive !== (expect.goLive === true) ||
    (expect.region !== undefined && regionText(value("mailgun.region")) !== regionText(expect.region));
  if (!changed && expect.replies !== undefined) changed = (await loadTeamFrom(tx)).replies !== repliesOf(expect.replies);
  if (!changed && expect.sendingDomain) {
    const used = expect.sendingDomain;
    const row = await tx.sendingDomain.findUnique({ where: { id: used.id }, select: { name: true, region: true, active: true } });
    changed = !row || !row.active || settingText(row.name) !== settingText(used.name) || regionText(row.region) !== regionText(used.region);
  }
  if (changed) throw new CampaignError(LAUNCH_SETTINGS_CHANGED_TEXT, "changed");
}

/**
 * The last transaction: the campaign becomes Scheduled or Running with its mode, the "Ignore
 * sending hours" choice and the sender snapshot (every switched-on follow-up stays on: campaigns of
 * every mode send their follow-ups), unticked people are marked excluded (their stray rows
 * cancelled), people at a company with a possible reply nobody has decided yet are put on hold
 * (M4-DESIGN §2.8.2), the launch is logged, and the chosen sender is told when someone else launched
 * it. Returns how many are excluded.
 *
 * First of all (SHARED-FROM-DESIGN F29) it re-reads the sending domain, the shared From address and go-live (and, review
 * SEND-3, the region and the sending domain row the snapshot used) and
 * refuses when any differs from what this launch used (`LAUNCH_SETTINGS_CHANGED_TEXT`, code "changed"): a launching
 * campaign is still a draft, so the refusals of a From or domain change never see it. The caller's clean-up gives back
 * what the launch took; the draft stays a draft.
 */
async function finalizeLaunch(
  tx: Tx,
  f: {
    campaign: { id: number; name: string };
    actorId: number;
    actorName: string;
    senderId: number;
    status: "SCHEDULED" | "RUNNING";
    mode: SendMode;
    ignoreWindow: boolean;
    startAt: Date;
    now: Date;
    fromName: string;
    fromAddress: string;
    /** Campaign.replyTo: the sender's own address in shared-From mode, else null. */
    replyTo: string | null;
    sendingDomainId: number | null;
    missingRecipientIds: number[];
    queued: number;
    /** Launched into RECHECK (waiting for the second address check). */
    rechecking: number;
    newlyExcluded: number;
    /**
     * Setting "sending.goLive" now: judged at launch for the campaign's whole life, the test-list exception (M5-DESIGN
     * §2.8, D31), whether its live sends count as "emailed" and whether they stay test-list only (M6-DESIGN §2.2, §2.3).
     */
    launchedGoLive: boolean;
    /**
     * F29: Setting "mailgun.domain", the saved "mailgun.fromAddress" and "sending.goLive" as this launch read them;
     * review SEND-3: "mailgun.region" and the sending domain row of the snapshot's address.
     */
    expect: LaunchSettings;
  },
): Promise<number> {
  const campaignId = f.campaign.id;
  await assertLaunchSettingsUnchanged(tx, f.expect);
  // Compare-and-set: still a draft, and still sent by the person whose snapshot was taken (the
  // email rows and the From line were made for them).
  const flipped = await tx.campaign.updateMany({
    where: { id: campaignId, status: "DRAFT", senderId: f.senderId },
    data: {
      status: f.status,
      mode: f.mode,
      ignoreWindow: f.ignoreWindow,
      fromName: f.fromName,
      fromAddress: f.fromAddress,
      replyTo: f.replyTo,
      sendingDomainId: f.sendingDomainId,
      startAt: f.startAt,
      launchedAt: f.now,
      launchedGoLive: f.launchedGoLive,
      pausedAt: null,
      pauseReason: null,
      finishedAt: null,
    },
  });
  if (flipped.count !== 1) {
    throw new CampaignError("This campaign changed while it was being launched. Refresh the page and check it.", "changed");
  }
  if (f.missingRecipientIds.length > 0) {
    await tx.campaignRecipient.updateMany({
      where: { id: { in: f.missingRecipientIds } },
      data: { included: false, state: "EXCLUDED", exclusionReason: COMPANY_GONE_REASON.text, nextDueAt: null },
    });
  }
  await tx.campaignRecipient.updateMany({
    where: { campaignId, included: false, exclusionReason: null },
    data: { exclusionReason: "Excluded by hand" },
  });
  await tx.campaignRecipient.updateMany({ where: { campaignId, included: false }, data: { state: "EXCLUDED", nextDueAt: null } });
  await tx.outboundEmail.updateMany({
    where: { campaignId, status: "QUEUED", recipient: { included: false } },
    data: { status: "CANCELLED", lastError: "This person was left out of the campaign." },
  });
  const total = await tx.campaignRecipient.count({ where: { campaignId, included: false } });
  // A possible reply (or a domain-held message) of one of its companies that nobody has decided yet holds the new
  // recipients at once, so the campaign page says why they wait (the sending guard never lets them go meanwhile).
  const companies = await tx.campaignRecipient.findMany({
    where: { campaignId, included: true },
    select: { companyId: true },
    distinct: ["companyId"],
  });
  if (companies.length > 0) {
    await applyPendingPossibleReplyHolds({ companyIds: companies.map((c) => c.companyId), campaignId, now: f.now, tx });
  }
  const modeWord = f.mode === "DRY_RUN" ? "dry run" : f.mode === "TEST" ? "test" : "live";
  await logActivity(
    {
      actorId: f.actorId,
      type: "campaign.launched",
      summary: `${f.actorName} launched ${f.campaign.name} (${modeWord}) with ${plural(f.queued + f.rechecking, "person", "people")}`,
      campaignId,
      data: {
        mode: f.mode,
        queued: f.queued,
        rechecking: f.rechecking,
        excluded: total,
        newlyExcluded: f.newlyExcluded,
        startAt: f.startAt.toISOString(),
        ignoreWindow: f.ignoreWindow,
      },
      mode: f.mode,
    },
    tx,
  );
  if (f.senderId !== f.actorId) {
    await createNotification(
      {
        userId: f.senderId,
        type: "campaign.sender",
        title: `${f.actorName} launched ${f.campaign.name} with you as the sender`,
        body:
          f.mode === "DRY_RUN"
            ? "It's a dry run: its emails go to the dry-run outbox and nothing is really sent."
            : f.mode === "TEST"
              ? "Its emails go to Mailgun's test mode, so nothing is delivered."
              : f.expect.replies === "own-mailbox"
                ? // MAIN-DOMAIN-DESIGN O19: replies never reach the sender's inbox in own-mailbox mode (the own From gets them).
                  OWN_MAILBOX_TEXTS.followUpReminder(f.fromAddress)
                : "Replies to its emails will come to your inbox.",
        link: `/campaigns/${campaignId}`,
      },
      tx,
    );
  }
  return total;
}
