import crypto from "node:crypto";
import { normalizeEmail } from "@/core/email-address";
import {
  catchAllRouteSpec,
  dmarcRouteSpec,
  isSafeForwardAddress,
  parseRouteDescription,
  publicAddressProblem,
  routeCheckAddress,
  sameRoute,
  senderRouteSpec,
  sendingDomainOf,
  type RouteSpec,
} from "@/core/mailgun/routes";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { logActivity } from "../../activity";
import { db, dbWrite } from "../../db";
import { publicUrl } from "../../env";
import { PlainJobError, redactText, type JobHandler } from "../../jobs";
import { getMailgunContext, mailgunSecrets, type MailgunContext, type MailgunContextResult } from "../../mailgun/context";
import { isMailgunError, plainMailgunError } from "../../mailgun/errors";
import { suppressionListsFor } from "../../mailgun/suppression-lookup";
import type { MailgunRoute, SuppressionList } from "../../mailgun/types";
import { notifyOwner } from "../../notifications";
import { shouldSendNotice } from "../../state-typed";
import { loadTeamFrom } from "./team-from";

/**
 * Reply routes in Mailgun (PLAN B6.10, M3-DESIGN §4.5.4): one per sender address (retired ones keep theirs), a catch-all
 * and a dmarc@ route per sending domain, all recognised by their "outreach-app:" description. The sync creates what is
 * missing, PUTs what changed (every field), deletes the app's routes that no address needs any more, then asks Mailgun's
 * `/routes/match` which route really catches each address.
 *
 * `SenderAddress.routeStatus` ("pending" | "ok" | "mismatch" | "error") decides whether LIVE emails from that address
 * may go out (§4.3.2), so a sync never makes a working route look broken:
 *  - a route that was "ok" stays "ok" while the sync runs and after one failed Mailgun call;
 *  - "mismatch" only after a verified `/match` answer names another route;
 *  - "error" only after a definite failure (a 4xx, a reply inbox that would loop or that Mailgun won't forward to, or
 *    Mailgun not answering on 3 syncs in a row);
 *  - a new address starts "pending" and turns "ok" after its verified match; until then the sync doesn't count as done
 *    (a problem is reported and the job tries again).
 */

export type SyncRoutesResult = {
  ok: boolean;
  created: number;
  updated: number;
  deleted: number;
  /** Plain sentences, one per problem. */
  problems: string[];
  /** Senders with a route on the active domain (for "Reply routes are set up for 3 senders"). */
  senders: number;
  /** Mailgun not answering, or /match not finding a new route yet, stood in the way: trying again later may work. */
  retryable: boolean;
};

/** "Another Mailgun route catches <address> first. …" (a verified /match named another route). */
export function routeMismatchText(address: string): string {
  return `Another Mailgun route catches ${address} first. In Mailgun, open Receiving › Routes and delete routes you don't recognise for this domain.`;
}

/** "Replies to <address> would loop: its reply inbox is on the sending domain. …" */
export function routeLoopText(address: string): string {
  return `Replies to ${address} would loop: its reply inbox is on the sending domain. Change the reply inbox in Settings › My profile.`;
}

const LIST_NAMES: Record<SuppressionList, string> = { bounces: "bounce", complaints: "complaint", unsubscribes: "unsubscribe" };

/** "Mailgun won't forward replies to <inbox>: it's on Mailgun's bounce list." (or the app's do-not-email list). */
export function suppressedInboxText(inbox: string, lists: ReadonlyArray<"local" | SuppressionList>): string {
  const mailgun = lists.find((l): l is SuppressionList => l !== "local");
  return mailgun
    ? `Mailgun won't forward replies to ${inbox}: it's on Mailgun's ${LIST_NAMES[mailgun]} list.`
    : `Mailgun won't forward replies to ${inbox}: it's on the do-not-email list.`;
}

/** Start of every "won't forward" route error, so pages can offer "Remove it" next to it. */
export const SUPPRESSED_INBOX_PREFIX = "Mailgun won't forward replies to ";

/**
 * Mailgun didn't answer (timeouts, network, 5xx) on this many syncs in a row → the route turns "error". Counted per
 * sender address in this process (the worker runs every sync); a restart simply starts counting again.
 */
export const TRANSIENT_FAILURES_BEFORE_ERROR = 3;
const transientFailures = new Map<number, number>();

