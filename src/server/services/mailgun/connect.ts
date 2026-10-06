import { MAILGUN_PLAN_FACTS, PLAN_TEXTS, type MailgunPlan } from "@/core/mailgun/plan";
import { validateSendingDomain } from "@/core/sender-address";
import { TEAM_FROM_TEXTS, teamFromDomainFor } from "@/core/sending/from-address";
import { GO_LIVE_COPY } from "@/core/sending/go-live-copy";
import { OWN_MAILBOX_TEXTS, validateFromAddressFor, validateOwnMailboxFrom, type RepliesMode } from "@/core/sending/own-mailbox";
import { DEFAULT_UNSUBSCRIBE_TEST } from "@/core/setting-types";
import { parseMailgunSetupState, parseUnsubscribeTest } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import type { Prisma } from "@/generated/prisma/client";
import { logActivity } from "../../activity";
import { db, dbTx, type Tx } from "../../db";
import { enqueueJob } from "../../jobs";
import { FAKE_KEY_PREFIX, isFakeMode } from "../../mailgun/base-url";
import { MailgunClient } from "../../mailgun/client";
import { AUTH_TEXT, NETWORK_TEXT, isMailgunError, plainMailgunError, wrongRegionText } from "../../mailgun/errors";
import type { MailgunRegion } from "../../mailgun/types";
import { deleteSecret, encryptSecret, getSecret, setSecret, type SecretKey } from "../../secrets";
import { SETTING_DEFAULTS, getSettings, setSettingIn } from "../../settings";
import { updateTyped } from "../../state-typed";
import { EMPTY_SETUP_STATE } from "./apply-settings";
import { loadPlanLimits } from "./plan";
import { loadTeamFrom } from "./team-from";

/**
 * Connecting Mailgun (PLAN B6.5, M3-DESIGN §4.5.1): test the key and domain read-only, and only after a pass save the
 * keys, the settings and the SendingDomain row, all in one transaction. A domain change moves everyone's sending
 * address to the new domain, starts the reply test again, re-pushes the do-not-email list, drops the old domain's
 * sending key and its "Apply recommended settings" run; it is refused while test or live campaigns still send from the
 * old domain (checked again inside the transaction). Keys are never returned, logged or put in a job payload.
 *
 * Shared From address (SHARED-FROM-DESIGN §2.7): the same name in the other region counts as a domain change (F28); a
 * new domain must keep the saved From address valid (F14); and `saveFromAddress` is the only writer of Setting
 * "mailgun.fromAddress" (F13). This file holds the only two writers of `sending.goLive = false`: a sending-domain
 * change in `connectMailgun` (G8) and a From change in `saveFromAddress` (F13). A domain change (a region-only move
 * too) re-writes the From address row with its own value so earlier evidence stops counting (`restartEvidence`, review
 * SETTING-1); the value itself is never changed there.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O1–O3, O7, O8, O22): "How the app sends" (Setting "mailgun.replies") is written
 * only here, by `saveConnection`, with the domain and the region. The mode is part of the connection: the sending domain
 * is validated with it (polygonparadise.com itself only in own-mailbox mode), a mode switch is a sending-domain change
 * (O2), and in own-mailbox mode nobody's sending address moves and no route sync is queued (nothing may ever create a
 * route there). The first own-mailbox connect with no plan saved sets the Free plan and its retention (1/1) in the same
 * transaction. The own From is validated with `validateFromAddressFor` (the mode's rules), here and in `saveFromAddress`.
 */

export type ConnectInput = {
  region: MailgunRegion;
  domain: string;
  apiKey?: string | null;
  sendingKey?: string | null;
  /** MAIN-DOMAIN-DESIGN O1, O2, O7: "How the app sends"; absent = the saved mode ("mailgun.replies"). */
  replies?: RepliesMode;
};
export type ConnectResult =
  | { ok: true; message: string; domainState: string | null }
  | { ok: false; field: "domain" | "apiKey" | "region" | null; error: string; detail: string | null };

/** For tests and the web process: how the connection test talks to Mailgun. */
export type ConnectDeps = { fetchImpl?: typeof fetch; retryDelayMs?: (attempt: number) => number; timeoutMs?: number };

export const CONNECT_TEXTS = {
  pasteKey: "Paste the API key from Mailgun › API Security.",
  testKey: "This is a test key. Paste the key from Mailgun › API Security.",
  realKeyInFakeMode: "The test server only takes test keys (key-fake-…). A real key is never sent to it.",
  unreadableKey: "The saved Mailgun key can't be read any more. Paste the key again.",
  practiceCopy: "The practice copy never talks to Mailgun.",
  unexpected: "Something unexpected went wrong while checking Mailgun. Try again.",
  badSendingKey: "The domain sending key doesn't fit this server. Paste the sending key from Mailgun, or leave the box empty.",
} as const;

/** "Mailgun has no domain called <d> in either region. …" */
export function unknownDomainText(domain: string): string {
  return `Mailgun has no domain called ${domain} in either region. Check the spelling, or add it in Mailgun first (Send › Domains › Add new domain).`;
}

/**
 * SHARED-FROM-DESIGN F28, §3.1: a subdomain (mail.polygonparadise.com) found only in the other region. It doesn't push
 * the Owner to the other region first: the main domain (which signs the emails) is usually in the chosen one, and the
 * subdomain belongs next to it. Any other domain keeps `wrongRegionText`.
 */
export function wrongRegionSubdomainText(domain: string, region: MailgunRegion, other: MailgunRegion): string {
  return `Mailgun can't find ${domain} in the ${region} region, only in ${other}. If your main domain is in the ${region} region in Mailgun, delete ${domain} there and add it again in the ${region} region (Mailgun guide, step 4). Otherwise change Region to ${other}.`;
}

