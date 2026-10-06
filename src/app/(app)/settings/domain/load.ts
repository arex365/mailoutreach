import "server-only";
import { checkMatchesMode } from "@/core/dns/check-state";
import { isSafeForwardAddress, senderRouteSpec } from "@/core/mailgun/routes";
import { providerLabel, providerOf, REPLY_TEST_TEXTS, teamFromDomainOf, type MailboxFacts } from "@/core/reply-test";
import { TEAM_FROM_TEXTS } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS } from "@/core/sending/own-mailbox";
import { parseMailgunSetupState } from "@/core/system-state-parse";
import { STATE_KEYS, type ChecklistRow } from "@/core/system-state";
import { formatShortDate, timeAgo } from "@/core/time/format";
import type { SessionUser } from "@/lib/auth/session";
import { db } from "@/server/db";
import { EMPTY_SETUP_STATE, setupFitsDomain } from "@/server/services/mailgun/apply-settings";
import { SUPPRESSED_INBOX_PREFIX } from "@/server/services/mailgun/routes";
import { loadGateInputs, loadReplyTest } from "@/server/services/reply-test";
import { getSetting } from "@/server/settings";
import { readTyped } from "@/server/state-typed";
import type { ReplyTestMailboxView, ReplyTestView, SenderRouteView, SetupStepView } from "@/components/settings/types";

/**
 * Everything Settings › Domain checklist (M3-DESIGN §5.3) shows: the rows the domain check (P4) wrote for the current
 * domain, the last Apply run, each sender's reply route with its exact values, the optional domain age and the reply
 * test. Worded and formatted in the viewer's time zone.
 *
 * Shared From address (SHARED-FROM-DESIGN §3.2, §3.4): the header's second line ("Emails show From … and go out
 * through …"), the domain age asked for the From domain, "reply address" words, and the reply test in shared-From mode
 * (its questions, the pasted original, the spam warnings, a result shown only for today's domain and From).
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.3, §3.5; `gate.replies`): the header's second line
 * (`OWN_MAILBOX_TEXTS.checklistLine`, also before a From is saved), the own-mailbox Apply hint, every stored row of this
 * mode (the from-mx guard shows with no From saved: the app-mode filter below doesn't apply), rows of the other mode
 * treated as not checked, no reply routes, the domain age for the sending domain, and the by-hand reply test (its
 * questions, the pasted original, the unsubscribe-by-email question with the original's `mailto:` address).
 */

export type DomainPageData =
  | { state: "practice" }
  | { state: "not-connected"; text: string }
  | {
      state: "connected";
      domain: string;
      region: "EU" | "US";
      headerLine: string;
      /** Shared-From mode: "Emails show From contact@… and go out through mail.…" (the header's second line); else null. */
      headerFromLine: string | null;
      /** Checked less than a minute ago: "Check again" starts disabled. */
      checkedRecently: boolean;
      rows: ChecklistRow[];
      setupLine: string | null;
      steps: SetupStepView[];
      applyJobId: number | null;
      senders: SenderRouteView[];
      domainRegisteredOn: string | null;
      /** The domain the Domain age row asks about: the From domain in shared-From mode, else the sending domain. */
      ageDomain: string;
      /** A shared From address is saved and fits (the "reply address" words). */
      teamFrom: boolean;
      replyTest: ReplyTestView;
      /** MAIN-DOMAIN-DESIGN §3.3: own-mailbox mode (its Apply hint, no reply routes). Absent = app mode. */
      ownMailbox?: boolean;
      /** The "Recommended settings" card's description (`applyHintFor`). */
      applyHint: string;
    };

/** The "Recommended settings" card's description in app mode (what Apply does). */
export const APPLY_HINT =
  "Switches off open and click tracking, switches on Mailgun's unsubscribe handling with blank footers, marks spam instead of deleting it, keeps stored replies for your plan's time, sets up secure unsubscribe links, the webhooks and the reply routes.";

/** The card's description: own-mailbox mode's Apply changes nothing about receiving mail (MAIN-DOMAIN-DESIGN §3.3). */
export function applyHintFor(ownMailbox: boolean): string {
  return ownMailbox ? OWN_MAILBOX_TEXTS.applyHint : APPLY_HINT;
}

/**
 * The stored rows the page shows. Review SECURITY-3: the From-domain rows exist only in shared-From mode, so in app mode
 * one a check stored just before the From address was cleared isn't shown (the check queued by the change drops it).
 * MAIN-DOMAIN-DESIGN O10: in own-mailbox mode the from-mx guard shows whether or not a From is saved, so that filter is
 * app mode's only.
 */
export function checklistRowsShown(rows: ChecklistRow[], ctx: { ownMailbox: boolean; fromSaved: boolean }): ChecklistRow[] {
  if (ctx.ownMailbox || ctx.fromSaved) return rows;
  return rows.filter((r) => r.key !== "from-mx" && r.key !== "from-spf");
}

