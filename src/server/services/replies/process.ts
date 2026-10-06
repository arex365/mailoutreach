import type { Prisma } from "@/generated/prisma/client";
import { REPLY_NOTIFICATION } from "@/core/notification-types";
import { classify } from "@/core/replies/classify";
import { replyActivitySummary, replyNotificationCopy, type ReplyCopyInput } from "@/core/replies/copy";
import { suggestedContact } from "@/core/replies/hints";
import { replyScope, storedKind, type ReplyLabel } from "@/core/replies/kind";
import { bodyMessageIds, bounceRecipients, namedRecipients, threadIds } from "@/core/replies/link-ids";
import {
  ATTENTION_SENT_SIGNAL,
  WAITING_KINDS,
  type InboundKindValue,
  type LinkMethod,
  type LinkTarget,
  type ReplyScope,
  type Verdict,
} from "@/core/replies/types";
import { countsAsEmailed } from "@/core/rules/mode";
import { logActivity } from "@/server/activity";
import { db, dbTx, type DbOrTx, type Tx } from "@/server/db";
import { notifyUsers } from "@/server/notifications";
import { finishCheck } from "@/server/services/campaigns/control";
import { holdCompany } from "@/server/services/sequences/holds";
import { markSent } from "@/server/services/sending/mark-sent";
import {
  applyBounceStop,
  applyReplyEffects,
  attentionSentRecently,
  audienceFor,
  confirmAudience,
  namesOf,
  sendReplyNotification,
  type ReplyAudience,
} from "./effects";
import {
  classifyInputOf,
  launchedGoLiveOf,
  loadInboundRow,
  loadReplyContext,
  newTextOf,
  noticeTextOf,
  rowHeaders,
  snippetOf,
  type InboundRow,
  type ReplyContext,
} from "./input";
import {
  domainHoldCompany,
  findTwinSource,
  knownPersonOf,
  newestSentTo,
  newestSentToCompany,
  sentSubjectsOf,
  threadLink,
  type KnownPerson,
  type LinkedEmail,
  type TwinSource,
} from "./link";

export { REPLY_FROM_MATCH_MS } from "./link";

/**
 * Reply processing (M4-DESIGN §3.8): the ONE place where a received message is linked, classified and acted on
 * (M4-DESIGN §0.2 rule 6; the inbound webhook only stores). The worker's event lane runs `processPendingInbound` every
 * second; Simulate reply calls `processInboundMessage` directly from the web process. A compare-and-set on
 * `processedAt` makes two processes working on the same row harmless.
 *
 * For one message: reads first (settings, internal senders, links, classification, assignee), then one short
 * transaction writes the row and its effects (stops, company status, holds, activities, notifications), then the
 * finish check runs for every campaign a stop touched. A reply that proves an UNKNOWN/UNCONFIRMED email arrived records
 * it as sent first (never a SENDING or FAILED row). A message whose processing keeps throwing is retried after 1, 5,
 * 15 and 60 minutes, then the fail-safe holds the company it points at and lists it for the Owner: never a release.
 */

/** Messages per lane tick. */
export const INBOUND_BATCH = 20;
/** A reply received this long before it is processed is "quiet" (M3 backlog, long outages): no notification of its own. */
export const QUIET_AFTER_MS = 3 * 86_400_000;
/** After this many failed tries the fail-safe takes over. */
export const INBOUND_MAX_FAILURES = 5;
/** Wait before the 2nd, 3rd, 4th and 5th try of a message whose processing threw: 1, 5, 15 and 60 minutes. */
export const INBOUND_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
/** Failures per InboundMessage id (the lane keeps one map): how many tries failed and when the next may run (ms). */
export type InboundFailures = Map<number, { count: number; nextTryAt: number }>;
/** What processing one message decided (null from `processInboundMessage`: already processed, maybe elsewhere). */
export type ProcessedReply = { id: number; kind: InboundKindValue; companyId: number | null; campaignIds: number[] };

type Logger = { error(message: string, err?: unknown): void };
const defaultLogger: Logger = { error: (m, err) => console.error(`[replies] ${m}`, err ?? "") };

/** Failures per message when the caller keeps no map of its own (one per process). */
const sharedFailures: InboundFailures = new Map();

/** Email statuses a reply proves were sent (M4-DESIGN §3.7, D12): never SENDING (claimed) or FAILED (refused). */
const PROVABLE_STATUSES = ["UNKNOWN", "UNCONFIRMED", "QUEUED"] as const;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// ───────────────────────── planning (reads only) ─────────────────────────

