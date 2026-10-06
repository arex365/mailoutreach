"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { checkMatchesMode } from "@/core/dns/check-state";
import { parseDomainCheckState } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireOwnerAction } from "@/lib/auth/dal";
import { teamFromDomainOf, testOriginalTexts } from "@/core/reply-test";
import { OWN_REPLY_TEST_TEXTS } from "@/core/sending/own-mailbox";
import { logActivity } from "@/server/activity";
import { enqueueJob } from "@/server/jobs";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import {
  decideReplyTest,
  loadGateInputs,
  replyTestBlockersFor,
  ReplyTestError,
  saveReplyTestAnswers,
  saveReplyTestOriginal,
  setLeaveOutMailto,
  switchUnsubscribeSetup,
} from "@/server/services/reply-test";
import { getSetting, setSetting } from "@/server/settings";
import { readTyped } from "@/server/state-typed";

/**
 * Settings › Domain checklist (M3-DESIGN §5.3). Owner-only: Apply recommended settings, Check again, the reply test
 * (send, answers, result, setup) and the optional domain age. The checks themselves run in the background worker.
 * Shared From address (SHARED-FROM-DESIGN §3.4): the answers gain the placement and DMARC questions (with a pasted
 * original read for DMARC, never stored), and the pasted original of one test email has its own action.
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.5, §8 P4): the answers also accept the unsubscribe-by-email answer
 * (`mailtoArrived`); the original's lines are own-mailbox mode's; a switch to Setup B is refused with its sentence.
 */

const CHECK_AGAIN_EVERY_MS = 60_000;
const CHECKED_JUST_NOW = "Checked just now. Check again in a minute.";

async function connectedOrThrow(): Promise<void> {
  const gate = await loadGateInputs();
  if (gate.practiceCopy) throw new UserError("The practice copy never talks to Mailgun.");
  if (!gate.connected) throw new UserError("Connect Mailgun first. Open Sending & Mailgun, choose the region and paste your API key.");
}

/** Queues "Apply recommended settings" (one at a time); the page follows its steps live. */
export async function applyRecommendedSettingsAction(): Promise<ActionResult<{ jobId: number }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    await connectedOrThrow();
    const job = await enqueueJob({
      type: "mailgun.applySettings",
      payload: { step: "all" },
      dedupeKey: "mailgun:apply",
      priority: 30,
      maxAttempts: 1,
      createdById: user.id,
    });
    revalidatePath("/settings/domain");
    return { jobId: job.id };
  }, "Applying the recommended settings. Each step shows below as it finishes.");
}

/** "Check again": a fresh domain check with Mailgun's own re-check (at most once a minute). */
export async function checkDomainAgainAction(): Promise<ActionResult<{ jobId: number }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    await connectedOrThrow();
    const check = (await readTyped(STATE_KEYS.domainCheck, parseDomainCheckState)).value;
    // MAIN-DOMAIN-DESIGN O36: a check made for the other way of sending doesn't count as "just checked".
    const sameMode = checkMatchesMode(check, (await loadTeamFrom()).replies);
    const last = check.checkedAt && sameMode ? Date.parse(check.checkedAt) : NaN;
    if (!Number.isNaN(last) && Date.now() - last < CHECK_AGAIN_EVERY_MS) throw new UserError(CHECKED_JUST_NOW);
    const job = await enqueueJob({
      type: "mailgun.checkDomain",
      payload: { verify: true },
      dedupeKey: "mailgun:domain-check",
      priority: 20,
      createdById: user.id,
    });
    revalidatePath("/settings/domain");
    return { jobId: job.id };
  }, "Checking your domain. The rows update in a minute.");
}

/** "Send test emails to my test list": refused with what's missing (§1.5 step 0); a double click queues one job. */
export async function sendReplyTestAction(): Promise<ActionResult<{ jobId: number }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const gate = await loadGateInputs();
    const blockers = replyTestBlockersFor(gate);
    if (blockers.length > 0) throw new UserError(`Not yet: ${blockers.join(" ")}`);
    const job = await enqueueJob({
      type: "send.testEmail",
      payload: { purpose: "REPLY_TEST", userId: user.id },
      dedupeKey: "send:reply-test",
      priority: 60,
      maxAttempts: 1,
      createdById: user.id,
    });
    revalidatePath("/settings/domain");
    return { jobId: job.id };
  }, "Sending the test emails. Reply from each mailbox once they arrive.");
}

const yesNoUnsure = z.enum(["pass", "fail", "unsure"]);

/** One mailbox's answers; every field is optional: absent = left as saved (the page sends only what changed). */
const answerFields = {
  inboxOk: z.boolean().nullable().optional(),
  authOk: yesNoUnsure.nullable().optional(),
  // Shared-From mode only (SHARED-FROM-DESIGN §3.4).
  placementOk: z.boolean().nullable().optional(),
  dmarcOk: yesNoUnsure.nullable().optional(),
};

