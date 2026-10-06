import type { SuppressionReason } from "@/generated/prisma/client";
import { normalizeEmail, parseEmail } from "@/core/email-address";
import type { NormalizedEvent } from "@/core/mailgun/events";
import { plural } from "@/core/text";
import { logActivity } from "@/server/activity";
import { db, dbTx, dbWrite, type Tx } from "@/server/db";
import { enqueueJob } from "@/server/jobs";
import { getMailgunContext, type MailgunContextResult } from "@/server/mailgun/context";
import { isMailgunError, plainMailgunError } from "@/server/mailgun/errors";
import type { MailgunClient } from "@/server/mailgun/client";
import type { SuppressionItem, SuppressionList } from "@/server/mailgun/types";
import { notifyOwner } from "@/server/notifications";
import { getSetting, getSettings } from "@/server/settings";
import { ServiceError } from "@/server/services/companies/mutations";
import { applyMailEvent, retryOnUnique } from "@/server/services/mail-events/apply";
import { stopRecipients } from "@/server/services/mail-events/stops";

/**
 * The do-not-email list and Mailgun's three suppression lists (PLAN B6.11, M3-DESIGN §4.4.6, §9.2 items 15 and 28).
 *  - Pull (catch-up): every entry of Mailgun's bounces/complaints/unsubscribes lists goes through applyMailEvent as a
 *    synthetic event, so addresses Mailgun refuses are refused by the app too.
 *  - Push: every local entry Mailgun doesn't have yet goes to the active domain's unsubscribes list (tags ["*"]), so
 *    Mailgun itself refuses anything the app wants never sent (bounced, complained, unsubscribed, "do not email").
 *    INVALID entries (the address check said the address doesn't exist) are never pushed: they aren't unsubscribes
 *    (M5-DESIGN D9); `addInvalidSuppression` marks them pushed when it writes them, and the push skips them anyway.
 *  - The Owner can add an address by hand, and take ONLY test-list addresses and active users' reply inboxes off it.
 */

/** Local rows pushed per Mailgun call (Mailgun refuses 1,000 or more per call). */
export const PUSH_BATCH = 999;
/** Events per transaction while pulling (B5: keep transactions short). */
const PULL_TX_BATCH = 50;
const LISTS: readonly SuppressionList[] = ["bounces", "complaints", "unsubscribes"];

export const REMOVE_REFUSED = "Only your test mailboxes and your team's reply inboxes can be taken off the list.";
export const INVALID_ADDRESS = "That doesn't look like an email address: check for typos like a missing @.";

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// ───────────────────────── pull ─────────────────────────

/**
 * One entry of a Mailgun suppression list as an event (§4.4.5 step 3). Its dedupe key includes the entry's
 * `created_at`, so an address removed from Mailgun's list and added again later is applied again.
 */
export function listEntryEvent(list: SuppressionList, item: SuppressionItem, domain: string, now: Date): NormalizedEvent {
  const createdAt = item.createdAt ? item.createdAt.toISOString() : "none";
  const base = {
    dedupeKey: `sup:${list}:${item.address}:${createdAt}`,
    providerEventId: `sup-${list}-${item.address}`,
    occurredAt: item.createdAt ?? now,
    messageId: null,
    recipient: item.address,
    userVariables: {},
    tags: item.tags,
    isTestMode: false,
    domain,
    raw: { list, address: item.address, created_at: item.createdAt ? item.createdAt.toISOString() : null, code: item.code, error: item.error, tags: item.tags },
  };
  if (list === "bounces") {
    const code = item.code && /^\d+$/.test(item.code) ? Number(item.code) : null;
    return {
      ...base,
      type: "failed",
      severity: "permanent",
      reason: "suppress-bounce",
      deliveryStatus: { code, message: item.error, description: null, bounceType: "hard" },
    };
  }
  return { ...base, type: list === "complaints" ? "complained" : "unsubscribed", severity: null, reason: null, deliveryStatus: null };
}

export type PullResult = {
  /** Every list was walked to its end. */
  complete: boolean;
  /** Entries not seen before (new events). */
  applied: number;
  /** New local do-not-email entries. */
  added: number;
  /** New local entries from the complaints list. */
  newComplaints: number;
  /** MAIN-DOMAIN-DESIGN O34 (own-mailbox mode): complaint and bounce entries linked to the email they concern. */
  linked: number;
};

/** How far back from a list entry's date the email it concerns may have been sent (O34). */
export const LIST_LINK_DAYS = 7;

