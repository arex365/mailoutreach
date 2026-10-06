import type { Prisma } from "@/generated/prisma/client";
import { normalizeEmail } from "@/core/email-address";
import { replyActivitySummary } from "@/core/replies/copy";
import { hasBeenLive, replyScope } from "@/core/replies/kind";
import { WAITING_KINDS, type InboundKindValue, type ReplyScope } from "@/core/replies/types";
import { logActivity } from "@/server/activity";
import { db, dbTx, type DbOrTx, type Tx } from "@/server/db";
import { activeOwnerId } from "@/server/notifications";
import { finishCheck } from "@/server/services/campaigns/control";
import { ServiceError } from "@/server/services/companies/mutations";
import { addPerson } from "@/server/services/people";
import { holdCompany, releaseCompanyHold, undecidedHolds } from "@/server/services/sequences/holds";
import { getSettings } from "@/server/settings";
import { applyReplyEffects, syncTwins } from "./effects";
import { launchedGoLiveOf } from "./input";
import { knownPersonOf, newestSentToCompany } from "./link";

/**
 * The decisions on "Replies waiting for an answer" (M4-DESIGN §3.5 "Decisions", §4.2, §9.1): Answered, No answer
 * needed, Undo, Real reply / It was an auto-reply, Link to a company and Add the sender as a person. The Server Actions
 * of the Notifications page and the tests call these. Everyone signed in may act on any waiting reply (SPEC §1, D17);
 * every decision is logged with who made it. Each runs in one short transaction with a compare-and-set on the row, is
 * copied to the row's twins, and uses the scope stored when the reply was processed (D23), never today's settings.
 * Problems the person can fix throw a ServiceError with the sentence to show.
 */

/** Who decides. */
export type ReplyActor = { id: number; name: string; role: "OWNER" | "MEMBER" };

/** The reply was decided, linked away or removed meanwhile (§9.1 "Errors"). */
export const REPLY_GONE = "This reply isn't on the list any more. Refresh the page.";
/** Answered / No answer needed on a possible reply: it must be decided first. */
export const DECIDE_FIRST = "Choose Real reply or It was an auto-reply first.";
/** Link without a company. */
export const PICK_COMPANY = "Pick a company first.";
/** Link to a company that was deleted (or doesn't exist). */
export const COMPANY_DELETED = "This company was deleted. Pick another one.";

/** "This reply was already handled by Sara. Refresh the page to see it." */
export function handledByText(name: string): string {
  return `This reply was already handled by ${name}. Refresh the page to see it.`;
}

/** "jonas@firma.de already belongs to C-1042. Link the reply there instead." */
export function belongsElsewhereText(email: string, companyId: number): string {
  return `${email} already belongs to C-${companyId}. Link the reply there instead.`;
}

const DECISION_SELECT = {
  id: true,
  kind: true,
  processedAt: true,
  answeredAt: true,
  answeredById: true,
  answerOutcome: true,
  confirmedById: true,
  companyId: true,
  personId: true,
  campaignId: true,
  outboundEmailId: true,
  heldCompanyId: true,
  replyScope: true,
  changesStatus: true,
  assigneeId: true,
  fromEmail: true,
  fromName: true,
  subject: true,
  receivedAt: true,
  autoReason: true,
  bodyAvailable: true,
  source: true,
} as const;

type DecisionRow = Prisma.InboundMessageGetPayload<{ select: typeof DECISION_SELECT }>;

async function userName(reader: DbOrTx, id: number | null): Promise<string | null> {
  if (id === null) return null;
  return (await reader.user.findUnique({ where: { id }, select: { name: true } }))?.name?.trim() || null;
}

async function companyName(reader: DbOrTx, id: number | null): Promise<string> {
  if (id === null) return "this company";
  return (await reader.company.findUnique({ where: { id }, select: { name: true } }))?.name ?? "this company";
}

/**
 * Why a row can't be decided any more, or null while it waits for an answer (processed, a waiting kind, not answered):
 * someone already handled it (answered it, or decided a possible reply) → "…handled by Sara…"; otherwise it left the
 * list → "This reply isn't on the list any more."
 */