/**
 * The round the page showed (REPLIES-03): the sending domain, the shared From address and the setup, and in shared-From
 * mode when the From address or the sending domain last changed (`since`, an ISO time).
 */
const roundSchema = z.object({
  domain: z.string().max(253).nullable(),
  from: z.string().max(320).nullable(),
  setup: z.enum(["A", "B", "C"]),
  since: z.string().max(40).nullable().optional(),
});

const answersSchema = z.object({
  mailboxes: z
    .array(
      z.object({
        address: z.string().max(320),
        ...answerFields,
        pastedHeaders: z.string().max(200_000).optional().nullable(),
        dmarcPasted: z.string().max(200_000).optional().nullable(),
        // The answers as the page showed them before the click (SECURITY-1: compare-and-set).
        was: z.object(answerFields).optional(),
      }),
    )
    .max(20),
  headersOk: z.boolean().nullable().optional(),
  // Own-mailbox mode (MAIN-DOMAIN-DESIGN O13): the unsubscribe-by-email question; absent = unchanged.
  mailtoArrived: z.boolean().nullable().optional(),
  round: roundSchema.nullable().optional(),
});

/**
 * Saves the answers (pasted headers and originals are read, never stored). Refused with a plain sentence when the page
 * belongs to an older round or a DMARC answer was read from a pasted original since the page was loaded.
 */
export async function saveReplyTestAnswersAction(input: z.infer<typeof answersSchema>): Promise<
  ActionResult<{
    authFromHeaders: Record<string, "pass" | "fail" | null>;
    dmarcFromHeaders: Record<string, "pass" | "fail" | null>;
  }>
> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(answersSchema, input);
    try {
      const res = await saveReplyTestAnswers({ id: user.id, name: user.name }, data);
      revalidatePath("/settings/domain");
      // A spam placement answer changes the go-live card (its recommendation and the dialog's tick).
      revalidatePath("/settings/sending");
      return res;
    } catch (err) {
      if (err instanceof ReplyTestError) throw new UserError(err.message);
      throw err;
    }
  }, "Answers saved.");
}

const originalSchema = z.object({
  pasted: z.string().trim().min(1, { error: "Paste the test email's original first." }).max(200_000),
  address: z.string().max(320).optional().nullable(),
});

/**
 * Shared-From mode (SHARED-FROM-DESIGN F25): "Read the original" — reads one pasted original of a reply-test email and
 * stores what it read (never the text); returns the lines to show, and the mailbox and DMARC result it set, so the page
 * shows that DMARC answer at once (SECURITY-1). Refused with a plain sentence when it isn't one of the current test
 * emails or shows another From address.
 */
export async function saveReplyTestOriginalAction(
  input: z.infer<typeof originalSchema>,
): Promise<ActionResult<{ lines: Array<{ ok: boolean; text: string }>; address: string; dmarc: "pass" | "fail" | null }>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(originalSchema, input);
    try {
      const { original, ownMailbox } = await saveReplyTestOriginal(
        { id: user.id, name: user.name },
        { pasted: data.pasted, address: data.address ?? null },
      );
      revalidatePath("/settings/domain");
      revalidatePath("/settings/sending");
      return {
        // Own-mailbox mode (§3.5): the From's domain is the sending domain, and the lines are own-mailbox mode's.
        lines: ownMailbox
          ? testOriginalTexts(original, { from: original.from, d: original.domain, org: original.domain, ownMailbox: true })
          : testOriginalTexts(original, { from: original.from, d: original.domain, org: teamFromDomainOf(original.from) ?? original.domain }),
        address: original.address,
        dmarc: original.dmarc,
      };
    } catch (err) {
      if (err instanceof ReplyTestError) throw new UserError(err.message);
      throw err;
    }
  }, "The original is read. The lines below say what it shows.");
}

const decideSchema = z.object({ answers: answersSchema.optional(), round: roundSchema.nullable().optional() });

/**
 * "Save the result": saves the answers given (the page gives none: each answer is saved when it's clicked), then stores
 * passed or failed from the saved answers; "not finished" saves nothing. `round`: refused when the page belongs to an
 * older round (REPLIES-03).
 */
