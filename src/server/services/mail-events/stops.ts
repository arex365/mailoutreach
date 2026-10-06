import type { RecipientState } from "@/generated/prisma/client";
import type { DbOrTx, Tx } from "@/server/db";
import { releaseCompanyIfDone } from "@/server/services/reservations";

/**
 * Stops (PLAN B6.4, M3-DESIGN §4.4.2 step 6, M4-DESIGN §2.5–§2.6). A stop moves recipients to STOPPED for good (a hold,
 * `@/server/services/sequences/holds`, can be released; a stop can't):
 *  - instant stops by address (`stopRecipients`): a bounce, complaint or unsubscribe, in the same transaction that
 *    records the event, so nothing more is sent to that address even before the next sending tick re-checks it; also
 *    the manual "do not email" and "mark unsubscribed" actions, a delivery-failure notice that reached our reply
 *    address, and a replier's own rows at another company;
 *  - company-wide reply stops (`stopCompany`): when anyone at a company replies, every campaign (or, in campaign
 *    scope, only the linked one) stops for everyone there, `replied` for the repliers and `company_replied` for the
 *    others;
 *  - status stops (`stopCompaniesForStatus`): a person set a company to Replied, Client, Not interested or Do not
 *    contact.
 * Every stop clears the hold fields (`holdReason`, `heldAt`) of the rows it stops, skips their QUEUED emails with a
 * plain `lastError` and releases the campaign's reservation on the company once nothing is open there.
 * Recipients are stopped only through these three functions (M4-DESIGN §0.2 rule 7).
 *
 * Milestone 5 (M5-DESIGN §2.6, §2.7, D24) adds the stop code `invalid` (the address check said the address doesn't
 * exist or not to email it, for recipients who already got an email) and `excludeUnsent`, the one door that leaves out
 * a recipient who never got an email after launch ("Left out: …" instead of "Stopped").
 */

/**
 * The stop codes written to CampaignRecipient.stopReason ("suppressed" = the Owner's "Do not email"; `invalid` = the
 * address check said not to email the address; `replied` = this person replied; `company_replied` = someone else at
 * the company replied).
 */
export type StopReason = "bounced" | "complained" | "unsubscribed" | "suppressed" | "invalid" | "replied" | "company_replied";

/** The company statuses whose manual setting stops follow-ups (M4-DESIGN §2.7); the code written is `status:<STATUS>`. */
export type StopStatus = "REPLIED" | "CLIENT" | "NOT_INTERESTED" | "DO_NOT_CONTACT";

/** Recipients still waiting for an email: the ones a stop moves to STOPPED. */
export const STOPPABLE_STATES: readonly RecipientState[] = ["SCHEDULED", "WAITING", "HELD", "RECHECK"];

/** lastError of the QUEUED emails a stop skips (shown on the campaign page, M4-DESIGN §2.6.1). */
export const STOP_SKIP_TEXT: Readonly<Record<StopReason, string>> = {
  bounced: "Stopped: this address bounced",
  unsubscribed: "Stopped: this address unsubscribed",
  complained: "Stopped: this address marked an email as spam",
  suppressed: "Stopped: this address is on the do-not-email list",
  invalid: "Stopped: the address check said not to email this address",
  replied: "Stopped: they replied",
  company_replied: "Stopped: someone at the company replied",
};

/** lastError of the QUEUED emails a status stop skips: "Stopped: the company was marked Client" (M4-DESIGN §2.6.1). */
export const STATUS_STOP_SKIP_TEXT: Readonly<Record<StopStatus, string>> = {
  REPLIED: "Stopped: the company was marked Replied",
  CLIENT: "Stopped: the company was marked Client",
  NOT_INTERESTED: "Stopped: the company was marked Not interested",
  DO_NOT_CONTACT: "Stopped: the company was marked Do not contact",
};

/** The stop code of a status stop: "status:CLIENT". */
export function statusStopCode(status: StopStatus): string {
  return `status:${status}`;
}

