import crypto from "node:crypto";
import { normalizeEmail } from "@/core/email-address";
import { PLAN_TEST_RESERVE, PLAN_TEXTS, planRoom, type PlanLimits } from "@/core/mailgun/plan";
import { replyTestEmail } from "@/core/reply-test";
import { senderAddressWords, senderHeaders, TEAM_FROM_TEXTS } from "@/core/sending/from-address";
import { MODE_GATE_TEXTS } from "@/core/sending/mode-gates";
import { OWN_MAILBOX_TEXTS, ownMailboxHeaders } from "@/core/sending/own-mailbox";
import type { RenderedEmail } from "@/core/templates/types";
import type { SendMode } from "@/generated/prisma/client";
import { logActivity } from "../activity";
import { db, dbTx, dbWrite, type DbOrTx } from "../db";
import { PlainJobError, redactText, type JobHandler } from "../jobs";
import {
  getMailgunContext,
  loadSendGuard,
  mailgunSecrets,
  type MailgunContext,
  type MailgunContextResult,
} from "../mailgun/context";
import {
  AUTH_TEXT,
  BUSINESS_VERIFICATION_TEXT,
  isAuthorizedOnlyRefusal,
  isMailgunError,
  plainMailgunError,
  type MailgunError,
} from "../mailgun/errors";
import type { PauseKind } from "@/core/system-state";
import { notifyOwner } from "../notifications";
import { getSettings } from "../settings";
import { shouldSendNotice } from "../state-typed";
import { loadPlanLimits } from "./mailgun/plan";
import { loadTeamFrom } from "./mailgun/team-from";
import { loadRenderSettings, renderCampaignEmail, RenderError } from "./render";
import { loadGateInputs, ownerAddressMissingText, replyTestBlockersFor, TEST_SEND_UNKNOWN_TEXT } from "./reply-test";
import { mailgunFailure, SENDING_KEY_TEAM_FROM_FIX } from "./sending/mailgun-transport";
import { getPauseState, pauseSending } from "./sending/pause";
import { countMailgunSendsSince, countUserTestSends, getTodayCap, type TodayCap } from "./sending/usage";

/**
 * Test sends (PLAN B6.5, B10, M3-DESIGN §1.5, §4.5.5):
 *  - "Send me a test" (Review step): one campaign email, rendered for the chosen person, sent to the clicking user's own
 *    reply inbox. Runs in the web process (one Mailgun call). In dry run it only shows the email. At most 20 a day per
 *    user, counted toward the domain's daily limit, checked in the same transaction that records the send, so a double
 *    click can neither pass a limit nor send twice.
 *  - The reply test (job "send.testEmail"): one email per test-list mailbox from the Owner's sending address. Each
 *    Message-ID is fixed by the job and the address, so running the same job again never sends a mailbox twice.
 * Test emails are always delivered for real (never Mailgun's test mode) and only while sending is Test mode or Live.
 *
 * Shared From address (SHARED-FROM-DESIGN §3.4, §3.5, F8, F26): both kinds take their From line and Reply-To from
 * `senderHeaders()` with `loadTeamFrom()` (From "<display name> <shared address>", Reply-To the sender's own address),
 * refuse while the saved From address doesn't fit the sending domain, and record the shared From address on every
 * TestSend row they create (`teamFrom`, null = per-person), so the reply test counts only emails of today's From.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.5, §3.6, O13, O23, O25; `loadTeamFrom().replies`): both kinds come From the
 * sender's display name with the own From (`ownMailboxHeaders`, never a Reply-To), need no sending address, and record
 * the own From on the TestSend row. In every mode a plan with a daily limit adds the rolling guard (the emails handed to
 * Mailgun in the last 24 hours, `PLAN_TEXTS.testsFull`), a send refused because the plan's limit is reached pauses like
 * a campaign email (`PAUSE_FOR.limit`), and a free account's authorized-recipients refusal gets the test sentence
 * (`PLAN_TEXTS.authorizedOnlyTest`).
 *
 * Review SEND-2: every test email is admitted in the same lock-first transaction that counts the plan's rolling 24 hours
 * and today's tests and records it (SENDING) before anything goes to Mailgun, the reply test's emails all at once, so
 * test sends running at the same time always count each other and never pass the plan's limit together. Review SEND-5:
 * with a daily-limit plan, tests may also use the 10 emails a day the plan keeps for them on top of today's limit
 * (`testCapFor`), and a refusal only suggests changing today's limit when that could help (`capReachedTestText`).
 */

/** The rolling guard's window (O23): Mailgun's day boundary is unknown, so no 24 hours may hold more than the limit. */
const PLAN_WINDOW_MS = 24 * 60 * 60_000;

/**
 * How many more test emails fit the plan's daily limit now (O23), or null without a daily limit. Pass `tx` to count
 * inside the transaction that records the send.
 */