async function notWaitingText(reader: DbOrTx, row: DecisionRow | null): Promise<string | null> {
  if (!row || !row.processedAt || !row.kind) return REPLY_GONE;
  if (row.answeredAt) {
    const by = await userName(reader, row.answeredById);
    return by ? handledByText(by) : REPLY_GONE;
  }
  if (!(WAITING_KINDS as readonly string[]).includes(row.kind)) {
    const by = row.kind === "REPLY" || row.kind === "AUTO_REPLY" ? await userName(reader, row.confirmedById) : null;
    return by ? handledByText(by) : REPLY_GONE;
  }
  return null;
}

/** The row inside `tx` when it still waits for an answer; otherwise throws the plain reason (`notWaitingText`). */
async function waitingRow(tx: Tx, id: number): Promise<DecisionRow> {
  const row = await tx.inboundMessage.findUnique({ where: { id }, select: DECISION_SELECT });
  const why = await notWaitingText(tx, row);
  if (!row || why) throw new ServiceError(why ?? REPLY_GONE);
  return row;
}

/** The stored scope as the effects read it ("real" unless the reply was filed in campaign scope). */
function storedScope(row: Pick<DecisionRow, "replyScope">): ReplyScope {
  return row.replyScope === "campaign" ? "campaign" : "real";
}

/** Runs the finish check of each campaign a decision's stops touched (after its transaction; failures are logged). */
async function finishAll(campaignIds: readonly number[], now: Date): Promise<void> {
  for (const campaignId of campaignIds) {
    try {
      await finishCheck(campaignId, { now });
    } catch (err) {
      console.error(`[replies] the finish check of campaign #${campaignId} failed`, err);
    }
  }
}

// ───────────────────────── Answered / No answer needed / Undo ─────────────────────────

async function answer(actor: ReplyActor, id: number, outcome: "answered" | "not-needed", now: Date): Promise<void> {
  await dbTx(async (tx) => {
    const row = await waitingRow(tx, id);
    if (row.kind === "POSSIBLE_REPLY") throw new ServiceError(DECIDE_FIRST);
    const res = await tx.inboundMessage.updateMany({
      where: { id, answeredAt: null, kind: row.kind ?? undefined },
      data: { answeredAt: now, answeredById: actor.id, answerOutcome: outcome },
    });
    if (res.count !== 1) throw new ServiceError(REPLY_GONE);
    // A domain hold waits for exactly this: someone looked at the message and decided nothing needs to stop.
    if (row.kind === "UNLINKED" && row.heldCompanyId !== null) {
      await releaseCompanyHold(tx, { companyId: row.heldCompanyId, reason: "possible-reply", campaignId: null, now });
    }
    const type = outcome === "answered" ? "reply.answered" : "reply.notNeeded";
    await logActivity(
      {
        actorId: actor.id,
        type,
        summary: replyActivitySummary({ type, fromEmail: row.fromEmail, actorName: actor.name }),
        companyId: row.companyId,
        personId: row.personId,
        data: { inboundId: id },
      },
      tx,
    );
  });
}

/**
 * "Answered" (M4-DESIGN §3.5): a REPLY or an UNLINKED reply leaves the waiting list; an UNLINKED one's domain hold is
 * released (recipients no other undecided message holds). A possible reply must be decided first.
 */
export async function markReplyAnswered(actor: ReplyActor, id: number, opts: { now?: Date } = {}): Promise<{ message: string }> {
  await answer(actor, id, "answered", opts.now ?? new Date());
  return { message: "Marked as answered." };
}

/** "No answer needed": as Answered, recorded as needing no answer. */
export async function markReplyNotNeeded(actor: ReplyActor, id: number, opts: { now?: Date } = {}): Promise<{ message: string }> {
  await answer(actor, id, "not-needed", opts.now ?? new Date());
  return { message: "Marked as needing no answer." };
}

