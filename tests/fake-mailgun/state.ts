import crypto from "node:crypto";
import type { FakeEvent } from "./events";
import { toLogItem } from "./events";

/**
 * The fake Mailgun server's options, faults and in-memory world (M3-DESIGN §6.2). Everything is in memory and reset
 * between tests; nothing here ever talks to the network.
 */

export type FakeRegion = "EU" | "US";

/** The Mailgun plan the fake behaves like (MAIN-DOMAIN-DESIGN §7.8 adds "free"). */
export type FakePlan = "foundation" | "basic" | "free";

/** The rolling window of the free plan's daily sending limit. */
export const DAILY_LIMIT_WINDOW_MS = 24 * 3_600_000;

/** Messages the fake accepted in the 24 hours before `now` (test mode included): the free plan's rolling count. */
export function sentInLast24h(world: FakeWorld, now: Date): number {
  const from = now.getTime() - DAILY_LIMIT_WINDOW_MS;
  return world.messages.filter((m) => m.receivedAt.getTime() > from).length;
}

export type FakeSwitches = {
  /** Logs: 400 "duration is required" unless the body has `duration` (tests the client's fallback). */
  strictDuration: boolean;
  /** Logs: the last non-empty page still carries a `next` token (tests the empty-page stop rule). */
  nextOnLastPage: boolean;
  /** Suppressions: `paging.next` points at a foreign host (tests the origin guard). */
  crossOriginNext: boolean;
  /** v3 webhooks GET answers `{url}` instead of `{urls}`. */
  legacyUrlField: boolean;
  /** PUT /v3/routes/{id} answers the bare route instead of `{message, route}`. */
  putBareRoute: boolean;
  /** Unsubscribe tracking PUT keeps the old footers when "" is sent. */
  ignoreEmptyFooters: boolean;
  /** PUT /v4/domains/{d}/verify answers 429. */
  verifyRateLimited: boolean;
  /** x509 generation ends in status "error". */
  certFails: boolean;
  /** The status call that turns a processing certificate active (1 = the first). */
  certPolls: number;
  /** Logs `message_id =` matches only the <bracketed> form (tests the proven-form learning, §4.3.6). */
  bracketedMessageIdFilter: boolean;
  /** Sends answer with, and events carry, Mailgun's own id instead of our h:Message-Id (§4.4.2 matching order). */
  rewriteMessageId: boolean;
  /** `user_variables contains` never matches (tests "no positive control → never requeue"). */
  brokenContainsFilter: boolean;
  // ── address validation (M5-DESIGN §7.1, research verification-reference §11.3) ──
  /** Shape of `engagement` in validation answers: the object (default), `{}`, null, or left out. */
  validateEngagement: "object" | "empty" | "null" | "absent";
  /** Validation answers carry `"did_you_mean": null` instead of leaving it out. */
  validateDidYouMeanNull: boolean;
  /** Validation answers (faults included) carry no X-RateLimit-* headers (tests the 2 s × 2^n back-off). */
  validateNoRateHeaders: boolean;
  /** At most this many validate requests in flight; extra ones get 429 without a reset header. null = no limit. */
  validateMaxActive: number | null;
  /** How long a `slow…` address takes to answer, in ms. */
  validateSlowMs: number;
};

export const DEFAULT_SWITCHES: FakeSwitches = {
  strictDuration: false,
  nextOnLastPage: false,
  crossOriginNext: false,
  legacyUrlField: false,
  putBareRoute: false,
  ignoreEmptyFooters: false,
  verifyRateLimited: false,
  certFails: false,
  certPolls: 2,
  bracketedMessageIdFilter: false,
  rewriteMessageId: false,
  brokenContainsFilter: false,
  validateEngagement: "object",
  validateDidYouMeanNull: false,
  validateNoRateHeaders: false,
  validateMaxActive: null,
  validateSlowMs: 1_500,
};