async function planTestsLeft(limits: PlanLimits | null, now: Date, reader?: DbOrTx): Promise<number | null> {
  if (!limits || limits.dailyLimit === null) return null;
  const used = await countMailgunSendsSince(new Date(now.getTime() - PLAN_WINDOW_MS), reader);
  return planRoom(limits, used.total)?.tests ?? null;
}

export const TEST_SENDS_PER_DAY = 20;
/** A test still on its way (SENDING) this recently blocks the next click. */
export const TEST_IN_FLIGHT_MS = 2 * 60_000;

/** A plain refusal or failure of a test send (shown as it is). */
export class TestSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestSendError";
  }
}

export const TEST_SEND_TEXTS = {
  dryRunPreview:
    "In dry run nothing leaves this PC, so here is the email as it would arrive. To get it in your inbox, set sending to Test mode or Live in Settings › Sending & Mailgun.",
  stillOnItsWay: "Your last test is still on its way. Wait a moment before sending another.",
  dailyMax: `You've sent ${TEST_SENDS_PER_DAY} tests today, the daily maximum. You can send more tomorrow.`,
  noInbox: "Add your reply inbox in Settings › My profile first, so the test has somewhere to go.",
  notInCampaign: "This person isn't in the campaign any more. Refresh the page to see the latest.",
  unknown: TEST_SEND_UNKNOWN_TEXT,
} as const;

/** "Sending is paused (<reason>). Tests go out again once it's resumed." */
export function pausedTestText(reason: string): string {
  return `Sending is paused (${reason || "by the Owner"}). Tests go out again once it's resumed.`;
}

/**
 * "Today's limit of 50 emails is reached, and tests count toward it. …" (no daily-limit plan: exactly as before).
 *
 * Review SEND-5: with a Mailgun plan that has a daily limit, tests may use the emails the plan keeps for them
 * (`reserve`, 10) on top of today's limit, so the refusal says both are used up. It suggests changing today's limit only
 * while that could help: when today's limit is already the highest the plan allows (`atMax`), it says so instead.
 */
export function capReachedTestText(cap: number, opts: { reserve?: number; atMax?: boolean } = {}): string {
  const limit = `${cap.toLocaleString("en-US")} email${cap === 1 ? "" : "s"}`;
  const reserve = Math.max(0, Math.floor(opts.reserve ?? 0));
  if (reserve === 0) {
    return `Today's limit of ${limit} is reached, and tests count toward it. Try again tomorrow, or change today's limit in Settings › Limits & warm-up.`;
  }
  const usedUp = `Today's limit of ${limit} and the ${reserve.toLocaleString("en-US")} kept for test emails are used up`;
  return opts.atMax
    ? `${usedUp}: that's all your Mailgun plan sends in a day. Try again tomorrow.`
    : `${usedUp}. Try again tomorrow, or change today's limit in Settings › Limits & warm-up.`;
}

/** The emails a day a plan with a daily limit keeps for tests (review SEND-5); 0 without a daily limit. */
function testReserveOf(limits: PlanLimits | null): number {
  return limits && limits.dailyLimit !== null ? PLAN_TEST_RESERVE : 0;
}

/**
 * How many emails (campaign and test) today's cap day may hold once a test email goes (review SEND-5): today's limit,
 * plus the 10 a plan with a daily limit keeps for tests, so a full day of campaign emails still leaves them room. The
 * plan's rolling guard (`planTestsLeft`) still keeps every 24 hours at the plan's limit. Without a daily limit (app
 * mode without a chosen plan): today's limit, as before.
 */
export function testCapFor(today: Pick<TodayCap, "cap">, limits: PlanLimits | null): number {
  return today.cap + testReserveOf(limits);
}

/** The refusal once tests would pass `testCapFor` (review SEND-5). */
function testCapText(today: Pick<TodayCap, "cap" | "maxCap">, limits: PlanLimits | null): string {
  return capReachedTestText(today.cap, { reserve: testReserveOf(limits), atMax: today.cap >= today.maxCap });
}

/**
 * "<Name> has no sending address yet. <Name> can add one in Settings › My profile." — "reply address" in shared-From
 * mode (SHARED-FROM-DESIGN §3.5, §3.6).
 */
export function noSenderAddressText(name: string, teamFrom = false): string {
  return `${name} has no ${senderAddressWords(teamFrom).lower} yet. ${name} can add one in Settings › My profile.`;
}

const REASON_WORDS: Record<string, string> = {
  BOUNCED: "it bounced",
  COMPLAINED: "it marked an email as spam",
  UNSUBSCRIBED: "it unsubscribed",
  MANUAL: "added by hand",
  INVALID: "not a valid address",
};

/** "Your reply inbox (<email>) is on the do-not-email list (<reason>), so tests can't be sent to it." */
export function suppressedInboxTestText(inbox: string, reason: string): string {
  return `Your reply inbox (${inbox}) is on the do-not-email list (${REASON_WORDS[reason] ?? reason.toLowerCase()}), so tests can't be sent to it.`;
}