/**
 * Whether the health counts already see a complaint (`complaints`) or a real hard bounce (`bounces`) for `address`: an
 * event of that kind linked to one of the LIVE emails sent to it (a Logs event, or a list entry an earlier pull linked).
 * The counts take one per email, so a second link to another email would count the same complaint twice.
 */
async function alreadyCounted(tx: Tx, list: "bounces" | "complaints", address: string): Promise<boolean> {
  const emails = await tx.outboundEmail.findMany({ where: { toNorm: address, mode: "LIVE" }, select: { id: true } });
  if (emails.length === 0) return false;
  const event = await tx.mailEvent.findFirst({
    where: {
      outboundEmailId: { in: emails.map((e) => e.id) },
      isTestMode: false,
      ...(list === "complaints"
        ? { type: "complained" }
        : { type: "failed", severity: "permanent", OR: [{ reason: null }, { NOT: { reason: { startsWith: "suppress-" } } }] }),
    },
    select: { id: true },
  });
  return event !== null;
}

/**
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O34, §2.8): a `complaints` or `bounces` entry gets the Message-ID of the newest
 * LIVE email SENT to that address within the 7 days before the entry's date (the pull's time when it has none), so
 * `applyMailEvent` links it to that email and the health counts see it; a linked bounce gets the reason "list-bounce"
 * (never a `suppress-*` drop; the entry's hard bounce type keeps it a hard bounce). An address that already has a local
 * do-not-email entry for another reason (Mark unsubscribed, Add an address) is linked too: that entry never counted a
 * complaint or a bounce (review REPLIES-10). Nothing is linked when the counts already see one for that address
 * (`alreadyCounted`: a Logs event, or the same entry linked by an earlier pull). Inside the pull's transaction, no
 * network. Returns the linked copy, or null when there is nothing to link (`listEntryEvent` itself is never changed).
 */
async function linkListEntry(tx: Tx, list: SuppressionList, ev: NormalizedEvent): Promise<NormalizedEvent | null> {
  if (list === "unsubscribes") return null;
  const address = normalizeEmail(ev.recipient ?? "");
  if (!address) return null;
  // The entry's date (`listEntryEvent` uses the pull's time when Mailgun gave none).
  const at = ev.occurredAt;
  const email = await tx.outboundEmail.findFirst({
    where: {
      toNorm: address,
      mode: "LIVE",
      status: "SENT",
      sentAt: { lte: at, gte: new Date(at.getTime() - LIST_LINK_DAYS * 86_400_000) },
    },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    select: { messageId: true },
  });
  if (!email) return null;
  if (await alreadyCounted(tx, list, address)) return null;
  return { ...ev, messageId: email.messageId, ...(list === "bounces" ? { reason: "list-bounce" } : {}) };
}

/**
 * Pulls Mailgun's three lists for one domain into the app (50 events per transaction, yielding in between). An
 * address already on the local list keeps its reason and the person's flags (the entry may be our own push), and any
 * stop uses that reason's code, so a "do not email" or bounced person is never relabelled "unsubscribed". No
 * per-address activity: one summary activity `mailgun.listsPulled` when something was added, and one Owner
 * notification when the complaints list brought new addresses. With `ownMailbox` (MAIN-DOMAIN-DESIGN O34) new complaint
 * and bounce entries are linked to the email they concern first (`linkListEntry`); absent = today's pull exactly.
 */
