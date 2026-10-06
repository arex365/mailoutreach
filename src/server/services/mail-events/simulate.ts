import type { CompanyStatus } from "@/generated/prisma/client";
import { GENERAL_INBOX_NAME } from "@/core/email-address";
import { COMPANY_STATUS_LABELS } from "@/core/labels";
import { makeSimulatedEvent } from "@/core/mailgun/events";
import { parseAddressHeader, type HeaderPair, type ParsedInbound } from "@/core/mailgun/inbound";
import type { InboundKindValue, SimulateReplyKind } from "@/core/replies/types";
import { routeAddressOf } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { firstNameFrom } from "@/core/text";
import { db, dbTx } from "@/server/db";
import { getSetting } from "@/server/settings";
import { ServiceError } from "@/server/services/companies/mutations";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { processInboundMessage } from "@/server/services/replies/process";
import { applyMailEventNow, retryOnUnique } from "./apply";
import { storeInbound } from "./inbound-store";

/**
 * The dry-run outbox's test tools (PLAN A8 "simulated bounce and unsubscribe", M3-DESIGN §4.4.8, M4-DESIGN §7): anyone
 * signed in can pretend Mailgun reported back about one dry-run email, or that the person answered it. A simulated
 * event goes through the same applyMailEvent as a real one, and a simulated reply is stored and processed like a real
 * one (source SIMULATED), so both show exactly what would happen: on real data a dry run only changes its own
 * campaign; in the practice copy (where dry runs count as real) it changes the person and the company too, like a real
 * event or reply. Real (TEST/LIVE) emails can never be simulated.
 */

export type { SimulateReplyKind };

export type SimulateKind = "delivered" | "bounce" | "complaint" | "unsubscribe";
export const SIMULATE_KINDS: readonly SimulateKind[] = ["delivered", "bounce", "complaint", "unsubscribe"];

/** The MailEvent type each kind becomes (its dedupe key is `sim:<emailId>:<type>`). */
const EVENT_TYPE: Readonly<Record<SimulateKind, string>> = {
  delivered: "delivered",
  bounce: "failed",
  complaint: "complained",
  unsubscribe: "unsubscribed",
};

export const ALREADY_SIMULATED = "Already simulated.";

function realDataMessage(kind: SimulateKind, email: string): string {
  const what = { delivered: "a delivery", bounce: "a bounce", complaint: "a spam complaint", unsubscribe: "an unsubscribe" }[kind];
  return `Simulated ${what} for ${email}. In a dry run this only changes this campaign.`;
}

function practiceMessage(kind: SimulateKind, email: string): string {
  switch (kind) {
    case "delivered":
      return `Simulated a delivery for ${email}.`;
    case "bounce":
      return `Simulated a bounce: ${email} is now marked Bounced and won't be emailed again.`;
    case "complaint":
      return `Simulated a spam complaint: ${email} is now marked Complained and won't be emailed again.`;
    case "unsubscribe":
      return `Simulated an unsubscribe: ${email} is now marked Unsubscribed and won't be emailed again.`;
  }
}

/**
 * Simulates one Mailgun report for a SENT dry-run email. Repeating the same kind for the same email is a no-op
 * ("Already simulated."). The event's activity (by the event lane) names who simulated it.
 */