/** "pp.t.<24 hex>@<domain>": a test's own Message-ID, never reused. */
function newTestMessageId(domain: string): string {
  return `pp.t.${crypto.randomBytes(12).toString("hex")}@${domain.toLowerCase()}`;
}

/** `pp.t.<jobId>.<first 12 hex of sha1(address)>@<domain>`: the same job and mailbox always get the same Message-ID. */
export function replyTestMessageId(jobId: number, address: string, domain: string): string {
  const hash = crypto.createHash("sha1").update(address.trim().toLowerCase()).digest("hex").slice(0, 12);
  return `pp.t.${jobId}.${hash}@${domain.trim().toLowerCase()}`;
}

export type TestSendDeps = { mailgun?: () => Promise<MailgunContextResult>; now?: Date };

async function mailgunOrThrow(deps: TestSendDeps): Promise<MailgunContext> {
  let ctx: MailgunContextResult;
  try {
    ctx = await (deps.mailgun ?? (() => getMailgunContext()))();
  } catch {
    throw new TestSendError("Mailgun isn't connected yet. Open Settings › Sending & Mailgun.");
  }
  if (!ctx.connected) throw new TestSendError(ctx.text);
  return ctx;
}

/** The user's reply inbox (else their sign-in email), normalised; null when neither is a valid address. */
async function ownInbox(userId: number): Promise<{ inbox: string | null; name: string }> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true, replyInbox: true } });
  if (!u) throw new TestSendError("Your session has ended. Please sign in again.");
  return { inbox: normalizeEmail(u.replyInbox || u.email), name: u.name };
}

export type TestSendInfo = {
  mode: "DRY_RUN" | "TEST" | "LIVE";
  /** Where the test goes: the user's reply inbox. */
  inbox: string | null;
  testsLeft: number;
  perDay: number;
  /** Why a test can't be sent right now (null = it can). */
  blocker: string | null;
  /**
   * Own-mailbox mode (review SCREENS-11): the dialog calls `inbox` "your inbox for test emails" instead of "your reply
   * inbox". False in dry run, the practice copy and app mode.
   */
  ownMailbox?: boolean;
};

/** What the "Send me a test" dialog shows when it opens (Review step). Cheap: no Mailgun call. */
export async function testSendInfo(actor: { id: number }, now: Date = new Date()): Promise<TestSendInfo> {
  const s = await getSettings(["sending.mode", "practice.copy"] as const);
  const mode = s["sending.mode"] === "TEST" || s["sending.mode"] === "LIVE" ? s["sending.mode"] : "DRY_RUN";
  const { inbox } = await ownInbox(actor.id);
  const used = await countUserTestSends(actor.id, now);
  const testsLeft = Math.max(0, TEST_SENDS_PER_DAY - used);
  let blocker: string | null = null;
  let ownMailbox = false;
  if (mode !== "DRY_RUN") {
    const team = s["practice.copy"] ? null : await loadTeamFrom();
    const problem = team?.problem ?? null;
    ownMailbox = team?.replies === "own-mailbox";
    if (s["practice.copy"]) blocker = MODE_GATE_TEXTS.practiceCopy;
    else if (problem) blocker = problem;
    else {
      const pause = await getPauseState();
      if (pause.paused) blocker = pausedTestText(pause.reason);
      else if (!inbox) blocker = TEST_SEND_TEXTS.noInbox;
      else {
        const sup = await db.suppression.findUnique({ where: { emailNorm: inbox }, select: { reason: true } });
        if (sup) blocker = suppressedInboxTestText(inbox, sup.reason);
        else if (testsLeft === 0) blocker = TEST_SEND_TEXTS.dailyMax;
        else {
          // MAIN-DOMAIN-DESIGN O23: the plan's daily limit, counted over the last 24 hours.
          const limits = await loadPlanLimits();
          const left = await planTestsLeft(limits, now);
          if (left !== null && left <= 0) blocker = PLAN_TEXTS.testsFull(limits!.dailyLimit!);
        }
      }
    }
  }
  return { mode, inbox, testsLeft, perDay: TEST_SENDS_PER_DAY, blocker, ownMailbox };
}

const PAUSE_FOR: Partial<Record<MailgunError["kind"], { kind: PauseKind; reason: string }>> = {
  auth: { kind: "mailgun-auth", reason: "Mailgun didn't accept the API key" },
  "business-verification": { kind: "mailgun-verification", reason: "Mailgun business verification" },
  "not-allowed": { kind: "mailgun-not-allowed", reason: "Mailgun isn't accepting emails" },
  // MAIN-DOMAIN-DESIGN O24, §2.8: a send refused because the plan's sending limit is reached pauses like a campaign email.
  limit: { kind: "mailgun-not-allowed", reason: PLAN_TEXTS.limitReason },
};

/**
 * Shared-From mode (SEND-2, SHARED-FROM-DESIGN §2.4): Mailgun refused the domain sending key that sent a test email. The
 * sentence doesn't blame the API key (it didn't send) and ends with the sending loop's own sending-key sentence.
 */