/** Everything the transaction writes for one message, worked out before it. */
type Plan = {
  kind: InboundKindValue;
  autoReason: string | null;
  signals: string[];
  linkMethod: LinkMethod | null;
  link: LinkTarget;
  email: LinkedEmail | null;
  companyId: number | null;
  personId: number | null;
  campaignId: number | null;
  scope: ReplyScope;
  changesStatus: boolean;
  label: ReplyLabel;
  heldCompanyId: number | null;
  /** Unlinked and marked as spam by Mailgun: answered at once, listed only for the Owner. */
  spam: boolean;
  /** A delivery-delay notice (the other server is still trying): stops nothing. */
  delay: boolean;
  /** A delivery-failure notice naming only other addresses: a forward from the person's mailbox failed. */
  forwardFailed: boolean;
  /** A delivery-failure notice that stops the address we wrote to. */
  bounceStop: boolean;
  known: KnownPerson | null;
  replierPersonIds: number[];
  crossCompany: boolean;
  snippet: string;
  quiet: boolean;
  audience: ReplyAudience;
  /** The copy facts for the notification and the activities (null for a twin: it gets neither). */
  copy: ReplyCopyInput | null;
  /** Set for a twin: the row it duplicates (its outcome is copied, nothing else happens). */
  twin: TwinSource | null;
};

/** The facts of a plan before its copy input is added. */
type PlanFacts = Omit<Plan, "copy" | "twin">;

/** The first lines stored as the snippet (§3.10), and whether the row is quiet (received more than 3 days ago). */
function baseOf(row: InboundRow, now: Date, newText = newTextOf(row)): { snippet: string; quiet: boolean } {
  return { snippet: snippetOf(row, newText), quiet: row.receivedAt.getTime() < now.getTime() - QUIET_AFTER_MS };
}

/** A plan that files the message as a test reply: nothing links, stops or notifies (§3.3.0, §3.3.1). */
function testReplyPlan(base: { snippet: string; quiet: boolean }, autoReason: "internal" | null, method: LinkMethod | null): PlanFacts {
  return {
    kind: "TEST_REPLY",
    autoReason,
    signals: [],
    linkMethod: method,
    link: "test",
    email: null,
    companyId: null,
    personId: null,
    campaignId: null,
    scope: "none",
    changesStatus: false,
    label: "",
    heldCompanyId: null,
    spam: false,
    delay: false,
    forwardFailed: false,
    bounceStop: false,
    known: null,
    replierPersonIds: [],
    crossCompany: false,
    snippet: base.snippet,
    quiet: base.quiet,
    audience: { assigneeId: null, notify: [] },
  };
}

/**
 * Links the message and classifies it (M4-DESIGN §3.8 steps 3–9): thread ids → internal sender → classification →
 * (unlinked) delivery-notice ids and addresses, a challenge's named address, the sender's address, a known contact →
 * classification again once linked → spam or domain hold → kind, scope, repliers, assignee and notify set.
 *
 * The thread ids are looked up before the internal-sender check, so one of our addresses answering the email that went
 * to it (a test-list mailbox that is also a user's login email) is a reply like any other; a team member forwarding
 * someone else's reply still points at the email to that person and stays internal (§3.3.0, `isInternal`).
 */
