import { parseEmail } from "@/core/email-address";
import { ROUTE_CHECK_LOCAL_PREFIX } from "@/core/mailgun/routes";
import {
  TEAM_FROM_REFUSED_LOCAL_PARTS,
  TEAM_FROM_TEXTS,
  formatFromHeader,
  validateTeamFromAddress,
  type TeamFromResult,
} from "@/core/sending/from-address";

/**
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O1–O6): the app sends through the domain of the Owner's own mailbox
 * (polygonparadise.com), every email From the own From with each sender's display name and no Reply-To; replies land in
 * that mailbox only. One flag, Setting "mailgun.replies"; absent or anything else = app mode (per-person or shared-From),
 * exactly as before. Pure and browser-safe (the connection card and the From card check as you type).
 *
 * The mode is decided only through `loadTeamFrom().replies`, `MailgunContext.replies` or `loadPlanLimits()` (all three
 * parse the setting with `repliesOf()`), never from "the From address is on the sending domain" (per-person mode has
 * that too) and never by reading the setting raw (§0.2 rule 5). The From line of an own-mailbox email comes only from
 * `ownMailboxHeaders()` (§0.2 rule 6).
 */

export type RepliesMode = "app" | "own-mailbox";

/** Setting "mailgun.replies" → the mode; anything but exactly "own-mailbox" is "app" (fail closed, O1). */
export function repliesOf(v: unknown): RepliesMode {
  return v === "own-mailbox" ? "own-mailbox" : "app";
}

/**
 * What the sender checks compare an own-mailbox email with (O6): null in app mode (today's rules), the own From in
 * own-mailbox mode, or "" when own-mailbox mode has no fitting From yet (then every email is refused).
 */
export function ownMailboxRuleFrom(replies: RepliesMode, ownFrom: string | null): string | null {
  return replies === "own-mailbox" ? (ownFrom ?? "").trim().toLowerCase() : null;
}

/** The From line of an own-mailbox email (§2.3). Never a Reply-To. */
export function ownMailboxHeaders(i: { displayName: string; from: string }): { from: string; replyTo: null } {
  return { from: formatFromHeader(i.displayName, i.from.trim().toLowerCase()), replyTo: null };
}

function cleanHost(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\.+$/, "");
}