export function sendingKeyRefusedText(): string {
  return `Mailgun didn't accept the domain sending key.${SENDING_KEY_TEAM_FROM_FIX}`;
}

/**
 * The test email was a shared-From one sent with the domain sending key (the same test as the sending loop's,
 * mailgun-transport.ts): a refused key then says how to send with the API key instead.
 */
function teamFromWithSendingKey(teamFrom: string | null, ctx: MailgunContext): boolean {
  return teamFrom !== null && ctx.sendClient !== ctx.client;
}

/**
 * Records a failed or uncertain test send and returns the owner's sentence. An account-level refusal (wrong key,
 * business verification, not allowed to send) pauses all sending, like a campaign email would.
 *
 * `opts.teamFromWithSendingKey` (SEND-2): a key refused for a shared-From test sent with the domain sending key gets the
 * sending-key sentence instead of "paste the API key here", and the same pause (reason and fix) as the sending loop
 * (`mailgunFailure`). Per-person mode, or no sending key: exactly as before.
 *
 * MAIN-DOMAIN-DESIGN O25 (every mode): a "not allowed to send" refusal because a free account only sends to authorized
 * recipients says `PLAN_TEXTS.authorizedOnlyTest` (a test mailbox may be authorized) and pauses with its own reason.
 */
async function recordFailure(
  testSendId: number,
  err: unknown,
  ctx: MailgunContext,
  now: Date,
  opts: { teamFromWithSendingKey?: boolean } = {},
): Promise<string> {
  let text: string;
  let status: "FAILED" | "UNKNOWN" = "FAILED";
  if (isMailgunError(err)) {
    if (err.ambiguous) {
      status = "UNKNOWN";
      text = TEST_SEND_TEXTS.unknown;
    } else {
      text = plainMailgunError(err, { domain: ctx.domain, region: ctx.region, now });
      const authorizedOnly =
        err.kind === "not-allowed" && (isAuthorizedOnlyRefusal(err.mailgunMessage) || isAuthorizedOnlyRefusal(err.message));
      if (authorizedOnly) text = PLAN_TEXTS.authorizedOnlyTest;
      const pause = PAUSE_FOR[err.kind];
      if (pause) {
        let reason = authorizedOnly ? PLAN_TEXTS.authorizedReason : pause.reason;
        let fixText =
          err.kind === "auth"
            ? `${AUTH_TEXT} Then click Resume.`
            : err.kind === "business-verification"
              ? BUSINESS_VERIFICATION_TEXT
              : text;
        if (err.kind === "auth" && err.requestStarted && opts.teamFromWithSendingKey === true) {
          text = sendingKeyRefusedText();
          const loop = mailgunFailure(err, { domain: ctx.domain, now, teamFromWithSendingKey: true });
          if (loop.kind === "pause") {
            reason = loop.reason;
            fixText = loop.fixText;
          }
        }
        await pauseSending({ kind: pause.kind, reason, fixText, detail: { mailgunMessage: err.mailgunMessage }, now }).catch(
          (e: unknown) => console.error("[test-send] couldn't pause sending", e),
        );
      }
    }
  } else {
    text = "Something unexpected went wrong while sending the test. Try again in a moment.";
  }
  await dbWrite((c) =>
    c.testSend.updateMany({ where: { id: testSendId, status: "SENDING" }, data: { status, error: text.slice(0, 500) } }),
  );
  return text;
}

/** Mailgun answered with its own id instead of ours: threading may break (§4.4.2). Told once a day at most. */
async function noticeRewrittenId(ours: string, theirs: string, now: Date): Promise<void> {
  if (ours === theirs) return;
  try {
    if (await shouldSendNotice("message-id-rewritten", now)) {
      await notifyOwner({
        type: "system.mailgun",
        title: "Mailgun changes the app's message IDs",
        body: "Replies and follow-ups may not thread as planned. Tell us so we can check it.",
        link: "/settings/domain",
      });
    }
  } catch (err) {
    console.error("[test-send] couldn't send the message-id notice", err);
  }
}

/**
 * "Send me a test" (Review step). Renders the chosen recipient's email with the campaign's sender. In dry run it only
 * returns the preview. Otherwise it refuses, in this order: practice copy; Mailgun not connected; the saved From address
 * doesn't fit the sending domain (SHARED-FROM-DESIGN F8); sending paused; the sender has no sending (reply) address;
 * the user's reply inbox missing or on the do-not-email list; then, in one transaction that also records the send: 20
 * tests today, a test still on its way (last 2 minutes), today's limit reached (plus the plan's 10 kept for tests,
 * review SEND-5). Then one POST to the user's own reply
 * inbox (never test mode) with `senderHeaders()`'s From and Reply-To, and SENT / FAILED / UNKNOWN. When the inbox is the
 * shared From address itself, the message says to look in spam (§3.5). Throws TestSendError.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.6): no sending address is needed; the From line is `ownMailboxHeaders()` with
 * the sender's display name and the own From, no Reply-To; the TestSend row records the own From; the inbox may be the
 * own From itself (then the "look in spam" sentence). With a plan's daily limit the transaction that records the send
 * also refuses once the last 24 hours hold that many emails (`PLAN_TEXTS.testsFull`, every mode).
 */
