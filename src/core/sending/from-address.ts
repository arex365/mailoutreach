import { getDomain as registrableDomain } from "tldts";
import { parseEmail } from "@/core/email-address";
import { isSharedDomain } from "@/core/shared-domains";
import { ROUTE_CHECK_LOCAL_PREFIX } from "@/core/mailgun/routes";

/**
 * The From line, the Reply-To and the shared From address (SHARED-FROM-DESIGN §2.2–§2.4). Pure and browser-safe, so the
 * From address card checks as you type with the rules the server applies.
 *
 * Two modes (§0.3): per-person mode (Setting "mailgun.fromAddress" empty, today's behaviour: From = the sender's own
 * address on the sending domain, no Reply-To) and shared-From mode (From = the shared address on the sending domain's
 * main domain with the sender's display name, Reply-To = the sender's own address). Every From line and Reply-To of a
 * campaign email, a test email or a reply-test email comes from `senderHeaders()` (§0.2 rule 5); the Mailgun domain of
 * an email is `mailgunDomainOf()` (rule 6).
 */

/** Characters that force quoting in an RFC 5322 display name. */
const NEEDS_QUOTES = /[()<>[\]:;@\\,."]/;

/** `Ali from Polygon Paradise <ali@send.example.com>`; the name is quoted when it needs to be. (Moved from addresses.ts.) */
export function formatFromHeader(name: string, address: string): string {
  const clean = name.replace(/[\r\n]+/g, " ").trim();
  if (!clean) return address;
  const display = NEEDS_QUOTES.test(clean) ? `"${clean.replace(/(["\\])/g, "\\$1")}"` : clean;
  return `${display} <${address}>`;
}

/** "Ali <ali@send.example.com>" → "ali@send.example.com" (lowercase); a bare address stays. (Moved from mailgun-transport.ts.) */
export function fromAddressOf(fromLine: string): string {
  const m = /<([^<>]+)>\s*$/.exec(fromLine ?? "");
  return (m ? m[1]! : (fromLine ?? "")).trim().toLowerCase();
}

/** The domain part of an address, lowercase, or null. (Moved from mailgun-transport.ts.) */
export function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  const d = at > 0 ? address.slice(at + 1).trim().toLowerCase() : "";
  return d || null;
}

function cleanHost(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * The main (registrable) domain of `sendingDomain` when the sending domain is a subdomain of it, else null:
 * "mail.polygonparadise.com" → "polygonparadise.com", "mail.polygonparadise.co.uk" → "polygonparadise.co.uk",
 * "send-studio.com" → null (it is a main domain itself).
 */
export function teamFromDomainFor(sendingDomain: string | null | undefined): string | null {
  const d = cleanHost(sendingDomain);
  if (!d) return null;
  const org = registrableDomain(d);
  return org && org !== d && d.endsWith(`.${org}`) ? org : null;
}

/** Names that can't receive replies or belong to mail servers; refused as the shared From address (§2.2 rule 8). */
export const TEAM_FROM_REFUSED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "postmaster",
  "abuse",
  "hostmaster",
  "mailer-daemon",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "bounce",
  "bounces",
  "unsubscribe",
  "u",
  "dmarc",
]);

