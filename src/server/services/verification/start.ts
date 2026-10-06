import type { Prisma } from "@/generated/prisma/client";
import { parseEmail } from "@/core/email-address";
import { plural } from "@/core/text";
import { isRealProvider } from "@/core/verification/policy";
import { MAX_CHECKS_PER_RUN, UNKNOWN_RECHECK_AFTER_MS, type VerifyRunPayload } from "@/core/verification/types";
import {
  CAMPAIGN_COUNT_CHANGED_TEXT,
  COUNT_CHANGED_TEXT,
  checkedTodayText,
  monthlyLimitRefusal,
  tooManyChecksText,
} from "@/core/verification/words";
import { db, dbWrite } from "@/server/db";
import { enqueueJob, requestJobCancel } from "@/server/jobs";
import { isLaunching, LAUNCHING_TEXT } from "@/server/services/campaigns/launch";
import { realCheckProviders } from "@/server/services/eligibility";
import { commitCheckResult } from "./commit";
import { estimateFor, loadCheckPricing } from "./estimate";
import { getChecksPause } from "./pause";
import { campaignRunKey, CheckRunError, NOT_A_CHECK_RUN, readVerifyRunCarry, readVerifyRunPayload, VERIFY_JOB_TYPE } from "./runs";
import { campaignCheckTargets, contactsCheckTargets } from "./select";
import { monthlyCheckLimit } from "./spend";

export { CheckRunError } from "./runs";

/**
 * Starting and stopping check runs (M5-DESIGN §2.5, §2.9, §6.11). A start re-counts on fresh data and refuses in
 * plain words (CheckRunError) while checks are paused, when no key is ready, when the count the person confirmed
 * changed, when a Contacts start has more than 5,000 addresses, when the panel's address was checked less than 24
 * hours ago, when the campaign is being launched (Verify step), and when the estimate would pass this office month's
 * check limit. Then it enqueues one `verify.addresses` job with a static list of person ids (D12) and the priority and
 * dedupe key of its source. Members may start checks (SPEC §1); only the Settings test is the Owner's, and it refuses
 * while a test of another address is still queued or running (one dedupe key for every test).
 */

export type CheckRunActor = { id: number; name: string; role: "OWNER" | "MEMBER" };

export type StartCheckRunInput =
  | { source: "wizard"; campaignId: number; confirmedCount: number }
  | { source: "contacts"; companyIds: number[]; recheckRecent: boolean; confirmedCount: number }
  | { source: "list"; listId: number; recheckRecent: boolean; confirmedCount: number }
  | { source: "panel"; personId: number }
  | { source: "settings"; address: string };

/** Priority, dedupe key and tries per source (M5-DESIGN §2.5); the re-check sweep (P6) uses the "recheck" row. */
export function checkRunJobOptions(payload: VerifyRunPayload): { priority: number; dedupeKey: string | undefined; maxAttempts: number } {
  switch (payload.source) {
    case "recheck":
      return { priority: 30, dedupeKey: "verify:recheck", maxAttempts: 3 };
    case "panel":
      return { priority: 25, dedupeKey: `verify:person:${payload.personIds[0] ?? 0}`, maxAttempts: 3 };
    case "settings":
      return { priority: 25, dedupeKey: "verify:settings", maxAttempts: 1 };
    case "wizard":
      return { priority: 20, dedupeKey: campaignRunKey(payload.campaignId), maxAttempts: 3 };
    default:
      return { priority: 10, dedupeKey: undefined, maxAttempts: 3 };
  }
}

const PERSON_GONE = "This person isn't in Contacts any more. Refresh the page to see the latest.";
const NOTHING_TO_CHECK = "No addresses here need a check.";
/** The Settings test while a test of a different address is still queued or running (its result would be shown). */
export const OTHER_TEST_RUNNING_TEXT = "A test of another address hasn't finished yet. Try again in a minute.";

/** An address as the dedupe comparison sees it (case and spaces don't make it another address). */
function addressKey(address: string): string {
  return parseEmail(address)?.norm ?? address.trim().toLowerCase();
}