export async function sendMeATest(
  actor: { id: number; name: string },
  input: { campaignId: number; recipientId: number; step: number },
  deps: TestSendDeps = {},
): Promise<{ status: "sent" | "preview"; message: string; preview?: RenderedEmail }> {
  const now = deps.now ?? new Date();
  const s = await getSettings(["sending.mode", "practice.copy"] as const);
  const mode: SendMode = s["sending.mode"] === "TEST" || s["sending.mode"] === "LIVE" ? s["sending.mode"] : "DRY_RUN";

  const recipient = await db.campaignRecipient.findUnique({ where: { id: input.recipientId }, select: { campaignId: true } });
  if (!recipient || recipient.campaignId !== input.campaignId) throw new TestSendError(TEST_SEND_TEXTS.notInCampaign);
  const campaign = await db.campaign.findUnique({
    where: { id: input.campaignId },
    select: { id: true, name: true, senderId: true, createdById: true },
  });
  if (!campaign) throw new TestSendError("This campaign doesn't exist any more.");
  const render = async (purpose: "preview" | "send") => {
    try {
      return await renderCampaignEmail({ recipientId: input.recipientId, step: input.step, purpose });
    } catch (err) {
      if (err instanceof RenderError) throw new TestSendError(err.message);
      throw err;
    }
  };

  if (mode === "DRY_RUN") {
    return { status: "preview", message: TEST_SEND_TEXTS.dryRunPreview, preview: await render("preview") };
  }
  if (s["practice.copy"]) throw new TestSendError(MODE_GATE_TEXTS.practiceCopy);
  const ctx = await mailgunOrThrow(deps);
  const team = await loadTeamFrom();
  if (team.problem) throw new TestSendError(team.problem);
  const pause = await getPauseState();
  if (pause.paused) throw new TestSendError(pausedTestText(pause.reason));

  const senderId = campaign.senderId ?? campaign.createdById;
  const sender = await db.user.findUnique({ where: { id: senderId }, select: { name: true, senderDisplayName: true } });
  if (!sender) throw new TestSendError("The campaign's sender doesn't exist any more. Pick another sender.");
  const displayName = (sender.senderDisplayName ?? "").trim() || sender.name;
  const own = team.replies === "own-mailbox";
  let headers: { from: string; replyTo: string | null };
  if (own) {
    // MAIN-DOMAIN-DESIGN §3.6, §0.2 rule 6: the own From with the sender's name, from the one place; no sending address.
    if (!team.ownFrom) throw new TestSendError(team.problem ?? OWN_MAILBOX_TEXTS.fromMissing(ctx.domain));
    headers = ownMailboxHeaders({ displayName, from: team.ownFrom });
  } else {
    const from = await db.senderAddress.findFirst({
      where: { userId: senderId, domainId: ctx.domainId, retiredAt: null },
      orderBy: { id: "desc" },
      select: { address: true },
    });
    if (!from) throw new TestSendError(noSenderAddressText(sender.name, team.address !== null));
    headers = senderHeaders({ displayName, senderAddress: from.address, teamFrom: team.address });
  }
  // The From this way of sending uses (O15): the shared From, the own From, or null per-person.
  const evidenceFrom = own ? team.ownFrom : team.address;

  const { inbox } = await ownInbox(actor.id);
  if (!inbox) throw new TestSendError(TEST_SEND_TEXTS.noInbox);
  const suppressed = await db.suppression.findUnique({ where: { emailNorm: inbox }, select: { reason: true } });
  if (suppressed) throw new TestSendError(suppressedInboxTestText(inbox, suppressed.reason));

  const email = await render("send");
  const today = await getTodayCap(now);
  const limits = await loadPlanLimits();
  const testCap = testCapFor(today, limits);
  const messageId = newTestMessageId(ctx.domain);
  const row = await dbTx(async (tx) => {
    if ((await countUserTestSends(actor.id, now, tx)) >= TEST_SENDS_PER_DAY) throw new TestSendError(TEST_SEND_TEXTS.dailyMax);
    // Only the user's own "Send me a test" (SETUP-06): a reply-test email in flight in the Owner's name never blocks it.
    const inFlight = await tx.testSend.count({
      where: { userId: actor.id, purpose: "SELF", status: "SENDING", sentAt: { gte: new Date(now.getTime() - TEST_IN_FLIGHT_MS) } },
    });
    if (inFlight > 0) throw new TestSendError(TEST_SEND_TEXTS.stillOnItsWay);
    const testsNow = await tx.testSend.count({ where: { status: { not: "FAILED" }, sentAt: { gte: today.dayStart, lt: today.dayEnd } } });
    // Review SEND-5: a daily-limit plan's 10 kept for tests are on top of today's limit.
    if (today.used - today.testSends + testsNow >= testCap) throw new TestSendError(testCapText(today, limits));
    // MAIN-DOMAIN-DESIGN O23: the plan's rolling 24 hours, counted in the same transaction that records the send.
    const planLeft = await planTestsLeft(limits, now, tx);
    if (planLeft !== null && planLeft <= 0) throw new TestSendError(PLAN_TEXTS.testsFull(limits!.dailyLimit!));
    return tx.testSend.create({
      data: {
        userId: actor.id,
        to: inbox,
        subject: email.subject.slice(0, 500),
        mode,
        recipientId: input.recipientId,
        purpose: "SELF",
        status: "SENDING",
        messageId,
        teamFrom: evidenceFrom,
        sentAt: now,
      },
      select: { id: true },
    });
  });

  const guard = { ...(await loadSendGuard({ userId: actor.id })), ownInbox: inbox };
  try {
    const res = await ctx.sendClient.sendMessage(ctx.domain, {
      from: headers.from,
      ...(headers.replyTo ? { replyTo: headers.replyTo } : {}),
      to: inbox,
      subject: email.subject,
      text: email.text,
      html: email.html,
      messageId,
      tags: ["outreach-test"],
      variables: { test_send_id: String(row.id) },
      testMode: false,
      purpose: "self-test",
      guard,
    });
    await dbWrite((c) =>
      c.testSend.updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: "SENT", providerId: res.id, error: null } }),
    );
    await noticeRewrittenId(messageId, res.id, now);
    await logActivity({
      actorId: actor.id,
      type: "test.sent",
      summary: `${actor.name} sent a test of “${campaign.name}” to ${inbox}`,
      campaignId: campaign.id,
      mode,
      data: { testSendId: row.id, to: inbox, step: input.step },
    }).catch((err: unknown) => console.error("[test-send] couldn't log the test", err));
    const note = evidenceFrom && inbox === evidenceFrom ? TEAM_FROM_TEXTS.selfTestNote(evidenceFrom) : "";
    return { status: "sent", message: `Test sent to ${inbox}. It should arrive within a minute.${note}` };
  } catch (err) {
    throw new TestSendError(await recordFailure(row.id, err, ctx, now, { teamFromWithSendingKey: teamFromWithSendingKey(evidenceFrom, ctx) }));
  }
}

