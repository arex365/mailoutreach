import {
  buildChecklistRows,
  lastGoodMxOf,
  ownMxCause,
  signingDomainOf,
  type ChecklistFacts,
  type Fact,
  type FromDomainFacts,
  type MailgunDomainFact,
  type OwnMxCause,
  type RouteSenderFact,
} from "@/core/dns/checklist";
import { checkMatchesMode } from "@/core/dns/check-state";
import { dkimKeyBits, dkimPublicKey } from "@/core/dns/dkim";
import type { DnsLookup } from "@/core/dns/types";
import { WEBSITE_DOMAINS } from "@/core/sender-address";
import { safeZone } from "@/core/sending/capday";
import { domainOfAddress } from "@/core/sending/from-address";
import type { UnsubscribeTestSetting } from "@/core/setting-types";
import {
  parseDomainCheckState,
  parseMailgunSetupState,
  parsePauseState,
  parseTunnelState,
  parseUnsubscribeTest,
} from "@/core/system-state-parse";
import { STATE_KEYS, type DomainCheckState } from "@/core/system-state";
import { db } from "@/server/db";
import { isFakeMode } from "@/server/mailgun/base-url";
import { getMailgunContext, type MailgunContextResult } from "@/server/mailgun/context";
import { isMailgunError, plainMailgunError, wrongRegionText } from "@/server/mailgun/errors";
import { suppressionListsFor } from "@/server/mailgun/suppression-lookup";
import type { DomainInfo } from "@/server/mailgun/types";
import { publicUrl } from "@/server/env";
import { notifyOwner } from "@/server/notifications";
import { getSecret } from "@/server/secrets";
import { getSettings } from "@/server/settings";
import { setupFitsDomain } from "@/server/services/mailgun/apply-settings";
import { loadPlanLimits } from "@/server/services/mailgun/plan";
import { loadTeamFrom, type TeamFromState } from "@/server/services/mailgun/team-from";
import { pauseSending } from "@/server/services/sending/pause";
import { readTyped, shouldSendNotice, updateTyped } from "@/server/state-typed";
import { createDnsLookup, mailgunRecordsLookup } from "./dns-lookup";
import { gatherDnsFacts, gatherFromDomainFacts } from "./dns-facts";
import { checkPublicAddress } from "./tunnel";

/**
 * The domain check (Settings › Domain checklist, PLAN B6.8, B9, M3-DESIGN §4.4.7): reads (never changes) everything the
 * checklist shows — Mailgun's view of the domain and its records, both public resolvers, the tracking certificate,
 * tracking and spam settings, retention, webhooks, the signing key, the reply routes and whether Mailgun would forward
 * to each reply inbox, the sending queue and pauses, the monthly limit, remote access, the reply test and the domain's
 * age — and writes the rows to SystemState "domain.check". Runs as job "mailgun.checkDomain" every 6 hours, after a
 * send's 404, after connecting, and on "Check again". When Mailgun doesn't know the domain (404 after the client's one
 * retry), sending pauses with the wrong-region sentence.
 *
 * Shared From address (SHARED-FROM-DESIGN §5, F27): while a From address is saved, the check also reads the From
 * domain's own DNS (TXT/SPF, MX, DMARC; never a Mailgun call for it) into `facts.from`, and afterwards tells the Owner
 * about a red from-mx or from-spf row (notice keys "from-mx-bad", "from-spf-broken").
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §5; `loadTeamFrom().replies === "own-mailbox"`): `facts.from` is built for the
 * sending domain itself, whatever the From (its own DNS, DNS only), with the plan limits and the last good MX; the rows
 * are the own-mailbox list. Every stored check records the mode it was built for (`replies`, O36) and, in own-mailbox
 * mode, the last good MX (O10). A red from-mx row tells the Owner ("from-mx-bad", own-mailbox body); there is no
 * from-spf row in that mode.
 */

/** "Ask Mailgun to re-check the records" at most once a minute (PUT …/verify can answer 429). */
export const VERIFY_EVERY_MS = 60_000;