export type FakeMailgunOptions = {
  /** Default "send.example.com". */
  domain?: string;
  /**
   * Older sending domains the fake also answers for (same region, same key): their domain paths are accepted like the
   * main domain's and share its world (lists, events, stored messages). Their Logs are empty unless a test adds events
   * for them. For the catch-up's several-domain cases. Default none.
   */
  otherDomains?: string[];
  /** Requests for the domain "in the other region" behave as unknown (404). Default "EU". */
  region?: FakeRegion;
  /**
   * The domain whose DKIM key signs the sending domain's email (SHARED-FROM-DESIGN §7.8): Mailgun's DKIM record for the
   * domain is then named `pdk1._domainkey.<dkimAuthority>` (a subdomain signed by its root's authority, e.g.
   * send.example.com signed by example.com). Default: the domain itself (today's record name).
   */
  dkimAuthority?: string;
  /** Default "key-fake-api". */
  apiKey?: string;
  /** Also accepted on POST /messages only (a domain sending key). Default none. */
  sendingKey?: string | null;
  /** Default "key-fake-signing"; null → GET http_signing_key answers 400. */
  signingKey?: string | null;
  /**
   * "basic" → x509 answers 402. "free" (MAIN-DOMAIN-DESIGN §7.8) → x509 answers 402 too, a daily sending limit (100 by
   * default), one inbound route at most and 1 day of logs by default. Default "foundation".
   */
  plan?: FakePlan;
  /** Logs retention in days, default 5 (1 on the free plan). */
  retentionDays?: number;
  /**
   * MAIN-DOMAIN-DESIGN §7.8: false = "the domain's MX isn't Mailgun's" (own-mailbox mode): every preset answer to the
   * fake's domain or its otherDomains lands "outside" (nothing stored, nothing evented), and the receiving DNS records
   * report `valid: "unverified"`. Default true (today's fake).
   */
  receivesMail?: boolean;
  /**
   * MAIN-DOMAIN-DESIGN §7.8: messages (test mode included) past this many in the fake's rolling 24 hours answer 400
   * "Domain <d> has reached its daily sending limit of <n> messages." (text chosen for the tests, UNVERIFIED). Default
   * 100 on the free plan, none otherwise.
   */
  dailyLimit?: number | null;
  /**
   * MAIN-DOMAIN-DESIGN §7.8: a free account's authorized recipients; a message to anyone else answers 403 "… is not
   * allowed to send: Free accounts are for test purposes only …". Default null (no such limit).
   */
  authorizedRecipients?: string[] | null;
  /**
   * The domain's tracking settings as "Apply recommended settings" leaves them: open and click tracking off, unsubscribe
   * handling on with blank footers. For a seeded database that records a finished Apply run (the own state of the screen
   * checks, `--settings-applied`): without it the first catch-up finds tracking "switched back on" and pauses sending
   * (review SCREENS-12). Default false: tracking on, unsubscribe handling off with Mailgun's footers (today's fake).
   */
  settingsApplied?: boolean;
  /** Highest message_ttl (seconds), default 86,400 (Foundation: 1 day). */
  maxMessageTtl?: number;
  /** Accepted events show up in Logs this long after the send, default 0. */
  indexLagMs?: number;
  now?: () => Date;
  /** Default 0 (any free port). */
  port?: number;
  /** CLI: where signed webhooks are POSTed; must be loopback. */
  appUrl?: string | null;
  /** Custom monthly message limit; null (default) → GET answers 404 "No threshold for account". */
  monthlyLimit?: { limit: number; current: number } | null;
  switches?: Partial<FakeSwitches>;
};

export type Fault =
  | { kind: "status"; status: number; body: string | object; headers?: Record<string, string> }
  /** Never answers → the client's timeout fires. */
  | { kind: "hang" }
  /** Records the message + accepted event, then destroys the socket. */
  | { kind: "acceptThenDrop" }
  /** Records the message + accepted event, then answers 302 (→ ambiguous). */
  | { kind: "acceptThenRedirect" }
  /** Records the message + accepted event, then answers 200 with {} (→ ambiguous). */
  | { kind: "acceptWithoutId" }
  /** 403 {"message":"Domain … is not allowed to send: business verification is required"}. */
  | { kind: "businessVerification" }
  /** Waits `ms` on real timers, then answers normally, or with `then` (M5: a timeout without hanging for ever). */
  | { kind: "delay"; ms: number; then?: Fault };

export type FakeRequest = {
  method: string;
  path: string;
  query: Record<string, string[]>;
  /** Parsed: form fields as Record<string, string[]>, JSON as itself, anything else as text (null when empty). */
  body: unknown;
  /** Lowercase names; never `authorization`. */
  headers: Record<string, string>;
};

export type FakeMessage = { id: string; fields: Record<string, string[]>; receivedAt: Date };

export type DnsKind = "spf" | "dkim" | "mx" | "tracking";

export type SuppressionEntry = { address: string; createdAt: Date; code?: string; error?: string; tags?: string[] };
export type FakeSuppressionList = "bounces" | "complaints" | "unsubscribes";

export type FakeRoute = {
  id: string;
  priority: number;
  description: string;
  expression: string;
  actions: string[];
  createdAt: Date;
  seq: number;
};

export type FakeCertificate = { status: "processing" | "active" | "expired" | "error"; polls: number; startedAt: Date };