/**
 * The stop codes that rank, weakest first (M4-DESIGN §2.6 "Ranks", D16; `invalid` right after `suppressed`,
 * M5-DESIGN §8 P4). Mailgun's own order of the last three (`STOP_PRECEDENCE` in @/core/mailgun/events) is kept:
 * bounced < unsubscribed < complained.
 */
const RANKED_STOPS: readonly StopReason[] = ["suppressed", "invalid", "company_replied", "replied", "bounced", "unsubscribed", "complained"];

/** The stop codes a reply writes: they also overwrite `failed` (M4-DESIGN §2.6 item 2). */
const REPLY_STOPS: ReadonlySet<string> = new Set<StopReason>(["replied", "company_replied"]);

/** The stop code `failForGood` writes when an email couldn't be sent (loop.ts); Retry reopens only these. */
const FAILED_STOP = "failed";

/**
 * Strength of each stop code: a stronger code replaces a weaker one on an already-stopped recipient, so stops applied
 * in any order end with the same code. suppressed 0 < invalid 1 < company_replied 2 < replied 3 < bounced 4 <
 * unsubscribed 5 < complained 6; codes that aren't stops of this kind (`status:…`, campaign_cancelled, failed,
 * "Skipped by …") are −1 and never replaced (except `failed`, which a reply stop overwrites, see `canReplace`).
 */
export function stopRank(code: string | null | undefined): number {
  if (!code) return -1;
  return RANKED_STOPS.indexOf(code as StopReason);
}

/**
 * Whether a new stop `reason` replaces the `existing` code of an already-stopped recipient: a ranked code only by a
 * stronger one; `failed` by a reply stop (so Retry, which reopens only `failed` recipients, can never reopen someone
 * whose company replied, M4-DESIGN §2.6 item 2); anything else never.
 */
export function canReplace(existing: string | null | undefined, reason: StopReason): boolean {
  if (existing === FAILED_STOP) return REPLY_STOPS.has(reason);
  const current = stopRank(existing);
  return current >= 0 && current < stopRank(reason);
}

/** The skip texts of the codes a stop with `reason` replaces (their emails now say why they really stopped). */
function weakerSkipTexts(reason: StopReason): string[] {
  return (Object.keys(STOP_SKIP_TEXT) as StopReason[]).filter((code) => canReplace(code, reason)).map((code) => STOP_SKIP_TEXT[code]);
}

/** Ids per `IN` list: SQLite limits bound parameters, and CONVENTIONS keep lists short. */
const IN_CHUNK = 400;