export async function simulateEmailEvent(
  actor: { id: number; name: string },
  emailId: number,
  kind: SimulateKind,
  opts: { now?: Date } = {},
): Promise<{ message: string }> {
  if (!SIMULATE_KINDS.includes(kind)) throw new ServiceError("Pick delivered, bounce, complaint or unsubscribe.");
  const email = await db.outboundEmail.findUnique({
    where: { id: emailId },
    select: { id: true, mode: true, status: true, messageId: true, toNorm: true, toEmail: true },
  });
  if (!email) throw new ServiceError("This email isn't in the dry-run outbox any more. Refresh the page.");
  if (email.mode !== "DRY_RUN") {
    throw new ServiceError("Only dry-run emails can be simulated. Real emails get their results from Mailgun.");
  }
  if (email.status !== "SENT") throw new ServiceError("This email hasn't gone out yet, so there's nothing to simulate.");

  const already = await db.mailEvent.findUnique({ where: { dedupeKey: `sim:${email.id}:${EVENT_TYPE[kind]}` }, select: { id: true } });
  if (already) return { message: ALREADY_SIMULATED };

  const now = opts.now ?? new Date();
  const ev = makeSimulatedEvent({ kind, emailId: email.id, messageId: email.messageId, recipient: email.toNorm, now });
  ev.raw = { ...(ev.raw as Record<string, unknown>), byUserId: actor.id, byName: actor.name };
  const res = await applyMailEventNow(ev, "SIMULATED", { now });
  if (res.status === "duplicate") return { message: ALREADY_SIMULATED };
  const practiceCopy = (await getSetting("practice.copy")) === true;
  return { message: practiceCopy ? practiceMessage(kind, email.toEmail) : realDataMessage(kind, email.toEmail) };
}

// ───────────────────────── simulated replies (M4-DESIGN §7.1) ─────────────────────────

export const SIMULATE_REPLY_KINDS: readonly SimulateReplyKind[] = ["reply", "out-of-office", "unclear"];

/** Own-mailbox mode's refusal without any saved From address: "In your setup replies go to your own mailbox, …". */
const OWN_MAILBOX_FALLBACK = "your own mailbox";

/** The kind each simulation should be filed as; anything else is reported ("the app filed it as …"). */
const EXPECTED_KIND: Readonly<Record<SimulateReplyKind, InboundKindValue>> = {
  reply: "REPLY",
  "out-of-office": "AUTO_REPLY",
  unclear: "POSSIBLE_REPLY",
};

/** "the app filed it as <kind words>". */
const KIND_WORDS: Readonly<Record<InboundKindValue, string>> = {
  REPLY: "a reply",
  AUTO_REPLY: "an automatic reply",
  BOUNCE_NOTICE: "a delivery failure notice",
  POSSIBLE_REPLY: "a possible reply",
  UNLINKED: "a reply we couldn't link to a company",
  TEST_REPLY: "a reply to a test email",
};

/** The storage key that makes each simulation once per email and kind. */
export function simulatedReplyKey(emailId: number, kind: SimulateReplyKind): string {
  return `sim:${emailId}:${kind}`;
}

/** A person's first name for a greeting ("" for a shared inbox or no name). */
function greetingName(name: string | null | undefined, firstName?: string | null): string {
  if (firstName?.trim()) return firstName.trim();
  const n = (name ?? "").trim();
  return n && n !== GENERAL_INBOX_NAME ? firstNameFrom(n) : "";
}

/** Subject, text and extra headers of each simulated message (M4-DESIGN §7.1 table). */
function simulatedMessage(
  kind: SimulateReplyKind,
  subject: string,
  names: { sender: string; person: string },
): { subject: string; text: string; headers: HeaderPair[]; nullSender: boolean } {
  const base = subject.replace(/^\s*(?:re\s*:\s*)+/i, "").trim() || "(no subject)";
  if (kind === "out-of-office") {
    return {
      subject: `Automatic reply: ${base}`,
      text: "I am out of the office until next Monday with limited access to email.",
      headers: [
        ["Auto-Submitted", "auto-replied"],
        ["X-Autoreply", "yes"],
      ],
      nullSender: true,
    };
  }
  if (kind === "unclear") {
    return {
      subject: `Re: ${base}`,
      text: "I'm out of the office this week, but yes, we're interested. Please send details.",
      headers: [],
      nullSender: false,
    };
  }
  const greeting = names.sender ? `Hi ${names.sender},` : "Hi,";
  const signOff = names.person ? `Best,\n${names.person}` : "Best";
  return {
    subject: `Re: ${base}`,
    text: `${greeting}\n\nThanks, this sounds interesting. Could you send a few examples and your prices?\n\n${signOff}`,
    headers: [],
    nullSender: false,
  };
}