/** The reply test was refused before anything was sent (the list of what's missing). */
export class ReplyTestRefusedError extends PlainJobError {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" "));
    this.name = "ReplyTestRefusedError";
  }
}

/** What one run of the reply test did; `paused` lists the mailboxes left out because sending was paused mid-run. */
export type ReplyTestSendResult = { sent: number; failed: number; skipped: string[]; paused: string[] };

/**
 * A reply-test mailbox admitted and recorded SENDING before the first email goes (review SEND-2): its TestSend row, and
 * for a row this job had failed before (sent again now) what it said then, so it can be put back if it never goes.
 */
type ReservedMailbox = {
  address: string;
  messageId: string;
  id: number;
  restore: { error: string | null; sentAt: Date; teamFrom: string | null } | null;
};

/**
 * Review SEND-2: reply-test mailboxes admitted but never handed to Mailgun (sending paused mid-run, an account-level
 * refusal of an earlier one, anything thrown) stop counting at once: a row this run created is removed (as before the
 * fix, such a mailbox has no row), a row sent again goes back to FAILED with what it said before. Only rows still SENDING
 * are touched. Never throws (the run's own outcome or error is what the Owner needs to see).
 */
async function releaseUnsent(rows: readonly ReservedMailbox[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await dbTx(async (tx) => {
      for (const r of rows) {
        if (r.restore) await tx.testSend.updateMany({ where: { id: r.id, status: "SENDING" }, data: { status: "FAILED", ...r.restore } });
        else await tx.testSend.deleteMany({ where: { id: r.id, status: "SENDING" } });
      }
    });
  } catch (err) {
    console.error("[test-send] couldn't release the reply test's unsent mailboxes", err);
  }
}

/**
 * The reply test's emails (job "send.testEmail"): refuses with the replyTestBlockers list (§1.5 step 0), when paused or
 * when today's limit has no room for them. Then one email per test-list address, From the Owner's sending address
 * (shared-From mode: From the shared address with the Owner's display name, Reply-To the Owner's own address, and every
 * TestSend row records `teamFrom`; a saved From address that doesn't fit refuses),
 * with the fixed text, the Owner's signature and the real footer. A mailbox whose Message-ID for this job already has a
 * TestSend that isn't FAILED is skipped ("already sent in this run"), so a rerun after a crash never sends it twice.
 * The pause is checked again before every email: a "Pause all sending" (or an automatic pause) that lands mid-run stops
 * the rest, which are listed in `paused` and keep no TestSend row (review SEND-2: every mailbox is recorded before the
 * first email goes, and the ones that never went are released again, `releaseUnsent`). Nothing is written to Setting
 * "mailgun.unsubscribeTest": the facts come from these rows.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O13, §3.5): no Owner's sending address is needed; every email is From the
 * Owner's display name with the own From (`ownMailboxHeaders`), no Reply-To, and its TestSend row records the own From.
 * With a plan's daily limit (every mode) the run is refused when its emails don't fit the last 24 hours' room
 * (`PLAN_TEXTS.testsFull`), counted in the transaction that records them (review SEND-2).
 */
