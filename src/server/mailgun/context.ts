import { normalizeEmail } from "@/core/email-address";
import { ownMailboxRuleFrom, type RepliesMode } from "@/core/sending/own-mailbox";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { db, dbWrite } from "../db";
import { getSecret, type SecretKey } from "../secrets";
import { getSettings } from "../settings";
import { assertKeyMatchesTarget, isFakeMode, mailgunApiBase } from "./base-url";
import { MailgunClient } from "./client";
import type { MailgunRegion, SendGuard } from "./types";

/**
 * Everything a Mailgun caller needs, loaded in one place (M3-DESIGN §4.2.4): the sending domain from Settings, the
 * keys from Secrets, and ready clients. Returns a plain "not connected" reason instead of throwing when something is
 * missing, so loops can wait and pages can say what to do.
 */

export type MailgunContext = {
  connected: true;
  domain: string;
  region: MailgunRegion;
  domainId: number;
  /** The Developer key: everything except sends when a sending key is saved. */
  client: MailgunClient;
  /** The domain sending key when saved, else `client`: POST /messages only. */
  sendClient: MailgunClient;
  fakeMode: boolean;
  /** MAIN-DOMAIN-DESIGN O1: how the app sends (`loadTeamFrom().replies`); "app" = per-person or shared-From mode. */
  replies: RepliesMode;
  /** MAIN-DOMAIN-DESIGN O3: own-mailbox mode, the saved From when it fits (`loadTeamFrom().ownFrom`); else null. */
  ownFrom: string | null;
  /**
   * MAIN-DOMAIN-DESIGN O6: `ownMailboxRuleFrom(replies, ownFrom)`: null in app mode (today's sender check), the own From
   * in own-mailbox mode, "" there while no From fits (every send refused). Both clients carry it.
   */
  ownMailboxFrom: string | null;
};

export type MailgunContextResult =
  | MailgunContext
  | { connected: false; reason: "practice-copy" | "no-domain" | "no-key"; text: string };

export const NOT_CONNECTED_TEXT = {
  "practice-copy": "The practice copy never talks to Mailgun.",
  "no-domain": "Mailgun isn't connected yet. Open Settings › Sending & Mailgun.",
  "no-key": "The Mailgun API key isn't saved yet. Open Settings › Sending & Mailgun.",
  mismatch:
    "The saved Mailgun key doesn't fit this server (test key on real Mailgun, or the other way round). Save the right key in Settings › Sending & Mailgun.",
  unreadable:
    "The saved Mailgun key can't be read: the app's encryption key changed. Save the key again in Settings › Sending & Mailgun.",
} as const;

function regionOf(v: unknown): MailgunRegion {
  return v === "US" ? "US" : "EU";
}

/** A secret, or "unreadable" when it can't be decrypted (the encryption key in .env changed). */
async function readSecret(name: SecretKey): Promise<string | null | "unreadable"> {
  try {
    return await getSecret(name);
  } catch {
    return "unreadable";
  }
}

/** Options passed to both clients. `retryDelayMs` is for tests (() => 0), so fake 404s and 429s don't wait. */
export type MailgunContextOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  retryDelayMs?: (attempt: number) => number;
};

/**
 * The connected Mailgun context, or why there is none. Also makes sure a SendingDomain row exists for the domain
 * (connect creates it; this only repairs a missing row). In a test run without the fake server this throws, on
 * purpose (mailgunApiBase).
 */