/** What a simulated reply's toast is built from: what was simulated, what the app filed, and what it changed. */
export type SimulatedReplyOutcome = {
  kind: SimulateReplyKind;
  /** The kind the app stored (null: not processed). */
  filed: InboundKindValue | null;
  /** The address the reply came from (the dry-run email's recipient). */
  from: string;
  company: string;
  /** The stored scope: "real" in the practice copy (every campaign), "campaign" on real data (only this dry run). */
  scope: string | null;
  /** The company's status before and after the reply (null: no company). */
  statusBefore: CompanyStatus | null;
  statusAfter: CompanyStatus | null;
};

/**
 * The toast after a simulated reply (M4-DESIGN §7.1 "Messages"): what was simulated, in the stored scope, saying what
 * really happened to the company's status. In the practice copy a reply makes the company Replied, except when it was
 * already Replied or is Client, Not interested or Do not contact (those never change, A5.5; its follow-ups still stop).
 * When the app filed the message as something else, the toast says what it decided.
 */
export function simulatedReplyMessage(o: SimulatedReplyOutcome): string {
  if (o.filed !== EXPECTED_KIND[o.kind]) {
    return `Simulated a message from ${o.from}; the app filed it as ${o.filed ? KIND_WORDS[o.filed] : "a message it couldn't read"}.`;
  }
  if (o.kind === "out-of-office") return `Simulated an out-of-office reply from ${o.from}. It's logged as automatic, so follow-ups continue.`;
  if (o.kind === "unclear") {
    return `Simulated an unclear reply from ${o.from}. Follow-ups to ${o.company} wait until someone chooses Real reply or It was an auto-reply on the Notifications page.`;
  }
  if (o.scope !== "real") {
    return `Simulated a reply from ${o.from}. In a dry run it only stops this campaign's emails to ${o.company}; statuses don't change.`;
  }
  const stopped = "its follow-ups stopped in every campaign";
  if (o.statusAfter === "REPLIED") {
    const status = o.statusBefore === "REPLIED" ? "was already Replied" : "is now Replied";
    return `Simulated a reply from ${o.from}: ${o.company} ${status} and ${stopped}.`;
  }
  if (o.statusAfter === null) return `Simulated a reply from ${o.from}: the follow-ups to ${o.company} stopped in every campaign.`;
  return `Simulated a reply from ${o.from}: ${o.company} stays ${COMPANY_STATUS_LABELS[o.statusAfter]} and ${stopped}.`;
}

/**
 * "Reply", "Out-of-office" and "Unclear reply" in the dry-run outbox (M4-DESIGN §7.1): pretends the person answered one
 * SENT dry-run email. The message is stored like a real reply (source SIMULATED, from the email's address to its From
 * address, or to its Reply-To in shared-From mode, threaded to its Message-ID) and processed at once, so it does what a real one would: on real data it
 * changes only that campaign (no status, "Dry run:" labels); in the practice copy it stops the company in every
 * campaign and makes it Replied (unless it is Client, Not interested or Do not contact, which never change: the toast
 * says so). Only the campaign's sender is notified. Once per email and kind ("Already simulated."); real (TEST/LIVE)
 * emails and emails that haven't gone out are refused.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O19, `loadTeamFrom().replies`): replies never pass through the app there, so a
 * simulated one would show a flow that never happens: refused with `OWN_MAILBOX_TEXTS.simulateReply(from)`. Mailgun's
 * reports (delivered, bounce, complaint, unsubscribe) can still be simulated.
 */