/** For tests: forget the in-process failure counts. */
export function resetRouteFailureCounts(): void {
  transientFailures.clear();
}

function isDefinite(err: unknown): boolean {
  return isMailgunError(err) && err.status !== null && err.status >= 400 && err.status < 500 && err.status !== 429;
}

function plain(err: unknown, ctx: MailgunContext): string {
  if (isMailgunError(err)) return plainMailgunError(err, { domain: ctx.domain, region: ctx.region });
  return "Something unexpected went wrong while setting up the reply routes. Try again.";
}

type AddressRow = {
  id: number;
  address: string;
  domainId: number;
  retiredAt: Date | null;
  routeStatus: string | null;
  mailgunRouteId: string | null;
  user: { id: number; name: string; active: boolean; replyInbox: string | null; email: string };
};

type Plan = {
  row: AddressRow;
  forwardTo: string | null;
  spec: RouteSpec | null;
  routeId: string | null;
  /** A definite problem: the route is "error" with this text. */
  error: string | null;
  /** The verified `/match` result: "ok", "mismatch" or null (not verified this time). */
  verified: "ok" | "mismatch" | null;
};

/**
 * Syncs every reply route with Mailgun and records the result on each SenderAddress (see the file comment). Needs a
 * connected Mailgun and a public address (the same guard as Apply: https, or http://127.0.0.1 in fake mode), because
 * each route stores the reply and notifies `<APP_PUBLIC_URL>/api/webhooks/mailgun/inbound`. Never throws for Mailgun
 * problems: they come back as plain sentences in `problems`.
 */