async function planFacts(reader: DbOrTx, row: InboundRow, ctx: ReplyContext, now: Date): Promise<PlanFacts> {
  const newText = newTextOf(row);
  const base = baseOf(row, now, newText);
  const simulated = row.source === "SIMULATED";
  const linkOpts = { fromEmail: row.fromEmail, simulated, practiceCopy: ctx.practiceCopy, internal: ctx.internal };
  const hit = await threadLink(reader, threadIds({ inReplyTo: row.inReplyTo, references: row.references }), linkOpts);
  const threadRecipients = hit?.type === "email" ? [hit.email.toNorm] : [];
  if (ctx.internal.isInternal(row.fromEmail, threadRecipients)) return testReplyPlan(base, "internal", null);
  if (hit?.type === "test") return testReplyPlan(base, null, simulated ? "simulated" : "headers");

  let email: LinkedEmail | null = hit?.type === "email" ? hit.email : null;
  let method: LinkMethod | null = email ? (simulated ? "simulated" : "headers") : null;
  let companyOnly: number | null = null;
  let known: KnownPerson | null = null;
  let verdict: Verdict = classify(
    classifyInputOf(row, { linked: email !== null, sentSubjects: email ? await sentSubjectsOf(reader, email.recipientId) : [] }),
  );

  if (!email) {
    const window = { receivedAt: row.receivedAt, practiceCopy: ctx.practiceCopy };
    if (verdict.nature === "BOUNCE") {
      const text = noticeTextOf(row);
      const byId = await threadLink(reader, bodyMessageIds(text), { ...linkOpts, tests: false });
      if (byId?.type === "email") {
        email = byId.email;
        method = "body-id";
      } else {
        email = await newestSentTo(reader, bounceRecipients({ headers: rowHeaders(row.headers), text }), window);
        if (email) method = "bounce-address";
      }
    } else {
      if (verdict.autoReason === "challenge") {
        email = await newestSentTo(reader, namedRecipients({ subject: row.subject, text: newText }), window);
        if (email) method = "named-address";
      }
      if (!email) {
        email = await newestSentTo(reader, [row.fromEmail], window);
        if (email) method = "from";
      }
      if (!email) {
        known = await knownPersonOf(reader, row.fromEmail);
        if (known) {
          email = await newestSentToCompany(reader, known.companyId, window);
          method = "person";
          if (!email) companyOnly = known.companyId;
        }
      }
      if (method) {
        verdict = classify(classifyInputOf(row, { linked: true, sentSubjects: email ? await sentSubjectsOf(reader, email.recipientId) : [] }));
      }
    }
  }

  const link: LinkTarget = email ? "email" : companyOnly !== null ? "company" : "none";
  known ??= link === "none" ? null : await knownPersonOf(reader, row.fromEmail);
  let autoReason: string | null = verdict.autoReason;
  let heldCompanyId: number | null = null;
  let spam = false;
  if (link === "none" && (verdict.nature === "REPLY" || verdict.nature === "POSSIBLE")) {
    if (verdict.signals.includes("mailgun-spam")) {
      spam = true;
      autoReason = "spam";
    } else {
      heldCompanyId = await domainHoldCompany(reader, row.fromEmail);
    }
  }
  const kind = storedKind(verdict.nature, link);
  const companyId = email?.companyId ?? companyOnly;
  const personId = email ? (email.personId ?? (method === "person" ? (known?.id ?? null) : null)) : companyOnly !== null ? (known?.id ?? null) : null;
  // A live email is "emailed" by its own campaign's launch flag, never by today's switch (M6-DESIGN §2.2).
  const launchedGoLive = email?.mode === "LIVE" ? await launchedGoLiveOf(reader, email) : null;
  const scope = replyScope({ mode: email?.mode ?? null, link, simulated, practiceCopy: ctx.practiceCopy, everLive: ctx.everLive, launchedGoLive });
  const replierPersonIds = known ? [known.id] : email?.personId ? [email.personId] : [];
  const crossCompany = known !== null && companyId !== null && known.companyId !== companyId;

  let forwardFailed = false;
  let bounceStop = false;
  if (kind === "BOUNCE_NOTICE" && email && !verdict.delay) {
    const named = bounceRecipients({ headers: rowHeaders(row.headers), text: noticeTextOf(row) });
    forwardFailed = named.length > 0 && !named.includes(email.toNorm);
    bounceStop = !forwardFailed;
  }
  const audience = await audienceFor(reader, {
    kind,
    link,
    spam,
    senderId: email?.senderId ?? null,
    senderAddressId: row.senderAddressId,
    simulated,
    ownerId: ctx.ownerId,
  });
  return {
    kind,
    autoReason,
    signals: verdict.signals,
    linkMethod: method,
    link,
    email,
    companyId,
    personId,
    campaignId: email?.campaignId ?? null,
    scope: scope.scope,
    changesStatus: scope.changesStatus,
    label: scope.label,
    heldCompanyId,
    spam,
    delay: verdict.delay,
    forwardFailed,
    bounceStop,
    known,
    replierPersonIds,
    crossCompany,
    snippet: base.snippet,
    quiet: base.quiet,
    audience: spam ? { assigneeId: null, notify: [] } : audience,
  };
}

