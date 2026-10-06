import { parse as parseDomain } from "tldts";
import { normalizeEmail, parseEmail } from "@/core/email-address";
import { domainOfAddress } from "@/core/sending/from-address";
import { OWN_REPLY_TEST_TEXTS } from "@/core/sending/own-mailbox";
import type {
  ReplyTestMailbox,
  ReplyTestOriginal,
  ReplyTestProvider,
  UnsubscribeSetup,
  UnsubscribeTestSetting,
} from "@/core/setting-types";
import { footerHtml, footerText, textToHtml, type FooterSettings } from "@/core/templates/html";

/**
 * The real-reply test that decides the unsubscribe setup (PLAN A4.5, B6.8, M3-DESIGN §1.5, §4.5.6). Pure and
 * browser-safe: the verdict, reading pasted headers, the test email itself and the test-list rules. The server
 * (src/server/services/reply-test.ts) gathers the facts from TestSend, MailEvent and InboundMessage rows.
 *
 * Shared From address (SHARED-FROM-DESIGN §3.4, F12, F25): with `opts.teamFrom` the verdict also needs, for every test
 * mailbox, the placement answer and "DMARC: PASS", and one pasted original of a test email (read by `parseTestOriginal`)
 * whose return address and `mailto:` host are on the sending domain. Without it everything is exactly as before.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O13, §3.5, `opts.ownMailbox` with `opts.teamFrom` = the own From): the test is
 * by hand. The app can't see replies, so each mailbox answers placement, "did your reply arrive in {from}" and DMARC;
 * one pasted original proves the return address, DMARC and, when it shows a `mailto:`, the Owner says whether an email
 * to that address reached a mailbox someone reads (`mailtoArrived`). Without `ownMailbox` nothing here changes.
 */

// ───────────────────────── mailbox providers ─────────────────────────

const GMAIL = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT_NAMES = new Set(["outlook", "hotmail", "live"]);

/**
 * Which inbox provider a test mailbox belongs to: gmail.com/googlemail.com → gmail; outlook.*, hotmail.*, live.* and
 * msn.com → microsoft; yahoo.* and ymail.com → yahoo; anything else → other. "outlook.*" means the provider's own
 * domains in any country (outlook.de, hotmail.co.uk), never a company domain that happens to start with "live.".
 */
export function providerOf(address: string): ReplyTestProvider {
  const parsed = parseEmail(address);
  if (!parsed) return "other";
  const domain = parsed.domain.toLowerCase();
  if (GMAIL.has(domain)) return "gmail";
  if (domain === "msn.com") return "microsoft";
  if (domain === "ymail.com") return "yahoo";
  const info = parseDomain(domain);
  if (info.domain !== domain || info.subdomain) return "other";
  const name = (info.domainWithoutSuffix ?? "").toLowerCase();
  if (MICROSOFT_NAMES.has(name)) return "microsoft";
  if (name === "yahoo") return "yahoo";
  return "other";
}

/** "Gmail", "Outlook.com", "Yahoo", "Other". */
export function providerLabel(p: ReplyTestProvider): string {
  return p === "gmail" ? "Gmail" : p === "microsoft" ? "Outlook.com" : p === "yahoo" ? "Yahoo" : "Other";
}

// ───────────────────────── the verdict ─────────────────────────

/** What the app sees itself for one test mailbox (never stored in the setting; loadReplyTest derives it). */
export type MailboxFacts = {
  /** The latest reply-test email to this mailbox on the current domain. */
  testSendId: number | null;
  sentAt: Date | null;
  /** A `delivered` Mailgun event for that email. */
  delivered: boolean;
  /** A reply from this mailbox to the Owner's sending address, received after the test was sent. */
  replyStored: boolean;
  /** The test email's TestSend status ("SENT", "UNKNOWN", "FAILED" …), for display. */
  status?: string | null;
  /** Why it failed, for display. */
  error?: string | null;
  /**
   * SHARED-FROM-DESIGN F26: a reply-test email to this mailbox exists that no longer counts (sent with another From
   * address, or before the From address last changed). Set only when true.
   */
  olderSent?: boolean;
  /**
   * Own-mailbox mode (review REPLIES-08): the test email isn't known as delivered and was sent longer ago than the days of
   * Mailgun's logs the app can read (plus an hour), so its report can never arrive now. Set only when true.
   */
  reportGone?: boolean;
};

/** A Mailgun report of something that happened before this time can no longer be read (review REPLIES-08). */
export const REPORT_GRACE_MS = 60 * 60_000;

/**
 * The moment before which Mailgun's reports are gone for good (review REPLIES-08): `logDays` days of logs
 * (`effectiveLogRetentionDays`) and one more hour for the hourly catch-up.
 */
export function reportsGoneBefore(now: Date, logDays: number): Date {
  const days = Number.isFinite(logDays) && logDays > 0 ? logDays : 1;
  return new Date(now.getTime() - days * 86_400_000 - REPORT_GRACE_MS);
}

export type ReplyTestVerdict = {
  status: "passed" | "failed" | "incomplete";
  /** Plain sentences: what is still missing (incomplete) or what went wrong (failed). */
  missing: string[];
  /**
   * Shared-From mode only (SHARED-FROM-DESIGN F12): "<address>: the test email landed in spam." per mailbox that answered
   * No to the placement question. Never fails the test; shown even when it passes. Absent in per-person mode.
   */
  warnings?: string[];
};

export const REPLY_TEST_TEXTS = {
  noMailboxes: "Add your test mailboxes first in Settings › Sending & Mailgun.",
  needMicrosoft: "Add an Outlook.com or Hotmail mailbox to your test list: the test needs one.",
  needGmailOrYahoo: "Add a Gmail or Yahoo mailbox to your test list: the test needs one.",
  sendFirst: "Send the test emails to your test list.",
  headersUnanswered: "Answer the question about the List-Unsubscribe headers.",
  headersMissing:
    "The test email didn't show the List-Unsubscribe headers. Click Apply recommended settings, then send the test emails again.",
  unsubscribe: "Click the unsubscribe link at the bottom of one test email, so the app can see that it works.",
  // ── Shared From address (SHARED-FROM-DESIGN §3.4) ──
  placementUnanswered: (address: string): string => `${address}: answer whether the test email arrived in the inbox.`,
  dmarcUnanswered: (address: string): string => `${address}: answer whether the test email's original says DMARC: PASS.`,
  originalMissing: "Paste one test email's original (below the mailboxes).",
  dmarcFailed: (address: string): string =>
    `${address}: the test email didn't pass DMARC, so inbox providers may treat it as fake. Check the "Mail servers know your policy (DMARC)" row on the Domain checklist.`,
  returnPathFailed: (returnPathDomain: string, d: string): string =>
    `The test email's return address is on ${returnPathDomain}, not on ${d}, so bounces and automatic replies would go to your everyday inbox instead of the app. Clear the From address in Settings › Sending & Mailgun and ask the person who set up the app.`,
  spamWarning: (address: string): string => `${address}: the test email landed in spam.`,
  headersFailedTeam: (d: string): string =>
    `The test email's List-Unsubscribe header is missing, or its mailto: address isn't on ${d}. Click Apply recommended settings and send the test emails again; if it stays that way, ask the person who set up the app.`,
  /** The section's failure sentence in shared-From mode (instead of "a separate reply address such as …"). */
  failedTeam: (from: string, d: string): string =>
    `The reply test didn't pass with the From address ${from}. The lines above say which check failed. If it was the return address or DMARC, clear the From address in Settings › Sending & Mailgun (emails then come from each person's own address on ${d}) and ask the person who set up the app.`,
  /** The pasted original's Message-ID isn't one of the reply-test emails that count (F25, F26). */
  notCurrentOriginal: (from: string): string =>
    `This isn't one of the current test emails. Paste the original of a test email sent with the From address ${from}.`,
  /** The pasted original shows another From address. */
  originalFromWrong: (found: string, from: string): string =>
    `From: ${found}, not ${from}: paste the original of a test email sent after the From address was set.`,
  returnPathUnknown: "The original doesn't show a return address. Paste the whole original, starting at the first line.",
  /** A mailbox's test email was sent before the From address last changed (or with another From): it doesn't count. */
  notSentWithThisFrom: "Not sent yet with this From address",
  /** decideReplyTest's compare-and-set refusal (§3.4). */
  changedWhileDeciding: "The From address or the sending domain changed while you were deciding. Open the reply test again.",
  /**
   * An answer or "Save the result" from a page opened before the reply test started again (REPLIES-03): the From
   * address, the sending domain or the setup changed since. Nothing is saved; the page reloads the current test.
   */
  roundChanged:
    "The From address, the sending domain or the setup changed since this page was opened, so nothing was saved. The page now shows the current reply test.",
  /**
   * SECURITY-1: a DMARC answer the app read from a pasted original after the page was opened is only changed by a click
   * on a page that showed it.
   */
  dmarcReadMeanwhile: (address: string): string =>
    `${address}: the DMARC answer was just read from a pasted original, so nothing was saved. The page now shows it; change it again if it's wrong.`,
  /** decideReplyTest: the answers changed between reading them and saving the result. */
  answersChangedWhileDeciding: "The answers changed while the result was being saved, so nothing was saved. Click Save the result again.",
  /** SCREENS-04: the shared From address typed into the test list (its own sentence; the From card says "on your test list"). */
  fromOnTestList: (from: string): string =>
    `${from} is your From address, so it can't be a test mailbox. Use a normal mailbox, such as Gmail or Outlook.com.`,
} as const;