export async function syncRoutes(
  opts: { now?: Date; mailgun?: () => Promise<MailgunContextResult>; byUserId?: number | null } = {},
): Promise<SyncRoutesResult> {
  const now = opts.now ?? new Date();
  const result: SyncRoutesResult = { ok: false, created: 0, updated: 0, deleted: 0, problems: [], senders: 0, retryable: false };

  let ctxResult: MailgunContextResult;
  try {
    ctxResult = await (opts.mailgun ?? (() => getMailgunContext()))();
  } catch (err) {
    result.problems.push(err instanceof Error ? err.message : "Mailgun isn't connected yet. Open Settings › Sending & Mailgun.");
    return result;
  }
  if (!ctxResult.connected) {
    result.problems.push(ctxResult.text);
    return result;
  }
  const ctx = ctxResult;
  // MAIN-DOMAIN-DESIGN O8 (§0.2 rule 8): no Mailgun route in own-mailbox mode. This is the one door, so it creates,
  // updates and deletes nothing, asks Mailgun nothing and writes no route status; routes of older domains stay as they are.
  if (ctx.replies === "own-mailbox") {
    return { ok: true, created: 0, updated: 0, deleted: 0, problems: [], senders: 0, retryable: false };
  }
  const pub = publicUrl();
  const pubProblem = publicAddressProblem(pub, ctx.fakeMode);
  if (pubProblem) {
    result.problems.push(pubProblem);
    return result;
  }
  const notifyUrl = `${pub!.replace(/\/+$/, "")}/api/webhooks/mailgun/inbound`;

  // ── what the app has ──
  const domains = await db.sendingDomain.findMany({
    select: { id: true, name: true, catchAllRouteId: true, dmarcRouteId: true },
    orderBy: { id: "asc" },
  });
  const domainNames = domains.map((d) => d.name);
  const owner = await db.user.findFirst({
    where: { role: "OWNER", active: true },
    orderBy: { id: "asc" },
    select: { id: true, name: true, email: true, replyInbox: true },
  });
  const ownerInbox = owner ? normalizeEmail(owner.replyInbox || owner.email) : null;
  const rows: AddressRow[] = await db.senderAddress.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      address: true,
      domainId: true,
      retiredAt: true,
      routeStatus: true,
      mailgunRouteId: true,
      user: { select: { id: true, name: true, active: true, replyInbox: true, email: true } },
    },
  });
  const current = rows.filter((r) => r.domainId === ctx.domainId && !r.retiredAt);

  // ── what Mailgun has ──
  let routes: MailgunRoute[];
  try {
    routes = await ctx.client.listRoutes();
  } catch (err) {
    await recordUnreachable(current, err, ctx, now, result);
    return result;
  }
  const ours = new Map<string, MailgunRoute[]>();
  for (const r of routes) {
    if (!parseRouteDescription(r.description)) continue;
    const list = ours.get(r.description) ?? [];
    list.push(r);
    ours.set(r.description, list);
  }

  // ── what each address needs ──
  const plans: Plan[] = rows.map((row) => {
    const inbox = row.user.active ? row.user.replyInbox || row.user.email : ownerInbox;
    const forwardTo = inbox ? (normalizeEmail(inbox) ?? inbox.trim()) : null;
    const plan: Plan = { row, forwardTo, spec: null, routeId: row.mailgunRouteId, error: null, verified: null };
    if (!forwardTo) {
      plan.error = `Replies to ${row.address} have nowhere to go: there's no active Owner with a reply inbox.`;
    } else if (!isSafeForwardAddress(forwardTo, domainNames)) {
      plan.error = sendingDomainOf(forwardTo, domainNames)
        ? routeLoopText(row.address)
        : `Replies to ${row.address} can't be forwarded to ${forwardTo}. Use a plain address, such as ali@gmail.com, as the reply inbox in Settings › My profile.`;
    } else {
      plan.spec = senderRouteSpec({ senderAddressId: row.id, address: row.address, forwardTo, notifyUrl });
    }
    return plan;
  });

  // Mailgun doesn't forward to an address on its own lists (nor should the app to one on the do-not-email list).
  const inboxes = [...new Set([...plans.filter((p) => p.spec).map((p) => p.forwardTo!), ...(ownerInbox ? [ownerInbox] : [])])];
  let listed = new Map<string, Array<"local" | SuppressionList>>();
  try {
    listed = await suppressionListsFor(inboxes, ctx);
  } catch (err) {
    result.problems.push(`Couldn't check whether Mailgun forwards to your team's inboxes right now (${plain(err, ctx)})`);
    result.retryable = true;
  }
  const suppressed = new Map<string, Array<"local" | SuppressionList>>();
  for (const [inbox, lists] of listed) if (lists.length > 0) suppressed.set(inbox, lists);

  // ── sender routes ──
  const usedRouteIds = new Set<string>();
  for (const plan of plans) {
    const desc = `outreach-app:sender:${plan.row.id}`;
    const existing = ours.get(desc) ?? [];
    let route: MailgunRoute | null = existing[0] ?? null;
    for (const extra of existing.slice(1)) await deleteQuietly(ctx, extra.id, result);

    if (!plan.spec) {
      // No route for an inbox that would loop: remove the app's route so replies can't circle.
      if (route) await deleteQuietly(ctx, route.id, result);
      plan.routeId = null;
      continue;
    }
    try {
      if (!route) {
        route = await ctx.client.createRoute(plan.spec);
        result.created++;
      } else if (!sameRoute(route, plan.spec)) {
        try {
          route = await ctx.client.updateRoute(route.id, plan.spec);
          result.updated++;
        } catch (err) {
          if (!(isMailgunError(err) && err.status === 404)) throw err;
          route = await ctx.client.createRoute(plan.spec);
          result.created++;
        }
      }
      plan.routeId = route.id;
      usedRouteIds.add(route.id);
      transientFailures.delete(plan.row.id);
    } catch (err) {
      if (route) usedRouteIds.add(route.id);
      noteFailure(plan, err, ctx, result);
    }
    const lists = plan.forwardTo ? suppressed.get(plan.forwardTo) : undefined;
    if (lists && !plan.error) plan.error = suppressedInboxText(plan.forwardTo!, lists);
  }

  // ── orphans: the app's sender routes no address needs any more ──
  const knownIds = new Set(rows.map((r) => r.id));
  for (const [desc, list] of ours) {
    const parsed = parseRouteDescription(desc);
    if (parsed?.kind !== "sender" || knownIds.has(parsed.senderAddressId)) continue;
    for (const r of list) if (!usedRouteIds.has(r.id)) await deleteQuietly(ctx, r.id, result);
  }

  // ── catch-all and dmarc@ per sending domain ──
  const domainRouteIds = new Map<number, { catchAll: string | null; dmarc: string | null }>();
  const ownerSafe = ownerInbox !== null && isSafeForwardAddress(ownerInbox, domainNames);
  if (!ownerSafe) {
    result.problems.push(
      ownerInbox
        ? `The catch-all route can't forward to your reply inbox (${ownerInbox}): it's on the sending domain. Change it in Settings › My profile.`
        : "The catch-all route needs an Owner with a reply inbox.",
    );
  } else if (suppressed.has(ownerInbox)) {
    result.problems.push(suppressedInboxText(ownerInbox, suppressed.get(ownerInbox)!));
  }
  for (const d of domains) {
    const isActive = d.id === ctx.domainId;
    const ids = { catchAll: d.catchAllRouteId, dmarc: d.dmarcRouteId };
    for (const kind of ["catchall", "dmarc"] as const) {
      const spec =
        kind === "catchall"
          ? catchAllRouteSpec({ domain: d.name, forwardTo: ownerInbox ?? "", notifyUrl })
          : dmarcRouteSpec({ domain: d.name, forwardTo: ownerInbox ?? "" });
      const existing = ours.get(spec.description) ?? [];
      let route: MailgunRoute | null = existing[0] ?? null;
      for (const extra of existing.slice(1)) await deleteQuietly(ctx, extra.id, result);
      // Older domains keep (and update) the routes they have; only the active domain gets new ones.
      if (!ownerSafe || (!route && !isActive)) {
        if (kind === "catchall") ids.catchAll = route?.id ?? null;
        else ids.dmarc = route?.id ?? null;
        continue;
      }
      try {
        if (!route) {
          route = await ctx.client.createRoute(spec);
          result.created++;
        } else if (!sameRoute(route, spec)) {
          try {
            route = await ctx.client.updateRoute(route.id, spec);
            result.updated++;
          } catch (err) {
            if (!(isMailgunError(err) && err.status === 404)) throw err;
            route = await ctx.client.createRoute(spec);
            result.created++;
          }
        }
      } catch (err) {
        result.problems.push(
          `Couldn't set up the ${kind === "catchall" ? "catch-all" : "dmarc@"} route for ${d.name}: ${plain(err, ctx)}`,
        );
        if (!isDefinite(err)) result.retryable = true;
      }
      if (kind === "catchall") ids.catchAll = route?.id ?? null;
      else ids.dmarc = route?.id ?? null;
    }
    domainRouteIds.set(d.id, ids);
  }
  // The app's catch-all/dmarc routes for domains the app no longer knows.
  const knownDomains = new Set(domainNames);
  for (const [desc, list] of ours) {
    const parsed = parseRouteDescription(desc);
    if (!parsed || parsed.kind === "sender" || knownDomains.has(parsed.domain)) continue;
    for (const r of list) await deleteQuietly(ctx, r.id, result);
  }

  // ── verify with /routes/match (active domain) ──
  for (const plan of plans) {
    if (plan.row.domainId !== ctx.domainId || plan.row.retiredAt || !plan.routeId || !plan.spec) continue;
    let confirmed = false;
    let definite: unknown = null;
    try {
      const m = await ctx.client.matchRoute(plan.row.address);
      if (m && m.id === plan.routeId) plan.verified = "ok";
      else if (m) plan.verified = "mismatch";
      // No answer from /match (yet): a route Mailgun just created can take a moment to be found.
      if (!m) result.retryable = true;
      confirmed = m !== null;
    } catch (err) {
      if (isDefinite(err)) definite = err;
      else result.retryable = true;
    }
    // A route that already worked stays "ok" through one unanswered check. One that isn't confirmed yet keeps the sync
    // from counting as done, so the job tries again and Apply doesn't show it as set up.
    if (!confirmed && plan.row.routeStatus !== "ok" && !plan.error) {
      result.problems.push(
        definite ? `Couldn't confirm the reply route for ${plan.row.address}: ${plain(definite, ctx)}` : routeUnconfirmedText(plan.row.address),
      );
    }
  }
  const active = domainRouteIds.get(ctx.domainId);
  if (active && ownerSafe) {
    const stored = domains.find((d) => d.id === ctx.domainId);
    await verifyDomainRoute(
      ctx,
      routeCheckAddress(ctx.domain, crypto.randomBytes(6).toString("hex")),
      active.catchAll,
      "unknown addresses",
      result,
      stored?.catchAllRouteId === active.catchAll,
    );
    await verifyDomainRoute(ctx, `dmarc@${ctx.domain}`, active.dmarc, `dmarc@${ctx.domain}`, result, stored?.dmarcRouteId === active.dmarc);
  }

  // ── record ──
  for (const [domainId, ids] of domainRouteIds) {
    const d = domains.find((x) => x.id === domainId)!;
    if (d.catchAllRouteId === ids.catchAll && d.dmarcRouteId === ids.dmarc) continue;
    await dbWrite((c) => c.sendingDomain.update({ where: { id: domainId }, data: { catchAllRouteId: ids.catchAll, dmarcRouteId: ids.dmarc } }));
  }
  const newlySuppressed: string[] = [];
  for (const plan of plans) {
    const { row } = plan;
    const isCurrent = row.domainId === ctx.domainId && !row.retiredAt;
    let status = row.routeStatus;
    let routeError: string | null | undefined = undefined;
    if (isCurrent) {
      if (plan.error) {
        status = "error";
        routeError = plan.error;
        if (plan.error.startsWith(SUPPRESSED_INBOX_PREFIX) && row.routeStatus !== "error") newlySuppressed.push(plan.forwardTo!);
      } else if (plan.verified === "ok") {
        status = "ok";
        routeError = null;
      } else if (plan.verified === "mismatch") {
        status = "mismatch";
        routeError = routeMismatchText(row.address);
      } else if (!status) {
        status = "pending";
      }
    }
    const checked = isCurrent && (plan.error !== null || plan.verified !== null);
    await dbWrite((c) =>
      c.senderAddress.update({
        where: { id: row.id },
        data: {
          mailgunRouteId: plan.routeId,
          forwardTo: plan.forwardTo,
          routeStatus: status,
          ...(routeError !== undefined ? { routeError } : {}),
          ...(checked ? { routeCheckedAt: now } : {}),
        },
      }),
    );
    if (isCurrent && plan.spec && plan.routeId) result.senders++;
  }
  for (const plan of plans) {
    if (plan.row.domainId !== ctx.domainId || plan.row.retiredAt) continue;
    if (plan.error) result.problems.push(plan.error);
    else if (plan.verified === "mismatch") result.problems.push(routeMismatchText(plan.row.address));
  }

  // ── tell the Owner ──
  if (newlySuppressed.length > 0 && (await shouldSendNotice("reply-inbox-suppressed", now))) {
    const inbox = newlySuppressed[0]!;
    await notifyOwner({
      type: "system.replyRoute",
      title: `Mailgun won't forward replies to ${inbox}`,
      body: `${inbox} is on a do-not-email list, so replies to that sender don't reach their inbox. Open Settings › Domain checklist and click Remove it next to it.`,
      link: "/settings/domain",
    }).catch((err: unknown) => console.error("[routes] couldn't notify the Owner", err));
  }
  if (result.created + result.updated + result.deleted > 0) {
    await logActivity({
      actorId: opts.byUserId ?? null,
      type: "mailgun.routesSynced",
      summary: `Reply routes updated: ${result.created} created, ${result.updated} changed, ${result.deleted} removed`,
      data: { created: result.created, updated: result.updated, deleted: result.deleted },
    }).catch((err: unknown) => console.error("[routes] couldn't log the sync", err));
  }

  result.ok = result.problems.length === 0;
  return result;
}