/** The copy facts of a plan (M4-DESIGN §5.1): names are read here, before the transaction. */
async function copyInputOf(reader: DbOrTx, row: InboundRow, p: PlanFacts, ctx: ReplyContext): Promise<ReplyCopyInput> {
  const [{ company, person }, held] = await Promise.all([
    namesOf(reader, { companyId: p.companyId, personId: p.personId }),
    p.heldCompanyId !== null ? namesOf(reader, { companyId: p.heldCompanyId }) : Promise.resolve(null),
  ]);
  const newText = newTextOf(row);
  const suggested =
    p.autoReason === "left-company"
      ? suggestedContact(newText || row.snippet, { fromEmail: row.fromEmail, companyDomain: company?.domain ?? null, ownDomains: ctx.ownDomains })
      : null;
  const fromIsThreadPerson = p.email
    ? row.fromEmail === p.email.toNorm || (p.known !== null && p.known.id === p.email.personId)
    : p.link === "company";
  return {
    kind: p.kind,
    autoReason: p.autoReason,
    companyName: company?.name ?? null,
    personName: person?.name ?? null,
    fromEmail: row.fromEmail,
    fromName: p.known ? p.known.name : row.fromName,
    replierIsKnown: p.known !== null,
    fromIsThreadPerson,
    newEmail: p.linkMethod === "person",
    threadSubject: p.email?.subject ?? null,
    subject: row.subject,
    suggested,
    label: p.label,
    failed: false,
    heldCompanyName: held?.company?.name ?? null,
    forwardFailed: p.forwardFailed,
    possibleChallenge: p.kind === "POSSIBLE_REPLY" && p.autoReason === "challenge",
    inboundId: row.id,
    companyId: p.companyId,
    campaignId: p.campaignId,
    recipientId: p.email?.recipientId ?? null,
    toEmail: p.email?.toEmail ?? null,
  };
}

/** The plan for a twin (§3.7): the first copy's outcome, answered as a duplicate; nothing else happens. */
function twinPlan(facts: PlanFacts, src: TwinSource): Plan {
  return {
    ...facts,
    kind: (src.kind ?? facts.kind) as InboundKindValue,
    autoReason: src.autoReason,
    signals: Array.isArray(src.signals) ? src.signals.filter((s): s is string => typeof s === "string") : facts.signals,
    linkMethod: (src.linkMethod as LinkMethod | null) ?? null,
    companyId: src.companyId,
    personId: src.personId,
    campaignId: src.campaignId,
    scope: (src.replyScope as ReplyScope | null) ?? "none",
    changesStatus: src.changesStatus ?? false,
    heldCompanyId: src.heldCompanyId,
    audience: { assigneeId: src.assigneeId, notify: [] },
    copy: null,
    twin: src,
  };
}

// ───────────────────────── writing (one transaction) ─────────────────────────

/** The row's processed fields. */
function rowData(row: InboundRow, p: Plan, now: Date): Prisma.InboundMessageUpdateManyMutationInput {
  const answered = p.twin ? "duplicate" : p.spam ? "spam" : null;
  return {
    processedAt: now,
    kind: p.kind,
    autoReason: p.autoReason,
    signals: p.signals as Prisma.InputJsonValue,
    linkMethod: p.linkMethod,
    outboundEmailId: p.twin ? p.twin.outboundEmailId : (p.email?.id ?? null),
    personId: p.personId,
    companyId: p.companyId,
    campaignId: p.campaignId,
    replyScope: p.scope,
    changesStatus: p.changesStatus,
    heldCompanyId: p.heldCompanyId,
    assigneeId: p.audience.assigneeId,
    snippet: p.snippet,
    ...(p.twin ? { confirmedAt: p.twin.confirmedAt, confirmedById: p.twin.confirmedById } : {}),
    ...(answered ? { answeredAt: now, answerOutcome: answered } : {}),
  };
}

