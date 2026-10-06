import {
  checkDecision,
  DEFAULT_VERIFICATION_POLICY,
  policyBlockedText,
  type RiskValue,
  type VerificationPolicy,
  type VerificationStatusValue,
} from "@/core/rules/eligibility";
import { MAX_UNKNOWNS_IN_A_ROW } from "@/core/verification/types";
import type { Tx } from "@/server/db";
import { excludeUnsent } from "@/server/services/mail-events/stops";
import { applyPendingPossibleReplyHolds, holdForOutageIfCompanyHeld } from "@/server/services/sequences/holds";
import { getSetting } from "@/server/settings";

/**
 * RECHECK: a launched recipient whose address got one "unknown" waits for a second check 24 hours later
 * (docs/dev/M5-DESIGN.md §2.7). It is entered only by `moveToRecheck` (the sending loop, before the first email) or by
 * the launch itself, and left only by `settleRecheckForPerson` (after that person got a new result, or when the
 * policy says to skip unknowns) or by the re-check sweep's stale rule. Nothing is sent while it waits: the sending
 * gates never pick a RECHECK recipient's emails (M4 `WAITING_RECIPIENT_STATES`).
 */

/** Why a RECHECK recipient is left out ("Left out: …" on the campaign page, D24). */
export const RECHECK_LEFT_OUT_TEXT = {
  /** The second check said "unknown" again (or three in a row: no more paid tries). */
  couldntBeChecked: "Address couldn't be checked",
  /** The address was edited (the check result was cleared with it) or differs from the one the email was made for. */
  emailChanged: "The email address changed after this email was prepared",
  personRemoved: "This person was removed from the company",
  undeliverable: "The address check said this address doesn't exist",
  doNotSend: "The address check said not to email this address",
} as const;

/** Only real sending waits for re-checks: dry runs never re-check (D6). */
const RECHECK_MODES = ["TEST", "LIVE"] as const;

/**
 * Setting "verification.policy" merged over the defaults (a policy saved before Milestone 5 has no `disposable` row;
 * a value that isn't text is ignored). `checkDecision` reads anything but "send" (or "recheck" for unknowns) as block.
 */
export async function loadCheckPolicy(): Promise<VerificationPolicy> {
  const stored: unknown = await getSetting("verification.policy");
  const out: VerificationPolicy = { ...DEFAULT_VERIFICATION_POLICY };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of Object.keys(out) as Array<keyof VerificationPolicy>) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === "string") out[key] = v;
    }
  }
  return out;
}

/**
 * The sending loop found `check-waiting` before a recipient's first email (§2.8 rule 6): compare-and-set SCHEDULED with
 * no `recheckAt` yet → RECHECK with `recheckAt` (a recipient that already waited once is never put back: a second
 * "unknown" leaves it out instead). The launch writes RECHECK itself, with the same fields. Returns true when it moved.
 */
export async function moveToRecheck(tx: Tx, input: { recipientId: number; recheckAt: Date; now: Date }): Promise<boolean> {
  const res = await tx.campaignRecipient.updateMany({
    where: { id: input.recipientId, state: "SCHEDULED", recheckAt: null },
    data: { state: "RECHECK", recheckAt: input.recheckAt },
  });
  return res.count === 1;
}

type RecheckRow = { id: number; campaignId: number; companyId: number; emailNorm: string; recheckAt: Date | null };
type PersonNow = {
  emailNorm: string | null;
  deletedAt: Date | null;
  verificationStatus: VerificationStatusValue | null;
  verificationRisk: RiskValue | null;
  verifiedAt: Date | null;
  verificationDisposable: boolean;
  verificationUnknowns: number;
};