/** A failed create/update for one address: definite → "error"; Mailgun not answering → "error" only on the 3rd sync in a row. */
function noteFailure(plan: Plan, err: unknown, ctx: MailgunContext, result: SyncRoutesResult): void {
  const text = plain(err, ctx);
  if (isDefinite(err)) {
    const why = isMailgunError(err) && err.mailgunMessage ? ` (${err.mailgunMessage})` : "";
    plan.error = `Mailgun refused the reply route for ${plan.row.address}${why}. ${text}`;
    transientFailures.delete(plan.row.id);
    return;
  }
  const n = (transientFailures.get(plan.row.id) ?? 0) + 1;
  transientFailures.set(plan.row.id, n);
  result.retryable = true;
  if (n >= TRANSIENT_FAILURES_BEFORE_ERROR) {
    plan.error = `Mailgun didn't answer while setting up the reply route for ${plan.row.address}, ${n} times in a row. ${text}`;
  } else {
    result.problems.push(`Couldn't update the reply route for ${plan.row.address} right now: ${text}`);
  }
}

/** listRoutes failed: nothing can be synced; each current address counts one failed sync. */
async function recordUnreachable(
  current: AddressRow[],
  err: unknown,
  ctx: MailgunContext,
  now: Date,
  result: SyncRoutesResult,
): Promise<void> {
  const text = plain(err, ctx);
  result.problems.push(`Couldn't read the reply routes from Mailgun: ${text}`);
  result.retryable = !isDefinite(err);
  if (isDefinite(err)) return;
  for (const row of current) {
    const n = (transientFailures.get(row.id) ?? 0) + 1;
    transientFailures.set(row.id, n);
    if (n < TRANSIENT_FAILURES_BEFORE_ERROR) continue;
    const routeError = `Mailgun didn't answer while checking the reply route for ${row.address}, ${n} times in a row. ${text}`;
    await dbWrite((c) =>
      c.senderAddress.update({ where: { id: row.id }, data: { routeStatus: "error", routeError, routeCheckedAt: now } }),
    );
  }
}