export async function decideReplyTestAction(
  input: z.infer<typeof decideSchema> = {},
): Promise<ActionResult<{ status: "passed" | "failed" }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const data = parseInput(decideSchema, input ?? {});
    const actor = { id: user.id, name: user.name };
    let verdict: Awaited<ReturnType<typeof decideReplyTest>>;
    try {
      if (data.answers) await saveReplyTestAnswers(actor, { ...data.answers, round: data.answers.round ?? data.round ?? null });
      verdict = await decideReplyTest(actor, new Date(), { round: data.round ?? null });
    } catch (err) {
      if (err instanceof ReplyTestError) throw new UserError(err.message);
      throw err;
    }
    revalidatePath("/settings/domain");
    revalidatePath("/settings/sending");
    if (verdict.status === "incomplete") {
      throw new UserError(`The reply test isn't finished yet, so nothing was saved. ${verdict.missing.join(" ")}`);
    }
    message =
      verdict.status === "passed"
        ? "Saved: the reply test passed. Live campaigns can start."
        : "Saved: the reply test failed. Live campaigns stay locked.";
    return { status: verdict.status };
  });
  return res.ok ? { ...res, message } : res;
}

const setupSchema = z.object({ setup: z.enum(["A", "B"], { error: "Choose Setup A or Setup B." }) });

/**
 * "Try Setup B (check only)" / "Back to Setup A": starts the reply test again with that setup. Own-mailbox mode
 * (MAIN-DOMAIN-DESIGN §3.5): Setup B is refused (`OWN_MAILBOX_TEXTS.setupAOnly`); **Back to normal** switches to A.
 */
export async function switchUnsubscribeSetupAction(input: z.infer<typeof setupSchema>): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { setup } = parseInput(setupSchema, input);
    try {
      await switchUnsubscribeSetup({ id: user.id, name: user.name }, setup);
    } catch (err) {
      if (err instanceof ReplyTestError) throw new UserError(err.message);
      throw err;
    }
    message =
      setup === "B"
        ? "Switched to Setup B (check only). Mailgun's unsubscribe handling is being switched off; send the test emails again once Apply has finished."
        : "Back to Setup A. Mailgun's unsubscribe handling is being switched on again.";
    revalidatePath("/settings/domain");
    return null;
  });
  return res.ok ? { ...res, message } : res;
}

const leaveOutSchema = z.object({ leaveOut: z.boolean(), round: roundSchema.nullable().optional() });

/**
 * Own-mailbox mode's last resort (review REPLIES-03): "Leave out unsubscribe by email" / "Offer unsubscribe by email
 * again". Owner-only; starts the reply test's proof again (`setLeaveOutMailto`). Refused with a plain sentence outside
 * own-mailbox mode, for an older round, or while a test or live campaign is scheduled, running or paused.
 */
export async function setLeaveOutMailtoAction(input: z.infer<typeof leaveOutSchema>): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { leaveOut, round } = parseInput(leaveOutSchema, input);
    try {
      await setLeaveOutMailto({ id: user.id, name: user.name }, { leaveOut, round: round ?? null });
    } catch (err) {
      if (err instanceof ReplyTestError) throw new UserError(err.message);
      throw err;
    }
    message = leaveOut ? OWN_REPLY_TEST_TEXTS.leaveOutDone : OWN_REPLY_TEST_TEXTS.offerAgainDone;
    revalidatePath("/settings/domain");
    revalidatePath("/settings/sending");
    return null;
  });
  return res.ok ? { ...res, message } : res;
}

const ageSchema = z.object({ date: z.string().max(20).nullable() });

function todayIn(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The optional "When did you buy <domain>?" (Domain age row); empty clears it. */
export async function saveDomainAgeAction(input: z.infer<typeof ageSchema>): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const { date } = parseInput(ageSchema, input);
    const value = (date ?? "").trim() || null;
    if (value !== null) {
      if (!isRealDate(value)) throw new UserError("Pick a date, for example 2026-09-01.", { date: ["Pick a date, for example 2026-09-01."] });
      if (value > todayIn(user.timeZone)) {
        throw new UserError("Pick a date that isn't in the future.", { date: ["Pick a date that isn't in the future."] });
      }
    }
    const before = await getSetting("mailgun.domainRegisteredOn");
    if (before !== value) {
      await setSetting("mailgun.domainRegisteredOn", value, user.id);
      // Shared-From mode (SHARED-FROM-DESIGN §3.2): the Domain age row is about the From domain.
      const org = teamFromDomainOf((await loadTeamFrom()).address);
      const whose = org ? `${org}'s` : "the sending domain's";
      await logActivity({
        actorId: user.id,
        type: "settings.updated",
        summary: value ? `${user.name} set ${whose} purchase date to ${value}` : `${user.name} cleared ${whose} purchase date`,
        data: { key: "mailgun.domainRegisteredOn", to: value },
      });
      await enqueueJob({ type: "mailgun.checkDomain", payload: {}, dedupeKey: "mailgun:domain-check", priority: 20, createdById: user.id });
    }
    revalidatePath("/settings/domain");
    return null;
  }, "Saved. The Domain age row updates in a minute.");
}
