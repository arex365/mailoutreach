import { getDomain as registrableDomain } from "tldts";
import type {
  ChecklistGroup,
  ChecklistRecord,
  ChecklistRow,
  ChecklistRowKey,
  CheckStatus,
  TunnelState,
} from "@/core/system-state";
import { PLAN_TEXTS, type PlanLimits } from "@/core/mailgun/plan";
import { replyTestPassedFor } from "@/core/reply-test";
import { WEBSITE_DOMAINS } from "@/core/sender-address";
import { NEVER_MAILGUN_MX_TEXT, OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS, validateOwnMailboxFrom } from "@/core/sending/own-mailbox";
import { formatShortDate } from "@/core/time/format";
import type { DmarcPolicy } from "./dmarc";
import { agree, type Agreement, type DnsAnswer } from "./types";
import { spfHasAll, spfIncludes, spfLookupTerms, spfRecords } from "./spf";

/**
 * The domain checklist (Settings › Domain checklist, M3-DESIGN §5.3, research deliverability-dns.md "Checklist rows"):
 * one pure builder per row. The server side (@/server/services/checks/domain-check) gathers the facts (Mailgun's
 * read-back, two public resolvers, SystemState) and writes the rows to SystemState "domain.check"; the Settings pages
 * (P5), the mode gates and the send holds (P3) read them.
 *
 * DNS rows compare what two resolvers see with Mailgun's own record list (never hard-coded values): both right → ok;
 * only one → warn "Still spreading. Check again in 30 minutes."; both answered and neither right → bad; a timeout on
 * either and neither right → unknown "Couldn't check right now." (a timeout never makes a row red).
 *
 * Shared From address (SHARED-FROM-DESIGN §3.2, §5, F10): with `facts.from` every row stays on the sending domain,
 * except that the DMARC row checks the From domain (with a strict-alignment check), the DKIM row names the signer (and,
 * when Mailgun lists no DKIM record, reads it from the reply test's pasted original), the Gmail dashboard and Domain age
 * rows name the From domain, and the reply-test row counts only a pass for today's From address. Two rows follow the
 * DMARC row, titled with the From domain: from-mx (its MX stays with the mail provider, never Mailgun) and from-spf (its
 * own SPF record, never blocking). No row ever asks for an MX record on the From domain pointing to Mailgun (§2.5).
 * Without `facts.from` (per-person mode) every row is exactly as before, except that a 1024-bit DKIM key is "ok" (F10).
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.3, §5, O10–O12; `facts.ownMailbox`): the app sends through the domain of the
 * Owner's own mailbox, so nothing inbound reaches Mailgun. Its own list of rows: no mx, spam-filter, retention,
 * reply-routes or from-spf; from-mx for the sending domain itself (its MX stays with the mail provider: red on a Mailgun
 * MX, a null or missing MX, or Cloudflare Email Routing, every red fix naming the last good MX and ending with
 * NEVER_MAILGUN_MX_TEXT); an include-aware SPF row that never shows a record box or an SPF value; "info" rows for what
 * the plan or a missing public address leave out. A website domain (WEBSITE_DOMAINS) checked in app mode never gets an
 * MX record box or an SPF value either (O37). Pure; no I/O.
 */

// ───────────────────────── facts ─────────────────────────

/** One fact read from Mailgun or elsewhere: the value, or why it couldn't be read. */
export type Fact<T> = { ok: true; value: T } | { ok: false; kind: "not-found" | "auth" | "unreachable" | "other"; message: string };

/** Both resolvers' answers (1.1.1.1 and 8.8.8.8). */
export type TwoAnswers<T> = { a: DnsAnswer<T>; b: DnsAnswer<T> };

/** A DNS record as Mailgun lists it (GET /v4/domains/{d}). */
export type DnsRecordFact = {
  recordType: string;
  name: string | null;
  value: string;
  priority: string | null;
  valid: string;
  isActive: boolean;
  cached: string[];
};

/** What Mailgun says about the domain. */
export type MailgunDomainFact = {
  state: string | null;
  isDisabled: boolean;
  disabledReason: string | null;
  spamAction: string | null;
  webPrefix: string;
  webScheme: "http" | "https" | null;
  /** Message retention, seconds. */
  messageTtl: number | null;
  webhooksRedactPii: boolean | null;
  sending: DnsRecordFact[];
  receiving: DnsRecordFact[];
};

export type DkimFact = {
  /** Full host name, e.g. "pdk1._domainkey.send.example.com". */
  name: string;
  recordType: "TXT" | "CNAME";
  /** Mailgun's value (the whole TXT record, or the CNAME target). */
  expected: string;
  answers: TwoAnswers<string[]>;
  /** A lookups of the name (a proxied CNAME answers IPs instead), when the CNAME was missing on both. */
  proxied: TwoAnswers<string[]> | null;
  /** The same record under the doubled name "<name>.<zone>" (a DNS panel appended the zone). */
  doubled: TwoAnswers<string[]> | null;
};

/** One resolver's DMARC tree walk (checks/dmarc-walk). */
export type DmarcFind = {
  /** The name whose `_dmarc` record applies, or null. */
  at: string | null;
  policy: DmarcPolicy | null;
  duplicates: boolean;
  /** The policy comes from a parent domain. */
  inherited: boolean;
  /** Set when a lookup failed (timeout): the result may be incomplete. */
  error: string | null;
};

/**
 * One resolver's walk of the SPF include tree, from the SPF record that resolver itself answered (own-mailbox review
 * DOMAIN-1): the DNS lookups it costs (a repeated include counted every time), whether that count is sure, the included
 * names without an SPF record, and every name looked up.
 */
export type SpfWalk = { count: number; complete: boolean; dangling: string[]; names: string[] };

/**
 * Review DOMAIN-1: the walk of 1.1.1.1 and the walk of 8.8.8.8 (null where that resolver has no SPF record). The SPF row
 * of the Owner's everyday domain (own-mailbox mode, and a website domain in app mode, O37) compares them, so a DNS change
 * that only one resolver sees yet says "Still spreading" instead of a fix. Absent = one walk only (the older facts).
 */
export type SpfWalks = [SpfWalk | null, SpfWalk | null];

export type DnsFacts = {
  /** TXT records at the domain itself (SPF, Google Postmaster verification). */
  txt: TwoAnswers<string[]>;
  /**
   * DNS lookups the SPF record costs, includes counted recursively (first resolver). `names`: every include the walk
   * looked up (MAIN-DOMAIN-DESIGN §5), read only by the website-domain guard's SPF row (O37); absent = not gathered.
   * For a website domain (O37, review DOMAIN-4) the gatherer also fills `dangling` and `walks`, as for own-mailbox mode.
   */
  spfLookups: { count: number; complete: boolean; names?: string[]; dangling?: string[]; walks?: SpfWalks } | null;
  dkim: DkimFact[];
  mx: TwoAnswers<Array<{ priority: number; exchange: string }>>;
  tracking: {
    host: string;
    expected: string | null;
    cname: TwoAnswers<string[]>;
    a: TwoAnswers<string[]> | null;
    doubled: TwoAnswers<string[]> | null;
  };
  dmarc: {
    a: DmarcFind;
    b: DmarcFind;
    /** Report domains outside the policy's own organisation → whether they agreed to receive reports (null: couldn't check). */
    ruaAuthorized: Record<string, boolean | null>;
  };
};

/** Shared-From mode only (SHARED-FROM-DESIGN §5): the From domain's own DNS, never Mailgun's. */
export type FromDomainFacts = {
  address: string;
  domain: string;
  /** Set when the saved From address doesn't fit the sending domain; `dns` is null then. */
  problem: string | null;
  /** The DKIM signer Mailgun lists for the sending domain (signingDomainOf), or null. */
  signingDomain: string | null;
  /**
   * The passing DKIM signer read from the reply test's pasted original, when that original belongs to today's sending
   * domain and From address; null otherwise. The DKIM row's fallback when Mailgun lists no DKIM record (§3.2).
   */
  originalSigner: string | null;
  /** Whether an original for today's domain and From was pasted at all (null signer + true = "no valid signature"). */
  originalPasted: boolean;
  dns: {
    txt: TwoAnswers<string[]>;
    /**
     * `names` (MAIN-DOMAIN-DESIGN §5, O11): every `include:`/`redirect=` name the walk looked up, in order, dangling ones
     * included (a walk that passed 10 may not list them all); own-mailbox mode's SPF row reads Mailgun's include
     * anywhere in the tree from it. Absent = not gathered (app mode, as before). `walks` (review DOMAIN-1): each
     * resolver's own walk, gathered in own-mailbox mode only; absent = one walk (app mode, as before).
     */
    spfLookups: { count: number; complete: boolean; dangling: string[]; names?: string[]; walks?: SpfWalks } | null;
    mx: TwoAnswers<Array<{ priority: number; exchange: string }>>;
    dmarc: DnsFacts["dmarc"];
  } | null;
};

export type RouteSenderFact = {
  name: string;
  address: string;
  /** SenderAddress.routeStatus: "pending" | "ok" | "mismatch" | "error" | null. */
  status: string | null;
  error: string | null;
  forwardTo: string | null;
  /** Lists holding the forward inbox ("local" = the app's own do-not-email list). */
  lists: string[];
};

export type ChecklistFacts = {
  domain: string;
  region: "EU" | "US";
  now: Date;
  /** The Owner's time zone, for dates in the texts. */
  timeZone: string;
  mailgun: Fact<MailgunDomainFact>;
  /** Mailgun's answer to "re-check the records" when it failed (plain text), else null. */
  verifyError: string | null;
  /** Null when Mailgun's record list couldn't be read. */
  dns: DnsFacts | null;
  certificate: Fact<{ status: "none" | "processing" | "active" | "expired" | "error"; error: string | null }>;
  /** The certificate state "Apply recommended settings" recorded (e.g. "not-in-plan"), or null. */
  setupCertificate: string | null;
  tracking: Fact<{ openActive: boolean; clickActive: boolean; unsubscribeActive: boolean; htmlFooter: string; textFooter: string }>;
  unsubscribeSetup: "A" | "B" | "C";
  messageRetentionDays: number;
  webhooks: { url: string | null; map: Fact<Partial<Record<string, string[]>>> };
  /**
   * The saved key against Mailgun's (GET only, never regenerated). `problem`: Mailgun has no key for the account yet
   * ("missing-at-mailgun", its 400), or the key couldn't be read ("unreachable").
   */
  signingKey: {
    saved: boolean;
    matches: boolean | null;
    problem: { kind: "missing-at-mailgun" | "unreachable"; message: string } | null;
  };
  routes: { senders: RouteSenderFact[]; catchAllRouteId: string | null; listsError: string | null };
  queues: Fact<{ regularDisabled: boolean; reason: string | null }>;
  /** Mailgun-related causes of the current pause (main and `also`). */
  pause: Array<{ kind: string; reason: string; fixText: string }>;
  monthlyLimit: Fact<{ limit: number; current: number; period: string } | null>;
  tunnel: TunnelState;
  publicUrl: string | null;
  fakeMode: boolean;
  replyTest: {
    status: "untested" | "passed" | "failed";
    setup: "A" | "B" | "C";
    domain: string | null;
    decidedAt: string | null;
    /** SHARED-FROM-DESIGN §3.2: the stored decision's shared From address (missing or null = per-person mode). */
    from?: string | null;
    /**
     * MAIN-DOMAIN-DESIGN O13: the stored decision's mode ("own-mailbox"; missing = app mode), so the reply-test row's
     * `replyTestPassedFor(…, { ownMailbox })` counts a pass only in the mode it was decided in.
     */
    replies?: "own-mailbox";
  };
  domainRegisteredOn: string | null;
  /**
   * M6 (M6-DESIGN §2.8, G7): Setting "remoteAccess.accessOff", the Owner's "We don't use Cloudflare Access". A sign-in
   * page that anyone can reach is then accepted (the app's own sign-in is the only login). Absent = false.
   */
  accessOff?: boolean;
  /** SHARED-FROM-DESIGN §5: the shared From address and its domain's DNS; absent or null = per-person mode. */
  from?: FromDomainFacts | null;
  /**
   * MAIN-DOMAIN-DESIGN §5: own-mailbox mode (Setting "mailgun.replies" = "own-mailbox"): the own-mailbox list of rows,
   * `from` built for the sending domain itself. Absent or false = app mode (today's list; a `WEBSITE_DOMAINS` sending
   * domain then gets the O37 guard).
   */
  ownMailbox?: boolean;
  /** MAIN-DOMAIN-DESIGN O22: the Mailgun plan limits in force (`loadPlanLimits()`); absent or null = no plan facts. */
  plan?: PlanLimits | null;
  /**
   * MAIN-DOMAIN-DESIGN O10: the sending domain's MX at the last own-mailbox check whose from-mx row was "ok"
   * (`DomainCheckState.lastGoodMx` of the same domain and mode), named in every red from-mx fix; absent or null = none.
   */
  lastGoodMx?: Array<{ priority: number; host: string }> | null;
};

// ───────────────────────── wording ─────────────────────────

export const SPREADING = "Still spreading. Check again in 30 minutes.";
export const COULD_NOT_CHECK = "Couldn't check right now.";
/** The fix when the public address isn't set yet (M6-DESIGN §5.2: one sentence everywhere). */
export const PUBLIC_ADDRESS_FIX =
  "Follow the Cloudflare guide (docs\\setup\\3-cloudflare.md), then run setup.bat again (and update.bat if the app runs as a Windows service).";
/** The remote-access row with the Cloudflare Access opt-out on (M6-DESIGN §2.8, G7). */
export const ACCESS_OFF_TEXT =
  "Remote access works. Cloudflare Access is off (Settings › System), so the app's own sign-in is the only login.";
const FIX_MAILGUN_ROW_FIRST = "Fix the 'Mailgun knows your domain' row first.";
const APPLY = "Click Apply recommended settings.";

