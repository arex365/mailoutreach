import {
  ABSENCE,
  ABSENCE_COMPANION,
  ACK_BODY,
  ACK_SUBJECT,
  ACK_ZENDESK,
  AUTO_COLON_PREFIX,
  AUTO_STATEMENT,
  AUTO_SUBJECT_PREFIX,
  AUTO_SUBJECT_WORD,
  AUTO_SUBJECT_WORD_STRONG,
  BOUNCE_DISPLAY,
  BOUNCE_LOCALPART,
  BOUNCE_PROSE,
  BOUNCE_SUBJECT,
  CHALLENGE,
  DELAY_PROSE,
  DELAY_SUBJECT,
  DSN_ACTION_DELAYED,
  HELPDESK_HEADER_NAME,
  HELPDESK_XMAILER,
  LEFT_COMPANY,
  NOREPLY_LOCALPART,
  OOF_SUBJECT_WORD,
  READ_RECEIPT_SUBJECT,
  REPLY_PREFIX,
  TICKET_ID,
  URL_RE,
  cleanMailText,
  dsnFieldNames,
  flattenMailText,
  headerToken,
  headerTruthy,
  sameSubject,
  stripReplyPrefixes,
} from "./phrases";
import { extractNewText } from "./quote";
import type { AutoReason, ClassifyInput, Confidence, HeaderPair, Nature, Verdict } from "./types";

/**
 * The reply classifier (M4-DESIGN §3.4; research replies-and-auto-replies §8.2 and Appendix A): what a received message
 * is — a real REPLY, an AUTOmatic reply, a delivery-failure notice (BOUNCE), or POSSIBLY a reply (someone decides).
 * Linking is a separate question (the processor, P4); the stored kind combines both (`storedKind`).
 *
 * Order of checks: normalise → delivery report → read receipt → help desk → challenge-response → strong signals →
 * medium signals → decision. The mistake that costs most is a real reply filed as automatic (follow-ups would keep
 * going to someone who answered), so:
 * - a message **linked** to one of our emails is AUTO only with at least one strong signal left after the help-desk
 *   filter; help-desk acknowledgements, challenges and medium signals without one make it POSSIBLE (rule 3);
 * - an **unlinked** message is AUTO with one strong or two medium signals (Appendix A as written; rule 2);
 * - a message without any text (`bodyAvailable: false`, recovered from Mailgun's log) is always POSSIBLE (rule 4).
 *
 * Pure and deterministic. Every body regex runs on at most the first 4,000 characters (rule 13).
 */

/** Body regexes read at most this many characters (M4-DESIGN §3.4 rule 13). */
export const CLASSIFY_BODY_BUDGET = 4_000;

/** Every value of a header, whitespace collapsed; the name is matched case-insensitively. */
function values(h: readonly HeaderPair[], name: string): string[] {
  const n = name.toLowerCase();
  return h.filter(([k]) => typeof k === "string" && k.toLowerCase() === n).map(([, v]) => flattenMailText(String(v ?? "")));
}

const hasHeader = (h: readonly HeaderPair[], name: string) => values(h, name).length > 0;

/** The well-formed [name, value] pairs of a header list (rows read from JSON may hold anything). */
function usableHeaders(h: unknown): HeaderPair[] {
  if (!Array.isArray(h)) return [];
  return h.filter(
    (p): p is HeaderPair => Array.isArray(p) && p.length >= 2 && typeof p[0] === "string" && typeof p[1] === "string",
  );
}

/** "", "<>" or only brackets and spaces: the SMTP null sender. */
const isNullSender = (v: string | null | undefined) => typeof v === "string" && /^\s*<?\s*>?\s*$/.test(v);

/** Classifies one received message. See the module comment for the rules. */
export function classify(m: ClassifyInput): Verdict {
  const v = classifyWithText(m);
  if (m.bodyAvailable !== false) return v;
  // No text at all: never sure. The automatic hint (a subject or header said so) is kept for the card.
  return { nature: "POSSIBLE", confidence: "low", autoReason: v.nature === "REPLY" ? null : v.autoReason, delay: false, signals: v.signals };
}