/** Setting "mailgun.fromAddress" in own-mailbox mode (§2.2): exactly on the sending domain. Empty → null (allowed). */
export function validateOwnMailboxFrom(input: string | null | undefined, sendingDomain: string | null | undefined): TeamFromResult {
  const v = (input ?? "").trim().replace(/^mailto:/i, "").trim();
  if (!v) return { ok: true, address: null };
  const d = cleanHost(sendingDomain);
  if (!d) return { ok: false, error: TEAM_FROM_TEXTS.notConnected };
  const example = `contact@${d}`;
  const parsed = parseEmail(v);
  if (!parsed || parsed.displayName || /[\s<>",;()]/.test(v) || parsed.email.toLowerCase() !== v.toLowerCase()) {
    return { ok: false, error: TEAM_FROM_TEXTS.invalid(example) };
  }
  const address = parsed.email.toLowerCase();
  if (parsed.domain.toLowerCase() !== d) return { ok: false, error: OWN_MAILBOX_TEXTS.fromWrongDomain(d) };
  const local = address.slice(0, address.lastIndexOf("@"));
  if (TEAM_FROM_REFUSED_LOCAL_PARTS.has(local) || local.startsWith(ROUTE_CHECK_LOCAL_PREFIX)) {
    return { ok: false, error: TEAM_FROM_TEXTS.reserved(local, example) };
  }
  return { ok: true, address };
}

/** The one dispatch (§2.2): today's shared-From rules in app mode, the own-mailbox rules otherwise. */
export function validateFromAddressFor(
  input: string | null | undefined,
  sendingDomain: string | null | undefined,
  replies: RepliesMode,
): TeamFromResult {
  return replies === "own-mailbox" ? validateOwnMailboxFrom(input, sendingDomain) : validateTeamFromAddress(input, sendingDomain);
}

/**
 * The List-Unsubscribe header the app sends itself when the Owner left out unsubscribe by email (review REPLIES-03): only
 * Mailgun's per-recipient web link (`%unsubscribe_url%`), no `mailto:`. Mailgun adds its own List-Unsubscribe only when
 * the message has none (docs/dev/research/mailgun-sending.md, help.mailgun.com article 203306610); Mailgun documents the
 * variable for the email's body only, so whether it is filled in here is proved by the reply test's pasted original,
 * never assumed (fail closed: no link and no `mailto:` → the test fails).
 */
export const WEB_ONLY_LIST_UNSUBSCRIBE = "<%unsubscribe_url%>";

/** The domain part of an address (after its last "@"), lowercase; "" without one. */
function domainPart(address: string): string {
  const v = address.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  return at >= 0 ? cleanHost(v.slice(at + 1)) : "";
}

/**
 * Review REPLIES-01: the unsubscribe-by-email address is on the own From's domain itself (in own-mailbox mode the
 * sending domain, whose MX is the mail provider's, never Mailgun's). Then only a mailbox someone reads can prove that an
 * email to it arrived: Settings › Deliverability would list the test mailbox anyway, because of the link click.
 */
export function mailtoOnOwnDomain(mailto: string, from: string): boolean {
  const host = domainPart(mailto);
  return host !== "" && host === domainPart(from);
}

/** The alias that catches Mailgun's `u+…@d` through sub-addressing: the part before "+" (or the whole local part). */
function mailtoAliasOf(mailto: string): string {
  const v = mailto.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at <= 0) return v;
  const local = v.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}@${v.slice(at + 1)}`;
}

/** O10: the sentence every red own-mailbox MX fix ends with (the P3 safety test requires it and allows Mailgun hosts only inside it). */
export const NEVER_MAILGUN_MX_TEXT = (d: string): string => `Never add Mailgun's MX records (mxa.mailgun.org, mxb.mailgun.org) to ${d}.`;