/**
 * The questions and labels of the reply test in shared-From mode (SHARED-FROM-DESIGN §3.4), in the order each mailbox's
 * box asks them: placement first (the test email asks to move it to the inbox before replying), then the two existing
 * questions, then DMARC; the pasted original below the mailboxes.
 */
export const REPLY_TEST_TEAM_TEXTS = {
  placementQuestion:
    "Did the test email arrive in this mailbox's inbox, not in spam or junk? (Gmail's Promotions or Updates tab counts as the inbox.)",
  dmarcQuestion:
    "Open the test email's original (Gmail: ⋮ › Show original. Outlook.com: ⋯ › View › View message source). Does it say DMARC: PASS (Gmail) or dmarc=pass?",
  dmarcPasteLabel: "Paste the test email's original here, and the app reads it for you.",
  zohoHelp: "Zoho Mail: open the email, click ⋯ (More actions) › Show original (it may be called View original).",
  originalHeading: "The test email's original",
  originalText:
    "Open one test email in a test mailbox, show its original (Gmail: ⋮ › Show original › Copy to clipboard; Outlook.com: ⋯ › View › View message source, select all, copy) and paste the whole text here. The app reads who sent it, its return address, DMARC and the signature, and doesn't keep the text.",
  readOriginalButton: "Read the original",
  /** Step 1 of the section's list. */
  intro: (from: string, ownerAddress: string): string =>
    `Send the test emails: one to each mailbox on your test list, from ${from} (replies go to ${ownerAddress}).`,
  /** The List-Unsubscribe question's note. */
  mailtoNote: (d: string, org: string): string =>
    `If it also shows a mailto: address, the part after the @ must end in ${d} (for example u+…@${d} or …@email.${d}). If it is …@${org}, answer No.`,
  notTestedYet: (from: string): string => `Not tested yet with the From address ${from}. Live campaigns start once this passes.`,
} as const;

type Group = "microsoft" | "gmail-yahoo";

function groupOf(address: string): Group | null {
  const p = providerOf(address);
  if (p === "microsoft") return "microsoft";
  if (p === "gmail" || p === "yahoo") return "gmail-yahoo";
  return null;
}

type Row = { address: string; facts: MailboxFacts; answer: ReplyTestMailbox | null };

/** The first thing still open for one mailbox, or null when it's complete. */
function nextStep(r: Row): string | null {
  if (!r.facts.testSendId) return `${r.address}: send the test email first.`;
  if (!r.facts.delivered) return `${r.address}: the test email hasn't been delivered yet.`;
  if (!r.facts.replyStored) return `${r.address}: no reply has reached the app yet. Reply to the test email from this mailbox.`;
  if (r.answer?.inboxOk !== true) return `${r.address}: answer whether the reply arrived in your reply inbox.`;
  if (r.answer?.authOk !== "pass") return `${r.address}: answer whether the reply's original says dkim=pass or arc=pass.`;
  return null;
}

function score(r: Row): number {
  return (
    Number(Boolean(r.facts.testSendId)) +
    Number(r.facts.delivered) +
    Number(r.facts.replyStored) +
    Number(r.answer?.inboxOk === true) +
    Number(r.answer?.authOk === "pass")
  );
}

function normAddress(v: string | null | undefined): string | null {
  return (v ?? "").trim().toLowerCase() || null;
}

function normHost(v: string | null | undefined): string | null {
  const h = (v ?? "").trim().toLowerCase();
  // Trailing dots dropped with a loop: /\.+$/ backtracks quadratically over long runs of dots (REPLIES-04).
  let end = h.length;
  while (end > 0 && h.charCodeAt(end - 1) === 46) end--;
  return h.slice(0, end) || null;
}

/** `host` is `domain` or a subdomain of it. */
function onOrUnder(host: string | null | undefined, domain: string | null | undefined): boolean {
  const h = normHost(host);
  const d = normHost(domain);
  return Boolean(h && d && (h === d || h.endsWith(`.${d}`)));
}

/**
 * The stored pasted original when it belongs to this sending domain and this shared From address (F25), else null (a
 * reset or a From/domain change makes an older one stale).
 */
export function currentOriginal(
  setting: Pick<UnsubscribeTestSetting, "original">,
  sendingDomain: string | null | undefined,
  teamFrom: string | null | undefined,
): ReplyTestOriginal | null {
  const o = setting.original ?? null;
  const d = normHost(sendingDomain);
  const from = normAddress(teamFrom);
  if (!o || !d || !from) return null;
  return normHost(o.domain) === d && normAddress(o.from) === from ? o : null;
}

/**
 * Own-mailbox mode (review SECURITY-03, fail closed): the original says List-Unsubscribe offers a `mailto:`, whether or
 * not its whole address could be read and kept: an address, the unreadable flag, a `mailto:` host, or a `mailto:` off the
 * sending domain (`mailtoOk` false). Only an original with none of these shows "not offered".
 */
export function mailtoOffered(
  o: Pick<ReplyTestOriginal, "mailtoDomain" | "mailtoOk"> & { mailtoAddress?: string | null; mailtoUnreadable?: boolean },
): boolean {
  return normAddress(o.mailtoAddress) !== null || o.mailtoUnreadable === true || normHost(o.mailtoDomain) !== null || o.mailtoOk === false;
}

/**
 * The reply test's result (§1.5 step 5), for the mailboxes in `facts` (the current test list) with the Owner's answers
 * from `setting` (answers for other addresses are ignored):
 *  - failed as soon as any mailbox has "In your inbox?" = No or "dkim/arc pass?" = No;
 *  - passed when at least one Outlook.com/Hotmail/Live mailbox AND at least one Gmail or Yahoo mailbox each have: the
 *    test email delivered, the reply reached the app, inbox = Yes and dkim/arc = Yes; plus the List-Unsubscribe
 *    headers = Yes and an unsubscribe that reached the app;
 *  - otherwise incomplete, with what is still missing.
 *
 * Shared-From mode (`opts.teamFrom` set, SHARED-FROM-DESIGN §3.4): also failed when any mailbox's DMARC answer is No, the
 * pasted original (for this sending domain and From, `currentOriginal`) shows a return address or a `mailto:` host that
 * isn't on the sending domain or DMARC fail, or the List-Unsubscribe headers answer is No; incomplete until every mailbox
 * was sent the test email and has answered the placement question and "DMARC: PASS" (Yes), and a pasted original shows a
 * return address on the sending domain; `warnings` lists each spam placement (a No never fails the test). Per-person
 * mode (no `teamFrom`) is exactly as before, without `warnings`.
 *
 * Own-mailbox mode (`opts.ownMailbox` with `opts.teamFrom` = the own From, MAIN-DOMAIN-DESIGN O13, §3.5):
 * `evaluateOwnMailboxReplyTest`, the by-hand rules.
 */