function mailgunFact<T>(err: unknown): Fact<T> {
  if (!isMailgunError(err)) return { ok: false, kind: "other", message: err instanceof Error ? err.message : String(err) };
  const kind = err.kind === "not-found" ? "not-found" : err.kind === "auth" ? "auth" : ["network", "timeout", "server", "rate-limited"].includes(err.kind) ? "unreachable" : "other";
  return { ok: false, kind, message: err.message };
}

async function settle<T>(p: Promise<T>): Promise<Fact<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return mailgunFact<T>(err);
  }
}

function domainFact(info: DomainInfo): MailgunDomainFact {
  return {
    state: info.state,
    isDisabled: info.isDisabled,
    disabledReason: info.disabled?.reason ?? info.disabled?.note ?? null,
    spamAction: info.spamAction,
    webPrefix: info.webPrefix,
    webScheme: info.webScheme,
    messageTtl: info.messageTtl,
    webhooksRedactPii: info.webhooksRedactPii,
    sending: info.sending,
    receiving: info.receiving,
  };
}

async function savedSigningKey(): Promise<string | null> {
  try {
    return (await getSecret("mailgun.webhookSigningKey"))?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The Owner notices of a bad From-domain row (SHARED-FROM-DESIGN §3.8, F27; type "system.mailgun", at most one per key
 * per 24 hours): "from-mx-bad" while the from-mx row is red because of the MX itself, "from-spf-broken" while the
 * from-spf row is red.
 */
export const FROM_DOMAIN_NOTICE_TEXTS = {
  mxTitle: (org: string): string => `Mail for ${org} goes to the wrong place`,
  mxBody: (org: string): string =>
    `${org}'s mail servers (MX) point to Mailgun or are missing, so your everyday email and forwarded replies can be lost. Live campaign emails wait until it's fixed. Open Settings › Domain checklist.`,
  /** Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.9): the sending domain itself is the Owner's mailbox domain. */
  mxBodyOwn: (d: string): string =>
    `${d}'s mail servers (MX) point to Mailgun or are missing, so your everyday email and the replies to your campaigns can be lost. Live campaign emails wait until it's fixed. Open Settings › Domain checklist.`,
  /**
   * Own-mailbox mode, the from-mx row red because of Cloudflare Email Routing (O10, review DOMAIN-8): the fix is in
   * Cloudflare, not at the DNS host, so the notice names it.
   */
  mxBodyOwnCloudflare: (d: string): string =>
    `Mail for ${d} goes to Cloudflare Email Routing instead of your mail provider, so your everyday email and the replies to your campaigns can be lost. Live campaign emails wait until it's fixed: switch Email Routing off in Cloudflare. Open Settings › Domain checklist.`,
  spfTitle: (org: string): string => `${org}'s SPF record is broken`,
  spfBody: (rowText: string): string => `${rowText} Open Settings › Domain checklist.`,
} as const;

/**
 * Shared-From mode (SHARED-FROM-DESIGN §5): the saved From address and its domain's own DNS (never a Mailgun call for
 * it). Null in per-person mode. A saved address that doesn't fit the sending domain gets `problem` and no DNS. The DKIM
 * fallback signer comes from the reply test's pasted original only when that original belongs to today's sending domain
 * and From address.
 */
async function fromDomainFacts(
  team: TeamFromState,
  domain: string,
  mailgun: Fact<MailgunDomainFact>,
  test: Pick<UnsubscribeTestSetting, "original">,
  lookups: readonly [DnsLookup, DnsLookup],
): Promise<FromDomainFacts | null> {
  if (!team.saved) return null;
  const address = team.address ?? team.saved;
  const fromDomain = domainOfAddress(address) ?? address;
  const o = test.original ?? null;
  const today =
    o !== null && team.address !== null && o.domain.trim().toLowerCase() === domain && o.from.trim().toLowerCase() === team.address ? o : null;
  return {
    address,
    domain: fromDomain,
    problem: team.problem,
    signingDomain: mailgun.ok ? signingDomainOf(mailgun.value) : null,
    originalSigner: today ? today.dkimSigner : null,
    originalPasted: today !== null,
    dns: team.problem || !team.address ? null : await gatherFromDomainFacts(fromDomain, lookups),
  };
}

/**
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §5): the "From domain" facts built for the sending domain itself, whatever the From
 * (saved, fitting or not; the from-mx row is built even with no From saved, O10). DNS only, as for a From domain. The
 * DKIM fallback signer comes from the pasted original only when it belongs to today's sending domain and evidence From.
 */
async function ownMailboxFacts(
  team: TeamFromState,
  domain: string,
  mailgun: Fact<MailgunDomainFact>,
  test: Pick<UnsubscribeTestSetting, "original">,
  lookups: readonly [DnsLookup, DnsLookup],
): Promise<FromDomainFacts> {
  const o = test.original ?? null;
  const today =
    o !== null && team.evidenceFrom !== null && o.domain.trim().toLowerCase() === domain && o.from.trim().toLowerCase() === team.evidenceFrom ? o : null;
  return {
    address: team.ownFrom ?? team.saved ?? "",
    domain,
    problem: null,
    signingDomain: mailgun.ok ? signingDomainOf(mailgun.value) : null,
    originalSigner: today ? today.dkimSigner : null,
    originalPasted: today !== null,
    // Review DOMAIN-1: both resolvers walk the SPF include tree, so a change only one of them sees is "still spreading".
    dns: await gatherFromDomainFacts(domain, lookups, { ownMailbox: true }),
  };
}

export type DomainCheckOptions = {
  now?: Date;
  verify?: boolean;
  lookups?: [DnsLookup, DnsLookup];
  mailgun?: () => Promise<MailgunContextResult>;
  fetchImpl?: typeof fetch;
};

/**
 * How many more times a check runs when the From address (or the sending domain) changed while it ran (review
 * SETTING-6). Two is plenty: each change is an Owner's click, and the last round writes whatever it found.
 */
export const FROM_CHANGE_RERUNS = 2;

/**
 * True when the From address setting, the sending domain or the way of sending (MAIN-DOMAIN-DESIGN O36) differs between
 * two reads (a save happened in between).
 */
function teamFromChanged(before: TeamFromState, after: TeamFromState): boolean {
  return (
    before.saved !== after.saved ||
    before.domain !== after.domain ||
    before.replies !== after.replies ||
    (before.changedAt?.getTime() ?? null) !== (after.changedAt?.getTime() ?? null)
  );
}

/**
 * Review DOMAIN-6: true when the saved sending domain or way of sending is no longer the one the round's Mailgun context
 * was loaded with (read before the Mailgun calls). Rows built then would describe the old domain in the new mode (an
 * own-mailbox from-mx row for an old Shape B subdomain, whose MX is Mailgun's), with a false notice.
 */
function contextMoved(ctx: { domain: string; replies?: string }, team: TeamFromState): boolean {
  return team.domain !== ctx.domain || team.replies !== (ctx.replies ?? "app");
}

/**
 * A round whose rows would belong to another domain or mode (review DOMAIN-6): it runs again, at most FROM_CHANGE_RERUNS
 * times; after that it writes nothing and tells nobody (the change queued a check of its own, which writes the rows) and
 * returns the stored state as it is.
 */
async function staleRound(opts: DomainCheckOptions, round: number, lastVerifyAt: string | null): Promise<DomainCheckState> {
  if (round < FROM_CHANGE_RERUNS) return runCheckRound(opts, round + 1, lastVerifyAt);
  return (await readTyped(STATE_KEYS.domainCheck, parseDomainCheckState)).value;
}

/**
 * Runs the whole check and writes "domain.check". `verify` also asks Mailgun to re-check the DNS records (at most once
 * a minute). `lookups` are the two resolvers (default 1.1.1.1 and 8.8.8.8; in fake mode Mailgun's own record list,
 * see mailgunRecordsLookup; tests inject a fake table). `fetchImpl` is
 * used for the public-address check when it has never run. Mailgun not connected → no rows and the reason as `error`.
 *
 * Review SETTING-6: the rows depend on the From address, read once in the middle of the check. When it changed by the
 * time the rows are ready (the Owner saved or cleared it meanwhile, or a domain change moved its change time), those
 * rows describe the old mode — a stale "bad" from-mx row would hold per-person LIVE emails — so they are never written:
 * the check runs again (at most FROM_CHANGE_RERUNS more times). `saveFromAddress` also queues one more check behind a
 * running one, for a save that lands between this last read and the write.
 */
export async function runDomainCheck(opts: DomainCheckOptions = {}): Promise<DomainCheckState> {
  return runCheckRound(opts, 0, null);
}

/** One round of runDomainCheck; `carriedVerifyAt` keeps an earlier round's "re-check the records" time (once a minute). */
async function runCheckRound(opts: DomainCheckOptions, round: number, carriedVerifyAt: string | null): Promise<DomainCheckState> {
  // Each round has its own time: a check that started before a From change must not look checked before it.
  const now = opts.now ?? new Date();
  const prev = (await readTyped(STATE_KEYS.domainCheck, parseDomainCheckState)).value;
  const ctx = await (opts.mailgun ?? getMailgunContext)();
  if (!ctx.connected) {
    const state: DomainCheckState = {
      domain: null,
      region: null,
      checkedAt: now.toISOString(),
      lastVerifyAt: prev.lastVerifyAt,
      rows: [],
      error: ctx.text,
      // O36: every stored check names its mode, so a reader of this mode still finds the reason (settings only).
      replies: (await loadTeamFrom()).replies,
    };
    await updateTyped(STATE_KEYS.domainCheck, parseDomainCheckState, () => state);
    return state;
  }
  const d = ctx.domain;
  const client = ctx.client;

  // Mailgun's view of the domain (optionally re-verified first).
  let lastVerifyAt = carriedVerifyAt ?? (prev.domain === d ? prev.lastVerifyAt : null);
  let verifyError: string | null = null;
  let info: Fact<DomainInfo> | null = null;
  if (opts.verify && (!lastVerifyAt || now.getTime() - Date.parse(lastVerifyAt) >= VERIFY_EVERY_MS)) {
    lastVerifyAt = now.toISOString();
    try {
      info = { ok: true, value: await client.verifyDomain(d) };
    } catch (err) {
      if (isMailgunError(err) && err.kind === "rate-limited") verifyError = "Mailgun asks to wait a minute before checking the records again.";
      else verifyError = isMailgunError(err) ? plainMailgunError(err, { domain: d, region: ctx.region }) : "Mailgun couldn't re-check the records.";
    }
  }
  info ??= await settle(client.getDomain(d));
  if (!info.ok && info.kind === "not-found") {
    await pauseSending({ kind: "mailgun-domain", reason: `Mailgun can't find ${d}`, fixText: wrongRegionText(d, ctx.region), now });
  }
  const mailgun: Fact<MailgunDomainFact> = info.ok ? { ok: true, value: domainFact(info.value) } : info;

  // Shared-From mode (SHARED-FROM-DESIGN §5): the saved From address; its domain's DNS is read below, never Mailgun.
  // Own-mailbox mode (MAIN-DOMAIN-DESIGN §5): the mode comes from the same read (§0.2 rule 5).
  const team = await loadTeamFrom();
  // Review DOMAIN-6: a mode switch or a new sending domain saved since the context was read (during the Mailgun calls
  // above): these rows would belong to the old domain in the new mode, so this round builds none.
  if (contextMoved(ctx, team)) return staleRound(opts, round, lastVerifyAt);
  const own = team.replies === "own-mailbox";
  const teamFromDomain = team.address ? domainOfAddress(team.address) : null;

  // Fake mode never asks the public resolvers about the fake's made-up records (M3-DESIGN §6.3), nor about the From
  // domain (a made-up mail provider answers for it; in own-mailbox mode for the sending domain itself).
  const fakeDns =
    !opts.lookups && ctx.fakeMode
      ? mailgunRecordsLookup(d, mailgun.ok ? mailgun.value : { sending: [], receiving: [] }, own ? { ownMailbox: true } : { fromDomain: teamFromDomain })
      : null;
  const lookups = opts.lookups ?? (fakeDns ? [fakeDns, fakeDns] : [createDnsLookup("1.1.1.1"), createDnsLookup("8.8.8.8")]);
  // O37, review DOMAIN-4: a website domain checked in app mode gets the own-mailbox SPF facts (both resolvers' walks and
  // the dangling includes), so its SPF row can name a lost `_spfm` helper instead of asking for Mailgun's include.
  const dns = mailgun.ok ? await gatherDnsFacts(d, mailgun.value, lookups, { everydaySpf: !own && WEBSITE_DOMAINS.has(d) }) : null;
  const certificate = mailgun.ok
    ? await settle(client.getCertificateStatus(`${mailgun.value.webPrefix}.${d}`))
    : ({ ok: false, kind: "other", message: "Mailgun's domain couldn't be read." } as const);
  const tracking = await settle(client.getTracking(d));
  const pub = publicUrl();
  const webhookUrl = pub ? `${pub.replace(/\/+$/, "")}/api/webhooks/mailgun/events` : null;
  const webhookMap = await settle(client.getWebhooks(d));

  // The signing key: GET only (a POST would regenerate it and break every webhook in flight).
  const saved = await savedSigningKey();
  let signingKey: ChecklistFacts["signingKey"];
  try {
    const mgKey = await client.getSigningKey();
    signingKey = { saved: saved !== null, matches: saved === null ? null : saved === mgKey, problem: null };
  } catch (err) {
    // 400 "could not get HSK for account": Mailgun has no key for this account yet (research §5).
    const missing = isMailgunError(err) && err.status === 400;
    signingKey = {
      saved: saved !== null,
      matches: null,
      problem: { kind: missing ? "missing-at-mailgun" : "unreachable", message: err instanceof Error ? err.message : String(err) },
    };
  }

  // Reply routes and whether Mailgun would forward to each inbox.
  const senderRows = await db.senderAddress.findMany({
    where: { domainId: ctx.domainId, retiredAt: null },
    orderBy: { id: "asc" },
    select: { address: true, routeStatus: true, routeError: true, forwardTo: true, user: { select: { name: true } } },
  });
  let lists = new Map<string, string[]>();
  let listsError: string | null = null;
  const inboxes = [...new Set(senderRows.map((s) => s.forwardTo).filter((x): x is string => Boolean(x)))];
  if (inboxes.length > 0) {
    try {
      lists = await suppressionListsFor(inboxes, ctx);
    } catch (err) {
      listsError = err instanceof Error ? err.message : String(err);
    }
  }
  const senders: RouteSenderFact[] = senderRows.map((s) => ({
    name: s.user.name,
    address: s.address,
    status: s.routeStatus,
    error: s.routeError,
    forwardTo: s.forwardTo,
    lists: s.forwardTo ? (lists.get(s.forwardTo.trim().toLowerCase()) ?? []) : [],
  }));
  const domainRow = await db.sendingDomain.findUnique({ where: { id: ctx.domainId }, select: { catchAllRouteId: true } });

  const queues = await settle(client.getSendingQueues(d));
  const monthlyLimit = await settle(client.getMonthlyLimit());

  const pauseState = (await readTyped(STATE_KEYS.pause, parsePauseState)).value;
  const pause = pauseState.paused
    ? [
        ...(pauseState.kind ? [{ kind: pauseState.kind, reason: pauseState.reason, fixText: pauseState.fixText }] : []),
        ...pauseState.also.map((a) => ({ kind: a.kind, reason: a.reason, fixText: "" })),
      ]
    : [];

  let tunnel = (await readTyped(STATE_KEYS.tunnel, parseTunnelState)).value;
  if (pub && !tunnel.publicCheck) {
    try {
      await checkPublicAddress({ now, fetchImpl: opts.fetchImpl });
      tunnel = (await readTyped(STATE_KEYS.tunnel, parseTunnelState)).value;
    } catch (err) {
      console.error("[domain-check] the public-address check failed", err);
    }
  }
  const setup = (await readTyped(STATE_KEYS.mailgunSetup, parseMailgunSetupState)).value;
  const s = await getSettings([
    "mailgun.unsubscribeTest",
    "mailgun.domainRegisteredOn",
    "mailgun.messageRetentionDays",
    "remoteAccess.accessOff",
  ] as const);
  const unsubscribeTest = parseUnsubscribeTest(s["mailgun.unsubscribeTest"]);
  const owner = await db.user.findFirst({ where: { role: "OWNER", active: true }, orderBy: { id: "asc" }, select: { timeZone: true } });
  const from = own ? await ownMailboxFacts(team, d, mailgun, unsubscribeTest, lookups) : await fromDomainFacts(team, d, mailgun, unsubscribeTest, lookups);
  // O10: the last good MX of an earlier own-mailbox check of this domain (another domain's or mode's is never used).
  const carriedMx = own && prev.domain === d && checkMatchesMode(prev, "own-mailbox") ? (prev.lastGoodMx ?? null) : null;

  const facts: ChecklistFacts = {
    domain: d,
    region: ctx.region,
    now,
    timeZone: safeZone(owner?.timeZone),
    mailgun,
    verifyError,
    dns,
    certificate,
    // A certificate Apply recorded for the old domain's host (a run that finished after a domain change) says nothing here.
    setupCertificate: setup.certificate && setupFitsDomain(setup, d) ? setup.certificate.status : null,
    tracking,
    unsubscribeSetup: unsubscribeTest.setup,
    messageRetentionDays: Math.max(1, Math.floor(Number(s["mailgun.messageRetentionDays"]) || 1)),
    webhooks: { url: webhookUrl, map: webhookMap },
    signingKey,
    routes: { senders, catchAllRouteId: domainRow?.catchAllRouteId ?? null, listsError },
    queues,
    pause,
    monthlyLimit,
    tunnel,
    publicUrl: pub,
    fakeMode: isFakeMode(),
    replyTest: {
      status: unsubscribeTest.status,
      setup: unsubscribeTest.setup,
      domain: unsubscribeTest.domain,
      decidedAt: unsubscribeTest.decidedAt,
      // The stored decision's From address; the row compares it with today's (facts.from, SHARED-FROM-DESIGN §3.2).
      from: unsubscribeTest.from ?? null,
      // The stored decision's mode (MAIN-DOMAIN-DESIGN O13): a pass counts only in the mode it was decided in.
      ...(unsubscribeTest.replies === "own-mailbox" ? { replies: "own-mailbox" as const } : {}),
    },
    domainRegisteredOn: typeof s["mailgun.domainRegisteredOn"] === "string" ? s["mailgun.domainRegisteredOn"] : null,
    // "We don't use Cloudflare Access" (M6-DESIGN §2.8): an open sign-in page is then fine for the remote-access row.
    accessOff: s["remoteAccess.accessOff"] === true,
    from,
    ...(own ? { ownMailbox: true, plan: await loadPlanLimits(), lastGoodMx: carriedMx } : {}),
  };

  // The DKIM key size, measured from Mailgun's own key (node:crypto).
  const txtKey = dns?.dkim.find((k) => k.recordType === "TXT");
  const p = txtKey ? dkimPublicKey(txtKey.expected) : null;
  const keyBits = p ? dkimKeyBits(p) : null;
  const rows = buildChecklistRows(facts, { keyBits: txtKey ? keyBits : null });

  // Review SETTING-6: rows built for a From address that changed meanwhile are never written; the check runs again.
  // Review DOMAIN-6: rows of a sending domain or mode that is no longer saved are never written, not even by the last
  // round, and send no notice (the change queued a check of its own).
  const after = await loadTeamFrom();
  if (contextMoved(ctx, after)) return staleRound(opts, round, lastVerifyAt);
  if (round < FROM_CHANGE_RERUNS && teamFromChanged(team, after)) {
    return runCheckRound(opts, round + 1, lastVerifyAt);
  }

  // O36: the rows belong to this way of sending. O10: an own-mailbox check whose from-mx row is ok remembers the MX it
  // saw; otherwise the earlier list of this domain and mode stays (an app-mode check stores none: the state is replaced).
  let lastGoodMx = carriedMx;
  if (own && rows.find((r) => r.key === "from-mx")?.status === "ok" && from?.dns) {
    const good = lastGoodMxOf(from.dns.mx);
    if (good.length > 0) lastGoodMx = good;
  }
  const state: DomainCheckState = {
    domain: d,
    region: ctx.region,
    checkedAt: now.toISOString(),
    lastVerifyAt,
    rows,
    error: null,
    replies: team.replies,
    ...(own ? { lastGoodMx } : {}),
  };
  await updateTyped(STATE_KEYS.domainCheck, parseDomainCheckState, () => state);

  if (certificate.ok && certificate.value.status === "expired" && (await shouldSendNotice("cert-expired", now))) {
    await notifyOwner({
      type: "system.mailgun",
      title: "Secure unsubscribe links stopped working",
      body: `Mailgun's certificate for ${mailgun.ok ? mailgun.value.webPrefix : "email"}.${d} has expired. Click Apply recommended settings in Settings › Domain checklist to renew it.`,
      link: "/settings/domain",
    });
  }
  if (own) await notifyOwnMailboxRows(d, rows, now, ownMxCause(from?.dns?.mx ?? dns?.mx ?? null));
  else if (from) await notifyFromDomainRows(from, rows, now);
  return state;
}

/**
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.9, §5): a red from-mx row (a Mailgun MX, a null or missing MX, or Cloudflare
 * Email Routing on the sending domain itself; live emails wait) tells the Owner at most once per 24 hours, with the
 * own-mailbox body; for Cloudflare Email Routing the body names it (`cause`, the row's own, review DOMAIN-8). No from-spf
 * row exists in this mode: the spf row is a gate, and Live mode and going live name it.
 */
async function notifyOwnMailboxRows(d: string, rows: ReturnType<typeof buildChecklistRows>, now: Date, cause: OwnMxCause | null): Promise<void> {
  const mx = rows.find((r) => r.key === "from-mx");
  if (mx?.status === "bad" && (await shouldSendNotice("from-mx-bad", now))) {
    await notifyOwner({
      type: "system.mailgun",
      title: FROM_DOMAIN_NOTICE_TEXTS.mxTitle(d),
      body: cause === "cloudflare" ? FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwnCloudflare(d) : FROM_DOMAIN_NOTICE_TEXTS.mxBodyOwn(d),
      link: "/settings/domain",
    });
  }
}

/**
 * F27: a red from-mx row (the From domain's MX points to Mailgun or is missing; live emails wait) and a broken from-spf
 * row tell the Owner, at most once per key per 24 hours. A saved From address that doesn't fit the sending domain also
 * turns from-mx red, but that isn't about the MX: TEST/LIVE launches refuse with their own sentence then.
 */
async function notifyFromDomainRows(from: FromDomainFacts, rows: ReturnType<typeof buildChecklistRows>, now: Date): Promise<void> {
  const org = from.domain;
  const mx = rows.find((r) => r.key === "from-mx");
  if (mx?.status === "bad" && !from.problem && (await shouldSendNotice("from-mx-bad", now))) {
    await notifyOwner({
      type: "system.mailgun",
      title: FROM_DOMAIN_NOTICE_TEXTS.mxTitle(org),
      body: FROM_DOMAIN_NOTICE_TEXTS.mxBody(org),
      link: "/settings/domain",
    });
  }
  const spf = rows.find((r) => r.key === "from-spf");
  if (spf?.status === "bad" && (await shouldSendNotice("from-spf-broken", now))) {
    await notifyOwner({
      type: "system.mailgun",
      title: FROM_DOMAIN_NOTICE_TEXTS.spfTitle(org),
      body: FROM_DOMAIN_NOTICE_TEXTS.spfBody(spf.text),
      link: "/settings/domain",
    });
  }
}