/** Every own-mailbox sentence of §3 that isn't a checklist row's status text (rows live in checklist.ts). */
export const OWN_MAILBOX_TEXTS = {
  // Mailgun connection card (§3.1)
  repliesLegend: "How the app sends",
  repliesAppLabel: "Through a sending subdomain (replies come through the app)",
  repliesAppHint:
    "For example mail.polygonparadise.com. Replies are recorded, stop follow-ups by themselves and are forwarded to your inbox. Needs Mailgun's Foundation plan (Mailgun guide).",
  repliesOwnLabel: "From polygonparadise.com itself (replies come to your own inbox)",
  repliesOwnHint:
    "Every email comes from your own address, such as contact@polygonparadise.com. Replies land in that inbox, and you mark them in the app with They replied. Works on Mailgun's Free plan (Own-mailbox guide).",
  websiteSwitch: "Use From polygonparadise.com itself",
  switchNote: "Changing this is like changing the sending domain: going live ends and the reply test starts again.",
  domainHint: "Your own domain, exactly as Mailgun shows it, for example polygonparadise.com.",
  domainPlaceholder: "polygonparadise.com",
  statusSuffix: " · replies go to your own mailbox",
  connectedNext: "Replies go to your own mailbox. Next: type your From address in the From address card below.",
  connectedMode: "Replies go to your own mailbox.",
  planSetFree: " The app keeps to Mailgun's Free plan (100 emails a day, 1 day of logs). If you upgrade, choose the plan under Advanced.",
  domainMisfit: (from: string, d: string): string => `Your From address ${from} isn't on ${d}. Clear it in the From address card first, then connect again.`,
  switchedSummary: (actorName: string, d: string, to: RepliesMode): string =>
    to === "own-mailbox" ? `${actorName} switched replies for ${d} to your own mailbox` : `${actorName} switched replies for ${d} to go through the app`,
  // From address card (§3.2)
  cardDescription: "The address every campaign email comes from. Replies go straight to this mailbox.",
  fieldLabel: "From address",
  hint: (displayName: string, shown: string, d: string): string =>
    `People see "${displayName} <${shown}>": each person's display name with this address. Replies go straight to this mailbox, not through the app. It must end in @${d}.`,
  missingHere: (d: string): string => `Type the address your emails come from, for example contact@${d}. Test and live campaigns can't start without it.`,
  misfitHere: (saved: string, d: string): string =>
    `The saved From address ${saved} isn't on your sending domain ${d}, so test and live campaigns can't start. Change it below.`,
  goodToKnow: (from: string, d: string): string[] => [
    `Replies come only to ${from}, never to the app, and follow-ups don't stop by themselves. Read ${from} every working day, its inbox and its Spam folder; when someone answered, open the company and click They replied: that stops every follow-up to it. Then click I've read ${from} on the Notifications page: live follow-ups wait for that each day.`,
    `If someone asks to be removed, or ${from} gets a "couldn't be delivered" notice about a campaign email, open the company and click ⋯ › Mark unsubscribed on that person (or set the company to Do not contact).`,
    "Automatic replies (out of office) and bounces that come later go to your mail provider too, or nowhere if it has no catch-all address. The app doesn't see them.",
    "The unsubscribe link in each email reaches the app. Some mail programs unsubscribe by sending an email instead: the reply test checks that those emails reach a mailbox you read. Handle them with Mark unsubscribed.",
    `Emails the app sends don't appear in the Sent folder of ${from}. The company's timeline has them.`,
    `Never add Mailgun's MX records to ${d} and never point its mail servers (MX) to Mailgun: your everyday email and every reply would stop arriving.`,
  ],
  savedOn: (from: string): string =>
    `From now on, campaign emails show From ${from}. Replies go straight to that mailbox (look in its Spam folder too): when someone answers, click They replied on their company. Run the reply test before live campaigns (Settings › Domain checklist).`,
  savedOff: (d: string): string => `The From address is cleared. Test and live campaigns can't start until you type an address on ${d}.`,
  clearedSummary: (actorName: string): string => `${actorName} cleared the From address`,
  // loadTeamFrom problems (§2.2)
  fromMissing: (d: string): string =>
    `Type the address your emails come from in Settings › Sending & Mailgun › From address, for example contact@${d}. Test and live campaigns can't start without it.`,
  misfit: (saved: string, d: string): string => `The From address ${saved} isn't on your sending domain ${d}. Change it in Settings › Sending & Mailgun.`,
  fromWrongDomain: (d: string): string => `The From address must end in @${d}, your sending domain.`,
  // Elsewhere
  checklistLine: (from: string | null, d: string): string =>
    from
      ? `Emails show From ${from} and go out through ${d} itself. Replies go straight to that mailbox.`
      : `Emails go out through ${d} itself. Type your From address in Settings › Sending & Mailgun.`,
  followUpReminder: (from: string): string =>
    `Replies come straight to ${from}, not to the app. Each day, read ${from} and its Spam folder, click They replied on every company that answered, then click I've read ${from} on the Notifications page: live follow-ups wait for that.`,
  openInboxCheck: "Open the inbox check",
  noSendingAddress: (from: string): string => `Nobody needs an address of their own: every email comes from ${from} with each person's display name.`,
  simulateReply: (from: string): string => `In your setup replies go to ${from}, not through the app. Use They replied on the company instead.`,
  repliesEmpty: (from: string): string => `Replies go straight to ${from}, not to the app. When someone answers, click They replied on their company.`,
  setupAOnly: "Your setup always uses Setup A.",
  setupNotNormal: "The reply test is set to a check-only setup. Click Back to normal in the Reply test section.",
  backToNormal: "Back to normal",
  applyHint:
    "Switches off open and click tracking, switches on Mailgun's unsubscribe handling with blank footers and asks Mailgun for secure unsubscribe links. With remote access it also sets the webhooks. It changes nothing about receiving mail: mail for polygonparadise.com stays with your mail provider.",
  applyNoPublicAddress:
    "No public address yet: Mailgun's reports come through the app's hourly check instead. Remote access is optional in your setup (Cloudflare guide).",
  applyNotNeeded: "Not needed: replies go to your own mailbox.",
  // Domain checklist fixes (§3.3, §2.5; checklist.ts builds the rows with these)
  mailgunDomainFix: (d: string): string =>
    `Check the SPF, DKIM and tracking rows below, then click Check again in a few minutes. Mailgun's page for ${d} also lists MX records: leave them out. ${NEVER_MAILGUN_MX_TEXT(d)}`,
  putBackMx: (lastGood: ReadonlyArray<{ priority: number; host: string }> | null | undefined): string =>
    lastGood && lastGood.length > 0
      ? `put back your mail provider's MX records: ${[...lastGood]
          .sort((a, b) => a.priority - b.priority)
          .map((m) => `${m.host} (priority ${m.priority})`)
          .join(", ")}`
      : "put back your mail provider's MX records (its help pages list them)",
  websiteInAppMode: (d: string): string => `${d} is your own domain, and its mail must stay with your mail provider.`,
  websiteInAppModeFix: "Open Settings › Sending & Mailgun and connect again with How the app sends = From polygonparadise.com itself.",
  // Sending (O35)
  senderBlocked: "This email didn't fit your From address, so sending paused once.",
  senderBlockedTwice: "Didn't send: this email doesn't fit your From address any more. Start a new campaign to email this person again.",
  profileFromLine: (displayName: string, from: string): string => `Your emails show "${displayName} <${from}>". Replies go straight to ${from}.`,
  profileFromMissing: "Your emails will show your display name with the From address the Owner sets in Settings › Sending & Mailgun.",
  testInboxLabel: "Inbox for your test emails",
  testInboxHint: (from: string): string => `Send me a test sends your test emails here. Replies to your campaigns go to ${from}.`,
  signatureHint: (from: string): string => ` If your signature shows an email address, use ${from}.`,
  switchOff: (name: string, from: string): string => `Replies to ${name}'s campaigns go to ${from}, as before.`,
  limitsColumn: "Emails show",
  senderStepInfo: (from: string): string =>
    `Display names and signatures are set in Settings › My profile. The From address (${from}) is set by the Owner in Settings › Sending & Mailgun. The Owner sets each teammate's own daily limit in Settings › Limits & warm-up.`,
  healthBounceNote: (from: string): string => ` Bounces that arrive later go to ${from}, not the app, so the real number can be higher.`,
  /**
   * Review REPLIES-08 (go-live card, instead of `MODE_GATE_TEXTS.liveTestSent`): the live test email's delivery report
   * fell outside the days of Mailgun's logs the app can read, so it can never arrive now.
   */
  liveTestGone:
    "Mailgun's report for your live test email is no longer available (Mailgun keeps its reports only for a short time), so the app can't see that it arrived. Send one more live campaign to your test list and check that it arrives.",
} as const;