export function evaluateReplyTest(
  setting: UnsubscribeTestSetting,
  facts: ReadonlyMap<string, MailboxFacts>,
  unsubscribeSeen: boolean,
  opts: { teamFrom?: string | null; sendingDomain?: string | null; ownMailbox?: boolean; unsubscribeGone?: boolean } = {},
): ReplyTestVerdict {
  if (opts.ownMailbox === true) return evaluateOwnMailboxReplyTest(setting, facts, unsubscribeSeen, opts);
  const teamFrom = normAddress(opts.teamFrom);
  const team = teamFrom !== null;
  const d = normHost(opts.sendingDomain) ?? normHost(setting.domain) ?? "";
  const answers = new Map(setting.mailboxes.map((m) => [m.address.trim().toLowerCase(), m]));
  const rows: Row[] = [...facts.entries()].map(([address, f]) => ({
    address,
    facts: f,
    answer: answers.get(address.trim().toLowerCase()) ?? null,
  }));
  const original = team ? currentOriginal(setting, d, teamFrom) : null;
  const warnings = rows.filter((r) => r.answer?.placementOk === false).map((r) => REPLY_TEST_TEXTS.spamWarning(r.address));
  const verdict = (status: ReplyTestVerdict["status"], missing: string[]): ReplyTestVerdict =>
    team ? { status, missing, warnings } : { status, missing };

  const failures: string[] = [];
  const fail = (text: string) => {
    if (!failures.includes(text)) failures.push(text);
  };
  for (const r of rows) {
    if (r.answer?.inboxOk === false) fail(`${r.address}: the reply didn't arrive in your reply inbox.`);
    if (r.answer?.authOk === "fail") fail(`${r.address}: the reply didn't pass dkim or arc.`);
  }
  if (team) {
    for (const r of rows) if (r.answer?.dmarcOk === "fail") fail(REPLY_TEST_TEXTS.dmarcFailed(r.address));
    if (original?.dmarc === "fail") fail(REPLY_TEST_TEXTS.dmarcFailed(original.address));
    if (original?.returnPathOk === false) fail(REPLY_TEST_TEXTS.returnPathFailed(original.returnPathDomain ?? "another domain", d));
    if (original?.mailtoOk === false || setting.headersOk === false) fail(REPLY_TEST_TEXTS.headersFailedTeam(d));
  }
  if (failures.length > 0) return verdict("failed", failures);

  const missing: string[] = [];
  const add = (text: string) => {
    if (!missing.includes(text)) missing.push(text);
  };
  if (rows.length === 0) return verdict("incomplete", [REPLY_TEST_TEXTS.noMailboxes]);
  const nothingSent = rows.every((r) => !r.facts.testSendId);
  if (nothingSent) add(REPLY_TEST_TEXTS.sendFirst);

  let groupsDone = 0;
  for (const group of ["microsoft", "gmail-yahoo"] as const) {
    const inGroup = rows.filter((r) => groupOf(r.address) === group);
    if (inGroup.length === 0) {
      add(group === "microsoft" ? REPLY_TEST_TEXTS.needMicrosoft : REPLY_TEST_TEXTS.needGmailOrYahoo);
      continue;
    }
    if (inGroup.some((r) => nextStep(r) === null)) {
      groupsDone++;
      continue;
    }
    // The mailbox that got furthest says what to do next ("send first" is already said once for everyone).
    const best = [...inGroup].sort((a, b) => score(b) - score(a))[0]!;
    const step = nextStep(best);
    if (step && !(nothingSent && !best.facts.testSendId)) add(step);
  }

  // Shared-From mode: every mailbox answers placement and DMARC, and one original proves the return address.
  let teamDone = true;
  if (team) {
    for (const r of rows) {
      if (!r.facts.testSendId) {
        teamDone = false;
        if (!nothingSent) add(`${r.address}: send the test email first.`);
        continue;
      }
      if (r.answer?.placementOk !== true && r.answer?.placementOk !== false) {
        teamDone = false;
        add(REPLY_TEST_TEXTS.placementUnanswered(r.address));
      }
      if (r.answer?.dmarcOk !== "pass") {
        teamDone = false;
        add(REPLY_TEST_TEXTS.dmarcUnanswered(r.address));
      }
    }
    if (!original) {
      teamDone = false;
      add(REPLY_TEST_TEXTS.originalMissing);
    } else if (original.returnPathOk !== true) {
      teamDone = false;
      add(REPLY_TEST_TEXTS.returnPathUnknown);
    }
  }

  if (setting.headersOk === false) add(REPLY_TEST_TEXTS.headersMissing);
  else if (setting.headersOk !== true) add(REPLY_TEST_TEXTS.headersUnanswered);
  if (!unsubscribeSeen) add(REPLY_TEST_TEXTS.unsubscribe);

  if (groupsDone === 2 && setting.headersOk === true && unsubscribeSeen && teamDone) return verdict("passed", []);
  return verdict("incomplete", missing);
}

/** The order own-mailbox mode lists what is still missing in (MAIN-DOMAIN-DESIGN §3.5, "What is still missing"). */
const OWN_STEPS = [
  "send",
  "delivered",
  "placement",
  "reply",
  "dmarc",
  "original",
  "returnPath",
  "headers",
  "mailto",
  "unsubscribe",
  "need",
] as const;
type OwnStep = (typeof OWN_STEPS)[number];

/**
 * The first thing still open for one mailbox in own-mailbox mode (`nextStepOwn`, O13): the test email sent, delivered,
 * the Owner's reply arrived in the own From (`inboxOk`), DMARC: PASS. The app never sees the reply itself.
 */
function nextStepOwn(r: Row, from: string): { step: OwnStep; text: string } | null {
  if (!r.facts.testSendId) return { step: "send", text: `${r.address}: send the test email first.` };
  if (!r.facts.delivered) {
    // Review REPLIES-08: a report lost over a gap never arrives, so waiting doesn't help: send again.
    return {
      step: "delivered",
      text: r.facts.reportGone === true ? OWN_REPLY_TEST_TEXTS.reportGone(r.address) : `${r.address}: the test email hasn't been delivered yet.`,
    };
  }
  if (r.answer?.inboxOk !== true) return { step: "reply", text: OWN_REPLY_TEST_TEXTS.replyUnanswered(r.address, from) };
  if (r.answer?.dmarcOk !== "pass") return { step: "dmarc", text: REPLY_TEST_TEXTS.dmarcUnanswered(r.address) };
  return null;
}

function scoreOwn(r: Row): number {
  return (
    Number(Boolean(r.facts.testSendId)) +
    Number(r.facts.delivered) +
    Number(r.answer?.inboxOk === true) +
    Number(r.answer?.dmarcOk === "pass")
  );
}

/**
 * The by-hand reply test's result in own-mailbox mode (MAIN-DOMAIN-DESIGN O13, §3.5), for the mailboxes in `facts` with
 * the Owner's answers from `setting`; `opts.teamFrom` is the own From, `opts.sendingDomain` the sending domain:
 *  - failed as soon as a mailbox says its reply didn't arrive in the own From or DMARC: No, the pasted original (for
 *    this domain and From, `currentOriginal`) says DMARC fail or shows a return address off the sending domain, the
 *    List-Unsubscribe answer is No, or the original shows a `mailto:` and the email sent to it didn't arrive
 *    (`mailtoArrived` No);
 *  - passed when at least one Outlook.com/Hotmail/Live mailbox and one Gmail or Yahoo mailbox each have the test email
 *    delivered, the reply in the own From (Yes) and DMARC: PASS; every mailbox was sent the test email and answered
 *    placement and DMARC (PASS); an original with a return address on the sending domain is stored; the List-Unsubscribe
 *    answer is Yes; the `mailto:` question (only while the original shows one) is Yes; and an unsubscribe reached the app;
 *  - otherwise incomplete, with what is still missing in §3.5's order.
 * The reply itself (`replyStored`) and "dkim/arc pass?" are never asked in this mode, and the original's `mailtoOk`
 * never fails it. `warnings` lists each spam placement (a No never fails the test).
 *
 * Review fixes: an original that offers a `mailto:` whose address couldn't be read fails (SECURITY-03: it never counts as
 * "not offered"); a report lost over a gap says to send again (`MailboxFacts.reportGone`, `opts.unsubscribeGone`,
 * REPLIES-08); and with unsubscribe by email left out (`setting.leaveOutMailto`, REPLIES-03) the question isn't asked,
 * the original must show a web link and no `mailto:` (else failed), and `warnings` ends with the left-out note.
 */
export function evaluateOwnMailboxReplyTest(
  setting: UnsubscribeTestSetting,
  facts: ReadonlyMap<string, MailboxFacts>,
  unsubscribeSeen: boolean,
  opts: { teamFrom?: string | null; sendingDomain?: string | null; unsubscribeGone?: boolean } = {},
): ReplyTestVerdict {
  const T = OWN_REPLY_TEST_TEXTS;
  const from = normAddress(opts.teamFrom) ?? "";
  const d = normHost(opts.sendingDomain) ?? normHost(setting.domain) ?? "";
  const answers = new Map(setting.mailboxes.map((m) => [m.address.trim().toLowerCase(), m]));
  const rows: Row[] = [...facts.entries()].map(([address, f]) => ({
    address,
    facts: f,
    answer: answers.get(address.trim().toLowerCase()) ?? null,
  }));
  const original = from ? currentOriginal(setting, d, from) : null;
  const mailto = normAddress(original?.mailtoAddress);
  // SECURITY-03 (fail closed): the original offers unsubscribe by email when any of its mailto: fields says so, even
  // when the whole address couldn't be read or kept.
  const mailtoShown = original !== null && mailtoOffered(original);
  const leftOut = setting.leaveOutMailto === true;
  const warnings = rows.filter((r) => r.answer?.placementOk === false).map((r) => REPLY_TEST_TEXTS.spamWarning(r.address));
  if (leftOut) warnings.push(T.leftOutNote);
  const verdict = (status: ReplyTestVerdict["status"], missing: string[]): ReplyTestVerdict => ({ status, missing, warnings });

  const failures: string[] = [];
  const fail = (text: string) => {
    if (!failures.includes(text)) failures.push(text);
  };
  for (const r of rows) if (r.answer?.inboxOk === false) fail(T.replyFailed(r.address, from));
  for (const r of rows) if (r.answer?.dmarcOk === "fail") fail(REPLY_TEST_TEXTS.dmarcFailed(r.address));
  if (original?.dmarc === "fail") fail(REPLY_TEST_TEXTS.dmarcFailed(original.address));
  if (original?.returnPathOk === false) fail(T.returnPathFailed(original.returnPathDomain ?? "another domain", d));
  if (setting.headersOk === false) fail(T.headersFailed);
  if (leftOut) {
    // The app's own header must have replaced Mailgun's: no mailto:, and a real web link (Mailgun filled in its link).
    if (mailtoShown) fail(T.leftOutMailtoStill);
    else if (original !== null && original.unsubscribeScheme === null) fail(T.leftOutNoLink);
  } else if (mailtoShown && mailto === null) {
    fail(T.mailtoUnreadable);
  } else if (mailto && setting.mailtoArrived === false) {
    fail(T.mailtoFailed(mailto, d, from));
  }
  if (failures.length > 0) return verdict("failed", failures);

  if (rows.length === 0) return verdict("incomplete", [REPLY_TEST_TEXTS.noMailboxes]);
  const buckets = new Map<OwnStep, string[]>();
  const add = (step: OwnStep, text: string) => {
    const list = buckets.get(step) ?? [];
    if (!list.includes(text)) list.push(text);
    buckets.set(step, list);
  };
  const nothingSent = rows.every((r) => !r.facts.testSendId);
  if (nothingSent) add("send", REPLY_TEST_TEXTS.sendFirst);

  let groupsDone = 0;
  for (const group of ["microsoft", "gmail-yahoo"] as const) {
    const inGroup = rows.filter((r) => groupOf(r.address) === group);
    if (inGroup.length === 0) {
      add("need", group === "microsoft" ? REPLY_TEST_TEXTS.needMicrosoft : REPLY_TEST_TEXTS.needGmailOrYahoo);
      continue;
    }
    if (inGroup.some((r) => nextStepOwn(r, from) === null)) {
      groupsDone++;
      continue;
    }
    // The mailbox that got furthest says what to do next ("send first" is already said once for everyone).
    const best = [...inGroup].sort((a, b) => scoreOwn(b) - scoreOwn(a))[0]!;
    const step = nextStepOwn(best, from);
    if (step && !(nothingSent && !best.facts.testSendId)) add(step.step, step.text);
  }

  // Every mailbox answers placement and DMARC; one original proves the return address.
  let everyDone = true;
  for (const r of rows) {
    if (!r.facts.testSendId) {
      everyDone = false;
      if (!nothingSent) add("send", `${r.address}: send the test email first.`);
      continue;
    }
    if (r.answer?.placementOk !== true && r.answer?.placementOk !== false) {
      everyDone = false;
      add("placement", REPLY_TEST_TEXTS.placementUnanswered(r.address));
    }
    if (r.answer?.dmarcOk !== "pass") {
      everyDone = false;
      add("dmarc", REPLY_TEST_TEXTS.dmarcUnanswered(r.address));
    }
  }
  if (!original) {
    everyDone = false;
    add("original", leftOut ? T.leftOutSendAgain : REPLY_TEST_TEXTS.originalMissing);
  } else if (original.returnPathOk !== true) {
    everyDone = false;
    add("returnPath", REPLY_TEST_TEXTS.returnPathUnknown);
  } else if (leftOut && original.unsubscribeScheme !== "http" && original.unsubscribeScheme !== "https") {
    // An original read before the link's scheme was kept says nothing about the link: a new one is needed.
    everyDone = false;
    add("original", T.leftOutSendAgain);
  }
  if (setting.headersOk !== true) add("headers", REPLY_TEST_TEXTS.headersUnanswered);
  // Left out: nothing to ask (a mailto: already failed above). Otherwise only while the original shows one.
  const mailtoDone = leftOut || !mailtoShown || setting.mailtoArrived === true;
  if (!mailtoDone) add("mailto", T.mailtoUnanswered);
  if (!unsubscribeSeen) add("unsubscribe", opts.unsubscribeGone === true ? T.unsubscribeGone : REPLY_TEST_TEXTS.unsubscribe);

  if (groupsDone === 2 && everyDone && setting.headersOk === true && mailtoDone && unsubscribeSeen) return verdict("passed", []);
  return verdict(
    "incomplete",
    OWN_STEPS.flatMap((s) => buckets.get(s) ?? []),
  );
}