export async function getMailgunContext(opts: MailgunContextOptions = {}): Promise<MailgunContextResult> {
  const s = await getSettings(["practice.copy", "mailgun.domain", "mailgun.region"] as const);
  if (s["practice.copy"]) return { connected: false, reason: "practice-copy", text: NOT_CONNECTED_TEXT["practice-copy"] };
  const domain = (s["mailgun.domain"] ?? "").trim().toLowerCase();
  if (!domain) return { connected: false, reason: "no-domain", text: NOT_CONNECTED_TEXT["no-domain"] };
  const apiKey = await readSecret("mailgun.apiKey");
  if (apiKey === "unreadable") return { connected: false, reason: "no-key", text: NOT_CONNECTED_TEXT.unreadable };
  if (!apiKey) return { connected: false, reason: "no-key", text: NOT_CONNECTED_TEXT["no-key"] };

  const region = regionOf(s["mailgun.region"]);
  const baseUrl = mailgunApiBase(region);
  try {
    assertKeyMatchesTarget(apiKey, baseUrl);
  } catch {
    return { connected: false, reason: "no-key", text: NOT_CONNECTED_TEXT.mismatch };
  }

  let row = await db.sendingDomain.findUnique({ where: { name: domain }, select: { id: true } });
  if (!row) {
    row = await dbWrite((c) =>
      c.sendingDomain.upsert({
        where: { name: domain },
        create: { name: domain, region, active: true },
        update: {},
        select: { id: true },
      }),
    );
  }

  // MAIN-DOMAIN-DESIGN O1, O6: the mode and the own From come from the one reader (never the setting raw).
  const team = await loadTeamFrom();
  const ownMailboxFrom = ownMailboxRuleFrom(team.replies, team.ownFrom);
  const shared = { region, baseUrl, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, retryDelayMs: opts.retryDelayMs };
  const client = new MailgunClient({ apiKey, ...shared, ownMailboxFrom });
  let sendClient = client;
  const sendingKey = await readSecret("mailgun.sendingKey");
  if (sendingKey && sendingKey !== "unreadable") {
    try {
      assertKeyMatchesTarget(sendingKey, baseUrl);
      sendClient = new MailgunClient({ apiKey: sendingKey, ...shared, ownMailboxFrom });
    } catch {
      // A sending key that doesn't fit this server is ignored; the Developer key sends instead.
    }
  }
  return {
    connected: true,
    domain,
    region,
    domainId: row.id,
    client,
    sendClient,
    fakeMode: isFakeMode(),
    replies: team.replies,
    ownFrom: team.ownFrom,
    ownMailboxFrom,
  };
}

/** Domains whose events still matter: the active one, plus inactive ones that sent live email in the last 60 days. */
export async function domainsToSync(now: Date): Promise<Array<{ id: number; name: string; region: MailgunRegion }>> {
  const since = new Date(now.getTime() - 60 * 86_400_000);
  const rows = await db.sendingDomain.findMany({
    where: { OR: [{ active: true }, { lastLiveSendAt: { gte: since } }] },
    select: { id: true, name: true, region: true, active: true },
    orderBy: [{ active: "desc" }, { id: "asc" }],
  });
  return rows.map((r) => ({ id: r.id, name: r.name, region: regionOf(r.region) }));
}

/** The context's Developer-key client for `region` (an older domain may live in the other region). */
export function clientFor(ctx: MailgunContext, region: MailgunRegion): MailgunClient {
  return ctx.client.forRegion(region);
}

/**
 * Every saved Mailgun secret (the address check key included, M5-DESIGN §5.2) plus its Basic-auth form
 * base64("api:" + key), for describeJobError/redactText.
 */
export async function mailgunSecrets(): Promise<string[]> {
  const out = new Set<string>();
  for (const name of ["mailgun.apiKey", "mailgun.sendingKey", "mailgun.webhookSigningKey", "verification.apiKey"] as const) {
    const v = await readSecret(name);
    if (!v || v === "unreadable") continue;
    out.add(v);
    out.add(Buffer.from("api:" + v).toString("base64"));
  }
  return [...out];
}

/** Loads Settings "sending.goLive"/"sending.testList" (and the user's reply inbox when userId is given) as a SendGuard. */
export async function loadSendGuard(opts: { userId?: number } = {}): Promise<SendGuard> {
  const s = await getSettings(["sending.goLive", "sending.testList"] as const);
  const testList = new Set<string>();
  for (const a of Array.isArray(s["sending.testList"]) ? s["sending.testList"] : []) {
    const n = typeof a === "string" ? normalizeEmail(a) : null;
    if (n) testList.add(n);
  }
  let ownInbox: string | null = null;
  if (opts.userId !== undefined) {
    const user = await db.user.findUnique({ where: { id: opts.userId }, select: { replyInbox: true, email: true } });
    ownInbox = user ? normalizeEmail(user.replyInbox || user.email) : null;
  }
  return { goLive: s["sending.goLive"] === true, testList, ...(opts.userId !== undefined ? { ownInbox } : {}) };
}