async function deleteQuietly(ctx: MailgunContext, id: string, result: SyncRoutesResult): Promise<void> {
  try {
    if ((await ctx.client.deleteRoute(id)) === "deleted") result.deleted++;
  } catch (err) {
    result.problems.push(`Couldn't remove an old reply route (${id}): ${plain(err, ctx)}`);
    if (!isDefinite(err)) result.retryable = true;
  }
}

/**
 * Checks with /match that the catch-all (or dmarc@) route really catches its probe address. A route Mailgun doesn't
 * find yet, or one it couldn't be asked about, keeps the sync from counting as done (and lets the job try again),
 * except that a route the app already had on record stays trusted through one unanswered check.
 */
async function verifyDomainRoute(
  ctx: MailgunContext,
  probe: string,
  expectedId: string | null,
  what: string,
  result: SyncRoutesResult,
  alreadyKnown: boolean,
): Promise<void> {
  if (!expectedId) return;
  try {
    const m = await ctx.client.matchRoute(probe);
    if (m && m.id !== expectedId) {
      result.problems.push(
        `Another Mailgun route catches ${what} on ${ctx.domain} first. In Mailgun, open Receiving › Routes and delete routes you don't recognise for this domain.`,
      );
    } else if (!m) {
      result.problems.push(`Mailgun doesn't use the app's route for ${what} on ${ctx.domain} yet. Click Apply recommended settings again.`);
      result.retryable = true;
    }
  } catch (err) {
    if (isDefinite(err)) result.problems.push(`Couldn't confirm the route for ${what} on ${ctx.domain}: ${plain(err, ctx)}`);
    else {
      result.retryable = true;
      if (!alreadyKnown) result.problems.push(`Couldn't confirm the route for ${what} on ${ctx.domain} yet. The app checks again in a few minutes.`);
    }
  }
}