export async function pullSuppressions(input: {
  client: MailgunClient;
  domain: string;
  activeDomain: string;
  now: Date;
  practiceCopy: boolean;
  signal?: AbortSignal;
  /** MAIN-DOMAIN-DESIGN O34: own-mailbox mode (the catch-up passes `ctx.replies === "own-mailbox"`). */
  ownMailbox?: boolean;
}): Promise<PullResult> {
  const result: PullResult = { complete: true, applied: 0, added: 0, newComplaints: 0, linked: 0 };
  for (const list of LISTS) {
    const walk = await input.client.walkSuppressions(
      input.domain,
      list,
      async (items) => {
        for (let i = 0; i < items.length; i += PULL_TX_BATCH) {
          const events = items.slice(i, i + PULL_TX_BATCH).map((item) => listEntryEvent(list, item, input.domain, input.now));
          // Which entries this transaction linked (reset when a lost unique-key race runs it again).
          let linkedHere = new Set<number>();
          const results = await retryOnUnique(() =>
            dbTx(async (tx) => {
              const out = [];
              linkedHere = new Set<number>();
              for (const [index, entry] of events.entries()) {
                const linkedCopy = input.ownMailbox === true ? await linkListEntry(tx, list, entry) : null;
                if (linkedCopy) linkedHere.add(index);
                const ev = linkedCopy ?? entry;
                out.push(
                  await applyMailEvent(tx, ev, "LOGS", {
                    now: input.now,
                    practiceCopy: input.practiceCopy,
                    processed: true,
                    fromList: true,
                    activeDomain: input.activeDomain,
                  }),
                );
              }
              return out;
            }),
          );
          for (const [index, r] of results.entries()) {
            // A linked entry counts once, when its event is new (a stored one changed nothing now).
            if (linkedHere.has(index) && r.status === "created") result.linked += 1;
            if (r.status === "created") result.applied += 1;
            if (r.suppression === "created") {
              result.added += 1;
              if (list === "complaints") result.newComplaints += 1;
            }
          }
          await yieldToEventLoop();
        }
      },
      { signal: input.signal },
    );
    if (!walk.complete) result.complete = false;
  }
  if (result.complete) {
    await dbWrite((c) =>
      c.syncCursor.upsert({
        where: { key: `${input.domain}:suppressions` },
        create: { key: `${input.domain}:suppressions`, value: input.now.toISOString() },
        update: { value: input.now.toISOString() },
      }),
    );
  }
  if (result.added > 0) {
    await logActivity({
      actorId: null,
      type: "mailgun.listsPulled",
      summary: `Mailgun's lists added ${plural(result.added, "address", "addresses")} to the do-not-email list`,
      data: { domain: input.domain, added: result.added, complaints: result.newComplaints },
    });
  }
  if (result.newComplaints > 0) {
    await notifyOwner({
      type: "email.complained",
      title: `Mailgun's complaint list has ${plural(result.newComplaints, "new address", "new addresses")}`,
      body: "They won't be emailed again. Settings › Deliverability lists them.",
      link: "/settings/deliverability",
    });
  }
  return result;
}

// ───────────────────────── push ─────────────────────────

/**
 * Pushes every local do-not-email entry Mailgun doesn't have yet (`pushedToMailgunAt` empty) to the ACTIVE domain's
 * unsubscribes list, tags ["*"], at most 999 per call; each batch is marked pushed as soon as Mailgun accepted it.
 * Never in the practice copy, and nothing when Mailgun isn't connected. Entries that aren't valid addresses can never
 * be sent to anyway, so they are marked without pushing. INVALID entries are never pushed (M5-DESIGN D9: belt and
 * braces, `addInvalidSuppression` already marks them).
 */
export async function pushLocalSuppressions(
  opts: { now?: Date; mailgun?: () => Promise<MailgunContextResult> } = {},
): Promise<{ pushed: number }> {
  const now = opts.now ?? new Date();
  if ((await getSetting("practice.copy")) === true) return { pushed: 0 };
  const ctx = await (opts.mailgun ?? getMailgunContext)();
  if (!ctx.connected) return { pushed: 0 };
  let pushed = 0;
  let lastId = 0;
  for (let round = 0; round < 1000; round++) {
    const rows = await db.suppression.findMany({
      where: { pushedToMailgunAt: null, reason: { not: "INVALID" }, id: { gt: lastId } },
      orderBy: { id: "asc" },
      take: PUSH_BATCH,
      select: { id: true, emailNorm: true, createdAt: true },
    });
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]!.id;
    const valid = rows.filter((r) => normalizeEmail(r.emailNorm) !== null);
    if (valid.length > 0) {
      await ctx.client.addUnsubscribes(
        ctx.domain,
        valid.map((r) => ({ address: r.emailNorm, createdAt: r.createdAt })),
      );
    }
    await dbWrite((c) =>
      c.suppression.updateMany({ where: { id: { in: rows.map((r) => r.id) }, pushedToMailgunAt: null }, data: { pushedToMailgunAt: now } }),
    );
    pushed += valid.length;
    await yieldToEventLoop();
  }
  return { pushed };
}

/** Queues the push (job mailgun.syncSuppressions, dedupe "mailgun:push"), except in the practice copy. */
export async function enqueueSuppressionPush(createdById: number | null = null): Promise<void> {
  if ((await getSetting("practice.copy")) === true) return;
  await enqueueJob({ type: "mailgun.syncSuppressions", dedupeKey: "mailgun:push", priority: 10, createdById });
}