/** Every sentence of the From address card, its action and its refusals (§3.1), plus the few shared-From lines elsewhere. */
export const TEAM_FROM_TEXTS = {
  cardTitle: "From address",
  cardDescription: "The address every campaign email comes from. Leave it empty to send from each person's own address.",
  practiceCopy: "The practice copy never talks to Mailgun, so there is no From address to set here.",
  notConnected: "Connect Mailgun first: the From address must fit your sending domain.",
  fieldLabel: "From address (optional)",
  /** `shown`: the typed address while it is valid, else the saved one, else `contact@<org>`. */
  hint: (displayName: string, shown: string, org: string, d: string): string =>
    `People see "${displayName} <${shown}>": each person's display name with this address. Replies go to each person's own address on ${d}, and from there to their reply inbox. It must end in @${org}.`,
  misfitHere: (saved: string, d: string): string =>
    `The saved From address ${saved} doesn't fit your sending domain ${d}, so test and live campaigns can't start. Change it or clear it below.`,
  riskNote: (org: string): string =>
    `Your everyday email from ${org} shares this address's reputation. If people mark these emails as spam, your normal emails can land in spam too, and that takes weeks to fix. The app pauses sending when Mailgun reports complaints, but Gmail and Google Workspace never report them: only Google Postmaster Tools shows those. Keep Settings › Deliverability › Thresholds as they are, and look at Postmaster Tools once a week.`,
  goodToKnowHeading: "Good to know",
  goodToKnow: (from: string, org: string, d: string): string[] => [
    `Most replies come back through the app. If someone writes a new email to ${from} instead of pressing Reply, or a colleague of theirs writes to it, the app doesn't see it and the follow-ups continue: set that company's status to Replied.`,
    `If someone asks at ${from} to be removed, or ${from} gets a "couldn't be delivered" notice about a campaign email, put that address on the do-not-email list (Settings › Deliverability › Add an address), or set the company to Do not contact.`,
    `Forwarding such an email from ${from} to a reply address doesn't help: the app treats mail from ${from} as your team's own.`,
    `When you answer a prospect from ${from}, the rest of that conversation stays in your inbox; the app only knows about their first reply.`,
    `Emails the app sends don't appear in the Sent folder of ${from}. The company's timeline has them.`,
    `Never point ${org}'s mail servers (MX) to Mailgun, and never forward ${from} to an address on ${d}.`,
  ],
  followUpReminder: (from: string): string =>
    `Replies written straight to ${from} don't reach the app. If someone answered there, set their company to Replied so the follow-ups stop.`,
  saveButton: "Save From address",
  saving: "Saving…",
  savedOn: (from: string, d: string): string =>
    `From now on, campaign emails show From ${from}, and replies go to each person's address on ${d}. Run the reply test before live campaigns (Settings › Domain checklist).`,
  savedOff: (d: string): string =>
    `From now on, each person's campaign emails come from their own address on ${d}. Run the reply test before live campaigns (Settings › Domain checklist).`,
  nothingChanged: "Nothing changed.",
  confirmTitle: "Change the From address?",
  confirmBody: "Going live ends: live campaigns only reach your test list until the reply test passes again and you go live again.",
  confirmButton: "Change it",
  cancelButton: "Keep it",
  onTestList: (from: string): string => `${from} is on your test list. Remove it from the test list first: it can't be a test mailbox.`,
  domainMisfit: (from: string, newDomain: string): string =>
    `Your From address ${from} doesn't fit ${newDomain}. Clear or change it in the From address card first.`,
  misfit: (from: string, d: string): string =>
    `The From address ${from} doesn't fit your sending domain ${d}. Change or clear it in Settings › Sending & Mailgun.`,
  checklistLine: (from: string, d: string): string => `Emails show From ${from} and go out through ${d}.`,
  selfTestNote: (from: string): string => ` It comes from ${from}, your own address: if it isn't in your inbox within a few minutes, look in spam.`,
  invalid: (example: string): string => `That isn't an email address. Type it the way people should see it, for example ${example}.`,
  noSubdomain: (d: string): string =>
    `A shared From address needs a sending domain that is part of your main domain, for example mail.polygonparadise.com. ${d} isn't: leave this empty, or add a subdomain such as mail.<your domain> in Mailgun and connect it above (Mailgun guide, step 4).`,
  onSendingDomain: (d: string, org: string): string =>
    `Leave this empty to send from each person's own address on ${d}. A shared From address goes on your main domain, for example contact@${org}.`,
  wrongDomain: (d: string, org: string): string => `The From address must end in @${org}, the main domain of your sending domain ${d}.`,
  shared: (example: string): string => `That domain belongs to an email provider. Use your own address, for example ${example}.`,
  reserved: (local: string, example: string): string =>
    `${local}@ can't receive replies or is kept for mail servers. Use the address your team reads, for example ${example}.`,
} as const;

export type TeamFromResult = { ok: true; address: string | null } | { ok: false; error: string };

/**
 * Setting "mailgun.fromAddress" (§2.2), rules in order: empty → per-person mode (`address: null`); no sending domain →
 * notConnected; not exactly one bare address → invalid; the sending domain isn't a subdomain of a main domain →
 * noSubdomain; on (or under) the sending domain → onSendingDomain; a shared or free-mail domain → shared; not on the
 * sending domain's main domain → wrongDomain; a mail-server or no-reply name → reserved; else the address, lowercase.
 * A pasted leading "mailto:" is forgiven. `WEBSITE_DOMAINS` is not consulted (§2.2).
 */