function testEmailText(f: MailboxFacts | undefined): string {
  if (f?.olderSent && !f.testSendId) return REPLY_TEST_TEXTS.notSentWithThisFrom;
  if (!f || !f.testSendId) return "Not sent yet";
  // Review REPLIES-08 (own-mailbox mode): the report fell outside the logs the app can read, so waiting can't help.
  if (f.reportGone === true && !f.delivered) return "Sent, but Mailgun's report is gone: send the test emails again";
  switch (f.status) {
    case "SENDING":
      return "Sending…";
    case "UNKNOWN":
      return "Not sure it was sent";
    case "FAILED":
      return f.error ? `Didn't send: ${f.error}` : "Didn't send";
    default:
      return f.delivered ? "Delivered" : "Sent, waiting for delivery";
  }
}

/** The page's data, for the signed-in Owner. */
export async function loadDomainPage(user: SessionUser, now: Date = new Date()): Promise<DomainPageData> {
  const gate = await loadGateInputs(now);
  if (gate.practiceCopy) return { state: "practice" };
  if (!gate.domain || !gate.connected) {
    return { state: "not-connected", text: "Connect Mailgun first. Open Sending & Mailgun, choose the region and paste your API key." };
  }
  const zone = user.timeZone;
  const domain = gate.domain;
  const own = gate.replies === "own-mailbox";
  // A check of another domain, or (O36) of the other way of sending, counts as "not checked yet".
  const checkedAt = gate.check.domain === domain && checkMatchesMode(gate.check, gate.replies) ? gate.check.checkedAt : null;
  const headerLine = `Domain checklist for ${domain} (${gate.region}) · ${checkedAt ? `checked ${timeAgo(checkedAt, now)}` : "not checked yet"}`;

  const stored = (await readTyped(STATE_KEYS.mailgunSetup, parseMailgunSetupState)).value;
  // A run for the old domain (one that finished after a domain change) isn't shown as this domain's.
  const setup = setupFitsDomain(stored, domain) ? stored : EMPTY_SETUP_STATE;
  const by = setup.byUserId ? await db.user.findUnique({ where: { id: setup.byUserId }, select: { name: true } }) : null;
  const applyJob = await db.job.findFirst({
    where: { type: "mailgun.applySettings", status: { in: ["QUEUED", "RUNNING"] }, activeDedupeKey: "mailgun:apply" },
    orderBy: { id: "desc" },
    select: { id: true },
  });

  // Reply routes: each current sending address on this domain (none in own-mailbox mode, O8, O9).
  const domainRow = own ? null : await db.sendingDomain.findUnique({ where: { name: domain }, select: { id: true } });
  const addressRows = domainRow
    ? await db.senderAddress.findMany({
        where: { domainId: domainRow.id, retiredAt: null },
        orderBy: { id: "asc" },
        select: {
          id: true,
          address: true,
          forwardTo: true,
          routeStatus: true,
          routeError: true,
          user: { select: { name: true, active: true, replyInbox: true, email: true } },
        },
      })
    : [];
  const domainNames = (await db.sendingDomain.findMany({ select: { name: true } })).map((d) => d.name);
  const notifyUrl = gate.publicUrl ? `${gate.publicUrl}/api/webhooks/mailgun/inbound` : null;
  const senders: SenderRouteView[] = addressRows.map((a) => {
    const forwardTo = a.forwardTo ?? (a.user.active ? (a.user.replyInbox || a.user.email).toLowerCase() : gate.owner?.inbox ?? null);
    const status = a.routeStatus === "ok" ? "ok" : a.routeStatus === "error" || a.routeStatus === "mismatch" ? "bad" : "pending";
    const suppressed = Boolean(a.routeError?.startsWith(SUPPRESSED_INBOX_PREFIX));
    const spec =
      forwardTo && notifyUrl && isSafeForwardAddress(forwardTo, domainNames)
        ? senderRouteSpec({ senderAddressId: a.id, address: a.address, forwardTo, notifyUrl })
        : null;
    return {
      name: a.user.name,
      address: a.address,
      forwardTo,
      status,
      statusText: status === "ok" ? "Working" : status === "pending" ? "Being set up…" : (a.routeError ?? "Not working."),
      removeHref: suppressed && forwardTo ? `/settings/deliverability?q=${encodeURIComponent(forwardTo)}` : null,
      values: spec ? { expression: spec.expression, actions: spec.actions, priority: spec.priority, description: spec.description } : null,
    };
  });

  // The reply test.
  const rt = await loadReplyTest(now, gate);
  const teamFrom = rt.teamFrom;
  // Own-mailbox mode (§3.5): the own From the by-hand test runs with (null while none fits).
  const ownFrom = own ? rt.evidenceFrom : null;
  const answers = new Map(rt.setting.mailboxes.map((m) => [m.address.toLowerCase(), m]));
  const mailboxes: ReplyTestMailboxView[] = rt.testList.map((address) => {
    const f = rt.facts.get(address);
    const a = answers.get(address);
    const base: ReplyTestMailboxView = {
      address,
      providerLabel: providerLabel(providerOf(address)),
      testEmail: testEmailText(f),
      delivered: f?.delivered ?? false,
      replyStored: f?.replyStored ?? false,
      inboxOk: a?.inboxOk ?? null,
      authOk: a?.authOk ?? null,
      authFromHeaders: a?.authFromHeaders ?? false,
    };
    // Shared-From and own-mailbox modes: the placement and DMARC answers (per-person views keep today's shape).
    return teamFrom || own
      ? { ...base, placementOk: a?.placementOk ?? null, dmarcOk: a?.dmarcOk ?? null, dmarcFromHeaders: a?.dmarcFromHeaders ?? false }
      : base;
  });
  const decidedDate = rt.decided?.at ? formatShortDate(rt.decided.at, zone, now) : null;
  const on = decidedDate ? ` on ${decidedDate}` : "";
  const decidedText = (status: "passed" | "failed"): string => {
    // Own-mailbox mode (§3.3, §3.5): the reply-test row's words, never "Setup A".
    if (own) return status === "passed" ? OWN_REPLY_TEST_TEXTS.passedRow(on, ownFrom ?? "") : OWN_REPLY_TEST_TEXTS.failedRow(ownFrom ?? "");
    if (teamFrom) {
      return status === "passed"
        ? `Setup ${rt.setting.setup} passed${on} with the From address ${teamFrom}: replies arrive in your inbox, unsubscribe links work, and the test email passed DMARC.`
        : `Setup ${rt.setting.setup} didn't pass${on} with the From address ${teamFrom}. Live campaigns stay locked.`;
    }
    return status === "passed"
      ? `Setup ${rt.setting.setup} passed${on}: replies arrive in your inbox, and unsubscribe links work.`
      : `Setup ${rt.setting.setup} failed${on}. Live campaigns stay locked.`;
  };
  const decided = rt.decided ? { status: rt.decided.status, text: decidedText(rt.decided.status) } : null;
  const replyJob = await db.job.findFirst({
    where: { type: "send.testEmail", status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { id: "desc" },
    select: { id: true },
  });

  const replyTest: ReplyTestView = {
    domain,
    setup: rt.setting.setup,
    decided,
    blockers: rt.blockers,
    testList: rt.testList,
    mailboxes,
    headersOk: rt.setting.headersOk,
    unsubscribeSeen: rt.unsubscribeSeen,
    verdict: { status: rt.verdict.status, missing: rt.verdict.missing },
    ownerAddress: rt.ownerAddress,
    runningJobId: replyJob?.id ?? null,
    ...(teamFrom
      ? { teamFrom, original: rt.original, warnings: rt.verdict.warnings ?? [], roundSince: gate.teamFromChangedAt?.toISOString() ?? null }
      : {}),
    ...(own
      ? {
          ownFrom,
          original: rt.original,
          warnings: rt.verdict.warnings ?? [],
          roundSince: gate.teamFromChangedAt?.toISOString() ?? null,
          mailtoAddress: rt.original?.mailtoAddress ?? null,
          mailtoArrived: rt.setting.mailtoArrived ?? null,
          mailtoLeftOut: rt.setting.leaveOutMailto === true,
        }
      : {}),
  };

  return {
    state: "connected",
    domain,
    region: gate.region,
    headerLine,
    headerFromLine: own ? OWN_MAILBOX_TEXTS.checklistLine(ownFrom, domain) : teamFrom ? TEAM_FROM_TEXTS.checklistLine(teamFrom, domain) : null,
    checkedRecently: checkedAt !== null && now.getTime() - Date.parse(checkedAt) < 60_000,
    rows: checklistRowsShown(gate.rows, { ownMailbox: own, fromSaved: gate.teamFromSaved !== null }),
    applyHint: applyHintFor(own),
    setupLine: setup.runAt ? `Last applied ${timeAgo(setup.runAt, now)} by ${by?.name ?? "the app"}.` : null,
    steps: setup.steps.map((s) => ({ key: s.key, ok: s.ok, text: s.text, detail: s.detail })),
    applyJobId: applyJob?.id ?? null,
    senders,
    domainRegisteredOn: await getSetting("mailgun.domainRegisteredOn"),
    ageDomain: teamFromDomainOf(teamFrom) ?? domain,
    teamFrom: teamFrom !== null,
    replyTest,
    ...(own ? { ownMailbox: true } : {}),
  };
}