/**
 * Undo of Answered / No answer needed (the toast's button): the reply is back on the waiting list and an UNLINKED
 * reply's domain hold comes back (`holdCompany`).
 */
export async function reopenReply(actor: ReplyActor, id: number, opts: { now?: Date } = {}): Promise<{ message: string }> {
  const now = opts.now ?? new Date();
  await dbTx(async (tx) => {
    const row = await tx.inboundMessage.findUnique({ where: { id }, select: DECISION_SELECT });
    if (!row || !row.processedAt || !row.kind || !(WAITING_KINDS as readonly string[]).includes(row.kind)) {
      throw new ServiceError(REPLY_GONE);
    }
    if (!row.answeredAt) throw new ServiceError("This reply is already waiting for an answer.");
    if (row.answerOutcome !== "answered" && row.answerOutcome !== "not-needed") throw new ServiceError(REPLY_GONE);
    const res = await tx.inboundMessage.updateMany({
      where: { id, answeredAt: row.answeredAt, answerOutcome: row.answerOutcome },
      data: { answeredAt: null, answeredById: null, answerOutcome: null },
    });
    if (res.count !== 1) throw new ServiceError(REPLY_GONE);
    if (row.kind === "UNLINKED" && row.heldCompanyId !== null) {
      await holdCompany(tx, { companyId: row.heldCompanyId, reason: "possible-reply", campaignId: null, now });
    }
    await logActivity(
      {
        actorId: actor.id,
        type: "reply.reopened",
        summary: replyActivitySummary({ type: "reply.reopened", fromEmail: row.fromEmail, actorName: actor.name }),
        companyId: row.companyId,
        personId: row.personId,
        data: { inboundId: id },
      },
      tx,
    );
  });
  return { message: "The reply is back on the waiting list." };
}

// ───────────────────────── Real reply / It was an auto-reply ─────────────────────────

/** A REPLY's stops, status and dates for a decided row, from its stored links and scope. */
async function replyEffectsOf(tx: Tx, row: DecisionRow, companyId: number, now: Date) {
  const known = await knownPersonOf(tx, row.fromEmail);
  const email = row.outboundEmailId
    ? await tx.outboundEmail.findUnique({ where: { id: row.outboundEmailId }, select: { personId: true, mode: true } })
    : null;
  const replierPersonIds = known ? [known.id] : email?.personId ? [email.personId] : row.personId ? [row.personId] : [];
  return applyReplyEffects(tx, {
    inboundId: row.id,
    companyId,
    scope: storedScope(row),
    campaignId: row.campaignId,
    changesStatus: row.changesStatus === true,
    receivedAt: row.receivedAt,
    fromEmail: row.fromEmail,
    replierPersonIds,
    crossCompany: known !== null && known.companyId !== companyId,
    personId: row.personId,
    mode: email?.mode ?? null,
    now,
  });
}

/**
 * "Real reply" / "It was an auto-reply" on a possible reply (M4-DESIGN §3.5, §2.8.2):
 *  - real: kind REPLY; the REPLY effects now, in the stored scope (the company's follow-ups stop, and in a scope that
 *    changes status it becomes Replied); it stays on the list until answered;
 *  - automatic: kind AUTO_REPLY (its reason kept, else "auto-reply"); the possible-reply hold is released for the
 *    recipients no other undecided message still holds; it leaves the list.
 * The decision is copied to the row's twins; a campaign whose last open company it stopped finishes at once.
 */