function chunks<T>(list: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** A stop by address (`stopRecipients`). */
export type StopInput = {
  /** The address, normalised (the matched email row's toNorm, never the event's possibly redacted recipient). */
  emailNorm: string;
  reason: StopReason;
  /**
   * "real": every open recipient with this address in every campaign (and the matched one); "campaign": only
   * `recipientId` (a dry run on real data, Mailgun's test mode, or an effect that concerns only this email).
   */
  scope: "real" | "campaign";
  recipientId?: number | null;
  /** The InboundMessage that caused the stop (a reply or a delivery-failure notice): written to stoppedByInboundId. */
  inboundId?: number | null;
  now: Date;
};

type FoundRecipient = { id: number; campaignId: number; companyId: number; state: RecipientState; stopReason: string | null };

/**
 * Stops the `open` recipients with `code` and upgrades the stopped ones in `replace` to it, inside `tx`. The open
 * ones become STOPPED (hold fields cleared, `stoppedByInboundId` written) and their QUEUED emails SKIPPED with
 * `skipText`; the upgraded ones get the code, and their emails skipped by the weaker stop get the new text. Returns
 * how many recipients were newly stopped.
 */
async function writeStop(
  tx: Tx,
  open: readonly FoundRecipient[],
  replace: readonly FoundRecipient[],
  code: StopReason,
  inboundId: number | null,
): Promise<number> {
  let stopped = 0;
  for (const part of chunks(open.map((r) => r.id))) {
    const res = await tx.campaignRecipient.updateMany({
      where: { id: { in: part }, state: { in: [...STOPPABLE_STATES] } },
      data: { state: "STOPPED", stopReason: code, nextDueAt: null, holdReason: null, heldAt: null, stoppedByInboundId: inboundId },
    });
    stopped += res.count;
    await tx.outboundEmail.updateMany({
      where: { recipientId: { in: part }, status: "QUEUED" },
      data: { status: "SKIPPED", lastError: STOP_SKIP_TEXT[code] },
    });
  }
  const weakerTexts = weakerSkipTexts(code);
  for (const part of chunks(replace.map((r) => r.id))) {
    await tx.campaignRecipient.updateMany({
      where: { id: { in: part }, state: "STOPPED" },
      data: { stopReason: code, stoppedByInboundId: inboundId, holdReason: null, heldAt: null },
    });
    // Emails skipped by the weaker stop now say why they really stopped (the same rows as in any other order).
    await tx.outboundEmail.updateMany({
      where: { recipientId: { in: part }, status: { in: ["SKIPPED", "QUEUED"] }, OR: [{ lastError: { in: weakerTexts } }, { status: "QUEUED" }] },
      data: { status: "SKIPPED", lastError: STOP_SKIP_TEXT[code] },
    });
  }
  return stopped;
}

/** Releases the campaigns' reservations on these companies where nothing is open any more; returns the campaign ids. */
async function releaseTouched(tx: Tx, rows: readonly { campaignId: number; companyId: number }[], now: Date): Promise<number[]> {
  const pairs = new Map<string, { campaignId: number; companyId: number }>();
  for (const r of rows) pairs.set(`${r.campaignId}:${r.companyId}`, { campaignId: r.campaignId, companyId: r.companyId });
  for (const p of pairs.values()) await releaseCompanyIfDone(tx, p.campaignId, p.companyId, now);
  return [...new Set(rows.map((r) => r.campaignId))].sort((a, b) => a - b);
}

/**
 * Stops recipients inside `tx`: open ones (SCHEDULED, WAITING, HELD, RECHECK) become STOPPED with the code (hold fields
 * cleared, `stoppedByInboundId` written when given), already stopped ones whose code it may replace (`canReplace`) get
 * it; their QUEUED emails become SKIPPED ("Stopped: this address bounced" …); reservations are released per campaign
 * and company when nothing is left open there. Returns how many recipients were newly stopped.
 */
export async function stopRecipients(tx: Tx, input: StopInput): Promise<number> {
  const emailNorm = input.emailNorm.trim().toLowerCase();
  const where =
    input.scope === "real"
      ? { OR: [{ emailNorm }, ...(input.recipientId ? [{ id: input.recipientId }] : [])] }
      : input.recipientId
        ? { id: input.recipientId }
        : null;
  if (!where || (input.scope === "real" && !emailNorm)) return 0;

  const found = await tx.campaignRecipient.findMany({
    where: { ...where, included: true, state: { in: [...STOPPABLE_STATES, "STOPPED"] } },
    select: { id: true, campaignId: true, companyId: true, state: true, stopReason: true },
  });
  const open = found.filter((r) => r.state !== "STOPPED");
  const replace = found.filter((r) => r.state === "STOPPED" && canReplace(r.stopReason, input.reason));
  const stopped = await writeStop(tx, open, replace, input.reason, input.inboundId ?? null);
  await releaseTouched(tx, open, input.now);
  return stopped;
}

/** A company-wide reply stop (`stopCompany`), computed by reply processing (M4-DESIGN §2.6 "Who is a replier"). */
export type CompanyStopInput = {
  companyId: number;
  /** The Person ids that replied (M4-DESIGN §0.3 "Replier") and the address they wrote from. */
  replierPersonIds: readonly number[];
  replierEmails: readonly string[];
  /**
   * The InboundMessage that caused the stop: written to CampaignRecipient.stoppedByInboundId. Omitted/null when there is
   * none: "They replied" by hand (MAIN-DOMAIN-DESIGN §2.9, `markRepliedByHand`) stops with the same reply codes.
   */
  inboundId?: number | null;
  /** Campaign scope (§3.6): only this campaign. Omitted/null: every campaign. */
  campaignId?: number | null;
  now: Date;
};

/**
 * A reply stops the company (M4-DESIGN §2.5, §2.6), inside `tx`. Every included recipient at the company (only in
 * `campaignId` when given; any campaign mode and status) that is open or stopped is looked at, through the
 * `(companyId, state)` index: the repliers (by person id or by the address they wrote from) get `replied`, everyone
 * else `company_replied`. Open ones stop (hold fields cleared, QUEUED emails SKIPPED with the §2.6.1 text); stopped
 * ones with a weaker code, or with `failed`, are upgraded. Returns how many were newly stopped and the campaigns
 * where that happened (the caller runs `finishCheck` for each after its transaction).
 */
export async function stopCompany(tx: Tx, input: CompanyStopInput): Promise<{ stopped: number; campaignIds: number[] }> {
  const personIds = new Set(input.replierPersonIds);
  const emails = new Set(input.replierEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const found = await tx.campaignRecipient.findMany({
    where: {
      companyId: input.companyId,
      included: true,
      state: { in: [...STOPPABLE_STATES, "STOPPED"] },
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    },
    select: { id: true, campaignId: true, companyId: true, personId: true, emailNorm: true, state: true, stopReason: true },
  });
  const codeOf = (r: { personId: number; emailNorm: string }): StopReason =>
    personIds.has(r.personId) || emails.has(r.emailNorm.toLowerCase()) ? "replied" : "company_replied";

  let stopped = 0;
  const openAll: FoundRecipient[] = [];
  for (const code of ["replied", "company_replied"] as const) {
    const mine = found.filter((r) => codeOf(r) === code);
    const open = mine.filter((r) => r.state !== "STOPPED");
    const replace = mine.filter((r) => r.state === "STOPPED" && canReplace(r.stopReason, code));
    stopped += await writeStop(tx, open, replace, code, input.inboundId ?? null);
    openAll.push(...open);
  }
  const campaignIds = await releaseTouched(tx, openAll, input.now);
  return { stopped, campaignIds };
}

/**
 * Email statuses that mean the recipient got (or may have got) an email: sent, or sent without a proof yet (the
 * reconciler's UNKNOWN, M4's UNCONFIRMED). A recipient with one is never "left out"; it is stopped instead. A SENDING
 * row doesn't count: the sending loop still holds its claim (M5-DESIGN §2.8 rule 6 skips it before leaving the
 * recipient out, and the final check before a send sees the recipient left out).
 */
const EMAILED_STATUSES = ["SENT", "UNKNOWN", "UNCONFIRMED"] as const;

/**
 * Of these recipients, the ones with no email that went out (or may have: SENT, UNKNOWN, UNCONFIRMED): the ones
 * `excludeUnsent` may leave out. Callers that must stop the others (an INVALID check result) split with it, inside
 * their transaction.
 */
export async function unsentRecipientIds(reader: DbOrTx, recipientIds: readonly number[]): Promise<number[]> {
  const ids = [...new Set(recipientIds)];
  const emailed = new Set<number>();
  for (const part of chunks(ids)) {
    const rows = await reader.outboundEmail.findMany({
      where: { recipientId: { in: part }, status: { in: [...EMAILED_STATUSES] } },
      select: { recipientId: true },
      distinct: ["recipientId"],
    });
    for (const r of rows) emailed.add(r.recipientId);
  }
  return ids.filter((id) => !emailed.has(id));
}

/**
 * Leaves out recipients who never got an email, after launch (M5-DESIGN §2.7 "Left out", D24), inside `tx`: the one
 * door for a failed re-check, an INVALID / DO_NOT_SEND check result, and a check or policy code found before the first
 * email. Open recipients (SCHEDULED, WAITING, HELD, RECHECK) without a sent email become EXCLUDED with
 * `included = false`, `exclusionReason = reason` (the campaign page words it "Left out: …"), `nextDueAt` and the hold
 * fields cleared; their QUEUED emails become CANCELLED with `lastError = reason`; reservations are released per
 * campaign and company when nothing is left open there. A recipient that already got an email is refused (and logged):
 * the caller stops it instead. Returns how many recipients were left out.
 */
export async function excludeUnsent(tx: Tx, input: { recipientIds: readonly number[]; reason: string; now: Date }): Promise<number> {
  const ids = [...new Set(input.recipientIds)];
  const reason = input.reason.trim();
  if (ids.length === 0 || !reason) return 0;
  let excluded = 0;
  const touched: Array<{ campaignId: number; companyId: number }> = [];
  for (const part of chunks(ids)) {
    const open = await tx.campaignRecipient.findMany({
      where: { id: { in: part }, state: { in: [...STOPPABLE_STATES] } },
      select: { id: true, campaignId: true, companyId: true },
    });
    if (open.length === 0) continue;
    const neverEmailed = new Set(await unsentRecipientIds(tx, open.map((r) => r.id)));
    for (const r of open) {
      if (!neverEmailed.has(r.id)) console.warn(`[stops] recipient #${r.id} already got an email, so it wasn't left out; stop it instead`);
    }
    const unsent = open.filter((r) => neverEmailed.has(r.id));
    if (unsent.length === 0) continue;
    const unsentIds = unsent.map((r) => r.id);
    const res = await tx.campaignRecipient.updateMany({
      where: { id: { in: unsentIds }, state: { in: [...STOPPABLE_STATES] } },
      data: { state: "EXCLUDED", included: false, exclusionReason: reason, nextDueAt: null, holdReason: null, heldAt: null },
    });
    excluded += res.count;
    await tx.outboundEmail.updateMany({
      where: { recipientId: { in: unsentIds }, status: "QUEUED" },
      data: { status: "CANCELLED", lastError: reason },
    });
    touched.push(...unsent);
  }
  await releaseTouched(tx, touched, input.now);
  return excluded;
}

/**
 * A person set these companies' status to Replied, Client, Not interested or Do not contact (M4-DESIGN §2.7, D18),
 * inside the status write's transaction. Set-based, for up to 50 companies per call (bulk changes run in chunks):
 * every open recipient of those companies (any campaign) becomes STOPPED with `status:<STATUS>` and hold fields
 * cleared, and their QUEUED emails become SKIPPED with "Stopped: the company was marked Client"; already stopped
 * recipients are left alone (a `status:` code never replaces and is never replaced). Returns how many were stopped and
 * the campaigns where that happened (the caller runs `finishCheck` for each after its transaction).
 */
export async function stopCompaniesForStatus(
  tx: Tx,
  input: { companyIds: readonly number[]; status: StopStatus; now: Date },
): Promise<{ stopped: number; campaignIds: number[] }> {
  const companyIds = [...new Set(input.companyIds)];
  if (companyIds.length === 0) return { stopped: 0, campaignIds: [] };
  const code = statusStopCode(input.status);
  const open: Array<{ id: number; campaignId: number; companyId: number }> = [];
  for (const part of chunks(companyIds)) {
    open.push(
      ...(await tx.campaignRecipient.findMany({
        where: { companyId: { in: part }, included: true, state: { in: [...STOPPABLE_STATES] } },
        select: { id: true, campaignId: true, companyId: true },
      })),
    );
  }
  let stopped = 0;
  for (const part of chunks(open.map((r) => r.id))) {
    const res = await tx.campaignRecipient.updateMany({
      where: { id: { in: part }, state: { in: [...STOPPABLE_STATES] } },
      data: { state: "STOPPED", stopReason: code, nextDueAt: null, holdReason: null, heldAt: null },
    });
    stopped += res.count;
    await tx.outboundEmail.updateMany({
      where: { recipientId: { in: part }, status: "QUEUED" },
      data: { status: "SKIPPED", lastError: STATUS_STOP_SKIP_TEXT[input.status] },
    });
  }
  const campaignIds = await releaseTouched(tx, open, input.now);
  return { stopped, campaignIds };
}