export function validateTeamFromAddress(input: string | null | undefined, sendingDomain: string | null | undefined): TeamFromResult {
  const v = (input ?? "").trim().replace(/^mailto:/i, "").trim();
  if (!v) return { ok: true, address: null };
  const d = cleanHost(sendingDomain);
  if (!d) return { ok: false, error: TEAM_FROM_TEXTS.notConnected };
  const org = teamFromDomainFor(d);
  const example = `contact@${org ?? registrableDomain(d) ?? d}`;
  const parsed = parseEmail(v);
  if (!parsed || parsed.displayName || /[\s<>",;()]/.test(v) || parsed.email.toLowerCase() !== v.toLowerCase()) {
    return { ok: false, error: TEAM_FROM_TEXTS.invalid(example) };
  }
  const address = parsed.email.toLowerCase();
  const domain = parsed.domain.toLowerCase();
  if (!org) return { ok: false, error: TEAM_FROM_TEXTS.noSubdomain(d) };
  if (domain === d || domain.endsWith(`.${d}`)) return { ok: false, error: TEAM_FROM_TEXTS.onSendingDomain(d, org) };
  if (isSharedDomain(domain)) return { ok: false, error: TEAM_FROM_TEXTS.shared(example) };
  if (domain !== org) return { ok: false, error: TEAM_FROM_TEXTS.wrongDomain(d, org) };
  const local = address.slice(0, address.lastIndexOf("@"));
  if (TEAM_FROM_REFUSED_LOCAL_PARTS.has(local) || local.startsWith(ROUTE_CHECK_LOCAL_PREFIX)) {
    return { ok: false, error: TEAM_FROM_TEXTS.reserved(local, example) };
  }
  return { ok: true, address };
}

/**
 * From line and Reply-To for one sender (§2.3). `senderAddress` is their own address on the sending domain; `teamFrom`
 * the shared From address (null or empty = per-person mode): per-person → `{ from: "Name <own>", replyTo: null }`,
 * shared-From → `{ from: "Name <shared>", replyTo: own }`.
 */
export function senderHeaders(i: { displayName: string; senderAddress: string; teamFrom: string | null }): { from: string; replyTo: string | null } {
  const own = i.senderAddress.trim().toLowerCase();
  const team = (i.teamFrom ?? "").trim().toLowerCase();
  return team ? { from: formatFromHeader(i.displayName, team), replyTo: own } : { from: formatFromHeader(i.displayName, own), replyTo: null };
}

/** Where a reply to this email lands (the route address): the Reply-To when set, else the From address. Lowercase. */
export function routeAddressOf(fromLine: string, replyTo: string | null | undefined): string {
  const r = (replyTo ?? "").trim().toLowerCase();
  return r || fromAddressOf(fromLine);
}

/** The Mailgun sending domain an email goes through (§2.3): the route address's domain. Per-person: the From's domain. */
export function mailgunDomainOf(fromLine: string, replyTo: string | null | undefined): string | null {
  return domainOfAddress(routeAddressOf(fromLine, replyTo));
}

/**
 * "pp.1a2b@mail.example.com" or "<pp.1a2b@mail.example.com>" → "mail.example.com" (lowercase), or null without an "@".
 * (Not the same as addresses.ts `messageIdDomainOf`, which falls back to the dry-run domain for follow-ups.)
 */
export function messageIdDomainOf(messageId: string | null | undefined): string | null {
  return domainOfAddress((messageId ?? "").trim().replace(/^<|>$/g, ""));
}

/**
 * Why this From line and Reply-To can't go out through `sendingDomain` (null = fine, §2.4). Accepted: a From on the
 * sending domain (per-person mode; any Reply-To, as before), or a From on the sending domain's main domain with one bare
 * Reply-To on the sending domain itself. Everything else is refused (fail closed, F8). The sentence is technical (for
 * "Details" and logs); the owner sees the pause's own fix text.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O6, §2.4): `opts.ownMailboxFrom` is a string (`ownMailboxRuleFrom`, never read
 * from a setting here) → only the From address (lowercase) exactly `ownMailboxFrom`, on the sending domain, with no
 * Reply-To is accepted; "" (no fitting own From yet) refuses everything. Null or absent: today's rules, unchanged.
 */
export function senderHeaderProblem(
  sendingDomain: string,
  fromLine: string,
  replyTo: string | null | undefined,
  opts: { ownMailboxFrom?: string | null } = {},
): string | null {
  const d = cleanHost(sendingDomain);
  const fromDomain = domainOfAddress(fromAddressOf(fromLine));
  if (typeof opts.ownMailboxFrom === "string") {
    const own = opts.ownMailboxFrom.trim().toLowerCase();
    if (!own) return "Own-mailbox mode has no From address yet.";
    if (fromAddressOf(fromLine) !== own) return `The From address isn't the own From ${own}.`;
    if (!d || fromDomain !== d) return `The From address isn't on ${d || "the sending domain"}.`;
    if ((replyTo ?? "").trim()) return "An own-mailbox email has a reply address.";
    return null;
  }
  if (!d || !fromDomain) return "The email has no From address.";
  if (fromDomain === d) return null;
  if (fromDomain !== teamFromDomainFor(d)) return `The From address isn't on ${d} or its main domain.`;
  const r = (replyTo ?? "").trim().toLowerCase();
  if (!r) return "An email from the shared From address has no reply address.";
  if (/[,;<>"\s]/.test(r) || domainOfAddress(r) !== d) return `The reply address isn't on ${d}.`;
  return null;
}

/** The per-person address's name on screens (F19): "Reply address" in shared-From mode, "Sending address" otherwise. */
export function senderAddressWords(teamFrom: boolean): { label: string; lower: string; noneYet: string; plural: string } {
  return teamFrom
    ? { label: "Reply address", lower: "reply address", noneYet: "No reply address yet", plural: "Reply addresses" }
    : { label: "Sending address", lower: "sending address", noneYet: "No sending address yet", plural: "Sending addresses" };
}

/** The launch's last transaction saw another From address, sending domain or go-live state (F29). */
export const LAUNCH_SETTINGS_CHANGED_TEXT =
  "The sending settings changed while this campaign was being launched (the From address, the sending domain or going live). Open the campaign and launch it again.";