/** The webhook types the app registers (§4.5.3), with the words the row uses for them. */
const WEBHOOK_WORDS: ReadonlyArray<[string, string]> = [
  ["delivered", "deliveries"],
  ["permanent_fail", "bounces"],
  ["temporary_fail", "temporary failures"],
  ["complained", "complaints"],
  ["unsubscribed", "unsubscribes"],
];

const GROUP: Readonly<Record<ChecklistRowKey, ChecklistGroup>> = {
  "mailgun-domain": "mailgun",
  spf: "dns",
  dkim: "dns",
  mx: "dns",
  "tracking-cname": "dns",
  "https-links": "dns",
  dmarc: "dns",
  "tracking-off": "settings",
  unsubscribe: "settings",
  "spam-filter": "settings",
  retention: "settings",
  "signing-key": "settings",
  webhooks: "settings",
  "reply-routes": "settings",
  "sending-allowed": "settings",
  "monthly-limit": "settings",
  "remote-access": "connection",
  "reply-test": "connection",
  postmaster: "optional",
  "domain-age": "optional",
  // Shared-From mode (SHARED-FROM-DESIGN §3.2): right after dmarc, in the "dns" group.
  "from-mx": "dns",
  "from-spf": "dns",
};

/**
 * Row titles with the domain filled in (§5.3). `d` is the sending domain, except for "from-mx" and "from-spf", whose
 * titles name the From domain (SHARED-FROM-DESIGN §3.2: "Mail for polygonparadise.com stays with your mail provider (MX)").
 */
export function checklistTitle(key: ChecklistRowKey, d: string): string {
  switch (key) {
    case "mailgun-domain":
      return "Mailgun knows your domain";
    case "spf":
      return `Mailgun may send for ${d} (SPF)`;
    case "dkim":
      return "Your emails are signed (DKIM)";
    case "mx":
      return "Replies reach the app (MX)";
    case "tracking-cname":
      return "Unsubscribe links work (tracking CNAME)";
    case "https-links":
      return "Unsubscribe links are secure (HTTPS)";
    case "dmarc":
      return "Mail servers know your policy (DMARC)";
    case "tracking-off":
      return "Open and click tracking are off";
    case "unsubscribe":
      return "Unsubscribe handling is on";
    case "spam-filter":
      return "Spam filter marks, never deletes";
    case "retention":
      return "Stored replies are kept";
    case "signing-key":
      return "Webhook signing key saved";
    case "webhooks":
      return "Mailgun tells the app what happened";
    case "reply-routes":
      return "Replies reach each sender";
    case "sending-allowed":
      return "Mailgun lets you send";
    case "monthly-limit":
      return "Monthly safety limit";
    case "remote-access":
      return "Remote access works";
    case "reply-test":
      return "Reply test";
    case "postmaster":
      return "Gmail dashboard";
    case "domain-age":
      return "Domain age";
    case "from-mx":
      return `Mail for ${d} stays with your mail provider (MX)`;
    case "from-spf":
      return `${d}'s SPF record (your everyday email)`;
  }
}

// ───────────────────────── helpers ─────────────────────────

function row(
  f: ChecklistFacts,
  key: ChecklistRowKey,
  status: CheckStatus,
  text: string,
  fix: string | null = null,
  records: ChecklistRecord[] = [],
  detail: string | null = null,
): ChecklistRow {
  return { key, group: GROUP[key], status, title: checklistTitle(key, f.domain), text, fix, records, detail };
}

/**
 * A shared-From row ("from-mx", "from-spf"): titled with the From domain, never the sending domain (§3.2: "Mail for
 * polygonparadise.com stays with your mail provider (MX)").
 */
function fromRow(
  x: FromDomainFacts,
  key: "from-mx" | "from-spf",
  status: CheckStatus,
  text: string,
  fix: string | null = null,
  detail: string | null = null,
): ChecklistRow {
  return { key, group: GROUP[key], status, title: checklistTitle(key, clean(x.domain)), text, fix, records: [], detail };
}

function clean(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

/** `host` is `org` itself or a name under it. */
function underOrg(host: string, org: string): boolean {
  const h = clean(host);
  const o = clean(org);
  return h === o || h.endsWith(`.${o}`);
}

/**
 * The DKIM signer Mailgun lists for the sending domain (SHARED-FROM-DESIGN §5): the part after `._domainkey.` of the
 * first active TXT/CNAME sending record whose name contains `._domainkey.` ("pdk1._domainkey.polygonparadise.com" →
 * "polygonparadise.com"); null when Mailgun lists none.
 */
export function signingDomainOf(m: Pick<MailgunDomainFact, "sending">): string | null {
  for (const r of m.sending) {
    const type = r.recordType.toUpperCase();
    const name = clean(r.name ?? "");
    if (!r.isActive || (type !== "TXT" && type !== "CNAME")) continue;
    const i = name.indexOf("._domainkey.");
    if (i < 0) continue;
    const signer = name.slice(i + "._domainkey.".length);
    if (signer) return signer;
  }
  return null;
}

/** Shared-From mode with a From address that fits and its DNS read (the rows that change with it); null otherwise. */
type TeamFacts = {
  /** Today's shared From address (lowercase). */
  address: string;
  /** Its domain: the main domain of the sending domain ("polygonparadise.com"). */
  org: string;
  dns: NonNullable<FromDomainFacts["dns"]>;
  /** The DKIM signer Mailgun lists, else null. */
  signer: string | null;
  /** The passing signer read from today's pasted original, else null. */
  originalSigner: string | null;
  originalPasted: boolean;
};

function teamOf(f: ChecklistFacts): TeamFacts | null {
  const x = f.from;
  if (!x || x.problem || !x.dns) return null;
  return {
    address: x.address.trim().toLowerCase(),
    org: clean(x.domain),
    dns: x.dns,
    signer: x.signingDomain ? clean(x.signingDomain) : null,
    originalSigner: x.originalSigner ? clean(x.originalSigner) : null,
    originalPasted: x.originalPasted,
  };
}

/** The DNS zone the owner edits: the registrable domain ("send.example.com" → "example.com"). */
export function zoneOf(domain: string): string {
  return registrableDomain(clean(domain)) ?? clean(domain);
}

/** A host name as typed in the zone's DNS panel: "@" for the zone itself, else the part before the zone. */
export function relativeName(fqdn: string, zone: string): string {
  const h = clean(fqdn);
  const z = clean(zone);
  if (h === z) return "@";
  if (h.endsWith(`.${z}`)) return h.slice(0, -(z.length + 1));
  return h;
}

function values<T>(x: DnsAnswer<T>): T | null {
  return x.ok ? x.value : null;
}

/** Everything both resolvers saw, de-duplicated (for "Details" and the record boxes). */
function seen(two: TwoAnswers<string[]>): string[] {
  return [...new Set([...(values(two.a) ?? []), ...(values(two.b) ?? [])])];
}

function answerText(label: string, x: DnsAnswer<unknown>): string {
  if (x.ok) {
    const v = x.value;
    const list = Array.isArray(v) ? v.map((i) => (typeof i === "string" ? i : JSON.stringify(i))) : [String(v)];
    return `${label}: ${list.length ? list.join(" | ") : "(empty)"}`;
  }
  return `${label}: ${x.code}${x.detail ? ` (${x.detail})` : ""}`;
}

function detailOf(two: TwoAnswers<unknown>, extra?: string | null): string {
  return [answerText("1.1.1.1", two.a), answerText("8.8.8.8", two.b), extra].filter(Boolean).join("\n");
}

/** Status and a default text for an agreement (the "none" text is the row's own). */
function byAgreement(ag: Agreement): { status: CheckStatus; text: string } | null {
  if (ag === "both") return null;
  if (ag === "one") return { status: "warn", text: SPREADING };
  if (ag === "unknown") return { status: "unknown", text: COULD_NOT_CHECK };
  return null;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function mailgunUnavailable(f: ChecklistFacts, key: ChecklistRowKey): ChecklistRow {
  return row(f, key, "unknown", COULD_NOT_CHECK, FIX_MAILGUN_ROW_FIRST);
}

/** A row for a fact that couldn't be read: grey "Couldn't check right now.", the reason under "Details". */
function unreadable(f: ChecklistFacts, key: ChecklistRowKey, message: string): ChecklistRow {
  return row(f, key, "unknown", COULD_NOT_CHECK, null, [], message);
}

// ───────────────────────── rows ─────────────────────────

/**
 * `own` (own-mailbox mode, MAIN-DOMAIN-DESIGN §3.3, O12): the not-active fix never sends the Owner to "the DNS records"
 * on Mailgun's page, which list Mailgun's MX records (`OWN_MAILBOX_TEXTS.mailgunDomainFix`); every other case as today.
 */
function mailgunDomainRow(f: ChecklistFacts, own = false): ChecklistRow {
  const d = f.domain;
  if (!f.mailgun.ok) {
    if (f.mailgun.kind === "not-found") {
      const other = f.region === "EU" ? "US" : "EU";
      return row(
        f,
        "mailgun-domain",
        "bad",
        `Mailgun can't find ${d} in the ${f.region} region. If you created the domain in the ${other} region, change Region to ${other}.`,
        `If you haven't added it yet: in Mailgun, open Send › Domains › Add new domain, type ${d} and choose ${f.region}.`,
        [],
        f.mailgun.message,
      );
    }
    if (f.mailgun.kind === "auth") {
      return row(
        f,
        "mailgun-domain",
        "bad",
        "Mailgun didn't accept the saved API key.",
        "In Mailgun, open API Security, create a key with the Developer role and paste it in Settings › Sending & Mailgun.",
        [],
        f.mailgun.message,
      );
    }
    return row(f, "mailgun-domain", "unknown", COULD_NOT_CHECK, null, [], f.mailgun.message);
  }
  const m = f.mailgun.value;
  const detail = [`Mailgun state: ${m.state ?? "unknown"}`, f.verifyError].filter(Boolean).join("\n");
  if (m.isDisabled) {
    return row(
      f,
      "mailgun-domain",
      "bad",
      `Mailgun has disabled ${d}${m.disabledReason ? `: ${m.disabledReason}` : ""}.`,
      "Check the banner in Mailgun, or ask Mailgun's support why.",
      [],
      detail,
    );
  }
  if ((m.state ?? "").toLowerCase() !== "active") {
    return row(
      f,
      "mailgun-domain",
      "bad",
      `Mailgun has your domain (${f.region}) but hasn't confirmed your records yet.`,
      own ? OWN_MAILBOX_TEXTS.mailgunDomainFix(clean(d)) : "Add the DNS records below, wait a few minutes, then click Check again.",
      [],
      detail,
    );
  }
  return row(f, "mailgun-domain", "ok", `Mailgun has your domain (${f.region}) and has confirmed your records.`, null, [], detail);
}

/** Mailgun's SPF record (the sending TXT record that starts with v=spf1). */
function expectedSpf(m: MailgunDomainFact): string | null {
  return m.sending.find((r) => r.recordType.toUpperCase() === "TXT" && /^v=spf1(\s|$)/i.test(r.value.trim()))?.value.trim() ?? null;
}

function spfRow(f: ChecklistFacts, m: MailgunDomainFact, dns: DnsFacts, zone: string): ChecklistRow {
  const d = f.domain;
  const expected = expectedSpf(m) ?? "v=spf1 include:mailgun.org ~all";
  const wanted = spfIncludes(expected);
  const found = seen(dns.txt).filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  const records: ChecklistRecord[] = [{ type: "TXT", name: relativeName(d, zone), fqdn: d, value: expected, priority: null, found }];
  const detail = detailOf(dns.txt, dns.spfLookups ? `DNS lookups in the SPF record: ${dns.spfLookups.count}${dns.spfLookups.complete ? "" : " or more"}` : null);

  const counts = [values(dns.txt.a), values(dns.txt.b)].map((t) => (t ? spfRecords(t).length : 0));
  const most = Math.max(...counts);
  if (most >= 2) {
    const others = [...new Set(found.flatMap((r) => spfIncludes(r)).filter((i) => !wanted.includes(i)))];
    const merged = `v=spf1 ${[...wanted, ...others].map((i) => `include:${i}`).join(" ")} ~all`;
    return row(
      f,
      "spf",
      "bad",
      `You have ${most} SPF records; mail servers ignore all of them.`,
      `Merge them into one: ${merged}`,
      records,
      detail,
    );
  }
  const good = (txt: string[]) => {
    const spf = spfRecords(txt);
    return spf.length === 1 && wanted.every((w) => spfIncludes(spf[0]!).includes(w)) && !spfHasAll(spf[0]!, "+");
  };
  const ag = agree(dns.txt.a, dns.txt.b, good);
  const other = byAgreement(ag);
  if (other) return row(f, "spf", other.status, other.text, null, records, detail);
  if (ag === "none") {
    const one = found[0];
    if (!one) {
      return row(f, "spf", "bad", `No SPF record found for ${d}.`, `Add a TXT record. Name: ${relativeName(d, zone)}. Value: ${expected}`, records, detail);
    }
    if (spfHasAll(one, "+")) {
      return row(f, "spf", "bad", "Your SPF record lets anyone send email for your domain (+all).", "Change +all at the end to ~all.", records, detail);
    }
    const extra = spfIncludes(one).filter((i) => !wanted.includes(i));
    const merged = `v=spf1 ${[...wanted, ...extra].map((i) => `include:${i}`).join(" ")} ~all`;
    return row(f, "spf", "bad", "Your SPF record doesn't include Mailgun.", `Change it to: ${merged}`, records, detail);
  }
  if (dns.spfLookups && dns.spfLookups.count > 10) {
    return row(
      f,
      "spf",
      "warn",
      "Too many services in your SPF record; some mail servers will reject it.",
      "Remove the ones you don't use.",
      records,
      detail,
    );
  }
  return row(f, "spf", "ok", `Mailgun is allowed to send email for ${d}.`, null, records, detail);
}

/** The p= value of a DKIM TXT record, whitespace removed (same rule as core/dns/dkim, which needs node:crypto). */
function pValue(record: string): string | null {
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0 || part.slice(0, eq).trim().toLowerCase() !== "p") continue;
    const v = part.slice(eq + 1).replace(/\s+/g, "");
    return v || null;
  }
  return null;
}