export async function sendReplyTestEmails(
  ownerId: number,
  opts: { jobId: number; now?: Date; mailgun?: () => Promise<MailgunContextResult> },
): Promise<ReplyTestSendResult> {
  const now = opts.now ?? new Date();
  const gate = await loadGateInputs(now);
  const own = gate.replies === "own-mailbox";
  const blockers = replyTestBlockersFor(gate);
  if (blockers.length > 0) throw new ReplyTestRefusedError(blockers);
  if (!gate.owner || gate.owner.id !== ownerId) throw new ReplyTestRefusedError(["Only the Owner can run the reply test."]);
  if (!own && !gate.ownerAddress) throw new ReplyTestRefusedError([ownerAddressMissingText(gate.teamFrom !== null)]);
  if (gate.teamFromProblem) throw new ReplyTestRefusedError([gate.teamFromProblem]);
  if (own && !gate.ownFrom) throw new ReplyTestRefusedError([OWN_MAILBOX_TEXTS.fromMissing(gate.domain ?? "")]);
  if (gate.pause.paused) throw new ReplyTestRefusedError([pausedTestText(gate.pause.reason)]);

  let ctx: MailgunContext;
  try {
    ctx = await mailgunOrThrow({ mailgun: opts.mailgun });
  } catch (err) {
    throw new ReplyTestRefusedError([err instanceof Error ? err.message : "Connect Mailgun first."]);
  }
  const owner = gate.owner;
  const displayName = (owner.senderDisplayName ?? "").trim() || owner.name;
  // SHARED-FROM-DESIGN §3.4: From "<display name> <shared address>", Reply-To the Owner's own address (per-person: no
  // Reply-To). MAIN-DOMAIN-DESIGN §0.2 rule 6: own-mailbox mode's From line comes from ownMailboxHeaders(), never a Reply-To.
  const teamFrom = own ? gate.ownFrom : gate.teamFrom;
  const headers = own
    ? ownMailboxHeaders({ displayName, from: gate.ownFrom! })
    : senderHeaders({ displayName, senderAddress: gate.ownerAddress!.address, teamFrom });
  const { footer } = await loadRenderSettings();
  const email = replyTestEmail({ signature: owner.signature, footer });
  const mode: SendMode = gate.mode === "LIVE" ? "LIVE" : "TEST";

  // Mailboxes not yet sent in this run; the rest are skipped without a Mailgun call.
  const todo: Array<{ address: string; messageId: string; retryId: number | null }> = [];
  const skipped: string[] = [];
  for (const address of gate.testList) {
    const messageId = replyTestMessageId(opts.jobId, address, ctx.domain);
    const existing = await db.testSend.findUnique({ where: { messageId }, select: { id: true, status: true } });
    if (existing && existing.status !== "FAILED") skipped.push(address);
    else todo.push({ address, messageId, retryId: existing?.id ?? null });
  }
  const today = await getTodayCap(now);
  const testCap = testCapFor(today, gate.planLimits);
  // Review SEND-2: every email of this run is admitted at once, in one transaction that takes the write lock first,
  // counts today's tests and the plan's rolling 24 hours (MAIN-DOMAIN-DESIGN O23), and records every mailbox as SENDING
  // (its fixed Message-ID) before the first one goes to Mailgun. A "Send me a test" clicked meanwhile counts all of
  // them, and they count it: together they never pass the plan's limit. A crash mid-POST still leaves a row that stops a
  // second send of that mailbox.
  const admitted = await dbTx(async (tx) => {
    if (todo.length > 0) {
      const testsNow = await tx.testSend.count({ where: { status: { not: "FAILED" }, sentAt: { gte: today.dayStart, lt: today.dayEnd } } });
      if (today.used - today.testSends + testsNow + todo.length > testCap) throw new ReplyTestRefusedError([testCapText(today, gate.planLimits)]);
      const planLeft = await planTestsLeft(gate.planLimits, now, tx);
      if (planLeft !== null && todo.length > planLeft) throw new ReplyTestRefusedError([PLAN_TEXTS.testsFull(gate.planLimits!.dailyLimit!)]);
    }
    const reserved: ReservedMailbox[] = [];
    const taken: string[] = [];
    for (const item of todo) {
      if (item.retryId !== null) {
        const prev = await tx.testSend.findUnique({ where: { id: item.retryId }, select: { status: true, error: true, sentAt: true, teamFrom: true } });
        if (!prev || prev.status !== "FAILED") {
          taken.push(item.address);
          continue;
        }
        await tx.testSend.update({ where: { id: item.retryId }, data: { status: "SENDING", error: null, sentAt: now, teamFrom } });
        reserved.push({ ...item, id: item.retryId, restore: { error: prev.error, sentAt: prev.sentAt, teamFrom: prev.teamFrom } });
        continue;
      }
      // Another run of this job recorded it meanwhile (the write lock is held, so nobody can between here and the create).
      if (await tx.testSend.findUnique({ where: { messageId: item.messageId }, select: { id: true } })) {
        taken.push(item.address);
        continue;
      }
      const row = await tx.testSend.create({
        data: {
          userId: owner.id,
          to: item.address,
          subject: email.subject,
          mode,
          purpose: "REPLY_TEST",
          status: "SENDING",
          messageId: item.messageId,
          teamFrom,
          sentAt: now,
        },
        select: { id: true },
      });
      reserved.push({ ...item, id: row.id, restore: null });
    }
    return { reserved, taken };
  });
  skipped.push(...admitted.taken);

  const guard = await loadSendGuard();
  let sent = 0;
  let failed = 0;
  const paused: string[] = [];
  let pauseReason = gate.pause.reason;
  const handedOver = new Set<number>();
  try {
    for (const [index, item] of admitted.reserved.entries()) {
      // Sending may have been paused since the run started (by hand, or by a health or Mailgun problem): stop here.
      const pause = await getPauseState();
      if (pause.paused) {
        pauseReason = pause.reason;
        paused.push(...admitted.reserved.slice(index).map((t) => t.address));
        break;
      }
      handedOver.add(item.id);
      try {
        const res = await ctx.sendClient.sendMessage(ctx.domain, {
          from: headers.from,
          ...(headers.replyTo ? { replyTo: headers.replyTo } : {}),
          to: item.address,
          subject: email.subject,
          text: email.text,
          html: email.html,
          messageId: item.messageId,
          tags: ["outreach-test"],
          variables: { test_send_id: String(item.id) },
          testMode: false,
          purpose: "reply-test",
          guard,
        });
        await dbWrite((c) =>
          c.testSend.updateMany({ where: { id: item.id, status: "SENDING" }, data: { status: "SENT", providerId: res.id, error: null } }),
        );
        await noticeRewrittenId(item.messageId, res.id, now);
        sent++;
      } catch (err) {
        await recordFailure(item.id, err, ctx, now, { teamFromWithSendingKey: teamFromWithSendingKey(teamFrom, ctx) });
        failed++;
        // The whole account was refused: the other mailboxes would be refused the same way.
        if (isMailgunError(err) && PAUSE_FOR[err.kind]) break;
      }
    }
  } finally {
    await releaseUnsent(admitted.reserved.filter((r) => !handedOver.has(r.id)));
  }

  if (sent > 0) {
    await logActivity({
      actorId: owner.id,
      type: "test.sent",
      summary: `${owner.name} sent the reply test to ${sent} test mailbox${sent === 1 ? "" : "es"}`,
      data: { jobId: opts.jobId, sent, failed, skipped: skipped.length, paused: paused.length },
    }).catch((err: unknown) => console.error("[test-send] couldn't log the reply test", err));
  }
  // Paused before anything went out: the same refusal as a pause found at the start.
  if (paused.length > 0 && sent === 0 && failed === 0) throw new ReplyTestRefusedError([pausedTestText(pauseReason)]);
  return { sent, failed, skipped, paused };
}