/** The daily inbox check (O33, §2.9, §3.9). */
export const INBOX_CHECK_TEXTS = {
  title: "Today's inbox check",
  intro: (from: string): string =>
    `Replies to your campaigns come only to ${from}. Before live follow-ups go, read its inbox and its Spam folder. For every answer, open the company and click They replied (search Contacts for the address it came from). A removal request, an email to the unsubscribe address or a "couldn't be delivered" notice isn't an answer: open the company and click ⋯ › Mark unsubscribed on that person instead. Then click the button below: live follow-ups wait for it each day.`,
  waitingHeading: "Follow-ups due in the next 24 hours:",
  more: (n: number): string => `and ${n.toLocaleString("en-US")} more`,
  last: (when: string, name: string): string => `Last read ${when} by ${name}.`,
  notToday: "Nobody has read it today.",
  button: (from: string): string => `I've read ${from}`,
  done: "Thanks. Live follow-ups due today can go now.",
  notOwnMailbox: "Replies come through the app in your setup, so there's nothing to check by hand.",
  item: (count: number, from: string): string =>
    `${count === 1 ? "1 follow-up waits" : `${count.toLocaleString("en-US")} follow-ups wait`} for today's check of ${from}. Whoever reads it: read its inbox and Spam folder, click They replied on every company that answered and ⋯ › Mark unsubscribed on the person for every removal request or "couldn't be delivered" notice, then click I've read ${from}.`,
  itemLink: "Open the inbox check",
  // Review SEND-1: the bell also rings when only a live first email to an already-emailed company waits.
  notificationTitle: "Live emails wait for today's inbox check",
  notificationBody: (from: string): string =>
    `Read ${from} (inbox and Spam), click They replied where someone answered and ⋯ › Mark unsubscribed on the person for removal requests and "couldn't be delivered" notices, then click I've read ${from}.`,
  activity: (actorName: string, from: string): string => `${actorName} read ${from} (inbox and Spam)`,
} as const;