/** Who a start checks, as its job payload, and how many addresses that is. */
async function planRun(actor: CheckRunActor, input: StartCheckRunInput, now: Date): Promise<{ payload: VerifyRunPayload; count: number }> {
  switch (input.source) {
    case "wizard": {
      // The launch leaves out whoever still needs a check: a run queued now would pay for people it already left out.
      if (isLaunching(input.campaignId)) throw new CheckRunError(LAUNCHING_TEXT, "launching");
      const t = await campaignCheckTargets(input.campaignId, now);
      if (t.campaignStatus !== "DRAFT") {
        throw new CheckRunError("This campaign has already been launched, so its Verify step is closed.", "not-draft");
      }
      const count = t.personIds.length;
      if (count === 0) throw new CheckRunError(NOTHING_TO_CHECK, "nothing");
      if (input.confirmedCount !== count) throw new CheckRunError(CAMPAIGN_COUNT_CHANGED_TEXT, "count-changed");
      return { payload: { source: "wizard", campaignId: input.campaignId, personIds: t.personIds, confirmedCount: count }, count };
    }
    case "contacts":
    case "list": {
      const t = await contactsCheckTargets(input.source === "list" ? { listId: input.listId } : { companyIds: input.companyIds }, {
        now,
        recheckRecent: input.recheckRecent,
      });
      const count = t.personIds.length;
      if (count > MAX_CHECKS_PER_RUN) throw new CheckRunError(tooManyChecksText(count), "too-many");
      if (count === 0) throw new CheckRunError(NOTHING_TO_CHECK, "nothing");
      if (input.confirmedCount !== count) throw new CheckRunError(COUNT_CHANGED_TEXT, "count-changed");
      return {
        payload: {
          source: input.source,
          personIds: t.personIds,
          confirmedCount: count,
          recheckRecent: input.recheckRecent,
          listId: input.source === "list" ? input.listId : null,
        },
        count,
      };
    }
    case "panel": {
      const person = await db.person.findUnique({
        where: { id: input.personId },
        select: {
          id: true,
          email: true,
          emailNorm: true,
          deletedAt: true,
          verifiedAt: true,
          verificationProvider: true,
          company: { select: { deletedAt: true } },
        },
      });
      if (!person || person.deletedAt || person.company.deletedAt) throw new CheckRunError(PERSON_GONE, "person-gone");
      if (!person.email || !person.emailNorm) throw new CheckRunError("No email address to check.", "no-email");
      // A real check of this address in the last 24 hours: Mailgun would answer the same and charge again (§10.3 item 22).
      const since = new Date(now.getTime() - UNKNOWN_RECHECK_AFTER_MS);
      const real = realCheckProviders();
      const recentRow = await db.verificationCheck.findFirst({
        where: { emailNorm: person.emailNorm, provider: { in: [...real] }, checkedAt: { gt: since } },
        select: { id: true },
      });
      const recentOnPerson = person.verifiedAt !== null && person.verifiedAt > since && isRealProvider(person.verificationProvider, real);
      if (recentRow || recentOnPerson) throw new CheckRunError(checkedTodayText(person.email), "checked-today");
      return { payload: { source: "panel", personIds: [person.id], confirmedCount: 1, recheckRecent: true, listId: null }, count: 1 };
    }
    case "settings": {
      if (actor.role !== "OWNER") throw new CheckRunError("Only the Owner can test address checks.", "owner-only");
      const parsed = parseEmail(input.address);
      if (!parsed) throw new CheckRunError("Enter a valid email address, like name@example.com.", "bad-address");
      return { payload: { source: "settings", address: parsed.email }, count: 1 };
    }
  }
}

/**
 * Starts a check run and returns its job and how many addresses it checks. A source with a dedupe key (the Verify
 * step, the panel, the Settings test) returns the run already queued or running for it instead of a second one.
 */
export async function startCheckRun(
  actor: CheckRunActor,
  input: StartCheckRunInput,
  opts: { now?: Date } = {},
): Promise<{ jobId: number; count: number }> {
  const now = opts.now ?? new Date();
  const pause = await getChecksPause(now);
  if (pause.paused) {
    throw new CheckRunError(pause.text || "Address checks are paused. Open Settings › Deliverability to see why.", "paused");
  }
  const pricing = await loadCheckPricing(now);
  if (pricing.checker.notReady) throw new CheckRunError(pricing.checker.notReady, "not-ready");

  const { payload, count } = await planRun(actor, input, now);

  const estimate = estimateFor(pricing, count);
  const monthly = await monthlyCheckLimit(estimate.aboutUsd, { now, spentUsd: pricing.spentUsd });
  if (monthly.wouldPass) {
    throw new CheckRunError(
      monthlyLimitRefusal({ limitUsd: monthly.limitUsd, spentUsd: monthly.spentUsd, isOwner: actor.role === "OWNER" }),
      "monthly-limit",
    );
  }

  const o = checkRunJobOptions(payload);
  const job = await enqueueJob({
    type: VERIFY_JOB_TYPE,
    payload: payload as unknown as Prisma.InputJsonValue,
    runAt: now,
    priority: o.priority,
    maxAttempts: o.maxAttempts,
    dedupeKey: o.dedupeKey,
    createdById: actor.id,
  });
  // A dedupe hit returns the run already going on: report what that one checks.
  const running = readVerifyRunPayload(job.payload);
  // The Settings test has one run at a time: never hand back another address's test as if it were this one's.
  if (payload.source === "settings" && running?.source === "settings" && addressKey(running.address) !== addressKey(payload.address)) {
    throw new CheckRunError(OTHER_TEST_RUNNING_TEXT, "test-busy");
  }
  const runningCount = running && "personIds" in running ? running.personIds.length : running?.source === "settings" ? 1 : count;
  return { jobId: job.id, count: runningCount };
}