/** "Sending was paused, so 2 mailboxes didn't get the test email. …" (the job summary after a pause mid-run). */
export function replyTestPausedText(count: number): string {
  return `Sending was paused, so ${count} mailbox${count === 1 ? "" : "es"} didn't get the test email. Once sending is resumed, click Send test emails to my test list again.`;
}

/** Job "send.testEmail": payload `{purpose: "REPLY_TEST", userId}`, enqueued with dedupe "send:reply-test", 1 try. */
export const sendTestEmailHandler: JobHandler = async (payload, ctx) => {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (p.purpose !== undefined && p.purpose !== "REPLY_TEST") {
    throw new PlainJobError("This task only sends the reply test's emails.");
  }
  const userId = typeof p.userId === "number" ? p.userId : ctx.createdById;
  if (!userId) throw new PlainJobError("Only the Owner can run the reply test.");
  try {
    const res = await sendReplyTestEmails(userId, { jobId: ctx.jobId });
    const parts = [`Sent the reply test to ${res.sent} mailbox${res.sent === 1 ? "" : "es"}.`];
    if (res.failed) parts.push(`${res.failed} couldn't be sent: see the Reply test section.`);
    if (res.skipped.length) parts.push(`${res.skipped.length} had already been sent.`);
    if (res.paused.length) parts.push(replyTestPausedText(res.paused.length));
    return { summary: parts.join(" "), sent: res.sent, failed: res.failed, skipped: res.skipped.length, paused: res.paused.length };
  } catch (err) {
    if (err instanceof PlainJobError) throw err;
    throw new PlainJobError(
      "The reply test emails couldn't be sent. Try again in a few minutes.",
      redactText(err instanceof Error ? err.message : String(err), await mailgunSecrets()),
    );
  }
};