/** One answered validate request: `billable` = a 200 answer (research §11.4: 4xx, 429 and 5xx assumed free). */
export type FakeValidationCall = { address: string; at: Date; status: number; billable: boolean };

/** `setValidation(address, …)`: the next `left` answers for that address (null = every one) use this status/body. */
export type FakeValidationOverride = { status: number | null; body: object | null; left: number | null };

/** What the fake knows about address validation. */
export type FakeValidationWorld = {
  calls: FakeValidationCall[];
  /** Billable answers per address (lowercase). */
  byAddress: Map<string, number>;
  /** The most validate requests that were in flight at once. */
  peakInFlight: number;
  /** Per address (lowercase). */
  overrides: Map<string, FakeValidationOverride>;
};

export type StoredInbound = {
  key: string;
  storedAt: Date;
  /** The default-Accept JSON (research §7). */
  json: Record<string, unknown>;
  /** For Accept: message/rfc2822. */
  mime: { recipients: string; sender: string; from: string; subject: string; "body-mime": string };
};

export type WebhookTypeName =
  | "accepted"
  | "delivered"
  | "opened"
  | "clicked"
  | "unsubscribed"
  | "complained"
  | "temporary_fail"
  | "permanent_fail";

export const WEBHOOK_TYPE_NAMES: readonly WebhookTypeName[] = [
  "accepted",
  "delivered",
  "opened",
  "clicked",
  "unsubscribed",
  "complained",
  "temporary_fail",
  "permanent_fail",
];

export type FakeDomain = {
  id: string;
  name: string;
  createdAt: Date;
  state: string;
  isDisabled: boolean;
  spamAction: "disabled" | "tag" | "block";
  webPrefix: string;
  webScheme: "http" | "https";
  messageTtl: number;
  webhooksRedactPii: boolean;
  wildcard: boolean;
  requireTls: boolean;
  useAutomaticSenderSecurity: boolean;
};

export type FakeTracking = {
  open: { active: boolean; placeAtTheTop: boolean };
  click: { active: boolean | "htmlonly" };
  unsubscribe: { active: boolean; htmlFooter: string; textFooter: string };
};

export const DEFAULT_HTML_FOOTER = '\n<br>\n<p><a href="%unsubscribe_url%">unsubscribe</a></p>\n';
export const DEFAULT_TEXT_FOOTER = "\n\nTo unsubscribe click: <%unsubscribe_url%>\n\n";

/** Everything the fake remembers. Mutated by the handlers; reset between tests. */
export type FakeWorld = {
  domain: FakeDomain;
  /** Lowercase; the domain itself unless FakeMailgunOptions.dkimAuthority says otherwise. */
  dkimAuthority: string;
  dns: Record<DnsKind, boolean>;
  tracking: FakeTracking;
  webhooks: Map<WebhookTypeName, string[]>;
  routes: FakeRoute[];
  routeSeq: number;
  suppressions: Record<FakeSuppressionList, Map<string, SuppressionEntry>>;
  messages: FakeMessage[];
  /** Per message id (Mailgun's id): what its events need. */
  messageFacts: Map<string, { ourId: string; recipients: string[]; from: string; to: string; subject: string; tags: string[]; userVariables: Record<string, string>; testMode: boolean }>;
  events: Array<{ ev: FakeEvent; visibleAt: Date }>;
  stored: Map<string, StoredInbound>;
  certificates: Map<string, FakeCertificate>;
  queue: { regularDisabled: boolean; reason: string | null; until: Date | null };
  monthlyLimit: { limit: number; current: number } | null;
  signingKey: string | null;
  signingKeyRegenerated: number;
  validation: FakeValidationWorld;
};

/** Records one answered validate request (and counts it for its address when billable). */
export function recordValidation(world: FakeWorld, call: FakeValidationCall): void {
  const address = call.address.trim().toLowerCase();
  world.validation.calls.push({ ...call, address: call.address });
  if (call.billable) world.validation.byAddress.set(address, (world.validation.byAddress.get(address) ?? 0) + 1);
}