export async function simulateReply(
  actor: { id: number; name: string },
  emailId: number,
  kind: SimulateReplyKind,
  opts: { now?: Date } = {},
): Promise<{ message: string }> {
  if (!SIMULATE_REPLY_KINDS.includes(kind)) throw new ServiceError("Pick reply, out-of-office or unclear reply.");
  const team = await loadTeamFrom();
  if (team.replies === "own-mailbox") {
    throw new ServiceError(OWN_MAILBOX_TEXTS.simulateReply(team.ownFrom ?? team.saved ?? OWN_MAILBOX_FALLBACK));
  }
  const email = await db.outboundEmail.findUnique({
    where: { id: emailId },
    select: {
      id: true,
      mode: true,
      status: true,
      messageId: true,
      references: true,
      subject: true,
      toEmail: true,
      toNorm: true,
      fromAddress: true,
      replyTo: true,
      companyName: true,
      companyId: true,
      senderId: true,
      personId: true,
    },
  });
  if (!email) throw new ServiceError("This email isn't in the dry-run outbox any more. Refresh the page.");
  if (email.mode !== "DRY_RUN") {
    throw new ServiceError("Only dry-run emails can be simulated. Real emails get their replies from real mailboxes.");
  }
  if (email.status !== "SENT") throw new ServiceError("This email hasn't gone out yet, so there's nothing to reply to.");
  const storageKey = simulatedReplyKey(email.id, kind);
  if (await db.inboundMessage.findUnique({ where: { storageKey }, select: { id: true } })) return { message: ALREADY_SIMULATED };

  const now = opts.now ?? new Date();
  const [sender, person, company] = await Promise.all([
    email.senderId !== null ? db.user.findUnique({ where: { id: email.senderId }, select: { name: true } }) : Promise.resolve(null),
    email.personId !== null
      ? db.person.findUnique({ where: { id: email.personId }, select: { name: true, firstName: true } })
      : Promise.resolve(null),
    email.companyId !== null ? db.company.findUnique({ where: { id: email.companyId }, select: { name: true, status: true } }) : Promise.resolve(null),
  ]);
  const from = parseAddressHeader(email.fromAddress);
  const names = {
    sender: greetingName(sender?.name ?? from?.name ?? null),
    person: greetingName(person?.name, person?.firstName),
  };
  const msg = simulatedMessage(kind, email.subject, names);
  const messageIdHeader = `sim.${email.id}.${kind}@simulated.invalid`;
  const references = [...new Set([...(email.references ?? "").split(/\s+/).filter(Boolean), email.messageId])];
  // Where the reply lands (SHARED-FROM-DESIGN §2.3): the Reply-To in shared-From mode (the sender's own address, the
  // SenderAddress the route catches), else the From address as before.
  const replyTo = email.replyTo?.trim() ? routeAddressOf(email.fromAddress, email.replyTo) : null;
  const headers: HeaderPair[] = [
    ["From", person?.name ? `${person.name} <${email.toEmail}>` : email.toEmail],
    ["To", replyTo ?? email.fromAddress],
    ["Subject", msg.subject],
    ["Message-Id", `<${messageIdHeader}>`],
    ["In-Reply-To", `<${email.messageId}>`],
    ["References", references.map((r) => `<${r}>`).join(" ")],
    ...msg.headers,
    ["Content-Type", "text/plain; charset=utf-8"],
  ];
  const parsed: ParsedInbound = {
    recipient: replyTo ?? (from?.email ?? email.fromAddress).trim().toLowerCase(),
    fromEmail: email.toEmail,
    fromName: person?.name?.trim() || null,
    subject: msg.subject,
    snippet: msg.text.replace(/\s+/g, " ").trim().slice(0, 300),
    messageIdHeader,
    inReplyTo: email.messageId,
    references,
    headers,
    storageKey,
    messageUrl: null,
    receivedAt: now,
    envelopeSender: msg.nullSender ? "" : email.toNorm,
    strippedText: msg.text,
    bodyText: msg.text,
    bodyAvailable: true,
  };
  const stored = await retryOnUnique(() => dbTx((tx) => storeInbound(tx, parsed, "SIMULATED")));
  if (stored.status === "duplicate") return { message: ALREADY_SIMULATED };

  await processInboundMessage(stored.id, { now });
  // Read back what processing stored and did (here, or by the worker's lane if it got there first).
  const [row, after] = await Promise.all([
    db.inboundMessage.findUnique({ where: { id: stored.id }, select: { kind: true, replyScope: true } }),
    email.companyId !== null ? db.company.findUnique({ where: { id: email.companyId }, select: { status: true } }) : Promise.resolve(null),
  ]);
  const message = simulatedReplyMessage({
    kind,
    filed: (row?.kind ?? null) as InboundKindValue | null,
    from: email.toEmail,
    company: company?.name ?? email.companyName,
    scope: row?.replyScope ?? null,
    statusBefore: company?.status ?? null,
    statusAfter: after?.status ?? null,
  });
  return { message };
}

