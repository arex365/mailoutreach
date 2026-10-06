import { parseEmail } from "@/core/email-address";

/**
 * Mailgun reply routes (PLAN B6.10, M3-DESIGN §4.5.4). Pure: builds the exact route values the app keeps in Mailgun,
 * reads back which routes are ours, and checks forward targets. The server sync (src/server/services/mailgun/routes.ts)
 * talks to Mailgun; the Domain checklist shows the same values for the guide's manual fallback.
 *
 * One route per sender address (priority 10), one catch-all per sending domain (priority 100) and one for dmarc@
 * (priority 50). Every expression is an anchored, escaped regex, so a route catches exactly its own address, never a
 * look-alike on another domain in the account (routes are account-wide). Descriptions start with "outreach-app:",
 * which is how the app recognises its own routes among any others in the account.
 */

export const ROUTE_DESC_PREFIX = "outreach-app:";

/** Evaluation order in Mailgun: smaller runs first. Senders before dmarc@ before the catch-all. */
export const SENDER_ROUTE_PRIORITY = 10;
export const DMARC_ROUTE_PRIORITY = 50;
export const CATCH_ALL_ROUTE_PRIORITY = 100;

/** The local part of the probe address used to check which route catches unknown addresses. */
export const ROUTE_CHECK_LOCAL_PREFIX = "pp-route-check";

export type RouteSpec = { priority: number; description: string; expression: string; actions: string[] };

/** Escapes every regex special character Mailgun's (Python) regex knows: \ ^ $ . | ? * + ( ) [ ] { }. */
export function escapeRouteRegex(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, (c) => `\\${c}`);
}

function matchRecipient(pattern: string): string {
  return `match_recipient("${pattern}")`;
}

function forward(to: string): string {
  return `forward("${to}")`;
}

function storeNotify(url: string): string {
  return `store(notify="${url}")`;
}

const STOP = "stop()";

/**
 * A sender's route: `match_recipient("^ali@send\.example\.com$")` → forward to the inbox, store and notify the app
 * (the inbound webhook), stop. `forwardTo` must already have passed isSafeForwardAddress.
 */
export function senderRouteSpec(i: { senderAddressId: number; address: string; forwardTo: string; notifyUrl: string }): RouteSpec {
  return {
    priority: SENDER_ROUTE_PRIORITY,
    description: `${ROUTE_DESC_PREFIX}sender:${i.senderAddressId}`,
    expression: matchRecipient(`^${escapeRouteRegex(i.address.trim().toLowerCase())}$`),
    actions: [forward(i.forwardTo.trim()), storeNotify(i.notifyUrl), STOP],
  };
}

/**
 * The catch-all for unknown addresses on one sending domain: `match_recipient("^.*@send\.example\.com$")` with the same
 * actions as a sender route, to the Owner's inbox. An anchored domain regex, not catch_all(): `/routes/match` can check
 * it, and other domains in the same Mailgun account are left alone (§9.2 item 12).
 */
export function catchAllRouteSpec(i: { domain: string; forwardTo: string; notifyUrl: string }): RouteSpec {
  const domain = i.domain.trim().toLowerCase();
  return {
    priority: CATCH_ALL_ROUTE_PRIORITY,
    description: `${ROUTE_DESC_PREFIX}catchall:${domain}`,
    expression: matchRecipient(`^.*@${escapeRouteRegex(domain)}$`),
    actions: [forward(i.forwardTo.trim()), storeNotify(i.notifyUrl), STOP],
  };
}

/** DMARC reports to dmarc@<domain>: forwarded to the Owner, never stored or shown in the app. */
export function dmarcRouteSpec(i: { domain: string; forwardTo: string }): RouteSpec {
  const domain = i.domain.trim().toLowerCase();
  return {
    priority: DMARC_ROUTE_PRIORITY,
    description: `${ROUTE_DESC_PREFIX}dmarc:${domain}`,
    expression: matchRecipient(`^dmarc@${escapeRouteRegex(domain)}$`),
    actions: [forward(i.forwardTo.trim()), STOP],
  };
}