/**
 * Answers a run had paid for but couldn't store yet (`carry.uncommitted`: a failed commit defers the run for a minute,
 * M5-DESIGN §2.5) are stored when Stop cancels that waiting run, so the people's results and this month's check spend
 * stay right (§0.2 rule 11: every paid call is counted). Race-free: the job is already CANCELLED, so the worker can't
 * claim it and store them too. What still can't be stored stays in the cancelled job's carry. Returns how many were
 * stored; a failure never undoes the stop.
 */
export async function storeStrandedAnswers(jobId: number, now: Date = new Date()): Promise<number> {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, payload: true, result: true } });
  if (!job || job.status !== "CANCELLED") return 0;
  const result = job.result && typeof job.result === "object" && !Array.isArray(job.result) ? (job.result as Record<string, unknown>) : {};
  const carry = readVerifyRunCarry(result.carry ?? null);
  if (carry.uncommitted.length === 0) return 0;
  const source = readVerifyRunPayload(job.payload)?.source ?? "contacts";
  const left: typeof carry.uncommitted = [];
  let stored = 0;
  for (const item of carry.uncommitted) {
    try {
      const person =
        source !== "settings" && typeof item.personId === "number"
          ? await db.person.findUnique({ where: { id: item.personId }, select: { id: true, companyId: true, email: true } })
          : null;
      const out = await commitCheckResult({
        person: person ? { id: person.id, companyId: person.companyId, email: person.email ?? item.emailNorm, emailNorm: item.emailNorm } : null,
        emailNorm: item.emailNorm,
        result: item.result,
        unreadable: item.unreadable === true,
        provider: typeof item.provider === "string" && item.provider ? item.provider : "mailgun",
        costUsd: typeof item.costUsd === "number" && Number.isFinite(item.costUsd) && item.costUsd >= 0 ? item.costUsd : 0,
        jobId,
        source,
        now,
        // The run may have stored it already and died before saving its smaller carry: never twice.
        once: true,
      });
      if (!out.duplicate) stored += 1;
    } catch {
      // Never the address or the database's text in a log line (§0.2 rule 9): the job id says where to look.
      console.error(`[checks] a paid answer of the stopped task #${jobId} couldn't be saved; it stays on the task`);
      left.push(item);
    }
  }
  const carryOut = { ...(result.carry && typeof result.carry === "object" ? (result.carry as Record<string, unknown>) : {}), uncommitted: left };
  await dbWrite((c) =>
    c.job.updateMany({
      where: { id: jobId, status: "CANCELLED" },
      data: { result: JSON.parse(JSON.stringify({ ...result, carry: carryOut })) as Prisma.InputJsonValue },
    }),
  );
  return stored;
}

/**
 * The Stop button of a check run (M5-DESIGN §0.2 rule 14): only a `verify.addresses` job can be stopped here, so an
 * id of any other job (a backup, a Mailgun task) is refused and left alone. A queued run is cancelled at once (answers
 * it had paid for but not stored yet are stored first, storeStrandedAnswers); a running one stops at its next safe
 * point, after the checks already running have finished.
 */
export async function stopCheckRun(actor: { id: number; name: string }, jobId: number, opts: { now?: Date } = {}): Promise<{ message: string }> {
  if (!Number.isInteger(jobId) || jobId <= 0) throw new CheckRunError(NOT_A_CHECK_RUN, "not-a-check-run");
  const res = await requestJobCancel(jobId, { type: VERIFY_JOB_TYPE, now: opts.now });
  switch (res) {
    case "not-found":
      throw new CheckRunError(NOT_A_CHECK_RUN, "not-a-check-run");
    case "cancelled": {
      try {
        await storeStrandedAnswers(jobId, opts.now ?? new Date());
      } catch {
        console.error(`[checks] couldn't look for paid answers of the stopped task #${jobId}`);
      }
      // A run that was waiting between passes (or for a pause) had already checked some: say so, as the job does.
      const job = await db.job.findUnique({ where: { id: jobId }, select: { progressDone: true, progressTotal: true } });
      if (job && job.progressDone > 0 && job.progressTotal > 0) {
        return { message: `Stopped after ${job.progressDone.toLocaleString("en-US")} of ${plural(job.progressTotal, "address", "addresses")}.` };
      }
      return { message: "Address checks stopped before they started." };
    }
    case "requested":
      return { message: "Stopping the address checks. The checks already running finish first." };
    default:
      return { message: "These address checks had already finished." };
  }
}