/** The activities of one processed message (M4-DESIGN §3.11), inside `tx`. */
async function logReplyActivities(tx: Tx, row: InboundRow, p: Plan): Promise<void> {
  if (!p.copy) return;
  const { kind: _kind, inboundId: _inboundId, ...facts } = p.copy;
  const simulated = row.source === "SIMULATED" ? { simulated: true } : {};
  const base = { actorId: null, companyId: p.companyId, personId: p.personId, campaignId: p.campaignId, mode: p.email?.mode ?? null };
  switch (p.kind) {
    case "REPLY":
      await logActivity(
        {
          ...base,
          type: "reply.received",
          summary: replyActivitySummary({ ...facts, type: "reply.received" }),
          data: {
            inboundId: row.id,
            snippet: p.snippet,
            subject: row.subject,
            from: row.fromEmail,
            replierPersonIds: p.replierPersonIds,
            emailId: p.email?.id ?? null,
            step: p.email?.step ?? null,
            linkMethod: p.linkMethod,
            ...simulated,
          },
        },
        tx,
      );
      return;
    case "POSSIBLE_REPLY":
      await logActivity(
        {
          ...base,
          type: "reply.possible",
          summary: replyActivitySummary({ ...facts, type: "reply.possible" }),
          data: { inboundId: row.id, snippet: p.snippet, signals: p.signals, ...simulated },
        },
        tx,
      );
      return;
    case "AUTO_REPLY":
      if (p.companyId === null) return;
      await logActivity(
        {
          ...base,
          type: "reply.auto",
          summary: replyActivitySummary({ ...facts, type: "reply.auto" }),
          data: { inboundId: row.id, snippet: p.snippet, autoReason: p.autoReason, ...simulated },
        },
        tx,
      );
      return;
    case "BOUNCE_NOTICE":
      if (!p.email) return;
      await logActivity(
        {
          ...base,
          type: "reply.bounce",
          summary: replyActivitySummary({ ...facts, type: "reply.bounce", delay: p.delay }),
          data: { inboundId: row.id, delay: p.delay, forwardFailed: p.forwardFailed, ...simulated },
        },
        tx,
      );
      return;
    case "UNLINKED":
      if (p.spam) return;
      await logActivity(
        {
          actorId: null,
          type: "reply.unlinked",
          summary: replyActivitySummary({ ...facts, type: "reply.unlinked" }),
          companyId: p.heldCompanyId,
          data: { inboundId: row.id, subject: row.subject, heldCompanyId: p.heldCompanyId, ...simulated },
        },
        tx,
      );
      return;
    default:
      return;
  }
}

/**
 * The notification of one processed message (M4-DESIGN §5.1, §5.5), inside `tx`: replies, possible replies and unlinked
 * replies to the notify set of §4.2; a challenge, a "left the company" auto-reply and a delivery notice to the sender
 * only, the attention ones once per person and reason per 30 days (counting only notices that really went out); quiet
 * rows give one grouped notice whose text fits where they are (the waiting list, or the Activity page). Returns true
 * when the row's own `reply.attention` was created, so the row can carry `ATTENTION_SENT_SIGNAL`.
 */
async function notifyFor(tx: Tx, row: InboundRow, p: Plan, now: Date): Promise<boolean> {
  const copy = p.copy ? replyNotificationCopy(p.copy) : null;
  if (!copy) return false;
  const waiting = (WAITING_KINDS as readonly string[]).includes(p.kind);
  if (!waiting && copy.type === REPLY_NOTIFICATION.attention) {
    const seen = await attentionSentRecently(tx, {
      inboundId: row.id,
      personId: p.personId,
      fromEmail: row.fromEmail,
      autoReason: p.autoReason,
      now,
    });
    if (seen) return false;
  }
  const targets = waiting ? p.audience.notify : p.audience.assigneeId !== null ? [p.audience.assigneeId] : [];
  const res = await sendReplyNotification(tx, { copy, targets, quiet: p.quiet, waiting, assigneeId: p.audience.assigneeId, now });
  return res.sent === "own" && copy.type === REPLY_NOTIFICATION.attention;
}

/**
 * Writes one plan inside `tx` (M4-DESIGN §3.8 step 10): the compare-and-set on `processedAt` (0 rows → null: another
 * process did it), then the effects of §3.5 for the kind and scope, the activities and the notification. A copy of the
 * same message processed meanwhile turns this one into its twin. Returns the campaigns whose recipients a stop touched.
 *
 * The compare-and-set is the transaction's first statement on purpose: SQLite's transactions start deferred, so a
 * read first would pin a snapshot that the other process's next commit (the web app's Simulate reply, or the worker's
 * lane) makes stale, and the upgrade to a write would then fail at once with SQLITE_BUSY instead of waiting its turn.
 * Claiming first takes the write lock through the normal busy wait; the twin check and the full row follow.
 */