/**
 * A stored pass counts only for the same sending domain and the same shared From address (null = per-person mode,
 * SHARED-FROM-DESIGN F12): a stored pass without `from` counts only in per-person mode. Use it everywhere a stored
 * result is shown or used (gates, launch, the checklist row, the reply-test section).
 *
 * MAIN-DOMAIN-DESIGN O13, O15: a pass also belongs to one way of sending. It counts only when the stored decision's mode
 * (`setting.replies === "own-mailbox"`) is the mode asked about (`opts.ownMailbox === true`); in own-mailbox mode pass
 * the own From as `teamFrom`. Without `opts` (app mode) a pass decided in own-mailbox mode never counts, and a stored
 * pass without `replies` counts exactly as before.
 */
export function replyTestPassedFor(
  setting: Pick<UnsubscribeTestSetting, "status" | "domain" | "from" | "replies">,
  domain: string | null,
  teamFrom: string | null,
  opts: { ownMailbox?: boolean } = {},
): boolean {
  if (!domain || setting.status !== "passed") return false;
  if ((setting.domain ?? "").toLowerCase() !== domain.toLowerCase()) return false;
  if ((setting.replies === "own-mailbox") !== (opts.ownMailbox === true)) return false;
  return ((setting.from ?? "").trim().toLowerCase() || null) === ((teamFrom ?? "").trim().toLowerCase() || null);
}

// ───────────────────────── the Owner's answers ─────────────────────────

type YesNoUnsure = "pass" | "fail" | "unsure";

/** One mailbox's answers as the page holds them; `placementOk` and `dmarcOk` only in shared-From mode (§3.4). */
export type ReplyTestAnswerState = {
  inboxOk: boolean | null;
  authOk: YesNoUnsure | null;
  placementOk?: boolean | null;
  dmarcOk?: YesNoUnsure | null;
};

export type ReplyTestAnswerField = "inboxOk" | "authOk" | "placementOk" | "dmarcOk";

/**
 * One mailbox in a save of the answers. A field that is absent keeps its saved answer: the page sends only the answer
 * that changed (REPLIES-03), with `was`, the value the page showed before the click (SECURITY-1). Pasted texts are read,
 * never stored.
 */
export type ReplyTestAnswerEntry = Partial<ReplyTestAnswerState> & {
  address: string;
  pastedHeaders?: string | null;
  /** Shared-From mode: the test email's original pasted for the DMARC question. */
  dmarcPasted?: string | null;
  was?: Partial<ReplyTestAnswerState>;
};

/**
 * What one run of the reply test belongs to (REPLIES-03): the sending domain, the shared From address (null = per-person
 * mode) and the setup. A From change, a domain change and a setup switch each start the test again.
 */
export type ReplyTestRound = {
  domain: string | null;
  from: string | null;
  setup: UnsubscribeSetup;
  /**
   * Shared-From mode: `loadTeamFrom().changedAt` as the page saw it (ISO), when the From address or the sending domain
   * (its region too) last changed. It tells apart rounds the three values above can't: a From address changed and
   * changed back, or a region-only move (review SETTING-1). Absent = not compared (per-person pages, older callers).
   */
  since?: string | null;
};

export type ReplyTestAnswersInput = {
  mailboxes: ReplyTestAnswerEntry[];
  /** The List-Unsubscribe question; absent = unchanged. */
  headersOk?: boolean | null;
  /**
   * Own-mailbox mode (MAIN-DOMAIN-DESIGN O13): the unsubscribe-by-email question ("did the email to the original's
   * mailto: address arrive?"); absent = unchanged. The service keeps it only in own-mailbox mode.
   */
  mailtoArrived?: boolean | null;
  /** The round the page showed; absent = not checked (tests, older callers). */
  round?: ReplyTestRound | null;
};

function yesNoUnsureOf(v: unknown): YesNoUnsure | null {
  return v === "pass" || v === "fail" || v === "unsure" ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return v === true || v === false ? v : null;
}

/**
 * The round a reply test section shows (its view's domain, From address and setup, and in shared-From mode
 * `roundSince`, when the From address or the sending domain last changed).
 */
export function replyTestRoundOf(v: {
  domain: string | null;
  teamFrom?: string | null;
  setup: UnsubscribeSetup;
  roundSince?: string | null;
}): ReplyTestRound {
  const round: ReplyTestRound = { domain: normHost(v.domain), from: normAddress(v.teamFrom), setup: v.setup };
  return v.roundSince !== undefined ? { ...round, since: v.roundSince } : round;
}