/** "Finish or cancel <names> first: it sends with the current From address." (SHARED-FROM-DESIGN §3.1) */
export function fromChangeBlockedText(names: string[]): string {
  return `Finish or cancel ${joinNames(names)} first: ${names.length === 1 ? "it sends" : "they send"} with the current From address.`;
}

/** The activity summary of a From address change (SHARED-FROM-DESIGN §3.1). */
export function fromChangedSummary(actorName: string, from: string | null, to: string | null): string {
  if (!from && to) return `${actorName} set the From address to ${to}`;
  if (from && to) return `${actorName} changed the From address from ${from} to ${to}`;
  return `${actorName} cleared the From address: each person's own address is the From again`;
}

/** "Finish or cancel <names> first: they send from <old domain>." */
export function domainChangeBlockedText(names: string[], oldDomain: string): string {
  return `Finish or cancel ${joinNames(names)} first: ${names.length === 1 ? "it sends" : "they send"} from ${oldDomain}.`;
}

function joinNames(names: readonly string[]): string {
  const quoted = names.map((n) => `“${n}”`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/** Keys are trimmed and stripped of zero-width characters (a copy from a web page can carry them). */
export function cleanKey(v: string | null | undefined): string {
  return (v ?? "").replace(/[​-‍﻿]/g, "").trim();
}

function regionOf(v: unknown): MailgunRegion {
  return v === "US" ? "US" : "EU";
}

/**
 * Checks a key, domain and region read-only (GET /v4/domains/{d}). A 401/404 on the chosen region is followed by the
 * same read-only GET on the other region, so the Owner hears "change Region to US" instead of a vague error. Never
 * saves anything. Test keys (key-fake-…) only go to the fake server, and it only gets test keys. `replies` (absent =
 * "app") is the mode the domain is checked for (MAIN-DOMAIN-DESIGN O7).
 */
export async function testMailgunConnection(
  input: { region: MailgunRegion; domain: string; apiKey: string; replies?: RepliesMode },
  deps: ConnectDeps = {},
): Promise<ConnectResult> {
  const apiKey = cleanKey(input.apiKey);
  if (!apiKey) return { ok: false, field: "apiKey", error: CONNECT_TEXTS.pasteKey, detail: null };
  const dom = validateSendingDomain(input.domain, { replies: input.replies });
  if (!dom.ok) return { ok: false, field: "domain", error: dom.error, detail: null };
  const domain = dom.domain;
  const region = regionOf(input.region);
  const fake = isFakeMode();
  if (!fake && apiKey.startsWith(FAKE_KEY_PREFIX)) return { ok: false, field: "apiKey", error: CONNECT_TEXTS.testKey, detail: null };
  if (fake && !apiKey.startsWith(FAKE_KEY_PREFIX)) {
    return { ok: false, field: "apiKey", error: CONNECT_TEXTS.realKeyInFakeMode, detail: null };
  }

  let client: MailgunClient;
  try {
    client = new MailgunClient({
      apiKey,
      region,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? 15_000,
      // One quick retry for a 404 or 429 is enough while the Owner waits for the answer.
      retryDelayMs: deps.retryDelayMs ?? (() => 1_000),
    });
  } catch (err) {
    return { ok: false, field: null, error: err instanceof Error ? err.message : CONNECT_TEXTS.unexpected, detail: null };
  }

  try {
    const info = await client.getDomain(domain);
    return { ok: true, message: `Mailgun found ${domain} (${region}).`, domainState: info.state };
  } catch (err) {
    if (!isMailgunError(err)) return { ok: false, field: null, error: CONNECT_TEXTS.unexpected, detail: null };
    const first = `${region}: ${err.message}`;
    if (err.kind === "auth" || err.kind === "not-found") {
      const other: MailgunRegion = region === "EU" ? "US" : "EU";
      try {
        await client.forRegion(other).getDomain(domain);
        // A subdomain of a main domain (F28): don't push the Owner to the other region first.
        const error = teamFromDomainFor(domain) ? wrongRegionSubdomainText(domain, region, other) : wrongRegionText(domain, region);
        return { ok: false, field: "region", error, detail: `${first} ${other}: found.` };
      } catch (err2) {
        const second = `${other}: ${isMailgunError(err2) ? err2.message : String(err2)}`;
        const detail = `${first} ${second}`;
        if (err.kind === "auth") return { ok: false, field: "apiKey", error: AUTH_TEXT, detail };
        return { ok: false, field: "domain", error: unknownDomainText(domain), detail };
      }
    }
    if (err.kind === "network" || err.kind === "timeout") return { ok: false, field: null, error: NETWORK_TEXT, detail: first };
    return { ok: false, field: null, error: plainMailgunError(err, { domain, region }), detail: first };
  }
}

/** Test and live campaigns that still send (or may send again) from the current domain. */
async function activeMailgunCampaigns(reader: Tx | typeof db = db): Promise<string[]> {
  const rows = await reader.campaign.findMany({
    where: { mode: { in: ["TEST", "LIVE"] }, status: { in: ["SCHEDULED", "RUNNING", "PAUSED"] } },
    select: { name: true },
    orderBy: { id: "asc" },
    take: 20,
  });
  return rows.map((r) => r.name);
}

/** Thrown inside the save transaction when a test or live campaign started while Mailgun was being asked. */
class DomainChangeBlocked extends Error {
  constructor(readonly names: string[]) {
    super("A test or live campaign still sends from the old domain.");
    this.name = "DomainChangeBlocked";
  }
}

/** Thrown inside a save transaction with the refusal to show (the From address no longer fits, F14; a From change, F13). */
class SaveRefused extends Error {
  constructor(
    message: string,
    readonly field: "domain" | "fromAddress" | null,
  ) {
    super(message);
    this.name = "SaveRefused";
  }
}

/**
 * F14: why the saved From address wouldn't fit `domain` in the mode `replies`, or null (nothing saved, or it fits).
 * App mode: `TEAM_FROM_TEXTS.domainMisfit`; own-mailbox mode (MAIN-DOMAIN-DESIGN §2.4): `OWN_MAILBOX_TEXTS.domainMisfit`.
 */
function fromMisfitFor(saved: unknown, domain: string, replies: RepliesMode): string | null {
  const from = typeof saved === "string" ? saved.trim().toLowerCase() : "";
  if (!from) return null;
  if (validateFromAddressFor(from, domain, replies).ok) return null;
  return replies === "own-mailbox" ? OWN_MAILBOX_TEXTS.domainMisfit(from, domain) : TEAM_FROM_TEXTS.domainMisfit(from, domain);
}

async function upsertSetting(tx: Prisma.TransactionClient, key: string, value: Prisma.InputJsonValue, userId: number): Promise<void> {
  await tx.setting.upsert({ where: { key }, create: { key, value, updatedById: userId }, update: { value, updatedById: userId } });
}

/** setSecret inside the connect transaction (encrypted exactly like setSecret), so keys and domain commit together. */
async function upsertSecret(tx: Prisma.TransactionClient, key: SecretKey, value: string, userId: number): Promise<void> {
  const trimmed = value.trim();
  const data = { ciphertext: encryptSecret(key, trimmed), last4: trimmed.slice(-4), updatedById: userId };
  await tx.secret.upsert({ where: { key }, create: { key, ...data }, update: data });
}

/** "The domain sending key you saved only worked for <old>, so it was removed. …" (after a domain change). */
export function sendingKeyRemovedText(oldDomain: string): string {
  return `The domain sending key you saved only worked for ${oldDomain}, so it was removed. Emails now go out with the API key; to use a sending key again, paste the new domain's key under Advanced.`;
}

/**
 * Added to "Save and connect"'s message after a region-only move (F28, review SETTING-1): the old region's evidence no
 * longer counts, and Mailgun's reports about emails sent there can't reach the app any more (the domain had to be
 * deleted in that region before its name could be added in this one, and a deleted domain has no events left to read).
 */
export function regionMovedText(oldRegion: MailgunRegion): string {
  return `Emails sent through the ${oldRegion} region no longer count for the reply test or the live test: run both again. Late bounces, complaints and unsubscribes of those emails can't reach the app any more: if someone asks to be removed, add them in Settings › Deliverability.`;
}

/** The dedupe key of the domain check every "Check again", connection and From change shares. */
const DOMAIN_CHECK_KEY = "mailgun:domain-check";
/** A second check queued behind one that was already running (review SETTING-6). */
const DOMAIN_CHECK_AFTER_CHANGE_KEY = "mailgun:domain-check-after-change";

/**
 * Asks for a domain check that sees a change just committed (review SETTING-6). A check that is still queued reads the
 * new settings when it starts. One that is already running may have read the old ones, and `enqueueJob` would hand it
 * back instead of queueing another (same dedupe key), so a second check with its own key is queued behind it (the
 * worker's main lane runs one job at a time). The check itself also runs again when the From address changed while it
 * ran (`runDomainCheck`); this covers the moment between its last read and its write.
 */
async function queueDomainCheckAfterChange(createdById: number): Promise<void> {
  const job = await enqueueJob({ type: "mailgun.checkDomain", payload: {}, dedupeKey: DOMAIN_CHECK_KEY, priority: 20, createdById });
  if (job.status === "RUNNING") {
    await enqueueJob({ type: "mailgun.checkDomain", payload: {}, dedupeKey: DOMAIN_CHECK_AFTER_CHANGE_KEY, priority: 20, createdById });
  }
}

/**
 * "Save and connect": validates, refuses a domain change while test or live campaigns are active, tests the connection
 * (an empty `apiKey` re-tests the saved key), then in one transaction (the domain-change refusal checked again) saves
 * keys, settings and the SendingDomain row, marks other domains inactive and moves every current sending address to the
 * same name on the new domain. A domain change also removes a saved domain sending key unless a new one is given (it
 * works for one domain only) and clears the old domain's "Apply recommended settings" run. Then it saves the webhook
 * signing key (not fatal when that fails) and asks for a domain check, a suppression sync and (after a move) a route
 * sync.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §2.7, O2, O8, O22): `input.replies` (absent = the saved mode) is validated with
 * the domain, and a different mode than the saved one is a domain change like any other (refused while test or live
 * campaigns are active, ends go-live, resets the reply test, …). In own-mailbox mode no address moves, no route sync is
 * queued, a saved From must be on the new domain (`OWN_MAILBOX_TEXTS.domainMisfit`), and the first connect with no plan
 * saved sets the Free plan (the message then says so, `planSetFree`).
 */
export async function connectMailgun(
  actor: { id: number; name: string },
  input: ConnectInput,
  deps: ConnectDeps = {},
): Promise<ConnectResult> {
  const s = await getSettings(["practice.copy", "mailgun.domain", "mailgun.region"] as const);
  if (s["practice.copy"]) return { ok: false, field: null, error: CONNECT_TEXTS.practiceCopy, detail: null };
  if (input.region !== "EU" && input.region !== "US") {
    return { ok: false, field: "region", error: "Choose the region you picked when you added the domain in Mailgun.", detail: null };
  }
  // The mode is read only through loadTeamFrom (MAIN-DOMAIN-DESIGN §0.2 rule 5), with the saved From address.
  const team = await loadTeamFrom();
  const oldReplies = team.replies;
  const replies: RepliesMode = input.replies === "own-mailbox" || input.replies === "app" ? input.replies : oldReplies;
  const own = replies === "own-mailbox";
  const dom = validateSendingDomain(input.domain, { replies });
  if (!dom.ok) return { ok: false, field: "domain", error: dom.error, detail: null };
  const domain = dom.domain;
  const region = input.region;

  const newKey = cleanKey(input.apiKey);
  let apiKey = newKey;
  if (!apiKey) {
    try {
      apiKey = (await getSecret("mailgun.apiKey")) ?? "";
    } catch {
      return { ok: false, field: "apiKey", error: CONNECT_TEXTS.unreadableKey, detail: null };
    }
    if (!apiKey) return { ok: false, field: "apiKey", error: CONNECT_TEXTS.pasteKey, detail: null };
  }
  const sendingKey = cleanKey(input.sendingKey);
  if (sendingKey && sendingKey.startsWith(FAKE_KEY_PREFIX) !== isFakeMode()) {
    return { ok: false, field: null, error: CONNECT_TEXTS.badSendingKey, detail: null };
  }

  const oldDomain = (s["mailgun.domain"] ?? "").trim().toLowerCase() || null;
  const oldRegion = regionOf(s["mailgun.region"]);
  // F28: the same name in the other region is a new Mailgun domain (new routes, keys and suppression lists).
  // MAIN-DOMAIN-DESIGN O2: so is the same name with another "How the app sends".
  const modeChanged = replies !== oldReplies;
  const changing = oldDomain !== null && (oldDomain !== domain || oldRegion !== region || modeChanged);
  const regionOnly = changing && oldDomain === domain && oldRegion !== region;
  if (changing) {
    const names = await activeMailgunCampaigns();
    if (names.length > 0) return { ok: false, field: "domain", error: domainChangeBlockedText(names, oldDomain), detail: null };
  }
  // F14: a new sending domain (or another mode) must keep the saved From address valid (checked again inside the
  // transaction). In own-mailbox mode the From must be exactly on the new domain (MAIN-DOMAIN-DESIGN §2.4).
  const checkFrom = oldDomain !== domain || modeChanged;
  if (checkFrom) {
    const misfit = fromMisfitFor(team.saved, domain, replies);
    if (misfit) return { ok: false, field: "domain", error: misfit, detail: null };
  }

  const test = await testMailgunConnection({ region, domain, apiKey, replies }, deps);
  if (!test.ok) return test;

  // Only after a pass, and all in one transaction: keys, settings, domains and addresses.
  let saved: SavedConnection;
  try {
    saved = await dbTx((tx) =>
      saveConnection(tx, {
        actor,
        domain,
        region,
        oldDomain: changing ? oldDomain : null,
        oldRegion,
        checkFrom,
        newKey,
        sendingKey,
        replies,
        oldReplies,
        now: new Date(),
      }),
    );
  } catch (err) {
    if (err instanceof DomainChangeBlocked && oldDomain) {
      return { ok: false, field: "domain", error: domainChangeBlockedText(err.names, oldDomain), detail: null };
    }
    if (err instanceof SaveRefused) return { ok: false, field: "domain", error: err.message, detail: null };
    throw err;
  }
  const moved = saved.moved;
  // A region-only move names the regions in its notes: "mail.polygonparadise.com (EU)" → "mail.polygonparadise.com (US)".
  const oldLabel = regionOnly && oldDomain ? `${oldDomain} (${oldRegion})` : oldDomain;
  const newLabel = regionOnly ? `${domain} (${region})` : domain;

  if (changing) {
    // The old domain's "Apply recommended settings" run (its steps and its certificate) says nothing about this one.
    await updateTyped(STATE_KEYS.mailgunSetup, parseMailgunSetupState, () => EMPTY_SETUP_STATE).catch((err: unknown) =>
      console.warn("[connect] couldn't clear the old domain's Apply run:", err),
    );
  }

  // The webhook signing key is fetched, never typed; a failure only turns its checklist row red.
  try {
    const client = new MailgunClient({ apiKey, region, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs ?? 15_000, retryDelayMs: deps.retryDelayMs });
    const key = await client.getSigningKey();
    let saved: string | null = null;
    try {
      saved = await getSecret("mailgun.webhookSigningKey");
    } catch {
      saved = null;
    }
    if (saved !== key) await setSecret("mailgun.webhookSigningKey", key, actor.id);
  } catch (err) {
    console.warn("[connect] couldn't fetch the webhook signing key:", isMailgunError(err) ? err.message : err);
  }

  // A check already running may have read the old domain or region (a region-only move keeps the name): one more follows.
  await queueDomainCheckAfterChange(actor.id);
  await enqueueJob({ type: "mailgun.syncSuppressions", payload: {}, dedupeKey: "mailgun:push", priority: 10, createdById: actor.id });
  // A region-only move (F28) needs every route again in the new region, even with nobody's address moved; so does a
  // switch back from own-mailbox mode, where nothing touched the routes. Own-mailbox mode never gets one (O8).
  if (!own && (moved > 0 || regionOnly || (changing && oldReplies === "own-mailbox"))) {
    await enqueueJob({ type: "mailgun.syncRoutes", payload: {}, dedupeKey: "mailgun:routes", priority: 30, createdById: actor.id });
  }

  const next =
    test.domainState === "active"
      ? "Next: click Apply recommended settings on the Domain checklist."
      : "Mailgun hasn't confirmed your DNS records yet: add them from the Domain checklist.";
  // Own-mailbox mode (§3.1): replies go to the own mailbox; without a fitting From the next step is the From card.
  const lead = !own ? next : saved.ownFromFits ? `${OWN_MAILBOX_TEXTS.connectedMode} ${next}` : OWN_MAILBOX_TEXTS.connectedNext;
  const planNote = saved.planSet ? OWN_MAILBOX_TEXTS.planSetFree : "";
  const keyNote = saved.droppedSendingKey && oldLabel ? ` ${sendingKeyRemovedText(oldLabel)}` : "";
  const liveNote = saved.goLiveEnded && oldLabel ? ` ${GO_LIVE_COPY.endedByDomainChange(oldLabel, newLabel)}` : "";
  const regionNote = regionOnly ? ` ${regionMovedText(oldRegion)}` : "";
  return {
    ok: true,
    message: `Connected to ${domain} (${region}). ${lead}${planNote}${keyNote}${liveNote}${regionNote}`,
    domainState: test.domainState,
  };
}

type SavedConnection = {
  moved: number;
  droppedSendingKey: boolean;
  goLiveEnded: boolean;
  /** MAIN-DOMAIN-DESIGN O22: this connect set the Free plan (own-mailbox mode, no plan saved before). */
  planSet: boolean;
  /** Own-mailbox mode: the saved From address fits the new domain (else the next step is typing one). */
  ownFromFits: boolean;
};

/**
 * The writes of "Save and connect", inside one transaction (no network here). `oldDomain` is set only for a domain
 * change, which is checked again here: a test or live campaign launched while Mailgun was being asked throws
 * DomainChangeBlocked, and nothing is saved. A domain change also ends go-live (M6-DESIGN §2.8, G8: the only writer
 * of `sending.goLive = false`): live campaigns reach only the test list until the Owner goes live on the new domain
 * through the whole checklist. `sending.goLiveAt` and `sending.goLiveDomain` stay, for the card's "You were live on …".
 *
 * Shared From address: `oldDomain` is also set for a region-only move of the same name (F28), which additionally puts
 * every current address's reply route back to "pending" (Mailgun's routes live per region; the caller queues the route
 * sync). `checkFrom` (a new domain name) re-checks that the saved From address still fits (F14): SaveRefused.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §2.7): `oldDomain` is also set for a switch of "How the app sends" on the same
 * domain and region (O2; its activity uses `OWN_MAILBOX_TEXTS.switchedSummary`). Setting "mailgun.replies" is written
 * here (its only writer, O1) when it changes. In own-mailbox mode nobody's address moves or is retired and no route is
 * reset (O5, O8), and with no plan saved yet the Free plan and 1/1 days of retention are written with their activity
 * (O22). `checkFrom` also runs for a mode switch, with the new mode's rules.
 */
async function saveConnection(
  tx: Tx,
  i: {
    actor: { id: number; name: string };
    domain: string;
    region: MailgunRegion;
    oldDomain: string | null;
    oldRegion: MailgunRegion;
    checkFrom: boolean;
    newKey: string;
    sendingKey: string;
    replies: RepliesMode;
    oldReplies: RepliesMode;
    now: Date;
  },
): Promise<SavedConnection> {
  const { actor, domain, region, oldDomain, now } = i;
  const own = i.replies === "own-mailbox";
  const sameName = oldDomain !== null && oldDomain === domain;
  const regionOnly = sameName && i.oldRegion !== region;
  if (oldDomain) {
    const names = await activeMailgunCampaigns(tx);
    if (names.length > 0) throw new DomainChangeBlocked(names);
  }
  // The From address and the mode as they are now (the compare-and-set re-read of F14, through the one reader).
  const teamNow = await loadTeamFrom(tx);
  if (i.checkFrom) {
    const misfit = fromMisfitFor(teamNow.saved, domain, i.replies);
    if (misfit) throw new SaveRefused(misfit, "domain");
  }
  let goLiveEnded = false;
  if (oldDomain) {
    const live = await tx.setting.findUnique({ where: { key: "sending.goLive" }, select: { value: true } });
    if (live?.value === true) {
      await upsertSetting(tx, "sending.goLive", false, actor.id);
      goLiveEnded = true;
    }
  }
  if (i.newKey) await upsertSecret(tx, "mailgun.apiKey", i.newKey, actor.id);
  let droppedSendingKey = false;
  if (i.sendingKey) await upsertSecret(tx, "mailgun.sendingKey", i.sendingKey, actor.id);
  else if (oldDomain) {
    // A domain sending key works for one domain only: kept, it would make every send from the new domain fail.
    droppedSendingKey = (await tx.secret.deleteMany({ where: { key: "mailgun.sendingKey" } })).count > 0;
  }
  await upsertSetting(tx, "mailgun.region", region, actor.id);
  await upsertSetting(tx, "mailgun.domain", domain, actor.id);
  // MAIN-DOMAIN-DESIGN O1: "How the app sends", written only here; left alone while it doesn't change (app mode keeps
  // its settings exactly as before).
  if (teamNow.replies !== i.replies) await upsertSetting(tx, "mailgun.replies", i.replies, actor.id);
  const row = await tx.sendingDomain.upsert({
    where: { name: domain },
    create: { name: domain, region, active: true },
    update: { region, active: true },
  });
  await tx.sendingDomain.updateMany({ where: { id: { not: row.id } }, data: { active: false } });

  // Everyone's current address moves to the same name on this domain; the old one is retired (its route stays).
  // Own-mailbox mode (O5, O8): nobody needs an address, so none moves (the old ones stay as they are).
  let moved = 0;
  if (!own) {
    const others = await tx.senderAddress.findMany({
      where: { retiredAt: null, domainId: { not: row.id } },
      select: { id: true, userId: true, localPart: true },
    });
    for (const a of others) {
      await tx.senderAddress.update({ where: { id: a.id }, data: { retiredAt: now } });
      const address = `${a.localPart}@${domain}`;
      const existing = await tx.senderAddress.findUnique({ where: { address }, select: { id: true, userId: true, routeStatus: true } });
      if (existing) {
        if (existing.userId !== a.userId) continue; // someone else has that name here: they pick a new one in My profile
        await tx.senderAddress.update({
          where: { id: existing.id },
          data: { retiredAt: null, routeStatus: existing.routeStatus ?? "pending" },
        });
      } else {
        await tx.senderAddress.create({
          data: { userId: a.userId, domainId: row.id, localPart: a.localPart, address, routeStatus: "pending" },
        });
      }
      moved++;
    }
    if (regionOnly) {
      // F28: the same addresses, but Mailgun's routes live per region: every current one is set up again.
      await tx.senderAddress.updateMany({ where: { domainId: row.id, retiredAt: null }, data: { routeStatus: "pending" } });
    }
  }

  if (oldDomain) {
    // The reply test belongs to one domain, and the new domain's suppression lists start empty.
    await upsertSetting(tx, "mailgun.unsubscribeTest", { ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes: [] }, actor.id);
    await restartEvidence(tx, actor.id);
    await tx.suppression.updateMany({ where: { pushedToMailgunAt: { not: null } }, data: { pushedToMailgunAt: null } });
    const modeSwitch = i.replies !== i.oldReplies;
    await tx.activityLog.create({
      data: {
        actorId: actor.id,
        type: "mailgun.domainChanged",
        summary: regionOnly
          ? `${actor.name} moved ${domain} from the ${i.oldRegion} region to the ${region} region`
          : sameName
            ? OWN_MAILBOX_TEXTS.switchedSummary(actor.name, domain, i.replies)
            : `${actor.name} changed the sending domain from ${oldDomain} to ${domain}`,
        data: {
          from: oldDomain,
          to: domain,
          fromRegion: i.oldRegion,
          toRegion: region,
          movedAddresses: moved,
          sendingKeyRemoved: droppedSendingKey,
          ...(goLiveEnded ? { goLiveEnded: true } : {}),
          // MAIN-DOMAIN-DESIGN §7.6: the mode before and after, whenever own-mailbox mode is involved (a change that
          // stays in app mode keeps today's data).
          ...(modeSwitch || own ? { fromReplies: i.oldReplies, toReplies: i.replies } : {}),
        },
      },
    });
  }

  // MAIN-DOMAIN-DESIGN O22: the first own-mailbox connect with no plan saved keeps to the Free plan, and its retention
  // numbers say so (1 day of logs, 1 day of stored replies), with the retention activity.
  let planSet = false;
  if (own) {
    const limits = await loadPlanLimits(tx);
    if (limits === null || limits.assumed) {
      await writeRetentionIn(tx, actor, { logRetentionDays: 1, messageRetentionDays: 1, plan: "free" });
      planSet = true;
    }
  }

  await tx.activityLog.create({
    data: {
      actorId: actor.id,
      type: "mailgun.connected",
      summary: `${actor.name} connected Mailgun (${domain}, ${region})`,
      data: { domain, region, keyChanged: Boolean(i.newKey), sendingKey: Boolean(i.sendingKey), ...(own ? { replies: i.replies } : {}) },
    },
  });
  const ownFrom = own ? validateOwnMailboxFrom(teamNow.saved, domain) : null;
  return { moved, droppedSendingKey, goLiveEnded, planSet, ownFromFits: ownFrom !== null && ownFrom.ok && ownFrom.address !== null };
}

/** The short name of a plan for sentences: "Free (100 emails a day)" → "Free". */
function planName(plan: MailgunPlan | null): string {
  return plan ? MAILGUN_PLAN_FACTS[plan].label.replace(/\s*\(.*\)\s*$/, "") : PLAN_TEXTS.planNotSure;
}

export type RetentionInput = {
  logRetentionDays: number;
  messageRetentionDays: number;
  /** MAIN-DOMAIN-DESIGN O22: "Your Mailgun plan" (null = Not sure); absent = unchanged. */
  plan?: MailgunPlan | null;
};

export type RetentionResult = {
  /** Anything was written (then the activity was logged too). */
  changed: boolean;
  /** The stored-replies days changed (Apply sets Mailgun's own retention to them in app mode). */
  messageChanged: boolean;
  planChanged: boolean;
};

/**
 * Settings "mailgun.logRetentionDays", "mailgun.messageRetentionDays" and "mailgun.plan" with their one activity, inside
 * an open transaction (MAIN-DOMAIN-DESIGN O22, §3.1): only what changed is written; the activity (type "settings.updated",
 * data key "mailgun.retention", data gains `plan`) names the plan when it changed ("Arslan set the Mailgun plan to Free,
 * with 1 day of event logs and 1 day of stored replies"), else today's retention sentence. The saved plan is read through
 * `loadPlanLimits` (a plan assumed in own-mailbox mode isn't a saved one). Its writers: `saveRetention` (the Advanced
 * numbers) and `saveConnection` (the first own-mailbox connect). No network here.
 */
export async function writeRetentionIn(tx: Tx, actor: { id: number; name: string }, input: RetentionInput): Promise<RetentionResult> {
  const rows = await tx.setting.findMany({
    where: { key: { in: ["mailgun.logRetentionDays", "mailgun.messageRetentionDays"] } },
    select: { key: true, value: true },
  });
  const valueOf = (key: string, fallback: unknown) => {
    const row = rows.find((r) => r.key === key);
    return row ? row.value : fallback;
  };
  const beforeLog = valueOf("mailgun.logRetentionDays", SETTING_DEFAULTS["mailgun.logRetentionDays"]);
  const beforeMessage = valueOf("mailgun.messageRetentionDays", SETTING_DEFAULTS["mailgun.messageRetentionDays"]);
  const limits = await loadPlanLimits(tx);
  const beforePlan: MailgunPlan | null = limits && !limits.assumed ? limits.plan : null;
  const plan = input.plan === undefined ? beforePlan : input.plan;

  const logChanged = beforeLog !== input.logRetentionDays;
  const messageChanged = beforeMessage !== input.messageRetentionDays;
  const planChanged = plan !== beforePlan;
  if (logChanged) await setSettingIn(tx, "mailgun.logRetentionDays", input.logRetentionDays, actor.id);
  if (messageChanged) await setSettingIn(tx, "mailgun.messageRetentionDays", input.messageRetentionDays, actor.id);
  if (planChanged) await setSettingIn(tx, "mailgun.plan", plan, actor.id);
  const changed = logChanged || messageChanged || planChanged;
  if (changed) {
    const log = input.logRetentionDays;
    const msg = input.messageRetentionDays;
    await logActivity(
      {
        actorId: actor.id,
        type: "settings.updated",
        summary: planChanged
          ? PLAN_TEXTS.planSummary(actor.name, planName(plan), log, msg)
          : `${actor.name} set Mailgun's retention to ${log} days of event logs and ${msg} day${msg === 1 ? "" : "s"} of stored replies`,
        data: { key: "mailgun.retention", logRetentionDays: log, messageRetentionDays: msg, plan },
      },
      tx,
    );
  }
  return { changed, messageChanged, planChanged };
}

/**
 * "Save these numbers" (Settings › Sending & Mailgun › Advanced; Owner-only through its action): the retention numbers
 * and "Your Mailgun plan" in one transaction (`writeRetentionIn`). A plan change takes effect at once (caps, the rolling
 * guard, retention); nothing about go-live changes. `replies` is the saved mode, for the toast.
 */
export async function saveRetention(
  actor: { id: number; name: string },
  input: RetentionInput,
): Promise<RetentionResult & { replies: RepliesMode }> {
  const out = await dbTx((tx) => writeRetentionIn(tx, actor, input));
  return { ...out, replies: (await loadTeamFrom()).replies };
}

/**
 * Review SETTING-1: evidence belongs to one way of sending, i.e. the From address, the sending domain and its region.
 * The reply test's emails and pasted original, the live test and the go-live checklist's freshness count only what
 * happened at or after `loadTeamFrom().changedAt` (F26, the updatedAt of Setting "mailgun.fromAddress"). A region-only
 * move (F28) keeps the domain name and its SendingDomain row, which the other evidence filters key on, so without this
 * the old region's test emails, delivered live test and checklist check would still count. Writing the From address
 * row again with its own value (null in per-person mode) moves `changedAt` to this change: the value never changes
 * here (`saveFromAddress` stays its only writer), only the moment from which evidence counts. Done for every domain
 * change, so switching to another domain and back never revives the first period's evidence either.
 */
async function restartEvidence(tx: Tx, userId: number): Promise<void> {
  const row = await tx.setting.findUnique({ where: { key: "mailgun.fromAddress" }, select: { value: true } });
  await setSettingIn(tx, "mailgun.fromAddress", typeof row?.value === "string" ? row.value : null, userId);
}

export type SaveFromAddressInput = { fromAddress: string; confirmEndGoLive?: boolean };
export type SaveFromAddressResult =
  | { ok: true; message: string; fromAddress: string | null; goLiveEnded: boolean }
  | { ok: false; field: "fromAddress" | null; error: string };

/**
 * "Save From address" (SHARED-FROM-DESIGN §2.7, F13, F15; Owner-only through its action). Refused in the practice copy,
 * for an address `validateTeamFromAddress` refuses (under the field), for an address on the test list, while a test or
 * live campaign is active (each keeps the From it started with), and while live unless the Owner confirmed that going
 * live ends. Saving the value already saved changes nothing ("Nothing changed."). Otherwise one transaction (the
 * campaigns, the fit and go-live checked again): `sending.goLive = false` when it was on (`goLiveAt`, `goLiveDomain` and
 * `goLiveFrom` stay), the From address (null = per-person mode), the reply test reset with its Setup kept (answers and
 * the pasted original cleared: earlier evidence belongs to the old From, F26) and the activity; then a domain check is
 * queued, and a second one behind a check that was already running (review SETTING-6). No network here. `now` dates
 * the activity.
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O3, §3.2): the address is checked with the mode's rules (`validateFromAddressFor`:
 * exactly on the sending domain; empty may be saved), and the toasts and the clearing activity use the own-mailbox
 * sentences. Everything else is the same door (F13).
 */
export async function saveFromAddress(
  actor: { id: number; name: string },
  input: SaveFromAddressInput,
  now: Date = new Date(),
): Promise<SaveFromAddressResult> {
  const s = await getSettings(["practice.copy", "mailgun.domain", "sending.goLive", "sending.testList"] as const);
  if (s["practice.copy"]) return { ok: false, field: null, error: TEAM_FROM_TEXTS.practiceCopy };
  const domain = (s["mailgun.domain"] ?? "").trim().toLowerCase() || null;
  const current = await loadTeamFrom();
  const v = validateFromAddressFor(input.fromAddress, domain, current.replies);
  if (!v.ok) return { ok: false, field: "fromAddress", error: v.error };
  const next = v.address;
  if (next === current.saved) return { ok: true, message: TEAM_FROM_TEXTS.nothingChanged, fromAddress: next, goLiveEnded: false };
  const testList = Array.isArray(s["sending.testList"]) ? s["sending.testList"] : [];
  if (next && testList.some((a) => typeof a === "string" && a.trim().toLowerCase() === next)) {
    return { ok: false, field: "fromAddress", error: TEAM_FROM_TEXTS.onTestList(next) };
  }
  const names = await activeMailgunCampaigns();
  if (names.length > 0) return { ok: false, field: null, error: fromChangeBlockedText(names) };
  const confirmed = input.confirmEndGoLive === true;
  if (s["sending.goLive"] === true && !confirmed) return { ok: false, field: null, error: TEAM_FROM_TEXTS.confirmBody };

  let saved: { domain: string | null; goLiveEnded: boolean; replies: RepliesMode };
  try {
    saved = await dbTx((tx) => saveFrom(tx, { actor, next, confirmed, now }));
  } catch (err) {
    if (err instanceof DomainChangeBlocked) return { ok: false, field: null, error: fromChangeBlockedText(err.names) };
    if (err instanceof SaveRefused) return { ok: false, field: err.field === "fromAddress" ? "fromAddress" : null, error: err.message };
    throw err;
  }

  // Review SETTING-6: a check already running may have read the old From address; one more follows it then.
  await queueDomainCheckAfterChange(actor.id);
  const d = saved.domain ?? domain ?? "your sending domain";
  const base =
    saved.replies === "own-mailbox"
      ? next
        ? OWN_MAILBOX_TEXTS.savedOn(next)
        : OWN_MAILBOX_TEXTS.savedOff(d)
      : next
        ? TEAM_FROM_TEXTS.savedOn(next, d)
        : TEAM_FROM_TEXTS.savedOff(d);
  return {
    ok: true,
    message: saved.goLiveEnded ? `${base} ${GO_LIVE_COPY.endedByFromChange}` : base,
    fromAddress: next,
    goLiveEnded: saved.goLiveEnded,
  };
}

/**
 * The writes of "Save From address", in one transaction (no network). Throws DomainChangeBlocked or SaveRefused. The
 * mode is read here again (through `loadTeamFrom`), so the address is checked with the rules in force at the write.
 */
async function saveFrom(
  tx: Tx,
  i: { actor: { id: number; name: string }; next: string | null; confirmed: boolean; now: Date },
): Promise<{ domain: string | null; goLiveEnded: boolean; replies: RepliesMode }> {
  const { actor, next } = i;
  const names = await activeMailgunCampaigns(tx);
  if (names.length > 0) throw new DomainChangeBlocked(names);
  const rows = await tx.setting.findMany({
    where: { key: { in: ["mailgun.domain", "mailgun.fromAddress", "sending.goLive", "mailgun.unsubscribeTest"] } },
    select: { key: true, value: true },
  });
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  const text = (key: string) => {
    const x = value(key);
    return typeof x === "string" && x.trim() ? x.trim().toLowerCase() : null;
  };
  const domain = text("mailgun.domain");
  const { replies } = await loadTeamFrom(tx);
  if (next) {
    // The sending domain (or the mode) could have changed since the address was checked.
    const v = validateFromAddressFor(next, domain, replies);
    if (!v.ok) throw new SaveRefused(v.error, "fromAddress");
  }
  const before = text("mailgun.fromAddress");
  const live = value("sending.goLive") === true;
  if (live && !i.confirmed) throw new SaveRefused(TEAM_FROM_TEXTS.confirmBody, null);
  if (live) await setSettingIn(tx, "sending.goLive", false, actor.id);
  await setSettingIn(tx, "mailgun.fromAddress", next, actor.id);
  // A new From changes whose reputation and which DMARC record apply: the reply test starts again (Setup kept).
  const setup = parseUnsubscribeTest(value("mailgun.unsubscribeTest")).setup;
  await setSettingIn(tx, "mailgun.unsubscribeTest", { ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes: [], setup }, actor.id);
  await tx.activityLog.create({
    data: {
      at: i.now,
      actorId: actor.id,
      type: "mailgun.fromAddressChanged",
      // Own-mailbox mode (§3.2): clearing never falls back to each person's own address.
      summary:
        replies === "own-mailbox" && !next ? OWN_MAILBOX_TEXTS.clearedSummary(actor.name) : fromChangedSummary(actor.name, before, next),
      data: { from: before, to: next, goLiveEnded: live },
    },
  });
  return { domain, goLiveEnded: live, replies };
}

/** The toasts of "Remove the sending key" (review SCREENS-01). */
export const REMOVE_SENDING_KEY_TEXTS = {
  removed: "The domain sending key is removed. Emails now go out with the API key. If sending is paused, click Resume sending.",
  nothingSaved: "No domain sending key is saved: emails already go out with the API key.",
} as const;

/**
 * "Remove the sending key" (Settings › Sending & Mailgun › Advanced, review SCREENS-01): deletes only the domain sending
 * key, so the API key sends every email again (`getMailgunContext` falls back to it). The API key, the webhook signing
 * key, the domain and everything else stay. It is the way out the key pause names when Mailgun refuses a shared-From
 * email sent with the sending key (SENDING_KEY_TEAM_FROM_FIX). `removed` is false when no sending key was saved.
 */
export async function removeSendingKey(actor: { id: number; name: string }): Promise<{ removed: boolean }> {
  const removed = await dbTx(async (tx) => {
    const gone = (await tx.secret.deleteMany({ where: { key: "mailgun.sendingKey" } })).count > 0;
    if (gone) {
      await logActivity(
        { actorId: actor.id, type: "mailgun.keysRemoved", summary: `${actor.name} removed the domain sending key`, data: { keys: ["sendingKey"] } },
        tx,
      );
    }
    return gone;
  });
  return { removed };
}

/** "Remove saved keys": deletes the API key, the sending key and the webhook signing key. */
export async function forgetMailgunKeys(actor: { id: number; name: string }): Promise<void> {
  await deleteSecret("mailgun.apiKey");
  await deleteSecret("mailgun.sendingKey");
  await deleteSecret("mailgun.webhookSigningKey");
  await logActivity({ actorId: actor.id, type: "mailgun.keysRemoved", summary: `${actor.name} removed the saved Mailgun keys` });
}