/** What happens to one RECHECK recipient given the person's result now (§2.7 settle table): stay, release, or a reason. */
function settleOne(row: RecheckRow, person: PersonNow | null, policy: VerificationPolicy): "stay" | "release" | string {
  if (!person || person.deletedAt) return RECHECK_LEFT_OUT_TEXT.personRemoved;
  const status = person.verificationStatus;
  if (!status || !person.verifiedAt || !person.emailNorm || person.emailNorm !== row.emailNorm) return RECHECK_LEFT_OUT_TEXT.emailChanged;
  const risk = person.verificationRisk;
  const decision = checkDecision(status, risk, policy, { disposable: person.verificationDisposable });
  switch (decision) {
    case "send":
      return "release";
    case "recheck": {
      // Due and done: the result is at least as new as the re-check time (no time set: treat it as done, so nobody
      // waits for ever). Three unknowns in a row: no more paid tries, the sweep never re-checks them (§2.5 step 4).
      const done = row.recheckAt === null || person.verifiedAt.getTime() >= row.recheckAt.getTime();
      return done || person.verificationUnknowns >= MAX_UNKNOWNS_IN_A_ROW ? RECHECK_LEFT_OUT_TEXT.couldntBeChecked : "stay";
    }
    case "undeliverable":
      return RECHECK_LEFT_OUT_TEXT.undeliverable;
    case "do-not-send":
      return RECHECK_LEFT_OUT_TEXT.doNotSend;
    default:
      // "block": the policy skips it (also "unknown" when "No answer" is set to Skip: no paid re-check).
      return policyBlockedText(status, risk, { disposable: person.verificationDisposable });
  }
}

/**
 * Settles every RECHECK recipient of this person (TEST/LIVE campaigns) against the person's result now, inside `tx`
 * (the check's own transaction, or the check job's settle-only step), §2.7:
 *
 * | Person now                                                          | Recipient becomes                            |
 * |---------------------------------------------------------------------|----------------------------------------------|
 * | removed                                                             | left out "This person was removed …"         |
 * | address changed (no result, or `emailNorm` ≠ the recipient's)      | left out "The email address changed …"       |
 * | UNKNOWN before `recheckAt`, fewer than 3 in a row, policy "recheck"  | stays RECHECK                                |
 * | UNKNOWN at/after `recheckAt` (or 3 in a row)                        | left out "Address couldn't be checked"      |
 * | UNKNOWN with "No answer" set to Skip                                | left out with the policy sentence            |
 * | decision send                                                       | released: SCHEDULED, then pending holds      |
 * | decision block                                                      | left out with the policy sentence            |
 * | undeliverable / do-not-send                                         | left out with the check's sentence           |
 *
 * Released recipients keep `recheckAt` (so they never wait twice) and `nextDueAt` (their first email goes at the next
 * open slot); an undecided possible reply at their company holds them at once (M4 `applyPendingPossibleReplyHolds`),
 * and so does an outage hold that holds others at the company (`holdForOutageIfCompanyHeld`). Leaving out goes through
 * `excludeUnsent` (a RECHECK recipient never got an email). `opts.policy`: the policy already loaded by the caller.
 */
export async function settleRecheckForPerson(
  tx: Tx,
  personId: number,
  now: Date,
  opts: { policy?: VerificationPolicy } = {},
): Promise<{ released: number; leftOut: number }> {
  const rows = await tx.campaignRecipient.findMany({
    where: { personId, state: "RECHECK", campaign: { mode: { in: [...RECHECK_MODES] } } },
    select: { id: true, campaignId: true, companyId: true, emailNorm: true, recheckAt: true },
    orderBy: { id: "asc" },
  });
  if (rows.length === 0) return { released: 0, leftOut: 0 };
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: {
      emailNorm: true,
      deletedAt: true,
      verificationStatus: true,
      verificationRisk: true,
      verifiedAt: true,
      verificationDisposable: true,
      verificationUnknowns: true,
    },
  });
  const policy = opts.policy ?? (await loadCheckPolicy());

  const leaveOut = new Map<string, number[]>();
  const release: RecheckRow[] = [];
  for (const row of rows) {
    const outcome = settleOne(row, person, policy);
    if (outcome === "stay") continue;
    if (outcome === "release") release.push(row);
    else leaveOut.set(outcome, [...(leaveOut.get(outcome) ?? []), row.id]);
  }

  let leftOut = 0;
  for (const [reason, recipientIds] of leaveOut) leftOut += await excludeUnsent(tx, { recipientIds, reason, now });

  let released = 0;
  for (const row of release) {
    const res = await tx.campaignRecipient.updateMany({ where: { id: row.id, state: "RECHECK" }, data: { state: "SCHEDULED" } });
    if (res.count !== 1) continue;
    released += 1;
    await applyPendingPossibleReplyHolds({ companyIds: [row.companyId], campaignId: row.campaignId, now, tx });
    await holdForOutageIfCompanyHeld(tx, row.id, now);
  }
  return { released, leftOut };
}