// ───────────────────────── by hand ─────────────────────────

const RANK: Readonly<Record<SuppressionReason, number>> = { MANUAL: 0, INVALID: 1, BOUNCED: 2, UNSUBSCRIBED: 3, COMPLAINED: 4 };

/**
 * The Owner's "Add an address" (Settings › Deliverability): the address goes on the do-not-email list for every sender
 * (Unsubscribed also sets the person's flag), and every email waiting for it stops, in one transaction; then the push
 * to Mailgun is queued. An address already on the list for a stronger reason keeps it.
 */
export async function addManualSuppression(
  actor: { id: number; name: string },
  input: { email: string; reason: "UNSUBSCRIBED" | "MANUAL" },
): Promise<{ created: boolean; stopped: number }> {
  const parsed = parseEmail(input.email);
  if (!parsed) throw new ServiceError(INVALID_ADDRESS, { fieldErrors: { email: [INVALID_ADDRESS] } });
  const reason: SuppressionReason = input.reason === "UNSUBSCRIBED" ? "UNSUBSCRIBED" : "MANUAL";
  const now = new Date();
  const res = await dbTx(async (tx) => {
    const existing = await tx.suppression.findUnique({ where: { emailNorm: parsed.norm } });
    const detail = `Added by ${actor.name}`;
    let created = false;
    let changed = false;
    if (!existing) {
      await tx.suppression.create({ data: { emailNorm: parsed.norm, reason, source: "manual", detail, pushedToMailgunAt: null } });
      created = true;
      changed = true;
    } else if (RANK[reason] > RANK[existing.reason]) {
      await tx.suppression.update({ where: { id: existing.id }, data: { reason, source: "manual", detail, pushedToMailgunAt: null } });
      changed = true;
    }
    const person = await tx.person.findUnique({ where: { emailNorm: parsed.norm }, select: { id: true, companyId: true, unsubscribedAt: true } });
    if (reason === "UNSUBSCRIBED" && person && !person.unsubscribedAt) {
      await tx.person.update({ where: { id: person.id }, data: { unsubscribedAt: now } });
      changed = true;
    }
    const stopped = await stopRecipients(tx, {
      emailNorm: parsed.norm,
      reason: reason === "UNSUBSCRIBED" ? "unsubscribed" : "suppressed",
      scope: "real",
      now,
    });
    if (changed || stopped > 0) {
      await logActivity(
        {
          actorId: actor.id,
          type: "suppression.added",
          summary: `${actor.name} added ${parsed.norm} to the do-not-email list${reason === "UNSUBSCRIBED" ? " (unsubscribed)" : ""}`,
          personId: person?.id ?? null,
          companyId: person?.companyId ?? null,
          data: { email: parsed.norm, reason, stopped },
        },
        tx,
      );
    }
    return { created, stopped, changed };
  });
  if (res.changed) await enqueueSuppressionPush(actor.id);
  return { created: res.created, stopped: res.stopped };
}

/**
 * The address check said an address doesn't exist or must not be emailed (M5-DESIGN §2.6 step 4), inside the check's
 * transaction `tx`: the one door for an INVALID do-not-email entry. A new entry gets reason INVALID, source
 * "verification" and `pushedToMailgunAt = now`, so it is never pushed to Mailgun's unsubscribes (D9). A MANUAL entry is
 * upgraded to INVALID (the existing RANK); a stronger one (bounced, unsubscribed, complained) or an INVALID one is kept
 * as it is. Then every open recipient with this address in every campaign is stopped with the code `invalid`
 * ("Stopped: the address check said not to email this address"); the caller leaves out the ones who never got an email
 * first (`excludeUnsent`, D24), so only people already emailed are stopped here. `personId`/`companyId` are the checked
 * person's (for the caller's activity entry; the entry is by address). No activity here: the check's commit writes one
 * `person.checked`. Returns whether the entry was created or upgraded, and how many recipients were stopped.
 */