/** An ISO time as milliseconds; null when it isn't one. */
function timeOf(v: string | null | undefined): number | null {
  const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The page's answers were given for another round than `current` (REPLIES-03). Only checked when a shared From address is
 * involved on either side; per-person mode on both sides is exactly as before (no check). No `expected` = not checked.
 * `since` is compared only when both sides carry it: the same From address, domain and setup after a change and back,
 * or after a region-only move, is still another round.
 */
export function replyTestRoundChanged(expected: ReplyTestRound | null | undefined, current: ReplyTestRound): boolean {
  if (!expected) return false;
  const from = normAddress(expected.from);
  const now = normAddress(current.from);
  if (from === null && now === null) return false;
  if (from !== now || normHost(expected.domain) !== normHost(current.domain) || expected.setup !== current.setup) return true;
  return expected.since !== undefined && current.since !== undefined && timeOf(expected.since) !== timeOf(current.since);
}

/** The saved answers a reply test section starts from, and goes back to after every save (keyed by mailbox). */
export function replyTestAnswersFrom(
  mailboxes: ReadonlyArray<{ address: string } & ReplyTestAnswerState>,
  team: boolean,
): Record<string, ReplyTestAnswerState> {
  return Object.fromEntries(
    mailboxes.map((m) => [
      m.address,
      team
        ? { inboxOk: m.inboxOk, authOk: m.authOk, placementOk: m.placementOk ?? null, dmarcOk: m.dmarcOk ?? null }
        : { inboxOk: m.inboxOk, authOk: m.authOk },
    ]),
  );
}

/**
 * Changes whenever the saved answers or the round change: the section then re-syncs its answers from the server, so a
 * DMARC answer read from a pasted original shows at once and is never overwritten by what the page held before.
 */
export function replyTestAnswersKey(v: {
  domain: string | null;
  teamFrom?: string | null;
  setup: UnsubscribeSetup;
  roundSince?: string | null;
  headersOk: boolean | null;
  mailboxes: ReadonlyArray<{ address: string } & ReplyTestAnswerState>;
  /** Own-mailbox mode (MAIN-DOMAIN-DESIGN O13): the stored original's mailto: address and its answer; absent = app mode. */
  mailtoAddress?: string | null;
  mailtoArrived?: boolean | null;
}): string {
  const parts: unknown[] = [
    replyTestRoundOf(v),
    v.headersOk,
    v.mailboxes.map((m) => [m.address, m.inboxOk, m.authOk, m.placementOk ?? null, m.dmarcOk ?? null]),
  ];
  if (v.mailtoAddress !== undefined || v.mailtoArrived !== undefined) parts.push([v.mailtoAddress ?? null, v.mailtoArrived ?? null]);
  return JSON.stringify(parts);
}

/**
 * One answer the Owner just gave, as the page saves it: only that mailbox and that field, with the value the page
 * showed before (`was`) and the round the page belongs to. Every other saved answer stays as the server has it.
 */
export function replyTestAnswerChange<F extends ReplyTestAnswerField>(
  address: string,
  field: F,
  value: ReplyTestAnswerState[F],
  shown: ReplyTestAnswerState | undefined,
  round: ReplyTestRound,
): ReplyTestAnswersInput {
  const was = { [field]: shown?.[field] ?? null } as Partial<ReplyTestAnswerState>;
  const entry = { address, [field]: value ?? null, was } as ReplyTestAnswerEntry;
  return { mailboxes: [entry], round };
}

/** What the pasted texts of one save say (read before the save's transaction; the texts are never stored). */
export type ReplyTestPasteReads = {
  auth: Map<string, "pass" | "fail" | null>;
  dmarc: Map<string, "pass" | "fail" | null>;
};

/** The entries of a save by normalised mailbox (the last one wins, as before). */
function entriesOf(input: Pick<ReplyTestAnswersInput, "mailboxes">): Map<string, ReplyTestAnswerEntry> {
  const given = new Map<string, ReplyTestAnswerEntry>();
  for (const m of input.mailboxes) {
    const a = normalizeEmail(m.address);
    if (a) given.set(a, m);
  }
  return given;
}

/**
 * Reads the pasted texts of a save: headers for "dkim/arc pass?" with `parseAuthResults` (only the mailbox's own
 * signature counts) and originals for DMARC with `parseDmarcResult` for the From domain. Pure; nothing is kept.
 */
export function readReplyTestPastes(input: Pick<ReplyTestAnswersInput, "mailboxes">, fromDomain: string | null): ReplyTestPasteReads {
  const auth = new Map<string, "pass" | "fail" | null>();
  const dmarc = new Map<string, "pass" | "fail" | null>();
  for (const [address, m] of entriesOf(input)) {
    const headers = (m.pastedHeaders ?? "").trim();
    if (headers) auth.set(address, parseAuthResults(headers, { from: address }));
    const original = (m.dmarcPasted ?? "").trim();
    if (original) dmarc.set(address, parseDmarcResult(original, { fromDomain }));
  }
  return { auth, dmarc };
}

/**
 * Merges one save into the stored answers, for the current test-list mailboxes only (answers for other addresses are
 * dropped). A field that is absent keeps its saved answer, so a save never overwrites another mailbox's answers or an
 * answer the page didn't touch (REPLIES-03). Pasted headers set "dkim/arc pass?" when they say pass or fail
 * (`authFromHeaders`); a pasted original sets DMARC the same way (`dmarcFromHeaders`). A DMARC answer that was read from
 * a pasted original (the DMARC box, or "Read the original" on the server) is replaced by a click only when the entry's
 * `was` is that stored answer; otherwise the save is refused (SECURITY-1: a page that never showed the read answer
 * can't erase a DMARC FAIL). Per-person answers keep exactly today's shape.
 */
export function mergeReplyTestAnswers(
  setting: UnsubscribeTestSetting,
  testList: readonly string[],
  input: ReplyTestAnswersInput,
  reads: ReplyTestPasteReads,
):
  | {
      ok: true;
      setting: UnsubscribeTestSetting;
      authFromHeaders: Record<string, "pass" | "fail" | null>;
      dmarcFromHeaders: Record<string, "pass" | "fail" | null>;
    }
  | { ok: false; error: string } {
  const previous = new Map(setting.mailboxes.map((m) => [m.address.toLowerCase(), m]));
  const given = entriesOf(input);
  const authFromHeaders: Record<string, "pass" | "fail" | null> = {};
  const dmarcFromHeaders: Record<string, "pass" | "fail" | null> = {};
  const mailboxes: ReplyTestMailbox[] = [];
  for (const address of testList) {
    const m = given.get(address);
    const prev = previous.get(address);
    if (!m) {
      if (prev) mailboxes.push({ ...prev, address, provider: providerOf(address) });
      continue;
    }
    let authOk = m.authOk !== undefined ? yesNoUnsureOf(m.authOk) : (prev?.authOk ?? null);
    let fromHeaders = false;
    if (reads.auth.has(address)) {
      const r = reads.auth.get(address) ?? null;
      authFromHeaders[address] = r;
      if (r) {
        authOk = r;
        fromHeaders = true;
      }
    } else if (prev?.authFromHeaders && prev.authOk === authOk) {
      fromHeaders = true;
    }
    const entry: ReplyTestMailbox = {
      address,
      provider: providerOf(address),
      inboxOk: m.inboxOk !== undefined ? boolOrNull(m.inboxOk) : (prev?.inboxOk ?? null),
      authOk,
      authFromHeaders: fromHeaders && authOk !== null,
    };
    // Shared-From answers: only when given now or saved before, so per-person answers keep today's shape.
    if (m.placementOk !== undefined) entry.placementOk = boolOrNull(m.placementOk);
    else if (prev?.placementOk !== undefined) entry.placementOk = prev.placementOk;
    const dmarcPasted = reads.dmarc.has(address);
    if (m.dmarcOk !== undefined || dmarcPasted || prev?.dmarcOk !== undefined) {
      let dmarcOk = m.dmarcOk !== undefined ? yesNoUnsureOf(m.dmarcOk) : (prev?.dmarcOk ?? null);
      let dmarcRead = false;
      if (dmarcPasted) {
        const r = reads.dmarc.get(address) ?? null;
        dmarcFromHeaders[address] = r;
        if (r) {
          dmarcOk = r;
          dmarcRead = true;
        }
      } else {
        const stored = prev?.dmarcOk ?? null;
        if (prev?.dmarcFromHeaders && m.dmarcOk !== undefined && dmarcOk !== stored) {
          const was = m.was && Object.hasOwn(m.was, "dmarcOk") ? (m.was.dmarcOk ?? null) : undefined;
          if (was !== stored) return { ok: false, error: REPLY_TEST_TEXTS.dmarcReadMeanwhile(address) };
        }
        if (prev?.dmarcFromHeaders && prev.dmarcOk === dmarcOk) dmarcRead = true;
      }
      entry.dmarcOk = dmarcOk;
      entry.dmarcFromHeaders = dmarcRead && dmarcOk !== null;
    }
    mailboxes.push(entry);
  }
  const headersOk = input.headersOk === undefined ? setting.headersOk : boolOrNull(input.headersOk);
  // Own-mailbox mode's unsubscribe-by-email answer (O13): only when given, so other shapes stay as they were.
  const mailto = input.mailtoArrived === undefined ? {} : { mailtoArrived: boolOrNull(input.mailtoArrived) };
  return { ok: true, setting: { ...setting, mailboxes, headersOk, ...mailto }, authFromHeaders, dmarcFromHeaders };
}

// ───────────────────────── pasted headers ─────────────────────────

/**
 * A header line is read up to this many characters (REPLIES-04). RFC 5322 caps a physical line at 998 characters; the
 * headers the app reads (Authentication-Results, From, Return-Path, Message-ID, List-Unsubscribe) stay far below this
 * even when folded, so only a garbled paste is cut.
 */
const HEADER_LINE_MAX = 8_000;
/** An address is looked for in the first this many characters of a header value (REPLIES-04). */
const ADDRESS_VALUE_MAX = 2_000;
/** U+2028 and U+2029 (line and paragraph separator): `.` doesn't match them, so they are read as spaces. */
const UNICODE_LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/**
 * Joins folded header lines (a line starting with a space or tab continues the one before), each at most
 * HEADER_LINE_MAX characters. Unicode line and paragraph separators count as spaces, so `.` in the per-line patterns
 * reaches the end of the line and every pattern here runs in linear time (REPLIES-04: pastes of up to 200,000
 * characters are read in the web server's process).
 */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of (text ?? "").replace(/\r\n?/g, "\n").replace(UNICODE_LINE_BREAKS, " ").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      const prev = out[out.length - 1]!;
      if (prev.length >= HEADER_LINE_MAX) continue;
      const next = `${prev} ${line.trim()}`;
      out[out.length - 1] = next.length > HEADER_LINE_MAX ? next.slice(0, HEADER_LINE_MAX) : next;
    } else {
      out.push(line.length > HEADER_LINE_MAX ? line.slice(0, HEADER_LINE_MAX) : line);
    }
  }
  return out;
}

/**
 * The first run of characters without whitespace, <, > or " that has an @ with something before and after it (a bare
 * "a@b"), or null. The same result as /([^\s<>"]+@[^\s<>"]+)/ (whose match is always such a whole run), in linear time.
 */