export async function confirmReply(actor: ReplyActor, id: number, real: boolean, opts: { now?: Date } = {}): Promise<{ message: string }> {
  const now = opts.now ?? new Date();
  const out = await dbTx(async (tx) => {
    const row = await waitingRow(tx, id);
    if (row.kind !== "POSSIBLE_REPLY" || row.companyId === null) throw new ServiceError(REPLY_GONE);
    const companyId = row.companyId;
    const data: Prisma.InboundMessageUpdateManyMutationInput = real
      ? { kind: "REPLY", confirmedAt: now, confirmedById: actor.id }
      : { kind: "AUTO_REPLY", autoReason: row.autoReason ?? "auto-reply", confirmedAt: now, confirmedById: actor.id };
    const res = await tx.inboundMessage.updateMany({ where: { id, kind: "POSSIBLE_REPLY", answeredAt: null }, data });
    if (res.count !== 1) throw new ServiceError(REPLY_GONE);

    let campaignIds: number[] = [];
    let statusChanged = false;
    let stillHeld = false;
    if (real) {
      const effects = await replyEffectsOf(tx, row, companyId, now);
      campaignIds = effects.campaignIds;
      statusChanged = effects.statusChanged;
    } else {
      const scope = storedScope(row);
      await releaseCompanyHold(tx, { companyId, reason: "possible-reply", campaignId: scope === "campaign" ? row.campaignId : null, now });
      const remaining = await undecidedHolds(tx, [companyId]);
      stillHeld = remaining.some((r) => r.campaignId === null || scope === "real" || r.campaignId === row.campaignId);
    }
    await logActivity(
      {
        actorId: actor.id,
        type: "reply.confirmed",
        summary: replyActivitySummary({ type: "reply.confirmed", fromEmail: row.fromEmail, actorName: actor.name, real }),
        companyId,
        personId: row.personId,
        campaignId: row.campaignId,
        data: { inboundId: id, real },
      },
      tx,
    );
    await syncTwins(tx, id);
    return { campaignIds, statusChanged, stillHeld, name: await companyName(tx, companyId) };
  });
  await finishAll(out.campaignIds, now);
  if (real) {
    return { message: `Marked as a real reply. Follow-ups to ${out.name} stopped${out.statusChanged ? " and it's now Replied" : ""}.` };
  }
  return {
    message: out.stillHeld
      ? `Marked as automatic. Follow-ups to ${out.name} still wait for another message to be checked.`
      : `Marked as automatic. Follow-ups to ${out.name} continue.`,
  };
}

// ───────────────────────── Link to a company / Add the sender ─────────────────────────

/**
 * Adds the reply's sender to a company as a person (the existing `addPerson`). `strict` (the card's "Add … to Firma
 * GmbH"): any Person with the address, anywhere, is a clash. Otherwise (Link's "Add as a person"): a live contact at
 * that company is already there, and a removed one is brought back. A clash names the company the address belongs to.
 */
async function addSender(
  actor: ReplyActor,
  row: Pick<DecisionRow, "fromEmail" | "fromName">,
  companyId: number,
  opts: { strict: boolean },
): Promise<void> {
  const emailNorm = normalizeEmail(row.fromEmail) ?? row.fromEmail.trim().toLowerCase();
  const existing = await db.person.findUnique({ where: { emailNorm }, select: { companyId: true, deletedAt: true } });
  if (existing && (opts.strict || existing.companyId !== companyId)) {
    throw new ServiceError(belongsElsewhereText(row.fromEmail, existing.companyId));
  }
  if (existing && !existing.deletedAt) return;
  try {
    await addPerson({ id: actor.id, name: actor.name }, companyId, { email: row.fromEmail, name: row.fromName });
  } catch (err) {
    if (err instanceof ServiceError) {
      // Added somewhere a moment ago (the unique address): say where, so the reply can be linked there.
      const found = await db.person.findUnique({ where: { emailNorm }, select: { companyId: true } });
      if (found) throw new ServiceError(belongsElsewhereText(row.fromEmail, found.companyId));
    }
    throw err;
  }
}

/** What to link an unlinked reply to (M4-DESIGN §3.5 "Linking by hand"). */
export type LinkReplyInput = {
  companyId: number;
  /** The person the reply concerns; omitted/null ("Not one of these people"): the linked email's person. */
  personId?: number | null;
  /** Add the sender to the company as a person first ("Add jonas@firma.de to this company as a person"). */
  addPerson?: boolean;
  /** "Is it a real reply?" Yes (default) → REPLY; No, it was automatic → AUTO_REPLY. */
  real?: boolean;
};