export function createWorld(opts: Required<Pick<FakeMailgunOptions, "domain">> & FakeMailgunOptions, now: Date): FakeWorld {
  return {
    domain: {
      id: crypto.randomBytes(12).toString("hex"),
      name: opts.domain,
      createdAt: now,
      state: "unverified",
      isDisabled: false,
      spamAction: "disabled",
      webPrefix: "email",
      webScheme: "http",
      messageTtl: 86_400,
      webhooksRedactPii: false,
      wildcard: false,
      requireTls: false,
      useAutomaticSenderSecurity: true,
    },
    dkimAuthority: (opts.dkimAuthority ?? opts.domain).trim().toLowerCase().replace(/\.+$/, "") || opts.domain,
    dns: { spf: false, dkim: false, mx: false, tracking: false },
    tracking: opts.settingsApplied
      ? {
          open: { active: false, placeAtTheTop: false },
          click: { active: false },
          unsubscribe: { active: true, htmlFooter: "", textFooter: "" },
        }
      : {
          open: { active: true, placeAtTheTop: false },
          click: { active: true },
          unsubscribe: { active: false, htmlFooter: DEFAULT_HTML_FOOTER, textFooter: DEFAULT_TEXT_FOOTER },
        },
    webhooks: new Map(),
    routes: [],
    routeSeq: 0,
    suppressions: { bounces: new Map(), complaints: new Map(), unsubscribes: new Map() },
    messages: [],
    messageFacts: new Map(),
    events: [],
    stored: new Map(),
    certificates: new Map(),
    queue: { regularDisabled: false, reason: null, until: null },
    monthlyLimit: opts.monthlyLimit ?? null,
    signingKey: opts.signingKey === undefined ? "key-fake-signing" : opts.signingKey,
    signingKeyRegenerated: 0,
    validation: { calls: [], byAddress: new Map(), peakInFlight: 0, overrides: new Map() },
  };
}

/**
 * Mailgun's record values for this fake domain (EU hosts for an EU domain). The DKIM record is named after the DKIM
 * authority (`pdk1._domainkey.<dkimAuthority>`, the domain itself by default). With `receivesMail: false`
 * (MAIN-DOMAIN-DESIGN §7.8, the domain's MX isn't Mailgun's) the receiving records are always `valid: "unverified"`,
 * as Mailgun shows them for a domain whose mail goes elsewhere.
 */
export function dnsRecords(world: FakeWorld, region: FakeRegion, opts: { receivesMail?: boolean } = {}) {
  const d = world.domain.name;
  const eu = region === "EU";
  const elsewhere = opts.receivesMail === false;
  const rec = (kind: DnsKind, r: { record_type: string; name?: string; value: string; priority?: string }) => {
    if (kind === "mx" && elsewhere) return { ...r, valid: "unverified", is_active: true, cached: [] as string[] };
    return {
      ...r,
      valid: world.dns[kind] ? "valid" : "unknown",
      is_active: true,
      cached: world.dns[kind] ? [r.priority ? `${r.priority} ${r.value}` : r.value] : [],
    };
  };
  return {
    sending: [
      rec("spf", { record_type: "TXT", name: d, value: eu ? "v=spf1 include:eu.mailgun.org ~all" : "v=spf1 include:mailgun.org ~all" }),
      rec("dkim", {
        record_type: "TXT",
        name: `pdk1._domainkey.${world.dkimAuthority}`,
        value:
          "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu5fakekeyfakekeyfakekeyfakekeyfakekeyfakekeyfakekeyQIDAQAB",
      }),
      rec("tracking", { record_type: "CNAME", name: `${world.domain.webPrefix}.${d}`, value: eu ? "eu.mailgun.org" : "mailgun.org" }),
    ],
    receiving: [
      rec("mx", { record_type: "MX", value: eu ? "mxa.eu.mailgun.org" : "mxa.mailgun.org", priority: "10" }),
      rec("mx", { record_type: "MX", value: eu ? "mxb.eu.mailgun.org" : "mxb.mailgun.org", priority: "10" }),
    ],
  };
}

/** The `domain` object of GET /v4/domains/{d}. */
export function domainJson(world: FakeWorld): Record<string, unknown> {
  const d = world.domain;
  return {
    created_at: d.createdAt.toUTCString(),
    id: d.id,
    name: d.name,
    require_tls: d.requireTls,
    skip_verification: false,
    smtp_login: `postmaster@${d.name}`,
    spam_action: d.spamAction,
    state: d.state,
    type: "custom",
    use_automatic_sender_security: d.useAutomaticSenderSecurity,
    web_prefix: d.webPrefix,
    web_scheme: d.webScheme,
    wildcard: d.wildcard,
    message_ttl: d.messageTtl,
    webhooks_redact_pii: d.webhooksRedactPii,
    is_disabled: d.isDisabled,
  };
}

/** The mapping `{type: {urls}}` (or `{url}` with legacyUrlField) of every configured type. */
export function webhooksJson(world: FakeWorld, legacy: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [type, urls] of world.webhooks) {
    if (!urls.length) continue;
    out[type] = legacy ? { url: urls[0] } : { urls: [...urls] };
  }
  return { webhooks: out };
}