function bareAddressToken(v: string): string | null {
  for (const token of v.split(/[\s<>"]+/)) {
    const at = token.indexOf("@", 1);
    if (at > 0 && at < token.length - 1) return token;
  }
  return null;
}

/** The first "<a@b>" without whitespace inside, or null: /<([^<>\s]+@[^<>\s]+)>/ in linear time. */
function angledAddressToken(v: string): string | null {
  for (const m of v.matchAll(/<([^<>]*)>/g)) {
    const inner = m[1]!;
    if (/\s/.test(inner)) continue;
    const at = inner.indexOf("@", 1);
    if (at > 0 && at < inner.length - 1) return inner;
  }
  return null;
}

/** Mailgun's own hops (its ARC seal on every routed reply records what Mailgun saw before forwarding). */
const MAILGUN_AUTHSERV = /(?:^|\.)mailgun\.(?:org|net|com)$/i;
/** DKIM results that mean the signature didn't survive (RFC 8601: only "pass" means it verified). */
const DKIM_BROKEN = new Set(["fail", "neutral", "permerror", "policy"]);

type AuthResult = { method: string; result: string; props: string };
type AuthSet = { order: number; arc: boolean; instance: number; authservId: string | null; results: AuthResult[] };

/** Removes (comments), nested ones included, outside "quoted strings". Gmail puts the i=1 results inside a comment. */
function stripComments(v: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    if (ch === "\\" && i + 1 < v.length) {
      if (depth === 0) out += ch + v[i + 1];
      i++;
    } else if (depth === 0 && ch === '"') {
      quoted = !quoted;
      out += ch;
    } else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** One (ARC-)Authentication-Results value: `[i=N;] authserv-id [version]; method=result props; …`. */
function parseAuthSet(raw: string, arc: boolean, order: number): AuthSet {
  let v = stripComments(raw).trim();
  let instance = 0;
  if (arc) {
    const m = /^i\s*=\s*(\d+)\s*;?/i.exec(v);
    if (m) {
      instance = Number(m[1]);
      v = v.slice(m[0].length);
    }
  }
  const parts = v
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  // Outlook.com leaves the authserv-id out ("spf=pass …; dkim=pass …"), so the first part may already be a result.
  let authservId: string | null = null;
  if (parts.length > 0 && !/^[a-z0-9._-]+\s*=/i.test(parts[0]!)) authservId = parts.shift()!.split(/\s+/)[0]!.toLowerCase();
  const results: AuthResult[] = [];
  for (const p of parts) {
    const m = /^([a-z0-9._-]+)\s*=\s*([a-z0-9_-]+)(.*)$/i.exec(p);
    if (m) results.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props: m[3] ?? "" });
  }
  return { order, arc, instance, authservId, results };
}

/** gmail.com and googlemail.com are one mailbox provider; everything else compares by its registrable domain. */
function orgDomain(domain: string): string {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  // Longer than any host name: compared as it is.
  if (d.length > 253) return d;
  const reg = parseDomain(d).domain ?? d;
  return reg === "googlemail.com" ? "gmail.com" : reg;
}

/** The signer of a dkim result: header.d=x.com, or header.i=@x.com / user@x.com. Null when the result doesn't say. */
function dkimSigner(props: string): string | null {
  const d = /\bheader\.d\s*=\s*"?([^\s;"]+)/i.exec(props);
  if (d) return d[1]!;
  const i = /\bheader\.i\s*=\s*"?(?:[^\s;"@]*@)?([^\s;"@]+)/i.exec(props);
  return i ? i[1]! : null;
}

/** The first From: address in pasted text (the reply's sender), for when the caller doesn't say which mailbox it is. */
function fromDomainIn(lines: readonly string[]): string | null {
  for (const l of lines) {
    const m = /^\s*from\s*:(.*)$/i.exec(l);
    if (!m) continue;
    const value = m[1]!.slice(0, ADDRESS_VALUE_MAX);
    const addr = angledAddressToken(value) ?? bareAddressToken(value);
    const parsed = addr ? parseEmail(addr) : null;
    if (parsed) return parsed.domain.toLowerCase();
  }
  return null;
}

/**
 * Reads the receiving mailbox's own verdict from a pasted original (§1.5 step 3): the top-most Authentication-Results
 * (the one the inbox provider added last, such as mx.google.com or Outlook.com's), or, when the text has none, the
 * ARC-Authentication-Results with the highest instance. Mailgun's own sets are ignored: Mailgun ARC-seals every reply it
 * forwards and records what it saw before the forward, which says nothing about what the inbox received.
 * In that one set: arc=pass, or dkim=pass → "pass"; otherwise a broken dkim (fail, neutral, permerror, policy) or
 * arc=fail → "fail"; neither → null. When the set lists a signature of the reply's own domain (`opts.from`, else the
 * pasted From:), only that signature's dkim result counts, so another signer's pass (a forwarder re-signing) can't hide
 * a broken one. Comments in parentheses never count. Unfolds continuation lines; case-insensitive. The text itself is
 * never stored.
 */
/**
 * The receiving mailbox's own Authentication-Results set: the top-most Authentication-Results that isn't Mailgun's, or,
 * when the text has none, the ARC-Authentication-Results with the highest instance. Null when there is none.
 */
function chosenAuthSet(lines: readonly string[]): AuthSet | null {
  const sets: AuthSet[] = [];
  lines.forEach((l, order) => {
    const m = /^\s*(arc-)?authentication-results\s*:(.*)$/i.exec(l);
    if (m) sets.push(parseAuthSet(m[2]!, Boolean(m[1]), order));
  });
  const inbox = sets.filter((s) => !(s.authservId && MAILGUN_AUTHSERV.test(s.authservId)));
  return inbox.find((s) => !s.arc) ?? inbox.filter((s) => s.arc).sort((a, b) => b.instance - a.instance || a.order - b.order)[0] ?? null;
}

export function parseAuthResults(headersText: string, opts: { from?: string | null } = {}): "pass" | "fail" | null {
  const lines = unfold(headersText ?? "");
  const chosen = chosenAuthSet(lines);
  if (!chosen) return null;

  const dkim = chosen.results.filter((r) => r.method === "dkim");
  const arc = chosen.results.filter((r) => r.method === "arc");
  const fromDomain = (opts.from ? parseEmail(opts.from)?.domain.toLowerCase() : null) ?? fromDomainIn(lines);
  const own = fromDomain
    ? dkim.filter((r) => {
        const signer = dkimSigner(r.props);
        return signer !== null && orgDomain(signer) === orgDomain(fromDomain);
      })
    : [];
  const judged = own.length > 0 ? own : dkim;
  if (arc.some((r) => r.result === "pass") || judged.some((r) => r.result === "pass")) return "pass";
  if (dkim.some((r) => DKIM_BROKEN.has(r.result)) || arc.some((r) => r.result === "fail")) return "fail";
  return null;
}

/** What the app says after reading pasted headers (§1.5 step 3). */
export function authResultsText(result: "pass" | "fail" | null): string {
  if (result === "pass") return "The headers say dkim=pass.";
  if (result === "fail") return "The headers say dkim=fail: the reply didn't keep its signature.";
  return "The headers don't show a DKIM or ARC result. Paste the whole original, starting at the first line.";
}

// ───────────────────────── pasted originals (shared From address) ─────────────────────────

/**
 * The header lines of a pasted original, unfolded: everything up to the first blank line after the Message-ID header
 * (the message's own headers end there; a Gmail "Show original" page's summary above it has no "Message-ID:" line), or
 * the whole text when it has no Message-ID header (just headers were pasted).
 */
function headerSection(text: string): string[] {
  const lines = unfold(text ?? "");
  const at = lines.findIndex((l) => /^message-id\s*:/i.test(l));
  if (at < 0) return lines;
  const end = lines.findIndex((l, i) => i > at && l.trim() === "");
  return end < 0 ? lines : lines.slice(0, end);
}

/** The value of the first (top-most) header called `name`, or null. */
function firstHeader(lines: readonly string[], name: string): string | null {
  const re = new RegExp(`^${name.replace(/[-]/g, "\\-")}\\s*:(.*)$`, "i");
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m[1]!.trim();
  }
  return null;
}