/**
 * "Link to a company" on an UNLINKED reply (M4-DESIGN §3.5 "Linking by hand"):
 *  - email: the company's newest SENT email of the real modes in the 90 days before the reply arrived, preferring one
 *    to the chosen person; its campaign, and its person when "Not one of these people" was chosen;
 *  - scope and status from that email (`replyScope` with its campaign's launch flag: a test email sent before go-live
 *    never makes a test-mailbox company Replied, also after go-live, M6-DESIGN §2.2); no email → real scope, status
 *    only in the practice copy or once the app has been live (`hasBeenLive`: a domain change that switched go-live off
 *    doesn't undo it, review GOLIVE-01); stored on the row;
 *  - assignee: that email's sender (switched off → the Owner); no email → unchanged;
 *  - Yes → kind REPLY with the REPLY effects (activities `reply.linked` and `reply.received`); No, it was automatic →
 *    kind AUTO_REPLY (activity `reply.auto`), nothing stops and it leaves the list;
 *  - a domain hold on another company is released; on the chosen company it becomes the stop (or, automatic, is
 *    released);
 *  - "Add as a person" adds the sender first (a clash names the company the address belongs to).
 */
export async function linkReply(actor: ReplyActor, id: number, input: LinkReplyInput, opts: { now?: Date } = {}): Promise<{ message: string }> {
  const now = opts.now ?? new Date();
  const companyId = Number(input.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) throw new ServiceError(PICK_COMPANY);
  const real = input.real !== false;

  const before = await db.inboundMessage.findUnique({ where: { id }, select: DECISION_SELECT });
  const why = await notWaitingText(db, before);
  if (!before || why) throw new ServiceError(why ?? REPLY_GONE);
  if (before.kind !== "UNLINKED") throw new ServiceError(REPLY_GONE);
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, deletedAt: true } });
  if (!company || company.deletedAt) throw new ServiceError(COMPANY_DELETED);
  let personId: number | null = null;
  if (input.personId) {
    const person = await db.person.findUnique({ where: { id: input.personId }, select: { companyId: true, deletedAt: true } });
    if (!person || person.deletedAt || person.companyId !== companyId) {
      throw new ServiceError(`This person isn't at ${company.name} any more. Pick another one.`);
    }
    personId = input.personId;
  }
  if (input.addPerson) await addSender(actor, before, companyId, { strict: false });

  const settings = await getSettings(["practice.copy", "sending.goLive", "sending.goLiveAt"] as const);
  const practiceCopy = settings["practice.copy"] === true;
  const email = await newestSentToCompany(db, companyId, { receivedAt: before.receivedAt, practiceCopy, personId });
  const scope = replyScope({
    mode: email?.mode ?? null,
    link: email ? "email" : "company",
    simulated: before.source === "SIMULATED",
    practiceCopy,
    // Once the app has been live, also after a domain change switched go-live off (review GOLIVE-01).
    everLive: hasBeenLive({ goLive: settings["sending.goLive"], goLiveAt: settings["sending.goLiveAt"] }),
    launchedGoLive: email?.mode === "LIVE" ? await launchedGoLiveOf(db, email) : null,
  });
  let assigneeId = before.assigneeId;
  if (email) {
    const sender = email.senderId !== null ? await db.user.findUnique({ where: { id: email.senderId }, select: { active: true } }) : null;
    assigneeId = sender?.active ? email.senderId : await activeOwnerId();
  }
  const storedPersonId = personId ?? email?.personId ?? null;
  const kind: InboundKindValue = real ? "REPLY" : "AUTO_REPLY";

  const out = await dbTx(async (tx) => {
    const row = await waitingRow(tx, id);
    if (row.kind !== "UNLINKED") throw new ServiceError(REPLY_GONE);
    const res = await tx.inboundMessage.updateMany({
      where: { id, kind: "UNLINKED", answeredAt: null },
      data: {
        kind,
        ...(real ? {} : { autoReason: row.autoReason && row.autoReason !== "process-failed" ? row.autoReason : "auto-reply" }),
        linkMethod: "manual",
        outboundEmailId: email?.id ?? null,
        personId: storedPersonId,
        companyId,
        campaignId: email?.campaignId ?? null,
        replyScope: scope.scope,
        changesStatus: scope.changesStatus,
        heldCompanyId: null,
        assigneeId,
        confirmedAt: now,
        confirmedById: actor.id,
      },
    });
    if (res.count !== 1) throw new ServiceError(REPLY_GONE);
    // The domain hold: another company is released; the chosen one gets its stop (or, automatic, its release).
    if (row.heldCompanyId !== null && (row.heldCompanyId !== companyId || !real)) {
      await releaseCompanyHold(tx, { companyId: row.heldCompanyId, reason: "possible-reply", campaignId: null, now });
    }
    const linked: DecisionRow = {
      ...row,
      kind,
      personId: storedPersonId,
      companyId,
      campaignId: email?.campaignId ?? null,
      outboundEmailId: email?.id ?? null,
      replyScope: scope.scope,
      changesStatus: scope.changesStatus,
    };
    let campaignIds: number[] = [];
    let statusChanged = false;
    const base = { companyId, personId: storedPersonId, campaignId: email?.campaignId ?? null, mode: email?.mode ?? null };
    if (real) {
      const effects = await replyEffectsOf(tx, linked, companyId, now);
      campaignIds = effects.campaignIds;
      statusChanged = effects.statusChanged;
      const who = await knownPersonOf(tx, row.fromEmail);
      await logActivity(
        {
          ...base,
          actorId: actor.id,
          type: "reply.linked",
          summary: replyActivitySummary({ type: "reply.linked", fromEmail: row.fromEmail, actorName: actor.name, companyName: company.name }),
          data: { inboundId: id },
        },
        tx,
      );
      await logActivity(
        {
          ...base,
          actorId: actor.id,
          type: "reply.received",
          summary: replyActivitySummary({
            type: "reply.received",
            fromEmail: row.fromEmail,
            fromName: who?.name ?? row.fromName,
            replierIsKnown: who !== null,
            subject: row.subject,
            linkedByName: actor.name,
          }),
          data: {
            inboundId: id,
            subject: row.subject,
            from: row.fromEmail,
            replierPersonIds: who ? [who.id] : storedPersonId ? [storedPersonId] : [],
            emailId: email?.id ?? null,
            step: email?.step ?? null,
            linkMethod: "manual",
          },
        },
        tx,
      );
    } else {
      await logActivity(
        {
          ...base,
          actorId: actor.id,
          type: "reply.auto",
          summary: replyActivitySummary({ type: "reply.auto", fromEmail: row.fromEmail, autoReason: row.autoReason }),
          data: { inboundId: id, autoReason: row.autoReason, linkedBy: actor.name },
        },
        tx,
      );
    }
    await syncTwins(tx, id);
    return { campaignIds, statusChanged };
  });
  await finishAll(out.campaignIds, now);
  return {
    message: real
      ? `Linked to ${company.name}. Its follow-ups stopped${out.statusChanged ? " and it's now Replied" : ""}.`
      : `Linked to ${company.name} as an automatic message.`,
  };
}

/**
 * "Add jonas@firma.de to Firma GmbH" (M4-DESIGN §3.5, §3.7): a linked reply whose sender isn't a Person anywhere adds
 * them to the reply's company (the existing `addPerson`); nothing else changes. When the address was added meanwhile:
 * "jonas@firma.de already belongs to C-1042. Link the reply there instead."
 */
export async function addReplySender(actor: ReplyActor, id: number): Promise<{ message: string }> {
  const row = await db.inboundMessage.findUnique({ where: { id }, select: DECISION_SELECT });
  if (!row || !row.processedAt || row.companyId === null || row.kind === "TEST_REPLY") throw new ServiceError(REPLY_GONE);
  await addSender(actor, row, row.companyId, { strict: true });
  return { message: `Added ${row.fromEmail} to ${await companyName(db, row.companyId)}.` };
}