/** "They replied" (§3.8). */
export const THEY_REPLIED_TEXTS = {
  button: "They replied",
  ariaLabel: "Mark as replied: stops every follow-up to this company",
  confirmTitleCompany: (company: string): string => `Mark ${company} as replied?`,
  confirmTitlePerson: (person: string): string => `Mark ${person} as replied?`,
  bodyStatusChanges: (company: string): string => `Every follow-up to ${company} stops, in every campaign, and its status becomes Replied.`,
  bodyStatusStays: (company: string): string => `Every follow-up to ${company} stops, in every campaign.`,
  bodyTestOnly: (company: string): string =>
    `Every follow-up to ${company} stops, in every campaign. Its status stays as it is, because it has only had test emails so far.`,
  bodyPerson: (person: string): string => `${person} is noted as the one who replied.`,
  confirm: "Mark as replied",
  cancel: "Cancel",
  toast: (stopped: number): string =>
    stopped > 0
      ? `Marked as replied. Follow-ups to ${stopped.toLocaleString("en-US")} ${stopped === 1 ? "person" : "people"} stopped.`
      : "Marked as replied. No follow-ups were waiting.",
  doNotContact: "This company is marked Do not contact: nothing is sent to it anyway.",
  personGone: "That person isn't at this company any more. Refresh the page.",
  activity: (actorName: string, company: string, person: string | null): string =>
    person ? `${actorName} marked ${person} (${company}) as replied` : `${actorName} marked ${company} as replied`,
} as const;