export async function addInvalidSuppression(
  tx: Tx,
  input: { emailNorm: string; detail: string; personId: number | null; companyId: number | null; now: Date },
): Promise<{ changed: boolean; stopped: number }> {
  const emailNorm = input.emailNorm.trim().toLowerCase();
  if (!emailNorm) return { changed: false, stopped: 0 };
  const detail = input.detail.trim().slice(0, 300) || null;
  const existing = await tx.suppression.findUnique({ where: { emailNorm } });
  let changed = false;
  if (!existing) {
    await tx.suppression.create({
      data: { emailNorm, reason: "INVALID", source: "verification", detail, createdAt: input.now, pushedToMailgunAt: input.now },
    });
    changed = true;
  } else if (RANK.INVALID > RANK[existing.reason]) {
    await tx.suppression.update({
      where: { id: existing.id },
      // An entry Mailgun already has keeps its date; one it doesn't have is never pushed as INVALID.
      data: { reason: "INVALID", source: "verification", detail, pushedToMailgunAt: existing.pushedToMailgunAt ?? input.now },
    });
    changed = true;
  }
  const stopped = await stopRecipients(tx, { emailNorm, reason: "invalid", scope: "real", now: input.now });
  return { changed, stopped };
}

/** Why an address may be taken off the list: a test-list address, or an active user's reply inbox. */
export type RemovableAddress = { kind: "test-list" } | { kind: "reply-inbox"; userName: string };

/** The addresses the Owner may take off the do-not-email list (§9.2 item 15), normalised. */
export async function removableAddresses(): Promise<Map<string, RemovableAddress>> {
  const out = new Map<string, RemovableAddress>();
  const s = await getSettings(["sending.testList"] as const);
  for (const a of Array.isArray(s["sending.testList"]) ? s["sending.testList"] : []) {
    const n = typeof a === "string" ? normalizeEmail(a) : null;
    if (n) out.set(n, { kind: "test-list" });
  }
  const users = await db.user.findMany({ where: { active: true }, select: { name: true, email: true, replyInbox: true } });
  for (const u of users) {
    const n = normalizeEmail(u.replyInbox || u.email);
    if (n && !out.has(n)) out.set(n, { kind: "reply-inbox", userName: u.name });
  }
  return out;
}

/**
 * Takes a test-list address or an active user's reply inbox off the do-not-email list (everyone else stays on it for
 * good): the local entry and the person's flags go in one transaction, then the address is deleted from Mailgun's
 * three lists (network, after the transaction) and the reply routes are re-synced so the "Replies reach each sender"
 * row turns green again (never in own-mailbox mode: there are no routes, MAIN-DOMAIN-DESIGN O8). `mailgunProblem` is a
 * plain sentence when Mailgun couldn't be told.
 */
export async function removeOwnSuppression(
  actor: { id: number; name: string },
  email: string,
  opts: { mailgun?: () => Promise<MailgunContextResult> } = {},
): Promise<{ removed: boolean; mailgunProblem: string | null }> {
  const norm = normalizeEmail(email);
  if (!norm) throw new ServiceError(INVALID_ADDRESS);
  const allowed = await removableAddresses();
  if (!allowed.has(norm)) throw new ServiceError(REMOVE_REFUSED);

  const local = await dbTx(async (tx) => {
    const existing = await tx.suppression.findUnique({ where: { emailNorm: norm } });
    if (existing) await tx.suppression.delete({ where: { id: existing.id } });
    const person = await tx.person.findUnique({ where: { emailNorm: norm }, select: { id: true, companyId: true } });
    if (person) {
      await tx.person.update({ where: { id: person.id }, data: { unsubscribedAt: null, bouncedAt: null, complainedAt: null } });
    }
    return { existed: existing !== null, person };
  });

  let removedAtMailgun = false;
  let mailgunProblem: string | null = null;
  const ctx = await (opts.mailgun ?? getMailgunContext)();
  if (ctx.connected) {
    for (const list of LISTS) {
      try {
        if ((await ctx.client.deleteSuppression(ctx.domain, list, norm)) === "deleted") removedAtMailgun = true;
      } catch (err) {
        mailgunProblem = isMailgunError(err)
          ? `Mailgun couldn't be told: ${plainMailgunError(err, { domain: ctx.domain, region: ctx.region })}`
          : "Mailgun couldn't be told. Try again in a few minutes.";
      }
    }
  }

  const removed = local.existed || removedAtMailgun;
  if (removed) {
    await logActivity({
      actorId: actor.id,
      type: "suppression.removed",
      summary: `${actor.name} took ${norm} off the do-not-email list`,
      personId: local.person?.id ?? null,
      companyId: local.person?.companyId ?? null,
      data: { email: norm, mailgun: removedAtMailgun },
    });
    if (ctx.connected && ctx.replies !== "own-mailbox") {
      await enqueueJob({ type: "mailgun.syncRoutes", dedupeKey: "mailgun:routes", priority: 30, createdById: actor.id });
    }
  }
  return { removed, mailgunProblem };
}
