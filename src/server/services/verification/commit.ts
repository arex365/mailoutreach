import type { Prisma } from "@/generated/prisma/client";
import { roundUsd } from "@/core/money";
import { checkDecision, type CheckDecision } from "@/core/rules/eligibility";
import type { CheckResult, CheckSource } from "@/core/verification/types";
import { logActivity } from "@/server/activity";
import { dbTx, type Tx } from "@/server/db";
import { excludeUnsent, STOPPABLE_STATES, unsentRecipientIds } from "@/server/services/mail-events/stops";
import { addInvalidSuppression } from "@/server/services/mailgun/suppressions";
import { loadCheckPolicy, RECHECK_LEFT_OUT_TEXT, settleRecheckForPerson } from "./settle";

/**
 * The one door that stores an address-check result (docs/dev/M5-DESIGN.md §2.6, §0.2 rule 7). Called by the check job
 * right after each answer came back, never with a network call inside: the whole commit is one short transaction, so
 * a paid answer is either stored completely or not at all (the job then carries it and commits it first on its next
 * run, "never pays twice").
 */

export type CommitCheckInput = {
  /** null: a typed address (the Settings test) with no person. */
  person: { id: number; companyId: number; email: string; emailNorm: string } | null;
  emailNorm: string;
  result: CheckResult;
  /** An unreadable answer or an unknown `result` string: a charged row, nothing else (§2.3). */
  unreadable: boolean;
  provider: string;
  /** verifier.pricePerCheck, or 0 while the plan's included checks aren't used up (freeLeft > 0). */
  costUsd: number;
  jobId: number | null;
  source: CheckSource;
  now: Date;
  /**
   * A carried answer (`carry.uncommitted`) being stored on a later run or by Stop: store nothing when this job already
   * has a row for this address. A run that stored it and then failed, or a worker that died before saving the smaller
   * carry, hands the same answer over again; it is saved exactly once (§0.2 rule 11).
   */
  once?: boolean;
};

export type CommitCheckOutcome = {
  /** From checkDecision with the current policy; null for a row-only commit. */
  decision: CheckDecision | null;
  /** False when the person's address changed during the call (or they were removed), or for a row-only commit. */
  personUpdated: boolean;
  /** An INVALID suppression was added or upgraded. */
  suppressed: boolean;
  /** Never-emailed recipients left out by it (excludeUnsent). */
  leftOut: number;
  /** Already-emailed recipients stopped by it (reason "invalid"). */
  stopped: number;
  settled: { released: number; leftOut: number };
  /** `once`: this job had already stored this address's answer, so nothing was written. */
  duplicate?: boolean;
};

const ROW_ONLY: CommitCheckOutcome = {
  decision: null,
  personUpdated: false,
  suppressed: false,
  leftOut: 0,
  stopped: 0,
  settled: { released: 0, leftOut: 0 },
};

/** Whose answer it was, in the do-not-email entry's detail ("Mailgun: undeliverable (mailbox_does_not_exist)"). */
function providerName(provider: string): string {
  if (provider === "mailgun" || provider === "mailgun-fake") return "Mailgun";
  if (provider === "fake") return "Test checker";
  if (provider === "zerobounce") return "ZeroBounce";
  if (provider === "neverbounce") return "NeverBounce";
  return provider;
}

/** "Mailgun: undeliverable (mailbox_does_not_exist)": the provider's own verdict word and reason codes. */
export function invalidSuppressionDetail(provider: string, result: CheckResult): string {
  const raw = result.raw && typeof result.raw === "object" ? (result.raw as { result?: unknown }).result : undefined;
  const verdict = typeof raw === "string" && raw.trim() ? raw.trim() : result.status === "INVALID" ? "undeliverable" : "do_not_send";
  const reasons = result.reasons.join(", ").slice(0, 200);
  return `${providerName(provider)}: ${verdict}${reasons ? ` (${reasons})` : ""}`;
}

/** A value from a parsed JSON answer, ready for a Json column (undefined for null/undefined or anything unserialisable). */
function jsonOrUndefined(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : (JSON.parse(text) as Prisma.InputJsonValue);
  } catch {
    return undefined;
  }
}

/** Open recipients with this address in every campaign that never got an email: the ones an INVALID result leaves out. */
async function leaveOutNeverEmailed(tx: Tx, emailNorm: string, reason: string, now: Date): Promise<number> {
  const open = await tx.campaignRecipient.findMany({
    where: { emailNorm, included: true, state: { in: [...STOPPABLE_STATES] } },
    select: { id: true },
  });
  if (open.length === 0) return 0;
  const unsent = await unsentRecipientIds(tx, open.map((r) => r.id));
  return unsent.length > 0 ? excludeUnsent(tx, { recipientIds: unsent, reason, now }) : 0;
}