async function writePlan(tx: Tx, row: InboundRow, plan: Plan, now: Date): Promise<{ plan: Plan; campaignIds: number[] } | null> {
  const claimed = await tx.inboundMessage.updateMany({ where: { id: row.id, processedAt: null }, data: { processedAt: now } });
  if (claimed.count !== 1) return null;
  let p = plan;
  if (!p.twin) {
    const src = await findTwinSource(tx, row);
    if (src) p = twinPlan(p, src);
  }
  // The assignee was chosen before the transaction; someone switched off since then hands it to the Owner (§4.2).
  if (!p.twin) p = { ...p, audience: await confirmAudience(tx, p.audience) };
  await tx.inboundMessage.updateMany({ where: { id: row.id }, data: rowData(row, p, now) });
  if (p.twin) return { plan: p, campaignIds: [] };

  const touched = new Set<number>();
  if (p.kind === "REPLY" && p.companyId !== null) {
    const res = await applyReplyEffects(tx, {
      inboundId: row.id,
      companyId: p.companyId,
      scope: p.scope,
      campaignId: p.campaignId,
      changesStatus: p.changesStatus,
      receivedAt: row.receivedAt,
      fromEmail: row.fromEmail,
      replierPersonIds: p.replierPersonIds,
      crossCompany: p.crossCompany,
      personId: p.personId,
      mode: p.email?.mode ?? null,
      now,
    });
    for (const c of res.campaignIds) touched.add(c);
  } else if (p.kind === "POSSIBLE_REPLY" && p.companyId !== null) {
    await holdCompany(tx, {
      companyId: p.companyId,
      reason: "possible-reply",
      campaignId: p.scope === "campaign" ? p.campaignId : null,
      now,
    });
  } else if (p.kind === "BOUNCE_NOTICE" && p.email && p.bounceStop) {
    const campaigns = await applyBounceStop(tx, {
      toNorm: p.email.toNorm,
      recipientId: p.email.recipientId,
      campaignId: p.email.campaignId,
      scope: p.scope,
      inboundId: row.id,
      now,
    });
    for (const c of campaigns) touched.add(c);
  } else if (p.kind === "UNLINKED" && p.heldCompanyId !== null) {
    await holdCompany(tx, { companyId: p.heldCompanyId, reason: "possible-reply", campaignId: null, now });
  }
  await logReplyActivities(tx, row, p);
  if (await notifyFor(tx, row, p, now)) {
    // Marks the row whose attention notice really went out: the 30-day rule counts only these (§5.5).
    p = { ...p, signals: [...p.signals, ATTENTION_SENT_SIGNAL] };
    await tx.inboundMessage.updateMany({ where: { id: row.id }, data: { signals: p.signals as Prisma.InputJsonValue } });
  }
  return { plan: p, campaignIds: [...touched].sort((a, b) => a - b) };
}

/**
 * A reply proves the email it answers arrived (M4-DESIGN §3.7, D12): a linked TEST/LIVE email still UNKNOWN,
 * UNCONFIRMED or QUEUED again is recorded as sent (`markSent` with `onlyFrom`, so a SENDING or FAILED row is never
 * touched), before the effects. A failure is logged and never blocks the reply.
 */
async function proveSent(row: InboundRow, email: LinkedEmail | null, ctx: ReplyContext, logger: Logger): Promise<void> {
  if (!email || email.mode === "DRY_RUN" || !(PROVABLE_STATUSES as readonly string[]).includes(email.status)) return;
  try {
    await markSent(email.id, email.claimedAt ?? row.receivedAt, { onlyFrom: [...PROVABLE_STATUSES], practiceCopy: ctx.practiceCopy });
  } catch (err) {
    logger.error(`Email #${email.id} couldn't be recorded as sent from the reply #${row.id}`, err);
  }
}

/** Processes one message with an already loaded context (the lane loads it once per batch). */
async function processWith(id: number, now: Date, ctx: ReplyContext, logger: Logger): Promise<ProcessedReply | null> {
  const row = await loadInboundRow(id);
  if (!row || row.processedAt) return null;
  const twin = await findTwinSource(db, row);
  let plan: Plan;
  if (twin) {
    // A second copy of a message already processed: nothing to link or classify, its outcome is copied.
    plan = twinPlan(testReplyPlan(baseOf(row, now), null, null), twin);
  } else {
    const facts = await planFacts(db, row, ctx, now);
    plan = { ...facts, twin: null, copy: await copyInputOf(db, row, facts, ctx) };
    await proveSent(row, plan.email, ctx, logger);
  }
  const written = await dbTx((tx) => writePlan(tx, row, plan, now));
  if (!written) return null;
  for (const campaignId of written.campaignIds) {
    try {
      await finishCheck(campaignId, { now });
    } catch (err) {
      // The 5-minute maintenance runs the finish check again.
      logger.error(`The finish check of campaign #${campaignId} failed after reply #${id}`, err);
    }
  }
  return { id, kind: written.plan.kind, companyId: written.plan.companyId, campaignIds: written.campaignIds };
}