/** What an app route is for, from its description; null for routes that aren't the app's. */
export function parseRouteDescription(
  d: string,
): { kind: "sender"; senderAddressId: number } | { kind: "catchall" | "dmarc"; domain: string } | null {
  const text = (d ?? "").trim();
  if (!text.startsWith(ROUTE_DESC_PREFIX)) return null;
  const rest = text.slice(ROUTE_DESC_PREFIX.length);
  const sender = /^sender:(\d{1,10})$/.exec(rest);
  if (sender) {
    const id = Number(sender[1]);
    return Number.isSafeInteger(id) && id > 0 ? { kind: "sender", senderAddressId: id } : null;
  }
  const other = /^(catchall|dmarc):([a-z0-9.-]+)$/i.exec(rest);
  if (other) return { kind: other[1]!.toLowerCase() as "catchall" | "dmarc", domain: other[2]!.toLowerCase() };
  return null;
}

/** True when Mailgun's route already does exactly what the spec says: same priority, expression and actions, in order. */
export function sameRoute(route: RouteSpec, spec: RouteSpec): boolean {
  if (Number(route.priority) !== spec.priority) return false;
  if (route.expression !== spec.expression) return false;
  if (route.actions.length !== spec.actions.length) return false;
  return route.actions.every((a, i) => a === spec.actions[i]);
}

/** Characters that would break out of `forward("…")` or make it a list of targets. */
const UNSAFE_FORWARD_CHARS = /["<>()[\]\\,;\s]/;

/**
 * parseEmail ok, no quotes, brackets, commas or spaces, and not on (or under) any of `sendingDomains`: a reply inbox on a
 * sending domain would make forward() hand the reply back to Mailgun, which forwards it again (a mail loop).
 */
export function isSafeForwardAddress(email: string, sendingDomains: readonly string[]): boolean {
  const raw = (email ?? "").trim();
  if (!raw || UNSAFE_FORWARD_CHARS.test(raw)) return false;
  const parsed = parseEmail(raw);
  if (!parsed || parsed.email.toLowerCase() !== raw.toLowerCase()) return false;
  const domain = parsed.domain.toLowerCase();
  return !sendingDomains.some((d) => {
    const sd = (d ?? "").trim().toLowerCase().replace(/\.+$/, "");
    return Boolean(sd) && (domain === sd || domain.endsWith(`.${sd}`));
  });
}

/** The sending domain `email` sits on (or under), or null. For the "would loop" messages. */
export function sendingDomainOf(email: string, sendingDomains: readonly string[]): string | null {
  const parsed = parseEmail(email);
  if (!parsed) return null;
  const domain = parsed.domain.toLowerCase();
  for (const d of sendingDomains) {
    const sd = (d ?? "").trim().toLowerCase().replace(/\.+$/, "");
    if (sd && (domain === sd || domain.endsWith(`.${sd}`))) return sd;
  }
  return null;
}

/** The two public-address sentences (M6-DESIGN §5.2: the same "run setup.bat again (and update.bat …)" everywhere). */
export const PUBLIC_ADDRESS_TEXTS = {
  missing:
    "The app's public address isn't set yet. Follow the Cloudflare guide (docs\\setup\\3-cloudflare.md), then run setup.bat again (and update.bat if the app runs as a Windows service).",
  notHttps:
    "The public address must start with https://. Run setup.bat again to change it (and update.bat if the app runs as a Windows service).",
} as const;

/**
 * B1 guard for webhooks and routes: Mailgun may only be pointed at an https public address (Cloudflare). In fake mode
 * (the local fake Mailgun server) `http://127.0.0.1:<port>` is accepted too, for the lead's manual checks. Returns the
 * plain problem, or null when the address is fine.
 */
export function publicAddressProblem(pub: string | null, fakeMode: boolean): string | null {
  const value = (pub ?? "").trim().replace(/\/+$/, "");
  if (!value) return PUBLIC_ADDRESS_TEXTS.missing;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return PUBLIC_ADDRESS_TEXTS.notHttps;
  }
  if (u.username || u.password) return PUBLIC_ADDRESS_TEXTS.notHttps;
  if (u.protocol === "https:" && u.hostname) return null;
  if (fakeMode && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(value)) return null;
  return PUBLIC_ADDRESS_TEXTS.notHttps;
}

/** "pp-route-check-<hex>@<domain>": an address no sender can have (reserved), to see which route catches unknown mail. */
export function routeCheckAddress(domain: string, random: string): string {
  const hex = (random ?? "").toLowerCase().replace(/[^a-f0-9]/g, "") || "0";
  return `${ROUTE_CHECK_LOCAL_PREFIX}-${hex}@${domain.trim().toLowerCase()}`;
}