function classifyWithText(m: ClassifyInput): Verdict {
  const h = usableHeaders(m.headers);
  const linked = m.linked === true;
  const signals: string[] = [];
  const verdict = (nature: Nature, confidence: Confidence, autoReason: AutoReason | null, delay = false): Verdict => ({
    nature,
    confidence,
    autoReason,
    delay,
    signals,
  });

  // 0. Normalise.
  if (values(h, "x-mailgun-sflag").some((x) => /^yes\b/i.test(x))) signals.push("mailgun-spam");
  const subject = flattenMailText(m.subject ?? "");
  const subjectNoPrefix = stripReplyPrefixes(subject);
  const replyShaped = REPLY_PREFIX.test(subject);
  const isOurSubject = (m.sentSubjects ?? []).some((s) => sameSubject(s, subject));
  const ct = values(h, "content-type")[0] ?? "";
  const ctType = headerToken(ct);
  const reportType = (/report-type\s*=\s*"?([\w-]+)/i.exec(ct)?.[1] ?? "").toLowerCase();
  const xenv = values(h, "x-envelope-from")[0];
  const nullSender = isNullSender(m.envelopeSender) || isNullSender(xenv);
  const local = (m.fromEmail ?? "").toLowerCase().split("@")[0] ?? "";
  const budget = (s: string | null | undefined) => (typeof s === "string" ? s.slice(0, CLASSIFY_BODY_BUDGET) : s);
  const text = extractNewText(budget(m.strippedText), budget(m.bodyPlain)) || flattenMailText(m.snippet ?? "");
  const nonEmpty = text.split("\n").filter((l) => l.trim());
  const head5 = nonEmpty.slice(0, 5).join(" ");
  const lines10 = nonEmpty.slice(0, 10).join(" ");
  const head10 = lines10.slice(0, 800);
  const fullBody = cleanMailText((m.bodyPlain ?? m.strippedText ?? m.snippet ?? "").slice(0, CLASSIFY_BODY_BUDGET));

  // 1. Delivery reports (before auto-replies: Exim bounces carry Auto-Submitted: auto-generated).
  const dsn = dsnFieldNames(fullBody);
  const isDelay =
    DELAY_SUBJECT.test(subject) || DSN_ACTION_DELAYED.test(fullBody) || (DELAY_PROSE.test(fullBody) && !BOUNCE_PROSE.test(fullBody));
  const bounceReason: AutoReason = isDelay ? "delay" : "dsn";
  if (ctType === "multipart/report" && reportType === "delivery-status") {
    signals.push("content-type:delivery-status");
    return verdict("BOUNCE", "certain", bounceReason, isDelay);
  }
  const bSubject = !replyShaped && (BOUNCE_SUBJECT.test(subject) || DELAY_SUBJECT.test(subject));
  const bFrom = BOUNCE_LOCALPART.test(local) || BOUNCE_DISPLAY.test(flattenMailText(m.fromName ?? ""));
  const bBody = dsn.has("final-recipient") && dsn.has("status") ? 2 : BOUNCE_PROSE.test(fullBody) ? 1 : 0;
  if (bSubject) signals.push("subject:bounce");
  if (bFrom) signals.push("from:mailer-daemon");
  if (bBody === 2) signals.push("body:dsn-fields");
  else if (bBody === 1) signals.push("body:bounce-text");
  // A bounce subject alone isn't enough (rule 8): it needs a mail-system sender, the null sender or bounce text.
  if (bBody === 2 || (bSubject && (bFrom || nullSender || bBody > 0)) || (bFrom && bBody > 0)) {
    return verdict("BOUNCE", "high", bounceReason, isDelay);
  }

  // 2. Read receipts (RFC 8098 MDN).
  if (ctType === "multipart/report" && reportType === "disposition-notification") {
    signals.push("content-type:disposition-notification");
    return verdict("AUTO", "certain", "read-receipt");
  }
  if (READ_RECEIPT_SUBJECT.test(subject) && (nullSender || /^\s*disposition\s*:/im.test(fullBody))) {
    signals.push("subject:read-receipt");
    return verdict("AUTO", "high", "read-receipt");
  }

  // 3. Help desks stamp Auto-Submitted / X-Auto-Response-Suppress on every email, agent replies included.
  const xMailer = values(h, "x-mailer").join(" ");
  const helpdesk = HELPDESK_XMAILER.test(xMailer) || h.some(([k]) => typeof k === "string" && HELPDESK_HEADER_NAME.test(k));
  const ack =
    (ACK_SUBJECT.test(subject) && (TICKET_ID.test(subject) || /\[.*\]/.test(subject))) ||
    ACK_ZENDESK.test(head10) ||
    (ACK_BODY.test(head10) && TICKET_ID.test(`${subject} ${head10}`));
  if (helpdesk) signals.push("helpdesk");
  if (ack) {
    signals.push("ack");
    if (!linked) return verdict("AUTO", helpdesk ? "certain" : "high", "helpdesk-ack");
  }

  // 4. Challenge-response: the link must be in the new text (rule 7), not in our own quoted footer.
  const challenge = !ack && (CHALLENGE.test(subject) || (CHALLENGE.test(head10) && URL_RE.test(lines10)));
  if (challenge) {
    signals.push("challenge");
    if (!linked) return verdict("AUTO", "high", "challenge");
  }

  // 5. Strong automatic signals.
  const strong: string[] = [];
  const autoSubmitted = values(h, "auto-submitted").map(headerToken);
  const autoSubmittedValue = autoSubmitted.find((x) => x && x !== "no");
  if (autoSubmittedValue) strong.push(`auto-submitted:${autoSubmittedValue}`);
  for (const name of ["x-autoreply", "x-autorespond", "x-autoresponder", "x-autoreply-from", "x-mail-autoreply"]) {
    if (values(h, name).some(headerTruthy)) strong.push(name);
  }
  const prec = [...values(h, "precedence"), ...values(h, "x-precedence")].map(headerToken);
  if (prec.some((p) => p === "auto_reply" || p === "auto-reply")) strong.push("precedence:auto_reply");
  if (values(h, "delivered-to").some((x) => /^autoresponder$/i.test(x))) strong.push("delivered-to:autoresponder");
  if (nullSender) strong.push("null-sender");
  const phrasePrefix = AUTO_SUBJECT_PREFIX.test(subject) || AUTO_COLON_PREFIX.test(subject);
  const wordPrefix = AUTO_SUBJECT_WORD.test(subject);
  const wordPrefixStrong = wordPrefix && AUTO_SUBJECT_WORD_STRONG.test(subject);
  const subjectPrefix = !isOurSubject && (phrasePrefix || wordPrefixStrong);
  if (subjectPrefix) strong.push("subject:auto-prefix");
  if (AUTO_STATEMENT.test(head10)) strong.push("body:auto-statement");

  // 6. Medium signals.
  const medium: string[] = [];
  const bulk = prec.find((p) => p === "bulk" || p === "junk" || p === "list");
  if (bulk) medium.push(`precedence:${bulk}`);
  const xars = values(h, "x-auto-response-suppress").flatMap((x) => x.toLowerCase().split(/[\s,]+/));
  if (xars.some((t) => t === "all" || t === "oof" || t === "autoreply")) medium.push("x-auto-response-suppress");
  const listHeaders = ["list-id", "list-unsubscribe", "list-post", "list-help", "list-subscribe", "list-owner", "list-archive"];
  if (listHeaders.some((n) => hasHeader(h, n))) medium.push("list-headers");
  if (hasHeader(h, "feedback-id")) medium.push("feedback-id");
  if (hasHeader(h, "x-loop") || hasHeader(h, "x-ms-exchange-inbox-rules-loop")) medium.push("loop-header");
  if (hasHeader(h, "x-autogenerated") || values(h, "x-fc-machinegenerated").some(headerTruthy)) medium.push("x-autogenerated");
  if (NOREPLY_LOCALPART.test(local) || (bFrom && !bSubject)) medium.push("from:no-reply");
  // A single auto word that isn't followed by ":" or " -" ("Absence of prices…") is only a hint (rule 5).
  if (!isOurSubject && !phrasePrefix && !wordPrefixStrong && (wordPrefix || OOF_SUBJECT_WORD.test(subjectNoPrefix))) {
    medium.push("subject:absence-word");
  }
  const absent = ABSENCE.test(head5);
  if (absent) medium.push("body:absence");
  if (absent && ABSENCE_COMPANION.test(text.slice(0, 1500))) medium.push("body:absence-details");
  const left = LEFT_COMPANY.test(head5);
  if (left) medium.push("body:left-company");
  if (helpdesk) medium.push("helpdesk-mailer");
  if (ACK_BODY.test(head10)) medium.push("body:ack");

  signals.push(...strong, ...medium);
  const reason: AutoReason = left ? "left-company" : absent || subjectPrefix ? "out-of-office" : "auto-reply";
  // Help-desk mail may be a human agent: its Auto-Submitted alone never proves anything.
  const strongForReal = helpdesk ? strong.filter((s) => !s.startsWith("auto-submitted")) : strong;
  const mediumScore = medium.filter((s) => s !== "helpdesk-mailer").length;

  if (linked) {
    // Rule 3: an answer to one of our emails is automatic only with a strong signal.
    if (strongForReal.length >= 1) {
      if (ack) return verdict("AUTO", helpdesk ? "certain" : "high", "helpdesk-ack");
      if (challenge) return verdict("AUTO", "high", "challenge");
      return verdict("AUTO", strongForReal.length >= 2 ? "certain" : "high", reason);
    }
    if (ack) return verdict("POSSIBLE", "low", "helpdesk-ack");
    if (challenge) return verdict("POSSIBLE", "low", "challenge");
    if (mediumScore >= 1 || helpdesk) return verdict("POSSIBLE", "low", reason);
    return verdict("REPLY", "high", null);
  }

  // Rule 2 (unlinked, Appendix A as written).
  if (strongForReal.length >= 1) return verdict("AUTO", strongForReal.length >= 2 ? "certain" : "high", reason);
  if (mediumScore >= 2) return verdict("AUTO", "medium", reason);
  if (mediumScore === 1 || helpdesk) return verdict("POSSIBLE", "low", reason);
  return verdict("REPLY", "high", null);
}