/**
 * Processes one stored message (M4-DESIGN §3.8): link, classify, and in one short transaction store the outcome and
 * apply its effects, activities and notifications; then the finish check of every campaign a stop touched. Returns
 * null when the row doesn't exist or was already processed (here or by the other process). Throws when processing
 * fails (the lane retries with back-off; Simulate shows the error).
 */
export async function processInboundMessage(id: number, opts: { now?: Date } = {}): Promise<ProcessedReply | null> {
  const now = opts.now ?? new Date();
  return processWith(id, now, await loadReplyContext(), defaultLogger);
}

// ───────────────────────── the lane's batch, back-off and fail-safe ─────────────────────────

/**
 * The fail-safe after the 5th failure (M4-DESIGN §3.8), one small transaction that never releases anything: the company
 * the message's thread points at (the first thread id that hits one of our emails; test emails and dry runs on real
 * data ignored), else the company of the live contact who sent it, is held for a possible reply in real scope, and the
 * row becomes POSSIBLE_REPLY `process-failed` assigned to the Owner; with no company it becomes UNLINKED
 * `process-failed`. Either way the Owner is told (`reply.unlinked`, the failure text). Returns false when the row was
 * processed meanwhile.
 *
 * A simulated reply on real data (the dry-run outbox's Simulate reply, practice copy off) keeps the dry run's scope
 * (§3.6): it holds only the campaign of the dry-run email it answers, stored with replyScope "campaign" and no status
 * change, so "Real reply" later changes only that campaign. It never falls back to the contact with that address (a
 * simulated message comes from the address the dry run went to, which would widen it to every campaign); with no
 * dry-run email found it is only listed, holding nothing.
 */
export async function applyReplyFailSafe(id: number, opts: { now?: Date } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const row = await loadInboundRow(id);
  if (!row || row.processedAt) return false;
  const ctx = await loadReplyContext();
  const simulated = row.source === "SIMULATED";
  const hit = await threadLink(db, threadIds({ inReplyTo: row.inReplyTo, references: row.references }), {
    fromEmail: row.fromEmail,
    simulated,
    practiceCopy: ctx.practiceCopy,
    internal: ctx.internal,
    tests: false,
  });
  const email = hit?.type === "email" ? hit.email : null;
  // A dry run on real data never leaves the PC: its simulated reply stays in the dry run's own campaign.
  const dryRunOnly = simulated && !ctx.practiceCopy;
  const campaignScope = dryRunOnly && email?.mode === "DRY_RUN";
  const known = email || dryRunOnly ? null : await knownPersonOf(db, row.fromEmail);
  const companyId = dryRunOnly && !campaignScope ? null : (email?.companyId ?? known?.companyId ?? null);
  const scope: ReplyScope = companyId === null ? "none" : campaignScope ? "campaign" : "real";
  const { company } = await namesOf(db, { companyId });
  const kind: InboundKindValue = companyId !== null ? "POSSIBLE_REPLY" : "UNLINKED";
  const snippet = snippetOf(row);
  const copy = replyNotificationCopy({
    kind,
    autoReason: "process-failed",
    failed: true,
    fromEmail: row.fromEmail,
    subject: row.subject,
    companyName: company?.name ?? null,
    heldCompanyName: company?.name ?? null,
    inboundId: row.id,
    companyId,
  });
  const linkedEmail = companyId !== null ? email : null;
  // "Changes status" (M6-DESIGN §2.2): a linked email by its own campaign's launch flag (a test email sent before
  // go-live never makes a test mailbox Replied), a company alone once the app has been live (also after a domain change
  // switched go-live off, review GOLIVE-01), as `replyScope` does.
  const changesStatus =
    scope !== "real"
      ? false
      : linkedEmail
        ? countsAsEmailed(linkedEmail.mode, { practiceCopy: ctx.practiceCopy, launchedGoLive: await launchedGoLiveOf(db, linkedEmail) })
        : ctx.practiceCopy || ctx.everLive;
  return dbTx(async (tx) => {
    const claimed = await tx.inboundMessage.updateMany({
      where: { id: row.id, processedAt: null },
      data: {
        processedAt: now,
        kind,
        autoReason: "process-failed",
        signals: ["process-failed"],
        linkMethod: linkedEmail ? (simulated ? "simulated" : "headers") : known ? "person" : null,
        outboundEmailId: linkedEmail?.id ?? null,
        personId: linkedEmail?.personId ?? known?.id ?? null,
        companyId,
        campaignId: linkedEmail?.campaignId ?? null,
        replyScope: scope,
        changesStatus,
        heldCompanyId: null,
        assigneeId: ctx.ownerId,
        snippet,
      },
    });
    if (claimed.count !== 1) return false;
    if (companyId !== null) {
      const campaignId = scope === "campaign" ? (linkedEmail?.campaignId ?? null) : null;
      await holdCompany(tx, { companyId, reason: "possible-reply", campaignId, now });
    }
    const facts = { fromEmail: row.fromEmail, subject: row.subject, heldCompanyName: company?.name ?? null };
    await logActivity(
      {
        actorId: null,
        type: companyId !== null ? "reply.possible" : "reply.unlinked",
        summary: replyActivitySummary({ ...facts, type: companyId !== null ? "reply.possible" : "reply.unlinked" }),
        companyId,
        personId: linkedEmail?.personId ?? known?.id ?? null,
        campaignId: linkedEmail?.campaignId ?? null,
        mode: linkedEmail?.mode ?? null,
        data: { inboundId: row.id, snippet, subject: row.subject, failed: true, ...(simulated ? { simulated: true } : {}) },
      },
      tx,
    );
    if (copy) await notifyUsers([ctx.ownerId], copy, tx);
    return true;
  });
}