/** 1024 or 2048 from the length of a base64 RSA key (216 / 392 characters), else null. */
export function keyBitsFromLength(p: string | null): number | null {
  if (!p) return null;
  const len = p.replace(/=+$/, "").length;
  if (len >= 200 && len <= 230) return 1024;
  if (len >= 380 && len <= 400) return 2048;
  if (len >= 700 && len <= 740) return 4096;
  return null;
}

/** " (2048-bit)", or for a 1024-bit key " (1024-bit; it works, 2048-bit is stronger)" (F10: 1024 is "ok"). */
function bitsText(keyBits: number | null): string {
  if (keyBits === 1024) return " (1024-bit; it works, 2048-bit is stronger)";
  return keyBits ? ` (${keyBits}-bit)` : "";
}

/**
 * Shared-From mode, Mailgun lists no DKIM record for the sending domain (§3.2): the signer comes from the reply test's
 * pasted original for today's domain and From. "unknown" and "warn" never block Live or the reply test, so the reply
 * test can always run and settle the row. The row is built only by a domain check, and pasting an original doesn't
 * start one, so the fixes say to click Check again after the paste (review SCREENS-08).
 */
function teamDkimWithoutRecord(f: ChecklistFacts, t: TeamFacts): ChecklistRow {
  const d = f.domain;
  const org = t.org;
  if (t.originalSigner && underOrg(t.originalSigner, org)) {
    return row(
      f,
      "dkim",
      "ok",
      `Mailgun doesn't list a DKIM record for ${d}, but the reply test's email was signed by ${t.originalSigner} (dkim=pass), which fits your From address.`,
    );
  }
  if (!t.originalPasted) {
    return row(
      f,
      "dkim",
      "unknown",
      `Mailgun didn't list a DKIM record for ${d}. With a From address, ${org} usually signs your emails.`,
      `Run the reply test (below) and paste one test email's original, then click Check again: this row reads the signature from it. If it shows no signature, check in Mailgun (Send › Domains) that ${org} and ${d} are both there, in the same region (US).`,
    );
  }
  return row(
    f,
    "dkim",
    "warn",
    `The reply test's email carried no valid signature of ${org}.`,
    `Check in Mailgun (Send › Domains) that ${org} is still there and verified, and that ${d} is in the same region (US). Then send the reply test's emails again, paste a new original and click Check again.`,
  );
}

/** The DKIM row's "ok" sentence in shared-From mode: who signs, and whether it matches the From address (§3.2). */
function teamDkimOkText(t: TeamFacts, dns: DnsFacts, keyBits: number | null): string {
  const bits = bitsText(keyBits);
  const org = t.org;
  const first = dns.dkim[0]?.name ?? "";
  const i = first.indexOf("._domainkey.");
  const signer = t.signer ?? (i >= 0 ? clean(first.slice(i + "._domainkey.".length)) : null);
  if (signer === org) return `Your emails carry ${org}'s digital signature${bits}, which matches your From address.`;
  if (signer && underOrg(signer, org)) {
    return `Your emails carry ${signer}'s digital signature${bits}. It fits your From address ${t.address}: same main domain. (${org} doesn't sign them: if you expected it to, check that both domains are in the same Mailgun account and region, US.)`;
  }
  return `Your emails carry ${signer ?? org}'s digital signature${bits}.`;
}

function dkimRow(f: ChecklistFacts, dns: DnsFacts, zone: string, keyBits: number | null, team: TeamFacts | null = null): ChecklistRow {
  const d = f.domain;
  if (dns.dkim.length === 0) {
    if (team) return teamDkimWithoutRecord(f, team);
    return row(f, "dkim", "unknown", "Mailgun didn't list a DKIM record for this domain.", "Check the domain in Mailgun: Send › Domains.");
  }
  const records: ChecklistRecord[] = [];
  const details: string[] = [];
  let worst: { status: CheckStatus; text: string; fix: string | null } | null = null;
  const rank: Record<CheckStatus, number> = { ok: 0, info: 0, off: 0, warn: 1, unknown: 2, bad: 3 };
  const note = (status: CheckStatus, text: string, fix: string | null) => {
    if (!worst || rank[status] > rank[worst.status]) worst = { status, text, fix };
  };

  for (const k of dns.dkim) {
    const name = relativeName(k.name, zone);
    records.push({ type: k.recordType, name, fqdn: k.name, value: k.expected, priority: null, found: seen(k.answers) });
    details.push(`${k.name}\n${detailOf(k.answers)}`);
    if (k.recordType === "TXT") {
      const want = pValue(k.expected);
      const good = (txt: string[]) => txt.some((t) => want !== null && pValue(t) === want);
      const ag = agree(k.answers.a, k.answers.b, good);
      const other = byAgreement(ag);
      if (other) {
        note(other.status, other.text, null);
        continue;
      }
      if (ag === "none") {
        const found = seen(k.answers).filter((t) => pValue(t));
        if (found.length > 0) {
          note("bad", "The DKIM record doesn't match Mailgun's.", "Replace it with the value below.");
        } else if (k.doubled && seen(k.doubled).length > 0) {
          note("bad", `The DKIM record was saved as ${k.name}.${zone}.`, `Edit it and type only ${name} in the Name box.`);
        } else {
          note(
            "bad",
            `The DKIM record for ${d} is missing.`,
            `Add a TXT record. Name: ${name}. Value: the long text below (paste it in one piece; your DNS host splits it).`,
          );
        }
      }
    } else {
      const good = (targets: string[]) => targets.some((t) => clean(t) === clean(k.expected));
      const ag = agree(k.answers.a, k.answers.b, good);
      const other = byAgreement(ag);
      if (other) {
        note(other.status, other.text, null);
        continue;
      }
      if (ag === "none") {
        const found = seen(k.answers);
        if (found.length > 0) {
          note("bad", `${name} points somewhere else (${found.join(", ")}).`, `Change its target to ${k.expected}.`);
        } else if (k.proxied && seen(k.proxied).length > 0) {
          note("bad", `${k.name} is proxied (orange cloud).`, "In Cloudflare, switch it to DNS only.");
        } else if (k.doubled && seen(k.doubled).length > 0) {
          note("bad", `The DKIM record was saved as ${k.name}.${zone}.`, `Edit it and type only ${name} in the Name box.`);
        } else {
          const cnames = dns.dkim.filter((x) => x.recordType === "CNAME").map((x) => `${relativeName(x.name, zone)} → ${x.expected}`);
          note("bad", `The DKIM records for ${d} are missing.`, `Add these CNAME records: ${cnames.join("; ")}. At Cloudflare set DNS only.`);
        }
      }
    }
  }
  const detail = details.join("\n\n");
  const w = worst as { status: CheckStatus; text: string; fix: string | null } | null;
  if (w) return row(f, "dkim", w.status, w.text, w.fix, records, detail);
  // A 1024-bit key is "ok" with a note in both modes (F10): Gmail, Yahoo and Microsoft accept it, and going live needs
  // every go-live row "ok".
  if (team) return row(f, "dkim", "ok", teamDkimOkText(team, dns, keyBits), null, records, detail);
  return row(f, "dkim", "ok", `Your emails carry ${d}'s digital signature${bitsText(keyBits)}.`, null, records, detail);
}

function mxRow(f: ChecklistFacts, m: MailgunDomainFact, dns: DnsFacts, zone: string): ChecklistRow {
  const d = f.domain;
  const expected = m.receiving.filter((r) => r.recordType.toUpperCase() === "MX");
  const wanted = expected.map((r) => clean(r.value));
  const hosts = (x: DnsAnswer<Array<{ priority: number; exchange: string }>>) => (x.ok ? x.value.map((v) => clean(v.exchange)) : []);
  const found = [...new Set([...hosts(dns.mx.a), ...hosts(dns.mx.b)])];
  const records: ChecklistRecord[] = expected.map((r) => ({
    type: "MX",
    name: relativeName(d, zone),
    fqdn: d,
    value: r.value,
    priority: r.priority ?? "10",
    found,
  }));
  const detail = detailOf(dns.mx);
  if (wanted.length === 0) return row(f, "mx", "unknown", "Mailgun didn't list its mail servers for this domain.", null, records, detail);

  const otherMailgun = found.filter((h) => !wanted.includes(h) && /(^|\.)mailgun\.org$/.test(h));
  if (otherMailgun.length > 0) {
    return row(
      f,
      "mx",
      "bad",
      `These are Mailgun's mail servers for the other region (${otherMailgun.join(", ")}); your domain is in the ${f.region} region.`,
      `Change them to ${wanted.join(" and ")}.`,
      records,
      detail,
    );
  }
  const good = (list: Array<{ priority: number; exchange: string }>) => {
    const h = list.map((v) => clean(v.exchange));
    return wanted.every((w) => h.includes(w));
  };
  const ag = agree(dns.mx.a, dns.mx.b, good);
  const other = byAgreement(ag);
  if (other) return row(f, "mx", other.status, other.text, null, records, detail);
  if (ag === "none") {
    const fix = `Add ${expected.length === 1 ? "an MX record" : `${expected.length} MX records`}. Name ${relativeName(d, zone)}: ${expected
      .map((r) => `mail server ${r.value}, priority ${r.priority ?? "10"}`)
      .join("; and ")}.`;
    return row(f, "mx", "bad", found.length ? `Replies to ${d} don't go to Mailgun.` : `No MX records found for ${d}.`, fix, records, detail);
  }
  const extra = found.filter((h) => !wanted.includes(h));
  if (extra.length > 0) {
    return row(
      f,
      "mx",
      "warn",
      `Other mail servers are also listed (${extra.join(", ")}). Some replies may go there instead.`,
      "Remove them (for example Cloudflare Email Routing or your registrar's mail forwarding).",
      records,
      detail,
    );
  }
  return row(f, "mx", "ok", `Replies to ${d} go to Mailgun, which passes them to the app and your inbox.`, null, records, detail);
}

function trackingCnameRow(f: ChecklistFacts, dns: DnsFacts, zone: string): ChecklistRow {
  const t = dns.tracking;
  const name = relativeName(t.host, zone);
  const expected = t.expected;
  const records: ChecklistRecord[] = expected
    ? [{ type: "CNAME", name, fqdn: t.host, value: expected, priority: null, found: seen(t.cname) }]
    : [];
  const detail = detailOf(t.cname, t.a ? `A records: ${seen(t.a).join(", ") || "none"}` : null);
  if (!expected) return row(f, "tracking-cname", "unknown", "Mailgun didn't list the tracking record for this domain.", null, records, detail);
  const ag = agree(t.cname.a, t.cname.b, (targets) => targets.some((x) => clean(x) === clean(expected)));
  const other = byAgreement(ag);
  if (other) return row(f, "tracking-cname", other.status, other.text, null, records, detail);
  if (ag === "none") {
    const found = seen(t.cname);
    if (found.length > 0) {
      return row(f, "tracking-cname", "bad", `${t.host} points somewhere else (${found.join(", ")}).`, `Change its target to ${expected}.`, records, detail);
    }
    if (t.a && seen(t.a).length > 0) {
      return row(f, "tracking-cname", "bad", `${t.host} is proxied (orange cloud).`, "In Cloudflare, switch it to DNS only.", records, detail);
    }
    if (t.doubled && seen(t.doubled).length > 0) {
      return row(f, "tracking-cname", "bad", `The record was saved as ${t.host}.${zone}.`, `Edit it and type only ${name} in the Name box.`, records, detail);
    }
    return row(f, "tracking-cname", "bad", `${t.host} is missing.`, `Add a CNAME record. Name: ${name}. Target: ${expected}.`, records, detail);
  }
  return row(f, "tracking-cname", "ok", `Unsubscribe links on ${t.host} work.`, null, records, detail);
}

function httpsRow(f: ChecklistFacts, m: MailgunDomainFact): ChecklistRow {
  const host = `${m.webPrefix}.${f.domain}`;
  if (f.setupCertificate === "not-in-plan") {
    return row(
      f,
      "https-links",
      "bad",
      "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do.",
      "Upgrade the Mailgun plan, then click Apply recommended settings.",
    );
  }
  if (!f.certificate.ok) return row(f, "https-links", "unknown", COULD_NOT_CHECK, null, [], f.certificate.message);
  const c = f.certificate.value;
  const detail = `Certificate for ${host}: ${c.status}${c.error ? ` (${c.error})` : ""}; links use ${m.webScheme ?? "http"}`;
  switch (c.status) {
    case "active":
      if (m.webScheme === "https") return row(f, "https-links", "ok", "Unsubscribe links use https, as Gmail and Yahoo require.", null, [], detail);
      return row(f, "https-links", "bad", "Mailgun has the certificate, but unsubscribe links still use http.", APPLY, [], detail);
    case "processing":
      return row(f, "https-links", "warn", "Mailgun is preparing the certificate.", "This can take a while. Check again later.", [], detail);
    case "expired":
      return row(f, "https-links", "bad", "The certificate for secure unsubscribe links has expired.", "Click Apply recommended settings to renew it.", [], detail);
    case "error":
      return row(
        f,
        "https-links",
        "bad",
        "Mailgun couldn't make the certificate for secure unsubscribe links.",
        "Fix the 'Unsubscribe links work' row, then click Apply recommended settings.",
        [],
        detail,
      );
    default:
      return row(f, "https-links", "bad", "Unsubscribe links use http.", "Click Apply recommended settings: it asks Mailgun for a certificate.", [], detail);
  }
}

function policyWords(p: string | null): string {
  if (!p || p === "none") return "monitor only";
  return p;
}

function orgOf(domain: string): string {
  return registrableDomain(clean(domain)) ?? clean(domain);
}

/**
 * `own` (own-mailbox mode, MAIN-DOMAIN-DESIGN §3.3): the record also covers the Owner's everyday email, so the missing
 * fix says p=none changes nothing for it, and an unauthorised report address is never pointed at dmarc@ (no route).
 */
