import type { Prisma, SendMode } from "@/generated/prisma/client";
import { dbWrite, type DbOrTx } from "./db";

/**
 * The activity log records every change and who made it (actorId null = the system).
 * It drives the company timeline, the Activity page and "recent team activity".
 *
 * Types in use (keep this list up to date):
 *  company.created, company.updated, company.status, company.priority, company.notes,
 *  company.personalLine, company.deleted, company.restored, company.lists, company.tags,
 *  person.created, person.updated, person.deleted, person.unsubscribed,
 *  import.done, list.created, list.renamed, list.deleted,
 *  user.created, user.invited, user.joined, user.deactivated, user.reactivated, user.passwordReset,
 *  user.passwordChanged, user.ownershipTransferred, user.profile, user.replyInbox, user.senderAddress, auth.lockout,
 *  settings.updated, backup.done, backup.failed,
 *  email.sent, email.skipped, email.failed, email.delivered, email.bounced, email.complained, email.unsubscribed,
 *  email.duplicate,
 *  reply.received, reply.auto,
 *  campaign.created, campaign.renamed, campaign.deleted, campaign.audience, campaign.putBack, campaign.sender,
 *  campaign.template, campaign.launched, campaign.paused, campaign.resumed, campaign.finished, campaign.cancelled,
 *  campaign.recipientSkipped, campaign.emailRetried, campaign.emailEdited, campaign.reservationsExpired,
 *  template.created, template.updated, template.deleted, template.starred,
 *  Milestone 3 (Mailgun, M3-DESIGN §4.7):
 *  sending.paused, sending.resumed, sending.warmup, sending.capOverride, sending.modeChanged, sending.testList,
 *  mailgun.connected, mailgun.domainChanged, mailgun.keysRemoved, mailgun.settingsApplied, mailgun.routesSynced,
 *  mailgun.listsPulled, suppression.added, suppression.removed, test.sent, replyTest.decided, restore.checked
 *  (settings.updated also covers the Limits, Email footer and Deliverability pages and a teammate's daily limit,
 *  data.key "user.dailyCap")
 *  Milestone 4 (sequences and replies, M4-DESIGN §3.11; summaries come from @/core/replies/copy, never with dates):
 *  reply.received, reply.auto, reply.possible, reply.bounce, reply.unlinked (from the event lane, actor null),
 *  reply.confirmed, reply.linked, reply.answered, reply.notNeeded, reply.reopened (decisions, actor = who decided),
 *  followups.held, followups.released (the outage hold, no company; data.from/to render in the viewer's zone),
 *  company.status with data.automatic = true when a reply set the company Replied
 *  Milestone 5 (address checks and AI, M5-DESIGN §2.11, §3.10; the Activity page files verify.* and ai.* under
 *  "Companies & people"):
 *  verify.run            one per check run: "Ali checked 40 addresses for Germany Q4: 33 can be emailed, …" (actor = the
 *                        requester, campaign id for wizard runs; actor null for the re-check sweep's runs: "The app
 *                        checked 2 addresses: …"; nothing for Settings' "Test address checks")
 *  person.checked        a result that says don't email ("… doesn't exist; it's on the do-not-email list now", actor
 *                        null, from the commit) and every company-panel check ("Ali checked anna@firma.de: can be
 *                        emailed", actor = who clicked)
 *  ai.run                a drafting run started: "Ali asked Claude to draft lines for 30 companies (about $0.17)." (also
 *                        Regenerate and Try again for one company; "(practice copy, free)" there)
 *  ai.rejected           "Ali rejected an AI line" (an undone reject logs nothing)
 *  company.personalLine  also for AI lines: "Ali approved an AI line" / "Ali undid the AI line", data.source "ai" with
 *                        draftId and edited
 *  import.done           a missing-emails round trip (a file with a company_id column) says what it added:
 *                        "Ali imported claude.csv: 2 people added to 1 company, …"; company.updated per company that
 *                        got people, data.roundTrip true
 *  settings.updated      also: the Address checks card (one per changed setting, data {key, from, to}), the address
 *                        check key (data.key "verification.apiKey", never the key), "Arslan resumed address checks"
 *                        (data.key "checks.pause"), Settings › AI saves (data.key "anthropic.apiKey", "ai.model",
 *                        "ai.monthlyLimitUsd", "ai.prices") and "Arslan resumed AI drafting" (data.key "ai.pause")
 *  Milestone 6 (go live, backups, the rule settings, M6-DESIGN §7.3):
 *  sending.goLive        the one-way go-live switch, written only by goLive(): "Arslan went live on send.example.com"
 *                        (GO_LIVE_COPY.activity), data {at, domain, modeFrom, modeTo: "LIVE", capOverrideCleared} (today's
 *                        hand-set limit that going live removed, or null)
 *  mailgun.domainChanged data gains goLiveEnded: true when the new sending domain ended go-live (G8)
 *  settings.updated      also: "The 30-day rule" card, one per changed key with data {key, from, to}: data.key
 *                        "teamRule.days" ("Arslan set the 30-day rule to 21 days"), "reservations.pausedExpiryDays"
 *                        ("Arslan set paused campaigns to keep their companies for 10 days") and "sharedDomains.extra"
 *                        ("Arslan changed the shared email domains"); and the Settings › System Access switch, data.key
 *                        "remoteAccess.accessOff" ("Arslan turned off the Cloudflare Access check" / "… turned on …")
 *  Shared From address (SHARED-FROM-DESIGN §3.1, §7.6):
 *  mailgun.fromAddressChanged  "Save From address", written only by saveFromAddress (connect.ts): "Arslan set the From
 *                        address to contact@polygonparadise.com" / "Arslan changed the From address from a@x to b@x" /
 *                        "Arslan cleared the From address: each person's own address is the From again"; data {from, to,
 *                        goLiveEnded} (the saved addresses before and after, null = per-person mode)
 *  sending.goLive        data gains from (the shared From address at go-live, null in per-person mode) and
 *                        spamPlacementConfirmed: true when the Owner ticked the spam-placement box (F12)
 *  replyTest.decided     data gains from (the From address the decision belongs to, null = per-person); the summary adds
 *                        " with the From address …" in shared-From mode
 *  mailgun.domainChanged a region-only reconnect (same name, other region, F28) writes it too ("Arslan moved
 *                        mail.polygonparadise.com from the EU region to the US region"); data gains fromRegion, toRegion
 *  user.senderAddress    in shared-From mode the summary says "reply address" instead of "sending address" (§3.6)
 *  mailgun.keysRemoved   also "Remove the sending key" (Settings › Sending & Mailgun › Advanced, review SCREENS-01):
 *                        "Arslan removed the domain sending key", data {keys: ["sendingKey"]}; nothing when none was saved
 *  Own-mailbox mode (MAIN-DOMAIN-DESIGN §7.6; summaries come from @/core/sending/own-mailbox and @/core/mailgun/plan):
 *  company.markedReplied "They replied" (markRepliedByHand, open to everyone): "Arslan marked Acme Studio as replied" /
 *                        "Arslan marked Anna Berg (Acme Studio) as replied" (THEY_REPLIED_TEXTS.activity), data {personId,
 *                        stopped, statusFrom, statusTo, at, countsAsReply}
 *  company.status        also written by They replied when the status changes (Not contacted/Contacted → Replied, only
 *                        when the click counts as a real reply), data gains markedReplied: true
 *  sending.inboxChecked  "I've read contact@…" (markInboxChecked, open to everyone): "Arslan read
 *                        contact@polygonparadise.com (inbox and Spam)" (INBOX_CHECK_TEXTS.activity), data {from}
 *  mailgun.domainChanged data gains fromReplies, toReplies whenever own-mailbox mode is involved; a switch of "How the app
 *                        sends" on the same domain writes it too ("Arslan switched replies for polygonparadise.com to your
 *                        own mailbox", OWN_MAILBOX_TEXTS.switchedSummary)
 *  mailgun.connected     data gains replies ("own-mailbox") on an own-mailbox connect
 *  settings.updated      the retention activity (data.key "mailgun.retention") gains plan; when the plan changed (also
 *                        from the first own-mailbox connect, which sets Free) the summary names it: "Arslan set the Mailgun
 *                        plan to Free, with 1 day of event logs and 1 day of stored replies" (PLAN_TEXTS.planSummary)
 *  replyTest.decided     data gains replies ("own-mailbox") for a by-hand decision
 *  sending.goLive        data gains replies, ownMailboxConfirmed and httpLinksConfirmed in own-mailbox mode
 * The Activity page has no sending filter: sending.* and mailgun.* rows (sending.goLive too) show under "Everything".
 */
export type ActivityInput = {
  actorId: number | null;
  type: string;
  summary: string;
  companyId?: number | null;
  personId?: number | null;
  campaignId?: number | null;
  data?: Prisma.InputJsonValue;
  mode?: SendMode | null;
};

function toRow(a: ActivityInput) {
  return {
    actorId: a.actorId,
    type: a.type,
    summary: a.summary,
    companyId: a.companyId ?? null,
    personId: a.personId ?? null,
    campaignId: a.campaignId ?? null,
    data: a.data,
    mode: a.mode ?? null,
  };
}

/** Log inside an existing transaction (tx), or on its own (takes the write lock). */
export async function logActivity(a: ActivityInput, tx?: DbOrTx): Promise<void> {
  if (tx) {
    await tx.activityLog.create({ data: toRow(a) });
    return;
  }
  await dbWrite((c) => c.activityLog.create({ data: toRow(a) }));
}

export async function logActivities(items: ActivityInput[], tx?: DbOrTx): Promise<void> {
  if (items.length === 0) return;
  const data = items.map(toRow);
  if (tx) {
    await tx.activityLog.createMany({ data });
    return;
  }
  await dbWrite((c) => c.activityLog.createMany({ data }));
}