/** The values of every header called `name`, top-most first. */
function allHeaders(lines: readonly string[], name: string): string[] {
  const re = new RegExp(`^${name.replace(/[-]/g, "\\-")}\\s*:(.*)$`, "i");
  const out: string[] = [];
  for (const l of lines) {
    const m = re.exec(l);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

/** The address in "Name <a@b>" or a bare "a@b", lowercase; null when there is none ("<>" included). */
function addressIn(value: string | null): string | null {
  if (value === null) return null;
  // Only the start of a long value is read, and without backtracking patterns (REPLIES-04).
  const v = stripComments(value.slice(0, ADDRESS_VALUE_MAX));
  const angled = /<([^<>]*)>/.exec(v);
  const raw = (angled ? angled[1]! : (bareAddressToken(v) ?? "")).trim().replace(/^"|"$/g, "");
  return raw.includes("@") ? raw.toLowerCase() : null;
}

/** The domain of an address, or a bare host (Outlook.com's `smtp.mailfrom=example.com`), lowercase; null when empty. */
function hostOf(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().replace(/^<|>$/g, "").replace(/^"|"$/g, "");
  const host = v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v;
  const cut = host.search(/[?>]/);
  return normHost(cut >= 0 ? host.slice(0, cut) : host);
}

/**
 * DMARC's verdict in a pasted original (SHARED-FROM-DESIGN §3.4): from the same Authentication-Results set as
 * `parseAuthResults` (the receiving mailbox's own, never Mailgun's), `dmarc=pass` → "pass", `dmarc=fail` → "fail",
 * anything else (none, bestguesspass, temperror, permerror, missing) → null. With `fromDomain`, a result whose
 * `header.from=` names another domain is ignored. Comments never count; the text itself is never stored.
 */
export function parseDmarcResult(text: string, opts: { fromDomain?: string | null } = {}): "pass" | "fail" | null {
  return dmarcIn(chosenAuthSet(headerSection(text)), normHost(opts.fromDomain));
}

function dmarcIn(chosen: AuthSet | null, fromDomain: string | null): "pass" | "fail" | null {
  if (!chosen) return null;
  const results = chosen.results.filter((r) => {
    if (r.method !== "dmarc") return false;
    const hf = /\bheader\.from\s*=\s*"?([^\s;"]+)/i.exec(r.props)?.[1];
    return !fromDomain || !hf || normHost(hf) === fromDomain;
  });
  if (results.some((r) => r.result === "fail")) return "fail";
  if (results.some((r) => r.result === "pass")) return "pass";
  return null;
}

/** What the app says after reading DMARC from a pasted original (§3.4). */
export function dmarcResultsText(result: "pass" | "fail" | null): string {
  if (result === "pass") return "The original says DMARC: PASS.";
  if (result === "fail") return "The original says DMARC: FAIL.";
  return "The original doesn't show a DMARC result. Paste the whole original, starting at the first line.";
}

/** What `parseTestOriginal` reads from a pasted original (never the text itself). */
export type ParsedTestOriginal = {
  /** The Message-ID without angle brackets, lowercase; null when the original has none. */
  messageId: string | null;
  /** The first From: header's address, lowercase. */
  from: string | null;
  returnPathDomain: string | null;
  returnPathOk: boolean | null;
  dmarc: "pass" | "fail" | null;
  dkimSigner: string | null;
  mailtoDomain: string | null;
  mailtoOk: boolean | null;
  /**
   * MAIN-DOMAIN-DESIGN §3.5: the scheme of the first http(s) URL in List-Unsubscribe ("https" or "http"); null when it
   * has none (or there is no List-Unsubscribe).
   */
  unsubscribeScheme: "https" | "http" | null;
  /**
   * MAIN-DOMAIN-DESIGN O13: the whole address of the first readable `mailto:` in the List-Unsubscribe headers, without
   * `?…`, percent-decoded, lowercase (at most 998 characters, review SECURITY-03); null without one.
   */
  mailtoAddress: string | null;
  /**
   * Review SECURITY-03: a List-Unsubscribe header offers a `mailto:` but none of its addresses could be read. Set only
   * when true (the question can't be asked, so own-mailbox mode's test fails closed).
   */
  mailtoUnreadable?: true;
};

/**
 * The longest `mailto:` address the app keeps (review SECURITY-03): a header line's limit (RFC 5322), not RFC 5321's
 * 254-character path, because Mailgun's `u+…` tokens may be longer (MAIN-DOMAIN-DESIGN §11 Q4). The same limit as the
 * stored value's parser (`@/core/system-state-parse`).
 */
const MAILTO_ADDRESS_MAX = 998;

/**
 * The first http(s) URL's scheme in a List-Unsubscribe value, in one linear scan (REPLIES-04): "<https://…>" → "https",
 * "<http://…>" → "http"; null when there is none.
 */
function webLinkScheme(value: string): "https" | "http" | null {
  const m = /\b(https?):\/\//i.exec(value);
  if (!m) return null;
  return m[1]!.toLowerCase() === "https" ? "https" : "http";
}

/**
 * One `mailto:` target as an address (review SECURITY-03): without its `?subject=…` part, percent-decoded (RFC 6068),
 * lowercase; null when it isn't one address of at most 998 characters: no spaces or angle brackets, and one "@" with
 * something on both sides (an "@" inside a quoted local part is allowed). The same rule as the stored value's parser.
 */
function mailtoTargetAddress(raw: string): string | null {
  const cut = raw.indexOf("?");
  let address = cut >= 0 ? raw.slice(0, cut) : raw;
  if (address.length > MAILTO_ADDRESS_MAX * 3) return null;
  if (address.includes("%")) {
    try {
      address = decodeURIComponent(address);
    } catch {
      return null;
    }
  }
  address = address.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (address.length === 0 || address.length > MAILTO_ADDRESS_MAX || at <= 0 || at === address.length - 1 || /[\s<>]/.test(address)) return null;
  const local = address.slice(0, at);
  if (local.includes("@") && !(local.length > 2 && local.startsWith('"') && local.endsWith('"'))) return null;
  return address;
}

/**
 * The `mailto:` addresses of List-Unsubscribe values (MAIN-DOMAIN-DESIGN O13, review SECURITY-03): the first readable
 * one, and whether any `mailto:` was offered at all. Every header counts (a second List-Unsubscribe header with a
 * `mailto:` must not hide behind a first one without). Linear: one global scan per value.
 */
function mailtosIn(values: readonly string[]): { address: string | null; offered: boolean } {
  let offered = false;
  for (const value of values) {
    for (const m of value.matchAll(/mailto:([^>,\s]*)/gi)) {
      offered = true;
      const address = mailtoTargetAddress(m[1] ?? "");
      if (address !== null) return { address, offered };
    }
  }
  return { address: null, offered };
}

/**
 * Reads one pasted original of a reply-test email (SHARED-FROM-DESIGN §3.4, F25). Pure; the text is never stored.
 *  - `from`: the first From: header's address;
 *  - `returnPathDomain`: the domain of the top-most Return-Path: header, else of `smtp.mailfrom=` in the receiving
 *    mailbox's Authentication-Results (null when neither); `returnPathOk`: that domain is the sending domain or under it
 *    (null when unknown; the From domain or anything else → false);
 *  - `dmarc`: `parseDmarcResult` for the From domain;
 *  - `dkimSigner`: the `header.d` (or `header.i` domain) of a `dkim=pass` result in that set whose signer is the From
 *    domain or under it, else null;
 *  - `mailtoDomain` / `mailtoOk`: the host of a `mailto:` in List-Unsubscribe: (true when there is no mailto, false when
 *    it isn't on or under the sending domain, e.g. exactly the From domain; null when there is no List-Unsubscribe);
 *  - `unsubscribeScheme` and `mailtoAddress` (MAIN-DOMAIN-DESIGN §3.5, O13): the web link's scheme and the whole
 *    `mailto:` address of List-Unsubscribe (null when there is none).
 * Only the message's own headers are read (up to the blank line after its Message-ID); folded lines are unfolded,
 * comments ignored, names case-insensitive.
 */
export function parseTestOriginal(text: string, opts: { sendingDomain: string; fromDomain: string }): ParsedTestOriginal {
  const lines = headerSection(text);
  const d = normHost(opts.sendingDomain);
  const org = normHost(opts.fromDomain);
  const chosen = chosenAuthSet(lines);

  const idValue = firstHeader(lines, "message-id");
  const idRaw = idValue === null ? "" : (/<([^<>]+)>/.exec(idValue)?.[1] ?? idValue);
  const messageId = idRaw.trim().toLowerCase() || null;

  const from = addressIn(firstHeader(lines, "from"));

  const returnPathHeader = firstHeader(lines, "return-path");
  let returnPathDomain = returnPathHeader !== null ? hostOf(addressIn(returnPathHeader)) : null;
  if (!returnPathDomain) {
    const spf = chosen?.results.find((r) => r.method === "spf" && /\bsmtp\.mailfrom\s*=/i.test(r.props));
    const mailfrom = spf ? /\bsmtp\.mailfrom\s*=\s*"?([^\s;"]+)/i.exec(spf.props)?.[1] ?? null : null;
    returnPathDomain = hostOf(mailfrom);
  }
  const returnPathOk = returnPathDomain === null ? null : onOrUnder(returnPathDomain, d);

  let signerFound: string | null = null;
  for (const r of chosen?.results ?? []) {
    if (r.method !== "dkim" || r.result !== "pass") continue;
    const signer = normHost(dkimSigner(r.props));
    if (signer && onOrUnder(signer, org)) {
      signerFound = signer;
      break;
    }
  }

  const listUnsubscribe = firstHeader(lines, "list-unsubscribe");
  let mailtoDomain: string | null = null;
  let mailtoOk: boolean | null = null;
  let unsubscribeScheme: "https" | "http" | null = null;
  let mailtoAddress: string | null = null;
  let mailtoUnreadable = false;
  if (listUnsubscribe !== null) {
    // The shared-From fields read the top-most header, as before.
    const mailto = /mailto:([^>,\s]+)/i.exec(listUnsubscribe)?.[1] ?? null;
    mailtoDomain = mailto ? hostOf(mailto.split("?")[0] ?? "") : null;
    mailtoOk = mailto === null ? true : onOrUnder(mailtoDomain, d);
    // Own-mailbox mode's fields read every List-Unsubscribe header (review SECURITY-03, REPLIES-03).
    const values = allHeaders(lines, "list-unsubscribe");
    for (const v of values) {
      unsubscribeScheme = webLinkScheme(v);
      if (unsubscribeScheme !== null) break;
    }
    const mailtos = mailtosIn(values);
    mailtoAddress = mailtos.address;
    mailtoUnreadable = mailtos.offered && mailtos.address === null;
  }

  return {
    messageId,
    from,
    returnPathDomain,
    returnPathOk,
    dmarc: dmarcIn(chosen, org),
    dkimSigner: signerFound,
    mailtoDomain,
    mailtoOk,
    unsubscribeScheme,
    mailtoAddress,
    ...(mailtoUnreadable ? { mailtoUnreadable: true as const } : {}),
  };
}