function dmarcRow(f: ChecklistFacts, dns: Pick<DnsFacts, "dmarc">, zone: string, own = false): ChecklistRow {
  const d = f.domain;
  const fqdn = `_dmarc.${d}`;
  const { a, b } = dns.dmarc;
  const found = [...new Set([a.policy?.raw, b.policy?.raw].filter((x): x is string => Boolean(x)))];
  const records: ChecklistRecord[] = [{ type: "TXT", name: relativeName(fqdn, zone), fqdn, value: "v=DMARC1; p=none", priority: null, found }];
  const detail = [a, b]
    .map((x, i) => `${i === 0 ? "1.1.1.1" : "8.8.8.8"}: ${x.at ? `_dmarc.${x.at}: ${x.policy?.raw ?? "two records"}` : x.error ? `couldn't check (${x.error})` : "none"}`)
    .join("\n");
  if (a.duplicates || b.duplicates) {
    return row(f, "dmarc", "bad", "Two DMARC records cancel each other.", "Keep one of them.", records, detail);
  }
  const good = (x: DmarcFind) => x.policy !== null;
  const answer = (x: DmarcFind): DnsAnswer<DmarcFind> => (x.policy ? { ok: true, value: x } : x.error ? { ok: false, code: "timeout", detail: x.error } : { ok: false, code: "missing", detail: "" });
  const ag = agree(answer(a), answer(b), good);
  const other = byAgreement(ag);
  if (other) return row(f, "dmarc", other.status, other.text, null, records, detail);
  if (ag === "none") {
    const fix = `Add a TXT record. Name: ${relativeName(fqdn, zone)}. Value: v=DMARC1; p=none`;
    const everyday = ` It also covers your everyday email from ${clean(d)}; p=none changes nothing for it.`;
    return row(f, "dmarc", "bad", `No DMARC policy found for ${d}.`, own ? `${fix}.${everyday}` : fix, records, detail);
  }
  const x = a.policy ? a : b;
  const pol = x.policy!;
  const effective = x.inherited ? (pol.sp ?? pol.p) : pol.p;
  const policyDomain = x.at ?? d;
  // Report addresses on another organisation's domain must be authorised there, or receivers drop them.
  const unauthorised = pol.rua
    .map((u) => /^mailto:[^@]+@([^!\s,;]+)/i.exec(u)?.[1]?.toLowerCase() ?? null)
    .filter((rd): rd is string => rd !== null && orgOf(rd) !== orgOf(policyDomain))
    .filter((rd) => dns.dmarc.ruaAuthorized[rd] === false);
  if (unauthorised.length > 0) {
    return row(
      f,
      "dmarc",
      "warn",
      `Reports to ${unauthorised.join(", ")} will be dropped (that domain hasn't agreed to receive them).`,
      !own ? `Use dmarc@${d} or remove rua.` : `Remove rua from the record, or use a mailbox at ${clean(d)} that you read.`,
      records,
      detail,
    );
  }
  if (x.inherited) {
    return row(f, "dmarc", "ok", `No record on ${d}; using ${policyDomain}'s policy: ${policyWords(effective)}.`, null, records, detail);
  }
  if (!effective || effective === "none") return row(f, "dmarc", "ok", "Policy found: monitor only. Right for now.", null, records, detail);
  return row(f, "dmarc", "ok", `Policy found: ${effective}.`, null, records, detail);
}

/**
 * A DMARC record with its `adkim=` and `aspf=` tags taken out and every other tag kept as written, in order
 * ("v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:d@x.com" → "v=DMARC1; p=quarantine; rua=mailto:d@x.com").
 */
export function withoutStrictAlignment(record: string): string {
  return record
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !/^(adkim|aspf)\s*=/i.test(part))
    .join("; ");
}

/**
 * Shared-From mode (§3.2): receivers judge DMARC by the From domain, so the walk starts at `_dmarc.<From domain>`. Bad
 * when missing, or when it asks for strict alignment that emails sent through the sending domain can't meet: `aspf=s`
 * (the return address is on the sending domain) together with `adkim=s` and a signer other than the From domain (or
 * none known). Report addresses go to `dmarc@<sending domain>` (its dmarc@ route forwards them; same organisation).
 */