/** The by-hand reply test (§3.5). */
export const OWN_REPLY_TEST_TEXTS = {
  intro: (from: string): string => `Send the test emails: one to each mailbox on your test list, from ${from}. Replies come straight to ${from}, not to the app.`,
  logsNote:
    "The app hears from Mailgun about deliveries and unsubscribes within the hour while the background sender runs. To check sooner, click Check with Mailgun now in Settings › Sending & Mailgun.",
  replyQuestion: (from: string): string => `Reply to the test email from this mailbox. Did your reply arrive in ${from}? Look in its Spam folder too.`,
  replyUnanswered: (address: string, from: string): string => `${address}: answer whether your reply arrived in ${from}.`,
  replyFailed: (address: string, from: string): string =>
    `${address}: your reply didn't arrive in ${from}. Check the Spam folder and the filters of ${from}, then change the answer.`,
  returnPathFailed: (rp: string, d: string): string => `The test email's return address is on ${rp}, not on ${d}. Tell the person who set up the app.`,
  headersFailed:
    "The test email has no List-Unsubscribe header. Click Apply recommended settings and send the test emails again; if it stays that way, ask the person who set up the app.",
  mailtoNote: "It may also show a mailto: address: that's expected. The next question checks where emails to it arrive.",
  /**
   * Review SCREENS-04: the List-Unsubscribe question in own-mailbox mode asks for what Mailgun's Free plan really
   * produces (a link, http on Free), with the note that https and List-Unsubscribe-Post need Foundation.
   */
  headersQuestion: "In one test mailbox, open the test email's original. Do you see a List-Unsubscribe: line with a link (http:// or https://)?",
  headersNote:
    "On Mailgun's Free plan the link starts with http:// and there's no List-Unsubscribe-Post line: that's expected. An https link and List-Unsubscribe-Post (the one-click unsubscribe Gmail and Yahoo show) need Mailgun's Foundation plan. Answer No only if the original has no List-Unsubscribe: line at all.",
  // The unsubscribe-by-email question (O13), asked while the stored original has a mailtoAddress. Review REPLIES-01: on
  // the From's own domain only "it arrived in a mailbox you read" proves it (Settings › Deliverability lists the test
  // mailbox anyway after its unsubscribe link was clicked); elsewhere the list counts only for the mailbox whose link
  // wasn't clicked.
  mailtoQuestion: (mailto: string, from: string): string =>
    mailtoOnOwnDomain(mailto, from)
      ? `From one of your test mailboxes, send an email to ${mailto} (any subject and text). Within the hour, did it arrive in ${from} or another mailbox you read? Look in Spam too.`
      : `From the test mailbox whose unsubscribe link you didn't click, send an email to ${mailto} (any subject and text). Within the hour, did it arrive in ${from} or another mailbox you read (look in Spam too), or does Settings › Deliverability now list that mailbox?`,
  /** Under the question while the address is on the From's own domain (`mailtoOnOwnDomain`). */
  mailtoAfter:
    `Answer Yes only if you found that email in a mailbox you read. If the test mailbox got a "couldn't be delivered" notice back, or nothing arrived, answer No. Settings › Deliverability can't answer this: it lists the test mailbox because of the unsubscribe link you clicked.`,
  /** Under the question for an address on another domain. */
  mailtoAfterElsewhere: "If Settings › Deliverability lists that mailbox now, click Remove there so the live test can reach it.",
  mailtoUnanswered: "Answer whether the email to the unsubscribe address arrived.",
  /**
   * Review REPLIES-03: every way forward, in order: a catch-all, then email aliases (Zoho may deliver `u+…@` to `u@`
   * through sub-addressing: unverified, so the test decides), then leaving out unsubscribe by email. Zoho's steps:
   * https://www.zoho.com/mail/help/adminconsole/catch-all-setup.html and https://www.zoho.com/mail/how-to/create-email-alias.html.
   */
  mailtoFailed: (mailto: string, d: string, from: string): string => {
    const alias = mailtoAliasOf(mailto);
    const aliases = alias === `bounce@${d}` ? alias : `${alias} and bounce@${d}`;
    const plus = alias === mailto.trim().toLowerCase() ? "" : ` Zoho may then deliver ${mailto} to ${alias}: try it, the test shows whether it works.`;
    return `Emails to ${mailto} don't reach anyone, so people who unsubscribe by email (a button some mail programs show) would never be removed. First, in your mail provider's admin settings for ${d}, turn on a catch-all address that delivers to ${from} (Zoho Mail: Admin Console › Domains › ${d} › Catch-all Address, under Advanced Settings). If your plan has no catch-all, add ${aliases} as email aliases of ${from} (Zoho Mail: Admin Console › Users › the user of ${from} › Mailbox Settings › Email Alias › Add).${plus} After each change, send the email again and change the answer. If nothing works, click Leave out unsubscribe by email below: your emails then offer unsubscribing by the link only.`;
  },
  /** Review SECURITY-03: the original offers a mailto: the app couldn't read (fail closed: the test can't pass). */
  mailtoUnreadable:
    "The test email's original offers unsubscribe by email, but the app can't read that address, so it can't check where those emails go. Paste the whole original again. If this stays, click Leave out unsubscribe by email below, or tell the person who set up the app.",
  // Leaving out unsubscribe by email (review REPLIES-03, the last resort; `leaveOutMailto`)
  leaveOutOffer:
    "Tried the catch-all and the aliases, and emails to the unsubscribe address still don't arrive? As a last resort, leave out unsubscribe by email: your emails then offer unsubscribing only by the link.",
  leaveOutButton: "Leave out unsubscribe by email",
  leaveOutTitle: "Leave out unsubscribe by email?",
  leaveOutBody:
    "Your emails will offer unsubscribing only by the link: the app sends its own List-Unsubscribe line with Mailgun's link and no email address. The reply test starts again for this: send the test emails, then paste the original of a new one. It passes only if that original shows the link and no mailto: address.",
  leaveOutConfirm: "Leave it out",
  leaveOutDone: "Unsubscribe by email is left out. Send the test emails again, then paste the original of a new one.",
  /** Shown while the choice is on (with the button that undoes it); also the verdict's note, never a failure. */
  leftOutNote: "Unsubscribe by email is left out: your emails offer unsubscribing only by the link.",
  leftOutSendAgain: "Send the test emails again, then paste the original of a new one: it must show the link and no mailto: address.",
  leftOutMailtoStill:
    "The test email's original still offers unsubscribe by email (mailto:). If that email was sent before you left it out, send the test emails again and paste the original of a new one. If a new one shows it too, click Offer unsubscribe by email again and tell the person who set up the app.",
  leftOutNoLink:
    "The test email's List-Unsubscribe line has no working link, so leaving out unsubscribe by email doesn't work with Mailgun. Click Offer unsubscribe by email again, then turn on a catch-all address or tell the person who set up the app.",
  offerAgainButton: "Offer unsubscribe by email again",
  offerAgainTitle: "Offer unsubscribe by email again?",
  offerAgainBody:
    "Mailgun's own List-Unsubscribe line comes back, with its mailto: address. The reply test starts again for this: send the test emails, paste the original of a new one and answer where an email to that address arrives.",
  offerAgainConfirm: "Offer it again",
  offerAgainDone: "Unsubscribe by email is offered again. Send the test emails again, then paste the original of a new one.",
  leaveOutActivity: (actorName: string, leaveOut: boolean): string =>
    leaveOut ? `${actorName} left out unsubscribe by email` : `${actorName} offered unsubscribe by email again`,
  leaveOutBusy: (names: string): string =>
    `Finish or cancel these test and live campaigns first, so all emails of a campaign unsubscribe the same way: ${names}.`,
  leaveOutNotOwn: "Only the own-mailbox setup has this choice. Open the reply test again.",
  // Review REPLIES-08: with 1 day of Mailgun logs, a report that fell into a gap never arrives.
  reportGone: (address: string): string =>
    `${address}: Mailgun's report for this test email is no longer available, so the app can't see that it arrived. Send the test emails again.`,
  unsubscribeGone:
    "Your unsubscribe click happened while the app couldn't read Mailgun's reports, so the app can't count it. In Settings › Deliverability, click Remove next to that test mailbox, then click the unsubscribe link in the test email again.",
  sectionFailed: (from: string): string => `The reply test didn't pass with the From address ${from}. The lines above say which check failed.`,
  passedRow: (when: string, from: string): string =>
    `The reply test passed${when} with the From address ${from}: test emails arrived, your replies reached ${from}, unsubscribing works, and the test email passed DMARC.`,
  failedRow: (from: string): string => `The reply test didn't pass with the From address ${from}.`,
  failedRowFix: "The reply test section says which check failed.",
  noFromRow: "Type your From address in Settings › Sending & Mailgun first.",
  // Pasted original lines (testOriginalTexts with ownMailbox)
  returnPathOwn: (rp: string): string =>
    `Return address: …@${rp}. Bounces that come later and automatic replies go to your own mailbox (or nowhere), not the app.`,
  returnPathElsewhere: (rp: string, d: string): string => `Return address: …@${rp}, not on ${d}. Tell the person who set up the app.`,
  linkHttps: "Unsubscribe link: https ✓",
  linkHttp: "Unsubscribe link: http. It works when clicked, but Gmail's and Yahoo's one-click unsubscribe button needs https (Mailgun's Foundation plan).",
  linkNone: "The original shows no unsubscribe link in its headers.",
  mailtoOwn: (mailto: string): string => `Unsubscribe by email goes to ${mailto}. The question below checks that it reaches a mailbox you read.`,
  mailtoNone: "Unsubscribe by email: not offered.",
  /** Review SECURITY-03: a mailto: is offered but its address couldn't be read (never "not offered"). */
  mailtoUnreadableLine: "Unsubscribe by email is offered, but the app can't read its address.",
} as const;