/**
 * One line per check of a pasted original (§3.4), for the section under "Read the original": From, return address,
 * DMARC, signature, unsubscribe by email. `ok` false marks the lines that stop the test (or say what to paste again).
 *
 * Own-mailbox mode (`ctx.ownMailbox`, MAIN-DOMAIN-DESIGN §3.5): From; the return address on {d} (late bounces and
 * automatic replies go to the own mailbox) or elsewhere; DMARC; the signature; the unsubscribe link's scheme (http is
 * honest, not a failure); and the `mailto:` address the question below asks about. Without it: exactly as before.
 */
export function testOriginalTexts(
  result: Pick<ParsedTestOriginal, "returnPathDomain" | "returnPathOk" | "dmarc" | "dkimSigner" | "mailtoDomain" | "mailtoOk"> & {
    from: string | null;
    unsubscribeScheme?: "https" | "http" | null;
    mailtoAddress?: string | null;
    mailtoUnreadable?: boolean;
  },
  ctx: { from: string; d: string; org: string; ownMailbox?: boolean },
): Array<{ ok: boolean; text: string }> {
  const out: Array<{ ok: boolean; text: string }> = [];
  const from = normAddress(ctx.from) ?? ctx.from;
  const found = normAddress(result.from);
  out.push(
    found === from
      ? { ok: true, text: `From: ${from} ✓` }
      : { ok: false, text: REPLY_TEST_TEXTS.originalFromWrong(found ?? "no address", from) },
  );
  if (ctx.ownMailbox === true) return out.concat(ownOriginalLines(result, ctx.d));
  if (result.returnPathOk === true) {
    out.push({ ok: true, text: `Return address: …@${result.returnPathDomain} ✓ (bounces and automatic replies reach the app)` });
  } else if (result.returnPathOk === false) {
    out.push({
      ok: false,
      text: `Return address: …@${result.returnPathDomain}, not on ${ctx.d}: bounces and automatic replies would go to your everyday inbox instead of the app.`,
    });
  } else {
    out.push({ ok: false, text: REPLY_TEST_TEXTS.returnPathUnknown });
  }
  out.push({ ok: result.dmarc === "pass", text: dmarcResultsText(result.dmarc) });
  out.push(result.dkimSigner ? { ok: true, text: `Signed by ${result.dkimSigner} ✓` } : { ok: false, text: "No valid signature found." });
  if (result.mailtoOk === true && result.mailtoDomain) {
    out.push({ ok: true, text: `Unsubscribe by email: …@${result.mailtoDomain} ✓` });
  } else if (result.mailtoOk === true) {
    out.push({ ok: true, text: "Unsubscribe by email: not offered (the link works) ✓" });
  } else if (result.mailtoOk === false) {
    out.push({ ok: false, text: `Unsubscribe by email goes to …@${result.mailtoDomain ?? ctx.org}, not to ${ctx.d}.` });
  } else {
    out.push({ ok: false, text: "The original doesn't show a List-Unsubscribe header." });
  }
  return out;
}

/** Own-mailbox mode's lines after From (MAIN-DOMAIN-DESIGN §3.5). */
function ownOriginalLines(
  result: Pick<ParsedTestOriginal, "returnPathDomain" | "returnPathOk" | "dmarc" | "dkimSigner" | "mailtoDomain" | "mailtoOk"> & {
    unsubscribeScheme?: "https" | "http" | null;
    mailtoAddress?: string | null;
    mailtoUnreadable?: boolean;
  },
  d: string,
): Array<{ ok: boolean; text: string }> {
  const T = OWN_REPLY_TEST_TEXTS;
  const out: Array<{ ok: boolean; text: string }> = [];
  if (result.returnPathOk === true) out.push({ ok: true, text: T.returnPathOwn(result.returnPathDomain ?? d) });
  else if (result.returnPathOk === false) out.push({ ok: false, text: T.returnPathElsewhere(result.returnPathDomain ?? "another domain", d) });
  else out.push({ ok: false, text: REPLY_TEST_TEXTS.returnPathUnknown });
  out.push({ ok: result.dmarc === "pass", text: dmarcResultsText(result.dmarc) });
  out.push(result.dkimSigner ? { ok: true, text: `Signed by ${result.dkimSigner} ✓` } : { ok: false, text: "No valid signature found." });
  // An original read before the scheme was kept (missing) says nothing about the link.
  if (result.unsubscribeScheme === "https") out.push({ ok: true, text: T.linkHttps });
  else if (result.unsubscribeScheme === "http") out.push({ ok: true, text: T.linkHttp });
  else if (result.unsubscribeScheme === null) out.push({ ok: false, text: T.linkNone });
  const mailto = normAddress(result.mailtoAddress);
  // Review SECURITY-03: a mailto: whose address couldn't be read is never "not offered".
  if (mailto) out.push({ ok: true, text: T.mailtoOwn(mailto) });
  else if (mailtoOffered(result)) out.push({ ok: false, text: T.mailtoUnreadableLine });
  else out.push({ ok: true, text: T.mailtoNone });
  return out;
}

/** The From domain of a shared From address ("contact@example.com" → "example.com"), or null. */
export function teamFromDomainOf(teamFrom: string | null | undefined): string | null {
  const a = normAddress(teamFrom);
  return a ? domainOfAddress(a) : null;
}

// ───────────────────────── the test email ─────────────────────────

export const REPLY_TEST_SUBJECT = "Reply test from Polygon Paradise Outreach";

const REPLY_TEST_BODY = [
  "Hi,",
  'This is a test from the Polygon Paradise outreach app. Please reply to this email with a short message such as "Got it".',
  "If it landed in spam, move it to your inbox first, then reply.",
].join("\n\n");

/**
 * The reply-test email (§1.5 step 1): the fixed text, the sender's signature and the real footer with
 * %unsubscribe_url% (Mailgun fills in the personal link while its unsubscribe handling is on, Setup A).
 */
export function replyTestEmail(i: { signature: string; footer: FooterSettings }): { subject: string; text: string; html: string } {
  const signature = (i.signature ?? "").replace(/\r\n?/g, "\n").trim();
  const body = signature ? `${REPLY_TEST_BODY}\n\n${signature}` : REPLY_TEST_BODY;
  return {
    subject: REPLY_TEST_SUBJECT,
    text: `${body}\n\n${footerText(i.footer, "send")}`,
    html: `${textToHtml(body)}\n${footerHtml(i.footer, "send")}`,
  };
}

// ───────────────────────── the test list ─────────────────────────

export const TEST_LIST_MAX = 10;

/**
 * Setting "sending.testList" (§2.1): at most 10 addresses, each a valid email, stored lowercase and de-duplicated; none on
 * (or under) a sending domain. A teammate's reply inbox is allowed but warned about (Gmail hides mail sent to and from
 * the same address). `ctx.teamFrom` (SHARED-FROM-DESIGN F15): the shared From address can't be a test mailbox, refused
 * with its own sentence (`REPLY_TEST_TEXTS.fromOnTestList`, SCREENS-04); absent or null = today's rules.
 */
export function validateTestList(
  input: readonly string[],
  ctx: {
    sendingDomains: readonly string[];
    teammateInboxes: ReadonlyArray<{ name: string; inbox: string }>;
    teamFrom?: string | null;
  },
): { ok: true; value: string[]; warnings: string[] } | { ok: false; error: string } {
  const teamFrom = (ctx.teamFrom ?? "").trim().toLowerCase();
  const value: string[] = [];
  for (const raw of input) {
    const text = (raw ?? "").trim();
    if (!text) continue;
    const parsed = parseEmail(text);
    if (!parsed) return { ok: false, error: `${text} isn't a valid email address. Check it and try again.` };
    const norm = parsed.norm;
    const onSending = ctx.sendingDomains.some((d) => {
      const sd = d.trim().toLowerCase();
      return Boolean(sd) && (parsed.domain === sd || parsed.domain.endsWith(`.${sd}`));
    });
    if (onSending) return { ok: false, error: `${norm} is on your sending domain. Use a normal mailbox, such as Gmail or Outlook.com.` };
    if (teamFrom && norm === teamFrom) return { ok: false, error: REPLY_TEST_TEXTS.fromOnTestList(norm) };
    if (!value.includes(norm)) value.push(norm);
  }
  if (value.length > TEST_LIST_MAX) {
    return { ok: false, error: `Your test list can hold ${TEST_LIST_MAX} addresses at most. Remove one first.` };
  }
  const warnings: string[] = [];
  for (const a of value) {
    const mate = ctx.teammateInboxes.find((t) => t.inbox.trim().toLowerCase() === a);
    if (mate) {
      warnings.push(`${a} is ${mate.name}'s reply inbox. Gmail hides emails sent to and from the same address, so use a different mailbox.`);
    }
  }
  return { ok: true, value, warnings };
}