/**
 * Stores one check result, in one short transaction (§2.6):
 *  1. the `VerificationCheck` row, always (its cost rounded with roundUsd);
 *  2. row only, stop here, for the Settings test (`source "settings"`: never a person, a suppression or a campaign, so
 *     the Owner's own inbox can't land on the do-not-email list) and for an unreadable answer (not a verdict);
 *  3. the person's latest result, compare-and-set on `{id, emailNorm, deletedAt: null}` (the address didn't change
 *     during the call): status, risk, `verifiedAt`, provider, the throwaway flag, and unknowns in a row (UNKNOWN adds
 *     one, anything else resets to 0). No match: the paid row stays and the person is left alone;
 *  4. INVALID or DO_NOT_SEND: the address's never-emailed open recipients are left out ("Left out: the address check
 *     said this address doesn't exist" / "… not to email this address", D24), then `addInvalidSuppression` puts it
 *     on the do-not-email list (never pushed to Mailgun) and stops everyone already emailed (`invalid`), and one
 *     `person.checked` activity says so. This is about the address, so it applies even when step 3 found the address
 *     changed;
 *  5. the person's RECHECK recipients are settled (`settleRecheckForPerson`).
 * Other results write no activity (a 5,000-address run would flood the Activity page): the run's `verify.run` entry
 * sums them up. The verification policy is read before the transaction.
 */
export async function commitCheckResult(input: CommitCheckInput): Promise<CommitCheckOutcome> {
  const person = input.person;
  const rowOnly = input.source === "settings" || input.unreadable || person === null;
  const policy = rowOnly ? null : await loadCheckPolicy();
  const emailNorm = input.emailNorm.trim().toLowerCase();
  const { result, now } = input;

  return dbTx(async (tx) => {
    if (input.once && input.jobId !== null) {
      // Inside the transaction (it holds the write lock), so two hand-overs of one answer can't both store it.
      const stored = await tx.verificationCheck.findFirst({ where: { jobId: input.jobId, emailNorm }, select: { id: true } });
      if (stored) return { ...ROW_ONLY, settled: { ...ROW_ONLY.settled }, duplicate: true };
    }
    await tx.verificationCheck.create({
      data: {
        personId: person?.id ?? null,
        emailNorm,
        provider: input.provider,
        status: result.status,
        risk: result.risk,
        isRole: result.isRole,
        isDisposable: result.isDisposable,
        didYouMean: result.didYouMean ? result.didYouMean.slice(0, 512) : null,
        reasons: result.reasons,
        raw: jsonOrUndefined(result.raw),
        costUsd: roundUsd(input.costUsd),
        jobId: input.jobId,
        source: input.source,
        checkedAt: now,
      },
    });
    if (rowOnly || !person || !policy) return { ...ROW_ONLY, settled: { ...ROW_ONLY.settled } };

    const decision = checkDecision(result.status, result.risk, policy, { disposable: result.isDisposable });
    const updated = await tx.person.updateMany({
      where: { id: person.id, emailNorm, deletedAt: null },
      data: {
        verificationStatus: result.status,
        verificationRisk: result.risk,
        verifiedAt: now,
        verificationProvider: input.provider,
        verificationDisposable: result.isDisposable,
        verificationUnknowns: result.status === "UNKNOWN" ? { increment: 1 } : 0,
      },
    });

    let suppressed = false;
    let leftOut = 0;
    let stopped = 0;
    if (result.status === "INVALID" || result.status === "DO_NOT_SEND") {
      const invalid = result.status === "INVALID";
      leftOut = await leaveOutNeverEmailed(tx, emailNorm, invalid ? RECHECK_LEFT_OUT_TEXT.undeliverable : RECHECK_LEFT_OUT_TEXT.doNotSend, now);
      const sup = await addInvalidSuppression(tx, {
        emailNorm,
        detail: invalidSuppressionDetail(input.provider, result),
        personId: person.id,
        companyId: person.companyId,
        now,
      });
      suppressed = sup.changed;
      stopped = sup.stopped;
      const shown = person.email || emailNorm;
      await logActivity(
        {
          actorId: null,
          type: "person.checked",
          summary: invalid
            ? `${shown} doesn't exist; it's on the do-not-email list now`
            : `The address check says not to email ${shown}; it's on the do-not-email list now`,
          companyId: person.companyId,
          personId: person.id,
          data: { email: emailNorm, status: result.status, provider: input.provider, source: input.source, jobId: input.jobId, leftOut, stopped },
        },
        tx,
      );
    }

    const settled = await settleRecheckForPerson(tx, person.id, now, { policy });
    return { decision, personUpdated: updated.count === 1, suppressed, leftOut, stopped, settled };
  });
}