/**
 * The event lane's reply work (M4-DESIGN §3.8, §3.9): up to `limit` (20) unprocessed messages, oldest first
 * (`receivedAt`, then id), skipping those still waiting for a retry, each in its own try, yielding to the event loop
 * between them. A message whose processing throws is retried after 1, 5, 15 and 60 minutes (`failures`, kept by the
 * lane: a bug or a long-busy database can't use up the tries in seconds; the sending guard keeps holding its company
 * meanwhile); after the 5th failure the fail-safe holds its company (`applyReplyFailSafe`). `processOne` replaces the
 * per-message step (tests). Returns how many were processed and how many threw this time.
 */
export async function processPendingInbound(opts: {
  now: Date;
  limit?: number;
  failures?: InboundFailures;
  logger?: Logger;
  processOne?: (id: number, opts: { now: Date }) => Promise<ProcessedReply | null>;
}): Promise<{ processed: number; failed: number }> {
  const now = opts.now;
  const failures = opts.failures ?? sharedFailures;
  const logger = opts.logger ?? defaultLogger;
  const limit = Math.max(1, Math.floor(opts.limit ?? INBOUND_BATCH));
  // Messages the other process (Simulate, the web app) processed while they waited here for a retry are forgotten.
  const due = [...failures].filter(([, f]) => f.nextTryAt <= now.getTime()).map(([id]) => id);
  if (due.length > 0) {
    const done = await db.inboundMessage.findMany({ where: { id: { in: due }, processedAt: { not: null } }, select: { id: true } });
    for (const { id } of done) failures.delete(id);
  }
  const waiting = [...failures].filter(([, f]) => f.nextTryAt > now.getTime()).map(([id]) => id);
  const rows = await db.inboundMessage.findMany({
    where: { processedAt: null, ...(waiting.length ? { id: { notIn: waiting } } : {}) },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
  const result = { processed: 0, failed: 0 };
  if (rows.length === 0) return result;

  let shared: ReplyContext | null = null;
  const one =
    opts.processOne ??
    (async (id: number, o: { now: Date }) => {
      const ctx = shared ?? (shared = await loadReplyContext());
      return processWith(id, o.now, ctx, logger);
    });

  for (const { id } of rows) {
    try {
      await one(id, { now });
      failures.delete(id);
      result.processed += 1;
    } catch (err) {
      result.failed += 1;
      const count = (failures.get(id)?.count ?? 0) + 1;
      if (count < INBOUND_MAX_FAILURES) {
        failures.set(id, { count, nextTryAt: now.getTime() + INBOUND_RETRY_DELAYS_MS[count - 1]! });
        logger.error(`Reply #${id} couldn't be processed (try ${count} of ${INBOUND_MAX_FAILURES})`, err);
      } else {
        logger.error(`Gave up processing reply #${id} after ${INBOUND_MAX_FAILURES} tries: holding its company to be safe`, err);
        try {
          await applyReplyFailSafe(id, { now });
          failures.delete(id);
        } catch (inner) {
          failures.set(id, { count, nextTryAt: now.getTime() + INBOUND_RETRY_DELAYS_MS[INBOUND_RETRY_DELAYS_MS.length - 1] });
          logger.error(`Couldn't hold the company of reply #${id}; trying again later`, inner);
        }
      }
    }
    await yieldToEventLoop();
  }
  return result;
}