function teamDmarcRow(f: ChecklistFacts, t: TeamFacts): ChecklistRow {
  const d = f.domain;
  const org = t.org;
  const zone = zoneOf(org);
  const fqdn = `_dmarc.${org}`;
  const { a, b } = t.dns.dmarc;
  const found = [...new Set([a.policy?.raw, b.policy?.raw].filter((x): x is string => Boolean(x)))];
  const records: ChecklistRecord[] = [{ type: "TXT", name: relativeName(fqdn, zone), fqdn, value: "v=DMARC1; p=none", priority: null, found }];
  const detail = [a, b]
    .map((x, i) => `${i === 0 ? "1.1.1.1" : "8.8.8.8"}: ${x.at ? `_dmarc.${x.at}: ${x.policy?.raw ?? "two records"}` : x.error ? `couldn't check (${x.error})` : "none"}`)
    .join("\n");
  if (a.duplicates || b.duplicates) {
    return row(f, "dmarc", "bad", "Two DMARC records cancel each other.", "Keep one of them.", records, detail);
  }
  const good = (x: DmarcFind) => x.policy !== null;
  const answer = (x: DmarcFind): DnsAnswer<DmarcFind> => (x.policy ? { ok: true, value: x } : x.error ? { ok: false, code: "timeout", detail: x.error } : { ok: false, code: "missing", detail: "" });
  const ag = agree(answer(a), answer(b), good);
  const other = byAgreement(ag);
  if (other) return row(f, "dmarc", other.status, other.text, null, records, detail);
  if (ag === "none") {
    return row(
      f,
      "dmarc",
      "bad",
      `No DMARC policy found for ${org}, the domain in your From address.`,
      `Add a TXT record. Name: ${relativeName(fqdn, zone)}. Value: v=DMARC1; p=none. It also covers your everyday email from ${org}; p=none changes nothing for it.`,
      records,
      detail,
    );
  }
  const x = a.policy ? a : b;
  const pol = x.policy!;
  const effective = x.inherited ? (pol.sp ?? pol.p) : pol.p;
  const policyDomain = x.at ?? org;
  const signer = t.signer ?? t.originalSigner;
  if (pol.aspf === "s" && pol.adkim === "s" && signer !== org) {
    // Review SCREENS-10: the record box offers the owner's own record without the two tags, never "v=DMARC1; p=none",
    // which would drop a stricter policy and the report address when copied.
    const at = `_dmarc.${policyDomain}`;
    const relaxed: ChecklistRecord = { type: "TXT", name: relativeName(at, zone), fqdn: at, value: withoutStrictAlignment(pol.raw), priority: null, found };
    return row(
      f,
      "dmarc",
      "bad",
      `${org}'s DMARC record asks for strict alignment (adkim=s and aspf=s), so emails sent through ${d} fail it.`,
      "Remove adkim=s and aspf=s from the record (relaxed is the default). Don't change anything else in it: the value below is your record without them.",
      [relaxed],
      detail,
    );
  }
  const unauthorised = pol.rua
    .map((u) => /^mailto:[^@]+@([^!\s,;]+)/i.exec(u)?.[1]?.toLowerCase() ?? null)
    .filter((rd): rd is string => rd !== null && orgOf(rd) !== orgOf(policyDomain))
    .filter((rd) => t.dns.dmarc.ruaAuthorized[rd] === false);
  if (unauthorised.length > 0) {
    return row(
      f,
      "dmarc",
      "warn",
      `Reports to ${unauthorised.join(", ")} will be dropped (that domain hasn't agreed to receive them).`,
      `Use dmarc@${d} or remove rua.`,
      records,
      detail,
    );
  }
  if (x.inherited) {
    return row(f, "dmarc", "ok", `No record on ${org}; using ${policyDomain}'s policy: ${policyWords(effective)}.`, null, records, detail);
  }
  if (!effective || effective === "none") return row(f, "dmarc", "ok", `${org}'s policy: monitor only. Right for now.`, null, records, detail);
  return row(f, "dmarc", "ok", `${org}'s policy: ${effective}.`, null, records, detail);
}

/** An MX host of Mailgun's, in either region (mxa.mailgun.org, mxb.eu.mailgun.org). */
const MAILGUN_MX = /(^|\.)mailgun\.org$/;
/** Cloudflare Email Routing's MX hosts (route1.mx.cloudflare.net …). */
const CLOUDFLARE_MX = /(^|\.)mx\.cloudflare\.net$/;

/**
 * from-mx (§2.5, §3.2, F27): mail for the From domain stays with the mail provider. Red when either resolver sees a
 * Mailgun MX host there (the owner's everyday email and the replies the app forwards to it would be lost), when there
 * is no MX at all or only a null MX ("0 .", review SETTING-3), or when the saved From address doesn't fit the sending
 * domain; amber for Cloudflare Email Routing
 * and while spreading. No record box: the app doesn't know the provider's values. Its fixes only ever ask to delete
 * Mailgun's records there or to put back the provider's; never to add a Mailgun MX record.
 */
function fromMxRow(x: FromDomainFacts): ChecklistRow {
  if (x.problem) return fromRow(x, "from-mx", "bad", x.problem);
  if (!x.dns) return fromRow(x, "from-mx", "unknown", COULD_NOT_CHECK);
  const org = clean(x.domain);
  const from = x.address.trim().toLowerCase();
  const mx = x.dns.mx;
  const hosts = (ans: DnsAnswer<Array<{ priority: number; exchange: string }>>) => (ans.ok ? ans.value.map((v) => clean(v.exchange)).filter(Boolean) : []);
  const all = [...new Set([...hosts(mx.a), ...hosts(mx.b)])];
  const detail = detailOf(mx);
  const mailgun = all.filter((h) => MAILGUN_MX.test(h));
  if (mailgun.length > 0) {
    const others = all.filter((h) => !MAILGUN_MX.test(h));
    const keep = others.length > 0 ? `keep only ${others.join(", ")}` : "put back your mail provider's MX records";
    return fromRow(
      x,
      "from-mx",
      "bad",
      `${org}'s mail servers (MX) point to Mailgun. Email to ${from} would go to Mailgun instead of your inbox, and replies the app forwards there would be lost. Live campaign emails wait until this is fixed.`,
      `In the DNS panel for ${org}, delete the MX records of ${org} (Name @) that point to Mailgun, and ${keep}. Never add Mailgun's MX records to ${org}. Then click Check again.`,
      detail,
    );
  }
  // A null MX (RFC 7505: one record "0 .", which node returns as an empty host) says the domain takes no email at all:
  // it counts as no mail server, never as the mail provider's (review SETTING-3).
  const hasHost = (list: Array<{ priority: number; exchange: string }>) => list.some((v) => clean(v.exchange) !== "");
  const ag = agree(mx.a, mx.b, hasHost);
  if (ag === "none" && [mx.a, mx.b].some((ans) => ans.ok && ans.value.length > 0 && !hasHost(ans.value))) {
    return fromRow(
      x,
      "from-mx",
      "bad",
      `${org}'s MX record says it takes no email (a "null MX"), so email to ${from} bounces, and some mail servers refuse emails from it. Live campaign emails wait until this is fixed.`,
      `In the DNS panel for ${org}, delete the MX record of ${org} (Name @) whose value is just a dot, and put back your mail provider's MX records. Its help pages list them. Then click Check again.`,
      detail,
    );
  }
  if (ag === "none") {
    return fromRow(
      x,
      "from-mx",
      "bad",
      `${org} has no mail servers (MX), so nobody can email ${from}, and some mail servers refuse emails from it. Live campaign emails wait until this is fixed.`,
      `Add your mail provider's MX records for ${org} (Name @). Its help pages list them. Then click Check again.`,
      detail,
    );
  }
  const cloudflare = all.filter((h) => CLOUDFLARE_MX.test(h));
  if (cloudflare.length > 0) {
    return fromRow(
      x,
      "from-mx",
      "warn",
      `Mail for ${org} goes to Cloudflare Email Routing (${cloudflare.join(", ")}), not straight to your mail provider.`,
      `If your mailbox is with another provider, switch Email Routing off for ${org} in Cloudflare and put back the provider's MX records (Cloudflare guide, step 1).`,
      detail,
    );
  }
  const other = byAgreement(ag);
  if (other) return fromRow(x, "from-mx", other.status, other.text, null, detail);
  return fromRow(x, "from-mx", "ok", `Mail for ${org} goes to your mail provider (${all.join(", ")}), not to Mailgun. Keep it that way.`, null, detail);
}

/**
 * from-spf (§3.2, F27): the From domain's own SPF record, which carries the owner's everyday email. Never blocks
 * anything: "bad" only when it is broken (two records, an included name without an SPF record, more than 10 lookups),
 * grey "info" when it is almost full (9–10) or missing, grey "unknown" when the lookups couldn't all be counted and the
 * lower bound is 10 or less (never "fine"). No fix ever builds a merged record or suggests removing
 * include:mailgun.org (Mailgun needs it to keep the From domain verified as the DKIM signer).
 */
function fromSpfRow(f: ChecklistFacts, x: FromDomainFacts): ChecklistRow {
  if (x.problem || !x.dns) return fromRow(x, "from-spf", "unknown", COULD_NOT_CHECK, null, x.problem);
  const d = f.domain;
  const org = clean(x.domain);
  const txt = x.dns.txt;
  const look = x.dns.spfLookups;
  const detail = detailOf(
    txt,
    [
      look ? `DNS lookups in the SPF record: ${look.count}${look.complete ? "" : " or more"}` : null,
      look && look.dangling.length > 0 ? `Included names without an SPF record: ${look.dangling.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n") || null,
  );
  const counts = [values(txt.a), values(txt.b)].map((t) => (t ? spfRecords(t).length : 0));
  const most = Math.max(...counts);
  if (most >= 2) {
    return fromRow(
      x,
      "from-spf",
      "bad",
      `${org} has ${most} SPF records, so mail servers ignore all of them. This affects your everyday email.`,
      "Ask the person who set up the app to merge them into one record, keeping every part of both (including include:mailgun.org).",
      detail,
    );
  }
  const ag = agree(txt.a, txt.b, (t) => spfRecords(t).length === 1);
  if (ag === "none") {
    return fromRow(
      x,
      "from-spf",
      "info",
      `${org} has no SPF record. The app's emails don't use it, but your everyday email should have one.`,
      "Your mail provider's help pages show the record to add (Name @).",
      detail,
    );
  }
  const other = byAgreement(ag);
  if (other) return fromRow(x, "from-spf", other.status, other.text, null, detail);
  const name = look?.dangling[0];
  if (name) {
    return fromRow(
      x,
      "from-spf",
      "bad",
      `${org}'s SPF record includes ${name}, which has no SPF record, so mail servers treat ${org}'s SPF as broken. This affects your everyday email.`,
      // Review SCREENS-09: after a nameserver move the old DNS host usually no longer shows the zone, so the fix points
      // at the name and value written down before the move (Cloudflare guide, step 1, option (b) step 2).
      `If ${org}'s DNS moved recently, add the TXT record of ${name} again with the name and value you wrote down before the move (Cloudflare guide, step 1). Otherwise ask the person who set up the app.`,
      detail,
    );
  }
  const record = seen(txt).find((t) => /^v=spf1(\s|$)/i.test(t.trim())) ?? "";
  const n = look ? look.count : spfLookupTerms(record);
  // Review SETTING-4: a lookup in the include tree that failed (a timeout, SERVFAIL, a name that can't be asked) leaves
  // only a lower bound. Over 10 is still over; anything else can't be called fine or almost full, so the row says the
  // count isn't known (grey, like any check that couldn't finish). "Details" keeps the "or more" count.
  if (look && !look.complete && n <= 10) {
    return fromRow(
      x,
      "from-spf",
      "unknown",
      `Couldn't count all the DNS lookups ${org}'s SPF record needs: at least ${n} of the 10 allowed.`,
      null,
      detail,
    );
  }
  if (n > 10) {
    return fromRow(
      x,
      "from-spf",
      "bad",
      `${org}'s SPF record needs ${n} DNS lookups (the limit is 10), so mail servers treat it as broken. This affects your everyday email.`,
      `Ask the person who set up the app to remove services you no longer use from it. Keep include:mailgun.org: Mailgun needs it to keep ${org} verified, and ${org} signs your emails.`,
      detail,
    );
  }
  if (n >= 9) {
    return fromRow(
      x,
      "from-spf",
      "info",
      `${org}'s SPF record is almost full (${n} of 10 DNS lookups). Before you add another email service to ${org}, ask the person who set up the app.`,
      null,
      detail,
    );
  }
  return fromRow(x, "from-spf", "ok", `${org}'s SPF record is fine (${n} of 10 DNS lookups). The app's emails don't use it; they use ${d}'s.`, null, detail);
}

function trackingOffRow(f: ChecklistFacts): ChecklistRow {
  if (!f.tracking.ok) return unreadable(f, "tracking-off", f.tracking.message);
  const t = f.tracking.value;
  if (!t.openActive && !t.clickActive) {
    return row(f, "tracking-off", "ok", "Mailgun doesn't add tracking pixels or change your links.");
  }
  const which = t.openActive && t.clickActive ? "Open and click tracking are" : t.openActive ? "Open tracking is" : "Click tracking is";
  return row(f, "tracking-off", "bad", `${which} on in Mailgun, so it changes your emails.`, APPLY);
}

function unsubscribeRow(f: ChecklistFacts): ChecklistRow {
  if (!f.tracking.ok) return unreadable(f, "unsubscribe", f.tracking.message);
  const t = f.tracking.value;
  if (f.unsubscribeSetup === "B") {
    return row(f, "unsubscribe", "info", "Unsubscribe handling is off on purpose while you check Setup B.");
  }
  if (!t.unsubscribeActive) {
    return row(f, "unsubscribe", "bad", "Mailgun's unsubscribe handling is off, so unsubscribe links wouldn't work.", APPLY);
  }
  if (t.htmlFooter.trim() || t.textFooter.trim()) {
    return row(
      f,
      "unsubscribe",
      "bad",
      "Mailgun adds its own unsubscribe footer as well as yours.",
      "Mailgun kept its own unsubscribe footer. In Mailgun: Domain settings › Tracking › Unsubscribes, clear both footers, then apply again.",
      [],
      `HTML footer: ${JSON.stringify(t.htmlFooter)}\nText footer: ${JSON.stringify(t.textFooter)}`,
    );
  }
  return row(f, "unsubscribe", "ok", "Mailgun fills in each email's unsubscribe link and adds the one-click unsubscribe header.");
}

function spamFilterRow(f: ChecklistFacts, m: MailgunDomainFact): ChecklistRow {
  const a = (m.spamAction ?? "").toLowerCase();
  if (a === "tag") return row(f, "spam-filter", "ok", "Suspicious replies are marked, never thrown away.");
  if (a === "block") return row(f, "spam-filter", "bad", "Mailgun throws away replies it thinks are spam.", APPLY);
  return row(f, "spam-filter", "warn", "Mailgun doesn't mark suspicious replies.", APPLY, [], `spam_action: ${m.spamAction ?? "unknown"}`);
}

function retentionRow(f: ChecklistFacts, m: MailgunDomainFact): ChecklistRow {
  const wantDays = Math.max(1, Math.floor(f.messageRetentionDays));
  const ttl = m.messageTtl ?? 0;
  const detail = `message_ttl: ${m.messageTtl ?? "not set"} seconds`;
  if (ttl <= 0) return row(f, "retention", "bad", "Mailgun doesn't keep stored replies.", APPLY, [], detail);
  const days = ttl / 86_400;
  if (ttl < wantDays * 86_400) {
    const have = days >= 1 ? `${Math.floor(days)} ${Math.floor(days) === 1 ? "day" : "days"}` : `${Math.max(1, Math.round(ttl / 3_600))} hours`;
    return row(
      f,
      "retention",
      "warn",
      `Mailgun keeps stored replies for ${have}, less than the app expects.`,
      "Click Apply recommended settings, or lower 'stored replies' in Settings › Sending & Mailgun.",
      [],
      detail,
    );
  }
  const d = Math.floor(days);
  return row(f, "retention", "ok", `Mailgun keeps each reply for ${d} ${d === 1 ? "day" : "days"}, so the app can fetch it after the PC was off.`, null, [], detail);
}

function signingKeyRow(f: ChecklistFacts): ChecklistRow {
  const s = f.signingKey;
  if (s.problem?.kind === "missing-at-mailgun") {
    return row(
      f,
      "signing-key",
      "bad",
      "Mailgun hasn't made a webhook signing key for your account yet.",
      "In Mailgun, open API Security and create the HTTP webhook signing key, then click Apply recommended settings.",
      [],
      s.problem.message,
    );
  }
  if (s.problem) {
    if (!s.saved) return row(f, "signing-key", "bad", "The webhook signing key isn't saved yet.", APPLY, [], s.problem.message);
    return unreadable(f, "signing-key", s.problem.message);
  }
  if (!s.saved) return row(f, "signing-key", "bad", "The webhook signing key isn't saved yet.", APPLY);
  if (s.matches === false) {
    return row(f, "signing-key", "bad", "The saved webhook signing key doesn't match Mailgun's.", "Click Apply recommended settings to fetch it again.");
  }
  return row(f, "signing-key", "ok", "The app can check that messages really come from Mailgun.");
}

function webhooksRow(f: ChecklistFacts, m: MailgunDomainFact): ChecklistRow {
  const url = f.webhooks.url;
  if (!url) {
    return row(
      f,
      "webhooks",
      "bad",
      "The public address isn't set yet, so Mailgun can't reach the app.",
      PUBLIC_ADDRESS_FIX,
    );
  }
  if (!f.webhooks.map.ok) return unreadable(f, "webhooks", f.webhooks.map.message);
  const map = f.webhooks.map.value;
  const missing = WEBHOOK_WORDS.filter(([type]) => !(map[type] ?? []).includes(url)).map(([, words]) => words);
  const detail = WEBHOOK_WORDS.map(([type]) => `${type}: ${(map[type] ?? []).join(", ") || "none"}`).join("\n");
  if (missing.length > 0) {
    const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
    return row(f, "webhooks", "bad", `Mailgun doesn't tell the app about ${list} yet.`, APPLY, [], detail);
  }
  if (m.webhooksRedactPii === true) {
    return row(f, "webhooks", "bad", "Mailgun hides the addresses in its reports (PII redaction is on).", APPLY, [], detail);
  }
  return row(f, "webhooks", "ok", `Deliveries, bounces, temporary failures, complaints and unsubscribes go to ${url}.`, null, [], detail);
}

function listName(list: string): string {
  if (list === "local") return "the app's do-not-email";
  if (list === "bounces") return "Mailgun's bounce";
  if (list === "complaints") return "Mailgun's complaint";
  return "Mailgun's unsubscribe";
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function replyRoutesRow(f: ChecklistFacts): ChecklistRow {
  const r = f.routes;
  const detail =
    r.senders.map((s) => `${s.name} <${s.address}>: ${s.status ?? "not set up"}${s.forwardTo ? ` → ${s.forwardTo}` : ""}${s.error ? ` (${s.error})` : ""}`).join("\n") ||
    null;
  if (r.senders.length === 0) {
    // No text of its own: the per-sender list under this row already says "Nobody has a sending address yet. Everyone
    // adds theirs in Settings › My profile › Sending address." (it was shown twice).
    return row(f, "reply-routes", "bad", "", null);
  }
  const suppressed = r.senders.find((s) => s.forwardTo && s.lists.length > 0);
  if (suppressed) {
    const list = suppressed.lists.find((l) => l !== "local") ?? suppressed.lists[0]!;
    return row(
      f,
      "reply-routes",
      "bad",
      `Mailgun won't forward replies to ${suppressed.forwardTo}: it's on ${listName(list)} list.`,
      "Remove it in Settings › Deliverability.",
      [],
      detail,
    );
  }
  const broken = r.senders.find((s) => s.status === "error" || s.status === "mismatch");
  if (broken) {
    return row(
      f,
      "reply-routes",
      "bad",
      broken.error ?? `Replies to ${broken.address} don't reach ${broken.name}.`,
      APPLY,
      [],
      detail,
    );
  }
  const waiting = r.senders.filter((s) => s.status !== "ok");
  if (waiting.length > 0) {
    return row(
      f,
      "reply-routes",
      "warn",
      `Reply routes are being set up for ${joinNames(waiting.map((s) => s.name))}.`,
      "Click Apply recommended settings if this doesn't change within a few minutes.",
      [],
      detail,
    );
  }
  if (!r.catchAllRouteId) {
    return row(f, "reply-routes", "warn", "The catch-all route for unknown addresses isn't set up yet.", APPLY, [], detail);
  }
  const names = r.senders.map((s) => s.name);
  return row(
    f,
    "reply-routes",
    "ok",
    `${names.length} ${names.length === 1 ? "reply route" : "reply routes"} (${names.join(", ")}), plus a catch-all for unknown addresses.`,
    null,
    [],
    [detail, r.listsError ? `Mailgun's lists couldn't be checked: ${r.listsError}` : null].filter(Boolean).join("\n") || null,
  );
}

const SENDING_PAUSE_KINDS = new Set(["mailgun-auth", "mailgun-verification", "mailgun-not-allowed", "mailgun-queue", "mailgun-domain"]);

function sendingAllowedRow(f: ChecklistFacts, m: MailgunDomainFact): ChecklistRow {
  const d = f.domain;
  if (!f.queues.ok) return row(f, "sending-allowed", "unknown", COULD_NOT_CHECK, null, [], f.queues.message);
  const q = f.queues.value;
  if (q.regularDisabled) {
    return row(f, "sending-allowed", "bad", `Mailgun has stopped accepting emails from ${d}${q.reason ? `: ${q.reason}` : ""}.`, "Check Mailgun's dashboard.");
  }
  if (m.isDisabled) {
    return row(f, "sending-allowed", "bad", `Mailgun has disabled ${d}${m.disabledReason ? `: ${m.disabledReason}` : ""}.`, "Check the banner in Mailgun.");
  }
  const pause = f.pause.find((p) => SENDING_PAUSE_KINDS.has(p.kind));
  if (pause) return row(f, "sending-allowed", "bad", `Sending is paused: ${pause.reason}.`, pause.fixText || null);
  return row(f, "sending-allowed", "ok", `Mailgun accepts emails from ${d}.`);
}

const NO_LIMIT_TEXT =
  "No monthly safety limit set in Mailgun. In Mailgun, set a custom monthly message limit of about 30,000 (see the Mailgun guide, step 9).";
/** The key may not read the limit (403): the app doesn't know whether one is set, so it doesn't say "none is set". */
export const LIMIT_UNREADABLE_TEXT = "Couldn't check: the app's key isn't allowed to read Mailgun's monthly limit.";
export const LIMIT_UNREADABLE_FIX = "If you set the limit in Mailgun (Mailgun guide, step 9), you can ignore this.";

function monthlyLimitRow(f: ChecklistFacts): ChecklistRow {
  const m = f.monthlyLimit;
  if (!m.ok) {
    // The Developer key may not read it (403, §9.5 item 8): a neutral "couldn't check" row, never a pause.
    if (m.kind === "auth") {
      return row(f, "monthly-limit", "unknown", LIMIT_UNREADABLE_TEXT, LIMIT_UNREADABLE_FIX, [], `The app's key can't read the limit: ${m.message}`);
    }
    return row(f, "monthly-limit", "unknown", COULD_NOT_CHECK, null, [], m.message);
  }
  if (!m.value) return row(f, "monthly-limit", "warn", NO_LIMIT_TEXT);
  const { limit, current, period } = m.value;
  const when = /m$/i.test(period) || !period ? "this month" : `in each period of ${period}`;
  return row(f, "monthly-limit", "ok", `Mailgun stops everything after ${num(limit)} emails ${when} (${num(current)} used).`);
}

/**
 * Remote access (§5.3): the public address answers through Cloudflare, Mailgun's webhooks get through without a login
 * page, and (unless the Owner switched the Access check off, M6-DESIGN §2.8) the sign-in page is behind Cloudflare
 * Access. With the opt-out an open sign-in page is "ok" with its own sentence; a weak connection and an old cloudflared
 * still warn after it.
 */
function remoteAccessRow(f: ChecklistFacts): ChecklistRow {
  const t = f.tunnel;
  const pub = f.publicUrl;
  if (!pub) {
    return row(f, "remote-access", "bad", "The public address isn't set yet.", PUBLIC_ADDRESS_FIX);
  }
  const detail = [
    `cloudflared: ${t.state}${t.readyConnections ? ` (${t.readyConnections} connections)` : ""}${t.version ? `, version ${t.version}` : ""}`,
    t.publicCheck ? `${pub}/api/health: ${t.publicCheck.ok ? "answered" : `failed (${t.publicCheck.error ?? t.publicCheck.status ?? "no answer"})`}` : null,
    t.webhookPathCheck ? `Webhook address: ${t.webhookPathCheck.ok ? "answered by the app" : `failed (${t.webhookPathCheck.error ?? t.webhookPathCheck.status ?? "no answer"})`}` : null,
    t.appProtectedCheck
      ? `Sign-in page: ${t.appProtectedCheck.ok ? "behind Cloudflare Access" : `reachable (${t.appProtectedCheck.location ?? t.appProtectedCheck.status ?? t.appProtectedCheck.error ?? "no redirect"})`}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  if (!t.publicCheck || !t.webhookPathCheck) {
    return row(f, "remote-access", "unknown", "Not checked yet.", "Click Check now in Settings › System.", [], detail);
  }
  if (!t.publicCheck.ok) {
    if (!f.fakeMode && t.state === "not-running") {
      return row(
        f,
        "remote-access",
        "bad",
        "cloudflared isn't running on this PC.",
        "If you haven't set up remote access yet, follow docs\\setup\\3-cloudflare.md. Otherwise check that the Cloudflared service is running (status.bat shows it).",
        [],
        detail,
      );
    }
    if (!f.fakeMode && t.state === "down") {
      return row(
        f,
        "remote-access",
        "bad",
        "Cloudflare can't reach this PC right now.",
        "Check that this PC is on and connected, and that the Cloudflared service is running (status.bat shows it).",
        [],
        detail,
      );
    }
    return row(
      f,
      "remote-access",
      "bad",
      `The public address doesn't answer (${pub}/api/health).`,
      "Finish the Cloudflare guide, check it on your phone, then click Check now in Settings › System.",
      [],
      detail,
    );
  }
  if (!t.webhookPathCheck.ok) {
    return row(
      f,
      "remote-access",
      "bad",
      "The webhook address shows Cloudflare's login page.",
      "In Cloudflare, check that the 'Outreach public endpoints' app covers api/webhooks/* (Cloudflare guide, step 6).",
      [],
      detail,
    );
  }
  if (f.fakeMode) {
    return row(f, "remote-access", "ok", "The public address answers, and Mailgun's messages get through (test server).", null, [], detail);
  }
  if (!t.appProtectedCheck) {
    return row(f, "remote-access", "unknown", "Not checked yet.", "Click Check now in Settings › System.", [], detail);
  }
  const accessOff = !t.appProtectedCheck.ok && f.accessOff === true;
  if (!t.appProtectedCheck.ok && !accessOff) {
    return row(
      f,
      "remote-access",
      "bad",
      "Anyone on the internet can reach your app's sign-in page.",
      "In Cloudflare, check the 'Outreach' application (Cloudflare guide, step 5).",
      [],
      detail,
    );
  }
  if (t.state === "degraded") {
    return row(f, "remote-access", "warn", "Remote access works, but the connection to Cloudflare is weak.", null, [], detail);
  }
  if (t.versionWarning) return row(f, "remote-access", "warn", t.versionWarning, null, [], detail);
  if (accessOff) return row(f, "remote-access", "ok", ACCESS_OFF_TEXT, null, [], detail);
  return row(
    f,
    "remote-access",
    "ok",
    "Cloudflare reaches this PC, only your team gets past the login, and Mailgun's messages get through without a login page.",
    null,
    [],
    detail,
  );
}

/** A stored From address as `replyTestPassedFor` compares it: trimmed, lowercase, empty = per-person mode. */
function sameFrom(a: string | null | undefined, b: string | null | undefined): boolean {
  return ((a ?? "").trim().toLowerCase() || null) === ((b ?? "").trim().toLowerCase() || null);
}

/**
 * The reply test (§3.2, F12, F26): a stored decision counts only for this sending domain and today's From address
 * (`replyTestPassedFor`; per-person mode is a null From). In shared-From mode the texts name the From address, and a
 * failure never suggests a separate reply domain.
 */
function replyTestRow(f: ChecklistFacts, team: TeamFacts | null): ChecklistRow {
  const r = f.replyTest;
  const today = team ? team.address : null;
  // MAIN-DOMAIN-DESIGN O13, O15: a decision made in own-mailbox mode never counts here (stored without `replies`: as before).
  const onThisDomain = r.domain !== null && r.domain.toLowerCase() === f.domain.toLowerCase() && r.replies !== "own-mailbox";
  const passed = replyTestPassedFor({ status: r.status, domain: r.domain, from: r.from ?? null, replies: r.replies }, f.domain, today);
  const failed = onThisDomain && r.status === "failed" && sameFrom(r.from, today);
  const when = r.decidedAt ? ` on ${formatShortDate(r.decidedAt, f.timeZone, f.now)}` : "";
  if (team) {
    if (passed) {
      return row(
        f,
        "reply-test",
        "ok",
        `Setup ${r.setup} passed${when} with the From address ${today}: replies arrive in your inbox, unsubscribe links work, and the test email passed DMARC.`,
      );
    }
    if (failed) {
      return row(
        f,
        "reply-test",
        "bad",
        `Setup ${r.setup} didn't pass with the From address ${today}.`,
        `The reply test section says which check failed. If it was the return address or DMARC, clear the From address in Settings › Sending & Mailgun (emails then come from each person's own address on ${f.domain}) and ask the person who set up the app.`,
      );
    }
    return row(f, "reply-test", "warn", `Not tested yet with the From address ${today}. Live campaigns start once this passes.`);
  }
  if (passed) {
    return row(f, "reply-test", "ok", `Setup ${r.setup} passed${when}: replies arrive in your inbox, and unsubscribe links work.`);
  }
  if (failed) {
    return row(
      f,
      "reply-test",
      "bad",
      `Setup ${r.setup} didn't pass.`,
      "The usual fix is a separate reply address such as ali@reply.<domain>. This needs a small change to the app and your OK.",
    );
  }
  return row(f, "reply-test", "warn", "Not tested yet. Live campaigns start once this passes.");
}

/**
 * Shared-From mode (§3.2): Gmail's dashboard is about the From domain, whose TXT records carry the verification. The
 * main domain usually has a google-site-verification record already (Search Console, Google Workspace…), and nothing in
 * the record says which Google service it is for, so it never proves Postmaster Tools is set up: the row stays grey
 * "info" with the reminder, and the go-live card keeps its Postmaster recommendation (review SCREENS-03).
 */
function teamPostmasterRow(f: ChecklistFacts, t: TeamFacts): ChecklistRow {
  const org = t.org;
  const addIt = `click Add new domain, type ${org}, copy the TXT record it shows and add it (Name @). It shows data only once you send enough email.`;
  if (seen(t.dns.txt).some((x) => x.trim().toLowerCase().startsWith("google-site-verification="))) {
    return row(
      f,
      "postmaster",
      "info",
      `A Google verification record is on ${org}. Check at postmaster.google.com that ${org} is listed there.`,
      `The app can't tell which Google service that record is for. If ${org} isn't listed in Postmaster Tools, ${addIt}`,
    );
  }
  return row(f, "postmaster", "info", `Optional: see how Gmail rates ${org}, the domain in your From address.`, `Open postmaster.google.com, ${addIt}`);
}

function postmasterRow(f: ChecklistFacts, dns: DnsFacts | null): ChecklistRow {
  const d = f.domain;
  const txt = dns ? seen(dns.txt) : [];
  if (txt.some((t) => t.trim().toLowerCase().startsWith("google-site-verification="))) {
    return row(f, "postmaster", "ok", "Google Postmaster Tools looks set up.");
  }
  return row(
    f,
    "postmaster",
    "info",
    "Optional: see how Gmail rates your domain.",
    `Open postmaster.google.com, click Add new domain, type ${d}, copy the TXT record it shows and add it (Name @). It shows data only once you send enough email.`,
  );
}

/** `d`: the sending domain, or the From domain in shared-From mode (§3.2: "{org} is 1,132 days old."). */
function domainAgeRow(f: ChecklistFacts, d: string = f.domain): ChecklistRow {
  const on = f.domainRegisteredOn;
  const t = on && /^\d{4}-\d{2}-\d{2}$/.test(on) ? Date.parse(`${on}T00:00:00Z`) : Number.NaN;
  // No fix sentence: the date field under this row is labelled "When did you buy <domain>?" (it was shown twice).
  if (!Number.isFinite(t)) return row(f, "domain-age", "info", `Optional: enter the day you bought ${d} to see its age.`);
  const days = Math.max(0, Math.floor((f.now.getTime() - t) / 86_400_000));
  const age = `${d} is ${num(days)} ${days === 1 ? "day" : "days"} old.`;
  if (days < 30) return row(f, "domain-age", "warn", `${age} Wait until it's 30 days old before real campaigns, then start slowly.`);
  return row(f, "domain-age", "ok", age);
}

// ───────────────────────── own-mailbox mode (MAIN-DOMAIN-DESIGN §3.3, §5) ─────────────────────────

/**
 * The own-mailbox SPF row's fixes that would change the everyday domain's SPF record (review DOMAIN-1). The Owner never
 * edits that record himself (Own-mailbox guide, troubleshooting: "Don't edit the SPF record yourself: your everyday Zoho
 * mail depends on it too."), so both go through the person who set up the app. Never a full SPF value.
 */
export const OWN_SPF_TEXTS = {
  noRecordFix: (d: string, at: string, include: string): string =>
    `Ask the person who set up the app to add an SPF record for ${d} (Name ${at}) as your mail provider's help pages show it, with ${include} just before ~all. Your everyday email depends on it too, so don't add it yourself. Then click Check again.`,
  noMailgunFix: (d: string, at: string, include: string, n: number): string =>
    `Ask the person who set up the app to add ${include} to ${d}'s SPF record (Name ${at}), just before ~all, changing nothing else. Your everyday email depends on that record too, so don't edit it yourself. It uses ${n} of 10 DNS lookups now, and ${include} adds about 5.`,
} as const;

/**
 * "Apply recommended settings" step texts the Recommended settings card words by (review DOMAIN-3, SCREENS-06). Shared
 * with the Apply service (`APPLY_TEXTS.certNotInPlan` is `certNotInPlan`), so the card never guesses from a sentence.
 */
export const APPLY_STEP_TEXTS = {
  /** The certificate step on a plan without it (Mailgun's 402): red in app mode, "Not in your plan" in own-mailbox mode. */
  certNotInPlan: "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do.",
  /** Own-mailbox mode, the certificate not in the plan: the https step (O20). */
  httpsNotInPlanOwn: "Unsubscribe links use http on your plan. They still work when clicked (see the HTTPS row).",
  /** Own-mailbox mode without a public address: the webhooks step (O21). */
  webhooksOptionalOwn: "Mailgun's reports come through the app's hourly check instead. Webhooks need remote access, which is optional in your setup.",
} as const;

/**
 * The word and colour of one Apply step on the Recommended settings card (review DOMAIN-3, SCREENS-06): done, not done,
 * and for a step with no result (`ok: null`) "Not needed" (own-mailbox mode's inbound steps), "Optional" (no public
 * address in own-mailbox mode), "Not in your plan" (own-mailbox mode on a plan without the certificate), all grey
 * "info", else "Waiting" (something still has to happen first, as before).
 */
export function applyStepStatus(step: { ok: boolean | null; text: string }): { status: CheckStatus; word?: string } {
  if (step.ok === true) return { status: "ok" };
  if (step.ok === false) return { status: "bad" };
  if (step.text === OWN_MAILBOX_TEXTS.applyNotNeeded) return { status: "info", word: "Not needed" };
  if (step.text === OWN_MAILBOX_TEXTS.applyNoPublicAddress || step.text === APPLY_STEP_TEXTS.webhooksOptionalOwn) {
    return { status: "info", word: "Optional" };
  }
  if (step.text === APPLY_STEP_TEXTS.certNotInPlan || step.text === APPLY_STEP_TEXTS.httpsNotInPlanOwn) {
    return { status: "info", word: "Not in your plan" };
  }
  return { status: "unknown", word: "Waiting" };
}

/** The sending domain's SPF facts the own-mailbox SPF row reads (the own DNS of `facts.from`, or `facts.dns`). */
type SpfSource = {
  txt: TwoAnswers<string[]>;
  spfLookups: { count: number; complete: boolean; dangling?: string[]; names?: string[]; walks?: SpfWalks } | null;
};

/** An SPF record as mail servers read it: spaces and case don't matter. */
function sameSpfRecord(a: string, b: string): boolean {
  const norm = (r: string) => r.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Review DOMAIN-1: both resolvers' walks. Facts without `walks` (one walk, the older shape) use that one walk for both;
 * facts without any walk count only the record's own terms. Null when a resolver's walk is missing although both
 * resolvers answered an SPF record (the facts are incomplete: the row can't be judged).
 */
function spfWalksOf(look: SpfSource["spfLookups"], record: string): [SpfWalk, SpfWalk] | null {
  if (look?.walks) {
    const [a, b] = look.walks;
    return a && b ? [a, b] : null;
  }
  const one: SpfWalk = look
    ? { count: look.count, complete: look.complete, dangling: look.dangling ?? [], names: look.names ?? [] }
    : { count: spfLookupTerms(record), complete: true, dangling: [], names: [] };
  return [one, one];
}

/** What one resolver's walk says about the record (after dangling names and +all). */
type SpfJudgement = { kind: "unsure" | "over" | "no-mailgun" | "ok"; n: number };

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** "Walk on 1.1.1.1: 9 lookups; includes a, b; without an SPF record: c" (Details, only when the two walks differ). */
function walkDetail(label: string, w: SpfWalk): string {
  const parts = [`${w.count}${w.complete ? "" : " or more"} lookups`, `includes ${w.names.join(", ") || "none"}`];
  if (w.dangling.length > 0) parts.push(`without an SPF record: ${w.dangling.join(", ")}`);
  return `Walk on ${label}: ${parts.join("; ")}`;
}

/**
 * spf in own-mailbox mode (O11), and for a website domain checked in app mode (O37): the domain's SPF record also
 * carries the Owner's everyday email, and its DNS host may wrap each service in an include (GoDaddy's `dc-…._spfm`).
 * Mailgun's include counts wherever it is in the include tree (the lookup report's `names`). Never a record box, never a
 * full or merged SPF value: every fix names only the one include (Mailgun's own, include:mailgun.org in the US region).
 *
 * Review DOMAIN-1: each resolver walks the tree from its own record (`walks`). A different record, a name without an SPF
 * record on only one of them, or walks that differ in Mailgun's include or in the count is "Still spreading" (or
 * "Couldn't count…" when a walk couldn't finish), never a fix. Adding Mailgun's include is only ever proposed when both
 * complete walks agree it is missing, and then through the person who set up the app: the Owner never edits the
 * everyday domain's SPF record himself (Own-mailbox guide, troubleshooting). `appMode` (O37, review DOMAIN-4): the
 * website domain in app mode never gets an include to add: its fix is to connect again in own-mailbox mode.
 */
function ownSpfRow(f: ChecklistFacts, m: MailgunDomainFact, spf: SpfSource, opts: { appMode?: boolean } = {}): ChecklistRow {
  const d = clean(f.domain);
  const at = relativeName(d, zoneOf(d));
  const wanted = spfIncludes(expectedSpf(m) ?? "v=spf1 include:mailgun.org ~all");
  const include = `include:${wanted[0] ?? "mailgun.org"}`;
  const txt = spf.txt;
  const look = spf.spfLookups;
  const dangling = look?.dangling ?? [];
  const [walkA, walkB] = look?.walks ?? [null, null];
  // Details name each resolver's walk when the two differ (what "Still spreading" is about).
  const differing = walkA && walkB && JSON.stringify(walkA) !== JSON.stringify(walkB) ? [walkDetail("1.1.1.1", walkA), walkDetail("8.8.8.8", walkB)] : [];
  const detail = detailOf(
    txt,
    [
      look ? `DNS lookups in the SPF record: ${look.count}${look.complete ? "" : " or more"}` : null,
      look?.names && look.names.length > 0 ? `Includes looked up: ${look.names.join(", ")}` : null,
      dangling.length > 0 ? `Included names without an SPF record: ${dangling.join(", ")}` : null,
      ...differing,
    ]
      .filter(Boolean)
      .join("\n") || null,
  );
  const both = "your campaign emails and your everyday email fail SPF.";
  const most = Math.max(...[values(txt.a), values(txt.b)].map((t) => (t ? spfRecords(t).length : 0)));
  if (most >= 2) {
    return row(
      f,
      "spf",
      "bad",
      `${d} has ${most} SPF records, so mail servers ignore all of them: ${both}`,
      `Ask the person who set up the app to merge them into one record, keeping every part of both (including ${include}).`,
      [],
      detail,
    );
  }
  const ag = agree(txt.a, txt.b, (t) => spfRecords(t).length === 1);
  if (ag === "none") {
    return row(
      f,
      "spf",
      "bad",
      `${d} has no SPF record, so mail servers can't tell that Mailgun may send for it.`,
      opts.appMode ? OWN_MAILBOX_TEXTS.websiteInAppModeFix : OWN_SPF_TEXTS.noRecordFix(d, at, include),
      [],
      detail,
    );
  }
  const other = byAgreement(ag);
  if (other) return row(f, "spf", other.status, other.text, null, [], detail);
  // Both resolvers see one SPF record. Not the same one: one of them still has the old record (a change or a DNS move
  // is still spreading), so nothing is judged yet (review DOMAIN-1).
  const recordA = spfRecords(values(txt.a) ?? [])[0] ?? "";
  const recordB = spfRecords(values(txt.b) ?? [])[0] ?? "";
  if (!sameSpfRecord(recordA, recordB)) return row(f, "spf", "warn", SPREADING, null, [], detail);
  const record = recordA;
  const walks = spfWalksOf(look, record);
  if (!walks) return row(f, "spf", "unknown", COULD_NOT_CHECK, null, [], detail);
  const [wa, wb] = walks;
  if (wa.dangling.length > 0 || wb.dangling.length > 0) {
    // A name without an SPF record on only one resolver: the other still sees it (a cache, or a DNS move halfway).
    if (!sameList(wa.dangling, wb.dangling)) return row(f, "spf", "warn", SPREADING, null, [], detail);
    const name = wa.dangling[0]!;
    return row(
      f,
      "spf",
      "bad",
      `${d}'s SPF record includes ${name}, which has no SPF record, so mail servers treat ${d}'s SPF as broken: ${both}`,
      `If ${d}'s DNS moved recently, add the TXT record of ${name} again with the name and value you wrote down before the move (Cloudflare guide, step 1). Otherwise ask the person who set up the app.`,
      [],
      detail,
    );
  }
  if (spfHasAll(record, "+")) {
    return row(f, "spf", "bad", "Your SPF record lets anyone send email for your domain (+all).", "Change +all at the end to ~all.", [], detail);
  }
  const judge = (w: SpfWalk): SpfJudgement => {
    // A lookup in the tree that failed leaves only a lower bound (review SETTING-4): over 10 is still over, anything
    // else can't be called fine (grey, like any check that couldn't finish).
    if (!w.complete && w.count <= 10) return { kind: "unsure", n: w.count };
    if (w.count > 10) return { kind: "over", n: w.count };
    const reached = new Set([...spfIncludes(record), ...w.names]);
    return { kind: wanted.every((x) => reached.has(x)) ? "ok" : "no-mailgun", n: w.count };
  };
  const ja = judge(wa);
  const jb = judge(wb);
  let verdict: SpfJudgement | null = null;
  if (ja.kind === jb.kind && (ja.n === jb.n || ja.kind === "over" || ja.kind === "unsure")) {
    verdict = { kind: ja.kind, n: Math.max(ja.n, jb.n) };
  } else if (ja.kind !== "ok" && jb.kind !== "ok" && (ja.kind === "unsure" || jb.kind === "unsure")) {
    // Neither walk is right and one couldn't finish: couldn't check (a timeout never makes the row red).
    verdict = ja.kind === "unsure" ? ja : jb;
  }
  // The walks disagree (Mailgun reached on one only, another count, over 10 on one only): still spreading.
  if (!verdict) return row(f, "spf", "warn", SPREADING, null, [], detail);
  const n = verdict.n;
  if (verdict.kind === "unsure") {
    return row(f, "spf", "unknown", `Couldn't count all the DNS lookups ${d}'s SPF record needs: at least ${n} of the 10 allowed.`, null, [], detail);
  }
  if (verdict.kind === "over") {
    return row(
      f,
      "spf",
      "bad",
      `${d}'s SPF record needs ${n} DNS lookups (the limit is 10), so mail servers treat it as broken: ${both}`,
      `Ask the person who set up the app to remove services you no longer use from it. Keep ${include}: without it Mailgun can't send for ${d}.`,
      [],
      detail,
    );
  }
  if (verdict.kind === "no-mailgun") {
    return row(
      f,
      "spf",
      "bad",
      `${d}'s SPF record doesn't include Mailgun, so the app's emails fail SPF.`,
      opts.appMode ? OWN_MAILBOX_TEXTS.websiteInAppModeFix : OWN_SPF_TEXTS.noMailgunFix(d, at, include, n),
      [],
      detail,
    );
  }
  if (n >= 9) {
    return row(
      f,
      "spf",
      "ok",
      `Mailgun may send for ${d} (through its SPF record's includes). The record is almost full: ${n} of 10 DNS lookups. Before you add another email service to ${d}, ask the person who set up the app.`,
      null,
      [],
      detail,
    );
  }
  return row(f, "spf", "ok", `Mailgun may send for ${d} (${n} of 10 DNS lookups).`, null, [], detail);
}

/**
 * from-mx in own-mailbox mode (O10, §2.5): mail for the sending domain itself stays with the mail provider, because the
 * Owner's everyday email and every reply land there. Red on a Mailgun MX (either region, either resolver), a null MX,
 * no MX, or Cloudflare Email Routing; each red fix deletes Mailgun's or Cloudflare's MX, names the MX records to keep or
 * put back (the last good MX the app saw, `facts.lastGoodMx`) and ends with NEVER_MAILGUN_MX_TEXT. Never a record box.
 */
/** Why own-mailbox mode's from-mx row is red: a Mailgun MX, a null MX, no MX, or Cloudflare Email Routing. */
export type OwnMxCause = "mailgun" | "null-mx" | "no-mx" | "cloudflare";

type MxAnswers = TwoAnswers<Array<{ priority: number; exchange: string }>>;

/**
 * The cause of a red own-mailbox from-mx row, in the row's own order (review DOMAIN-8: the Owner's notice names the same
 * cause as the row): a Mailgun MX host on either resolver; both resolvers answered and neither has a mail server, with a
 * null MX ("0 .") or with none; Cloudflare Email Routing's hosts. Null when the row isn't red for its MX (ok, spreading,
 * couldn't check).
 */
export function ownMxCause(mx: MxAnswers | null): OwnMxCause | null {
  if (!mx) return null;
  const hosts = (ans: DnsAnswer<Array<{ priority: number; exchange: string }>>) => (ans.ok ? ans.value.map((v) => clean(v.exchange)).filter(Boolean) : []);
  const all = [...new Set([...hosts(mx.a), ...hosts(mx.b)])];
  if (all.some((h) => MAILGUN_MX.test(h))) return "mailgun";
  // A null MX (RFC 7505: one record "0 .", which node returns as an empty host) says the domain takes no email at all.
  const hasHost = (list: Array<{ priority: number; exchange: string }>) => list.some((v) => clean(v.exchange) !== "");
  if (agree(mx.a, mx.b, hasHost) === "none") {
    return [mx.a, mx.b].some((ans) => ans.ok && ans.value.length > 0 && !hasHost(ans.value)) ? "null-mx" : "no-mx";
  }
  if (all.some((h) => CLOUDFLARE_MX.test(h))) return "cloudflare";
  return null;
}

function ownFromMxRow(f: ChecklistFacts, mx: MxAnswers | null): ChecklistRow {
  if (!mx) return row(f, "from-mx", "unknown", COULD_NOT_CHECK);
  const d = clean(f.domain);
  const at = relativeName(d, zoneOf(d));
  const hosts = (ans: DnsAnswer<Array<{ priority: number; exchange: string }>>) => (ans.ok ? ans.value.map((v) => clean(v.exchange)).filter(Boolean) : []);
  const all = [...new Set([...hosts(mx.a), ...hosts(mx.b)])];
  const detail = detailOf(mx);
  const putBack = OWN_MAILBOX_TEXTS.putBackMx(f.lastGoodMx);
  const never = NEVER_MAILGUN_MX_TEXT(d);
  const wait = "Live campaign emails wait until this is fixed.";
  const cause = ownMxCause(mx);
  if (cause === "mailgun") {
    // Only the mail provider's hosts are kept (never Cloudflare Email Routing's, which is red here too).
    const others = all.filter((h) => !MAILGUN_MX.test(h) && !CLOUDFLARE_MX.test(h));
    const keep = others.length > 0 ? `keep only ${others.join(", ")}` : putBack;
    return row(
      f,
      "from-mx",
      "bad",
      `${d}'s mail servers (MX) point to Mailgun. Your everyday email and every reply to your campaigns would go to Mailgun, where nobody reads them. ${wait}`,
      `In the DNS panel for ${d} (GoDaddy), delete the MX records of ${d} (Name ${at}) that point to Mailgun, and ${keep}. ${never} Then click Check again.`,
      [],
      detail,
    );
  }
  if (cause === "null-mx") {
    return row(
      f,
      "from-mx",
      "bad",
      `${d}'s MX record says it takes no email (a "null MX"), so replies to your campaigns bounce, and some mail servers refuse emails from it. ${wait}`,
      `In the DNS panel for ${d}, delete the MX record of ${d} (Name ${at}) whose value is just a dot, and ${putBack}. ${never} Then click Check again.`,
      [],
      detail,
    );
  }
  if (cause === "no-mx") {
    return row(
      f,
      "from-mx",
      "bad",
      `${d} has no mail servers (MX), so replies to your campaigns can't reach you, and some mail servers refuse emails from it. ${wait}`,
      `In the DNS panel for ${d}, ${putBack} (Name ${at}). ${never} Then click Check again.`,
      [],
      detail,
    );
  }
  if (cause === "cloudflare") {
    const cloudflare = all.filter((h) => CLOUDFLARE_MX.test(h));
    // O10, review S6: red in this mode (app mode keeps its amber row), so it holds live emails and tells the Owner.
    return row(
      f,
      "from-mx",
      "bad",
      `Mail for ${d} goes to Cloudflare Email Routing (${cloudflare.join(", ")}), not to your mailbox at your mail provider, so your everyday email and the replies to your campaigns may never reach it. ${wait}`,
      `In Cloudflare, switch Email Routing off for ${d}, then in its DNS ${putBack}. ${never} Then click Check again.`,
      [],
      detail,
    );
  }
  const hasHost = (list: Array<{ priority: number; exchange: string }>) => list.some((v) => clean(v.exchange) !== "");
  const other = byAgreement(agree(mx.a, mx.b, hasHost));
  if (other) return row(f, "from-mx", other.status, other.text, null, [], detail);
  return row(f, "from-mx", "ok", `Mail for ${d} goes to your mail provider (${all.join(", ")}), not to Mailgun, so replies reach your inbox. Keep it that way.`, null, [], detail);
}

/** A host name as the stored last good MX keeps it (the SystemState parser drops the whole list for anything else). */
const MX_HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * O10: the MX records to remember as the last good MX after an own-mailbox check whose from-mx row is "ok": the hosts
 * both resolvers agree on (with the first resolver's priority), never a Mailgun or Cloudflare Email Routing host, sorted
 * by priority, at most 10. Empty when the resolvers share none (the caller then keeps the earlier list).
 */
export function lastGoodMxOf(mx: TwoAnswers<Array<{ priority: number; exchange: string }>>): Array<{ priority: number; host: string }> {
  if (!mx.a.ok || !mx.b.ok) return [];
  const onB = new Set(mx.b.value.map((v) => clean(v.exchange)));
  const out = new Map<string, number>();
  for (const v of mx.a.value) {
    const host = clean(v.exchange);
    if (!host || !onB.has(host) || MAILGUN_MX.test(host) || CLOUDFLARE_MX.test(host) || !MX_HOST_NAME.test(host)) continue;
    if (!Number.isInteger(v.priority) || v.priority < 0 || v.priority > 65_535) continue;
    const had = out.get(host);
    if (had === undefined || v.priority < had) out.set(host, v.priority);
  }
  return [...out]
    .map(([host, priority]) => ({ priority, host }))
    .sort((x, y) => x.priority - y.priority || x.host.localeCompare(y.host))
    .slice(0, 10);
}

/** https-links in own-mailbox mode (O20): a plan without the certificate is honest "info"; every other case as today. */
function ownHttpsRow(f: ChecklistFacts, m: MailgunDomainFact): ChecklistRow {
  if (f.setupCertificate === "not-in-plan") {
    return row(
      f,
      "https-links",
      "info",
      "Your Mailgun plan doesn't include secure (https) unsubscribe links, so they use http. They still work when clicked, but Gmail's and Yahoo's one-click unsubscribe button needs https, so it may not show. That is required only above 5,000 emails a day to Gmail.",
      "Foundation and higher include https links. After upgrading, choose the plan in Settings › Sending & Mailgun › Advanced and click Apply recommended settings.",
    );
  }
  return httpsRow(f, m);
}

/** webhooks in own-mailbox mode (O21): optional without a public address (the hourly Logs catch-up brings the events). */
function ownWebhooksRow(f: ChecklistFacts, m: MailgunDomainFact | null): ChecklistRow {
  if (!f.webhooks.url) {
    return row(
      f,
      "webhooks",
      "info",
      "No public address yet, so Mailgun can't tell the app at once. The app reads Mailgun's logs every hour instead, while the background sender runs.",
      "Optional: remote access (Cloudflare guide) lets Mailgun tell the app at once.",
    );
  }
  return m ? webhooksRow(f, m) : mailgunUnavailable(f, "webhooks");
}

/** remote-access in own-mailbox mode (O21): nothing inbound needs the public address, so without one it is "info". */
function ownRemoteAccessRow(f: ChecklistFacts): ChecklistRow {
  if (!f.publicUrl) {
    return row(
      f,
      "remote-access",
      "info",
      "Remote access isn't set up: the app works on this PC and your office network only.",
      "Optional in your setup. To reach the app from elsewhere, follow the Cloudflare guide.",
    );
  }
  return remoteAccessRow(f);
}

/** monthly-limit in own-mailbox mode (§2.8): a plan with a daily limit already stops Mailgun, so the row is "info". */
function ownMonthlyLimitRow(f: ChecklistFacts): ChecklistRow {
  const limit = f.plan?.dailyLimit ?? null;
  if (limit !== null) return row(f, "monthly-limit", "info", PLAN_TEXTS.monthlyNotNeeded(limit));
  return monthlyLimitRow(f);
}

/**
 * reply-test in own-mailbox mode (O13, O15): a stored decision counts only for this sending domain, today's own From and
 * own-mailbox mode (`replyTestPassedFor(…, { ownMailbox: true })`). The own From is the saved From when it fits the
 * sending domain (`validateOwnMailboxFrom`).
 */
function ownReplyTestRow(f: ChecklistFacts): ChecklistRow {
  const r = f.replyTest;
  const fits = validateOwnMailboxFrom(f.from?.address ?? "", f.domain);
  const from = fits.ok ? fits.address : null;
  if (!from) return row(f, "reply-test", "warn", OWN_REPLY_TEST_TEXTS.noFromRow);
  const setting = { status: r.status, domain: r.domain, from: r.from ?? null, replies: r.replies };
  if (replyTestPassedFor(setting, f.domain, from, { ownMailbox: true })) {
    const when = r.decidedAt ? ` on ${formatShortDate(r.decidedAt, f.timeZone, f.now)}` : "";
    return row(f, "reply-test", "ok", OWN_REPLY_TEST_TEXTS.passedRow(when, from));
  }
  const onThisDomain = r.domain !== null && r.domain.toLowerCase() === f.domain.toLowerCase();
  if (onThisDomain && r.status === "failed" && r.replies === "own-mailbox" && sameFrom(r.from, from)) {
    return row(f, "reply-test", "bad", OWN_REPLY_TEST_TEXTS.failedRow(from), OWN_REPLY_TEST_TEXTS.failedRowFix);
  }
  return row(f, "reply-test", "warn", `Not tested yet with the From address ${from}. Live campaigns start once this passes.`);
}

/**
 * postmaster in own-mailbox mode: the shared-From rule for the sending domain. It is the Owner's everyday domain, whose
 * google-site-verification record may be for any Google service, so it never proves Postmaster Tools is set up.
 */
function ownPostmasterRow(f: ChecklistFacts, txt: TwoAnswers<string[]> | null): ChecklistRow {
  const d = clean(f.domain);
  const addIt = `click Add new domain, type ${d}, copy the TXT record it shows and add it (Name ${relativeName(d, zoneOf(d))}). It shows data only once you send enough email.`;
  if (txt && seen(txt).some((x) => x.trim().toLowerCase().startsWith("google-site-verification="))) {
    return row(
      f,
      "postmaster",
      "info",
      `A Google verification record is on ${d}. Check at postmaster.google.com that ${d} is listed there.`,
      `The app can't tell which Google service that record is for. If ${d} isn't listed in Postmaster Tools, ${addIt}`,
    );
  }
  return row(f, "postmaster", "info", `Optional: see how Gmail rates ${d}, the domain your everyday email uses.`, `Open postmaster.google.com, ${addIt}`);
}

/**
 * Own-mailbox mode's rows, in display order (§3.3): mailgun-domain, spf, dkim, tracking-cname, https-links, dmarc,
 * from-mx, tracking-off, unsubscribe, signing-key, webhooks, sending-allowed, monthly-limit, remote-access, reply-test,
 * postmaster, domain-age. Team facts are never built here (`teamOf` isn't called): dkim, dmarc and domain-age use their
 * per-person wording for the sending domain. `facts.from.dns` is the sending domain's own DNS (with the SPF walk's
 * `names` and `dangling`); `facts.dns` is Mailgun's view of the same domain.
 */
function buildOwnMailboxRows(f: ChecklistFacts, keyBits: number | null | undefined): ChecklistRow[] {
  const zone = zoneOf(f.domain);
  const m = f.mailgun.ok ? f.mailgun.value : null;
  const dns = f.dns;
  const own = f.from?.dns ?? null;
  const rows: ChecklistRow[] = [mailgunDomainRow(f, true)];
  if (m && dns) {
    const txtKey = dns.dkim.find((k) => k.recordType === "TXT");
    const bits = keyBits !== undefined ? keyBits : txtKey ? keyBitsFromLength(pValue(txtKey.expected)) : null;
    rows.push(ownSpfRow(f, m, own ?? dns), dkimRow(f, dns, zone, bits), trackingCnameRow(f, dns, zone));
  } else {
    rows.push(mailgunUnavailable(f, "spf"), mailgunUnavailable(f, "dkim"), mailgunUnavailable(f, "tracking-cname"));
  }
  rows.push(m ? ownHttpsRow(f, m) : mailgunUnavailable(f, "https-links"));
  const dmarc = dns?.dmarc ?? own?.dmarc ?? null;
  rows.push(dmarc ? dmarcRow(f, { dmarc }, zone, true) : mailgunUnavailable(f, "dmarc"));
  rows.push(ownFromMxRow(f, own?.mx ?? dns?.mx ?? null));
  rows.push(trackingOffRow(f), unsubscribeRow(f), signingKeyRow(f), ownWebhooksRow(f, m));
  rows.push(m ? sendingAllowedRow(f, m) : mailgunUnavailable(f, "sending-allowed"));
  rows.push(ownMonthlyLimitRow(f), ownRemoteAccessRow(f), ownReplyTestRow(f), ownPostmasterRow(f, own?.txt ?? dns?.txt ?? null), domainAgeRow(f));
  return rows;
}

/**
 * O37 (§2.5 item 7): a website domain (WEBSITE_DOMAINS) checked in app mode — a corrupted "mailgun.replies", a seed, a
 * manual edit — gets no receiving advice: the mx row says to connect again in own-mailbox mode, with no record box.
 */
function websiteMxRow(f: ChecklistFacts, dns: DnsFacts | null): ChecklistRow {
  const d = clean(f.domain);
  return row(f, "mx", "bad", OWN_MAILBOX_TEXTS.websiteInAppMode(d), OWN_MAILBOX_TEXTS.websiteInAppModeFix, [], dns ? detailOf(dns.mx) : null);
}

/** The row without MX record boxes (O37: no MX box anywhere for a website domain). */
function withoutMxBoxes(r: ChecklistRow): ChecklistRow {
  return r.records.some((x) => x.type.toUpperCase() === "MX") ? { ...r, records: r.records.filter((x) => x.type.toUpperCase() !== "MX") } : r;
}

/**
 * Every checklist row, in display order (§5.3). `keyBits` is the DKIM key size measured by the server (node:crypto);
 * when it is null the size is estimated from the key's length. With `facts.from` (a saved shared From address,
 * SHARED-FROM-DESIGN §5) the from-mx and from-spf rows follow the DMARC row.
 *
 * MAIN-DOMAIN-DESIGN §5: `facts.ownMailbox === true` → the own-mailbox list (buildOwnMailboxRows). A WEBSITE_DOMAINS
 * sending domain without it → today's list with the O37 guard (the mx row asks to connect again in own-mailbox mode, the
 * spf row never shows a value, no MX record box anywhere). Any other app-mode facts → exactly today's list.
 */
export function buildChecklistRows(facts: ChecklistFacts, opts: { keyBits?: number | null } = {}): ChecklistRow[] {
  const f = facts;
  if (f.ownMailbox === true) return buildOwnMailboxRows(f, opts.keyBits);
  const website = WEBSITE_DOMAINS.has(clean(f.domain));
  const zone = zoneOf(f.domain);
  const team = teamOf(f);
  const rows: ChecklistRow[] = [mailgunDomainRow(f)];
  const m = f.mailgun.ok ? f.mailgun.value : null;
  const dns = f.dns;
  if (m && dns) {
    const txtKey = dns.dkim.find((k) => k.recordType === "TXT");
    const bits = opts.keyBits !== undefined ? opts.keyBits : txtKey ? keyBitsFromLength(pValue(txtKey.expected)) : null;
    rows.push(
      // O37, review DOMAIN-4: the own-mailbox SPF logic (dangling includes and both resolvers' walks included), but its
      // fix is never an include to add to the website domain: connect again in own-mailbox mode first.
      website ? ownSpfRow(f, m, dns, { appMode: true }) : spfRow(f, m, dns, zone),
      dkimRow(f, dns, zone, bits, team),
      website ? websiteMxRow(f, dns) : mxRow(f, m, dns, zone),
      trackingCnameRow(f, dns, zone),
    );
  } else {
    rows.push(
      mailgunUnavailable(f, "spf"),
      mailgunUnavailable(f, "dkim"),
      website ? websiteMxRow(f, null) : mailgunUnavailable(f, "mx"),
      mailgunUnavailable(f, "tracking-cname"),
    );
  }
  rows.push(m ? httpsRow(f, m) : mailgunUnavailable(f, "https-links"));
  // Shared-From mode: DMARC is judged by the From domain, whose DNS the check reads itself (no Mailgun needed).
  rows.push(team ? teamDmarcRow(f, team) : dns ? dmarcRow(f, dns, zone) : mailgunUnavailable(f, "dmarc"));
  // The From domain's own rows, right after DMARC, only while a From address is saved (§3.2).
  if (f.from) rows.push(fromMxRow(f.from), fromSpfRow(f, f.from));
  rows.push(trackingOffRow(f), unsubscribeRow(f));
  rows.push(m ? spamFilterRow(f, m) : mailgunUnavailable(f, "spam-filter"));
  rows.push(m ? retentionRow(f, m) : mailgunUnavailable(f, "retention"));
  rows.push(signingKeyRow(f));
  rows.push(m ? webhooksRow(f, m) : mailgunUnavailable(f, "webhooks"));
  rows.push(replyRoutesRow(f));
  rows.push(m ? sendingAllowedRow(f, m) : mailgunUnavailable(f, "sending-allowed"));
  rows.push(
    monthlyLimitRow(f),
    remoteAccessRow(f),
    replyTestRow(f, team),
    team ? teamPostmasterRow(f, team) : postmasterRow(f, dns),
    domainAgeRow(f, team ? team.org : f.domain),
  );
  return website ? rows.map(withoutMxBoxes) : rows;
}