// ───────────────────────── the Simulate row ─────────────────────────

export type SimulationView = {
  emailId: number;
  practiceCopy: boolean;
  /** Mailgun-report kinds already simulated for this email (their buttons are done). */
  done: SimulateKind[];
  /** Reply kinds already simulated for this email (their buttons are done). */
  repliesDone: SimulateReplyKind[];
  /** "Delivered · Bounced · Replied (simulated)", or "No results yet." */
  resultLine: string;
};

/** The results words of the replies linked to an email, in this order. */
const REPLY_RESULTS: ReadonlyArray<{ kind: InboundKindValue; word: string }> = [
  { kind: "REPLY", word: "Replied" },
  { kind: "AUTO_REPLY", word: "Automatic reply" },
  { kind: "POSSIBLE_REPLY", word: "Possible reply" },
];

/**
 * What the outbox's Simulate row shows for one dry-run email; null when it isn't a sent dry-run email. The results line
 * lists what the email now records (Delivered, Bounced, Unsubscribed, Complained) and the replies linked to it
 * (Replied, Automatic reply, Possible reply).
 */
export async function loadSimulation(emailId: number): Promise<SimulationView | null> {
  const email = await db.outboundEmail.findUnique({
    where: { id: emailId },
    select: { id: true, mode: true, status: true, deliveredAt: true, bouncedAt: true, unsubscribedAt: true, complainedAt: true },
  });
  if (!email || email.mode !== "DRY_RUN" || email.status !== "SENT") return null;
  const keys = SIMULATE_KINDS.map((k) => `sim:${email.id}:${EVENT_TYPE[k]}`);
  const [events, simulated, replies] = await Promise.all([
    db.mailEvent.findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } }),
    db.inboundMessage.findMany({
      where: { storageKey: { in: SIMULATE_REPLY_KINDS.map((k) => simulatedReplyKey(email.id, k)) } },
      select: { storageKey: true },
    }),
    db.inboundMessage.findMany({
      where: { outboundEmailId: email.id, processedAt: { not: null }, kind: { in: REPLY_RESULTS.map((r) => r.kind) } },
      select: { kind: true },
    }),
  ]);
  const have = new Set(events.map((e) => e.dedupeKey));
  const done = SIMULATE_KINDS.filter((k) => have.has(`sim:${email.id}:${EVENT_TYPE[k]}`));
  const haveReplies = new Set(simulated.map((s) => s.storageKey));
  const repliesDone = SIMULATE_REPLY_KINDS.filter((k) => haveReplies.has(simulatedReplyKey(email.id, k)));
  const kinds = new Set(replies.map((r) => r.kind));
  const parts: string[] = [];
  if (email.deliveredAt) parts.push("Delivered");
  if (email.bouncedAt) parts.push("Bounced");
  if (email.unsubscribedAt) parts.push("Unsubscribed");
  if (email.complainedAt) parts.push("Complained");
  for (const r of REPLY_RESULTS) if (kinds.has(r.kind)) parts.push(r.word);
  const practiceCopy = (await getSetting("practice.copy")) === true;
  const anySimulated = done.length > 0 || repliesDone.length > 0;
  return {
    emailId: email.id,
    practiceCopy,
    done,
    repliesDone,
    resultLine: parts.length ? `${parts.join(" · ")}${anySimulated ? " (simulated)" : ""}` : "No results yet.",
  };
}