export function routeJson(r: FakeRoute): Record<string, unknown> {
  return {
    id: r.id,
    priority: r.priority,
    description: r.description,
    expression: r.expression,
    actions: [...r.actions],
    created_at: r.createdAt.toUTCString(),
  };
}

/** What `fake.state()` returns: plain copies, safe to inspect and change. */
export type FakeState = {
  domain: Record<string, unknown>;
  /** The domain whose DKIM key signs (SHARED-FROM-DESIGN §7.8); the domain itself unless started with one. */
  dkimAuthority: string;
  dns: Record<DnsKind, boolean>;
  tracking: FakeTracking & { webScheme: string };
  webhooks: Record<string, string[]>;
  routes: Array<Record<string, unknown>>;
  suppressions: Record<FakeSuppressionList, SuppressionEntry[]>;
  logEvents: Array<Record<string, unknown>>;
  certificates: Record<string, { status: string; polls: number }>;
  queue: { regularDisabled: boolean; reason: string | null; until: string | null };
  monthlyLimit: { limit: number; current: number } | null;
  signingKey: string | null;
  signingKeyRegenerated: number;
  stored: Array<{ key: string; storedAt: string }>;
  /** Address validation counters (research §11.4): billable answers this month (fake clock, UTC), per address, peak concurrency. */
  validations: { billableThisMonth: number; byAddress: Record<string, number>; peakInFlight: number };
  // MAIN-DOMAIN-DESIGN §7.8: the plan the fake behaves like.
  /** False: the domain's MX isn't Mailgun's (presets to it land "outside"). */
  receivesMail: boolean;
  plan: FakePlan;
  /** Messages allowed in the rolling 24 hours; null = no limit. */
  dailyLimit: number | null;
  /** Only these recipients may be sent to; null = anyone. */
  authorizedRecipients: string[] | null;
  /** Messages accepted in the 24 hours before the fake's now (test mode included). */
  sentLast24h: number;
};

/** The plan settings `snapshot` reports (the resolved options). */
export type FakePlanFacts = {
  receivesMail: boolean;
  plan: FakePlan;
  dailyLimit: number | null;
  authorizedRecipients: string[] | null;
};

/** The validation counters of `snapshot`; the month is the calendar month (UTC) of `now`. */
function validationCounters(world: FakeWorld, now: Date): FakeState["validations"] {
  const month = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  const current = month(now);
  return {
    billableThisMonth: world.validation.calls.filter((c) => c.billable && month(c.at) === current).length,
    byAddress: Object.fromEntries(world.validation.byAddress),
    peakInFlight: world.validation.peakInFlight,
  };
}

export function snapshot(
  world: FakeWorld,
  now: Date = new Date(),
  plan: FakePlanFacts = { receivesMail: true, plan: "foundation", dailyLimit: null, authorizedRecipients: null },
): FakeState {
  const hooks: Record<string, string[]> = {};
  for (const [t, urls] of world.webhooks) if (urls.length) hooks[t] = [...urls];
  const list = (m: Map<string, SuppressionEntry>) => [...m.values()].map((e) => ({ ...e, tags: e.tags ? [...e.tags] : undefined }));
  const certs: Record<string, { status: string; polls: number }> = {};
  for (const [h, c] of world.certificates) certs[h] = { status: c.status, polls: c.polls };
  return {
    domain: domainJson(world),
    dkimAuthority: world.dkimAuthority,
    dns: { ...world.dns },
    tracking: {
      open: { ...world.tracking.open },
      click: { ...world.tracking.click },
      unsubscribe: { ...world.tracking.unsubscribe },
      webScheme: world.domain.webScheme,
    },
    webhooks: hooks,
    routes: world.routes.map(routeJson),
    suppressions: { bounces: list(world.suppressions.bounces), complaints: list(world.suppressions.complaints), unsubscribes: list(world.suppressions.unsubscribes) },
    logEvents: world.events.map((e) => toLogItem(e.ev)),
    certificates: certs,
    queue: { ...world.queue, until: world.queue.until ? world.queue.until.toISOString() : null },
    monthlyLimit: world.monthlyLimit ? { ...world.monthlyLimit } : null,
    signingKey: world.signingKey,
    signingKeyRegenerated: world.signingKeyRegenerated,
    stored: [...world.stored.values()].map((s) => ({ key: s.key, storedAt: s.storedAt.toISOString() })),
    validations: validationCounters(world, now),
    receivesMail: plan.receivesMail,
    plan: plan.plan,
    dailyLimit: plan.dailyLimit,
    authorizedRecipients: plan.authorizedRecipients ? [...plan.authorizedRecipients] : null,
    sentLast24h: sentInLast24h(world, now),
  };
}