/** "Couldn't confirm the reply route for <address> yet. …" (its /match check had no answer this time). */
export function routeUnconfirmedText(address: string): string {
  return `Couldn't confirm the reply route for ${address} yet. The app checks again in a few minutes.`;
}

/** "Reply routes are set up for 3 senders, plus a catch-all." */
export function routesOkText(senders: number): string {
  return `Reply routes are set up for ${senders} sender${senders === 1 ? "" : "s"}, plus a catch-all.`;
}

/**
 * Job "mailgun.syncRoutes" (dedupe "mailgun:routes"): enqueued when a sending address or a reply inbox changes, when a
 * teammate is switched off or on, after a domain change and by "Remove it". A sync that only failed because Mailgun
 * didn't answer throws, so the job runner tries again in a few minutes. In own-mailbox mode it finishes at once
 * ("Not needed: replies go to your own mailbox.", MAIN-DOMAIN-DESIGN O8).
 */
export const syncRoutesHandler: JobHandler = async (_payload, ctx) => {
  const res = await syncRoutes({ byUserId: ctx.createdById });
  const ownMailbox = res.ok && (await loadTeamFrom()).replies === "own-mailbox";
  const summary = ownMailbox ? OWN_MAILBOX_TEXTS.applyNotNeeded : res.ok ? routesOkText(res.senders) : res.problems.join(" ");
  if (!res.ok && res.retryable) {
    throw new PlainJobError(res.problems[0] ?? "Mailgun didn't answer.", redactText(res.problems.join(" "), await mailgunSecrets()));
  }
  return { summary, created: res.created, updated: res.updated, deleted: res.deleted, problems: res.problems };
};
