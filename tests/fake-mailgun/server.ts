import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { handleAdmin } from "./admin";
import {
  complainedEvent,
  deliveredEvent,
  permanentFailEvent,
  storedEvent,
  tempFailEvent,
  toEventData,
  unsubscribedEvent,
  type FakeEvent,
  type MessageFacts,
} from "./events";
import { bareAddress, stripBrackets, type FakeContext, type HandlerResult, type ParsedRequest, type ResolvedOptions } from "./handlers/context";
import { findRoute } from "./handlers/index";
import { VALIDATE_PATTERN, validationAddressOf } from "./handlers/validate";
import {
  deliveredToFake,
  findSentMessage,
  presetInbound,
  withoutTarget,
  type InboundPreset,
  type PresetTarget,
} from "./inbound-presets";
import {
  createWorld,
  DEFAULT_SWITCHES,
  recordValidation,
  snapshot,
  type DnsKind,
  type Fault,
  type FakeMailgunOptions,
  type FakeMessage,
  type FakeRegion,
  type FakeRequest,
  type FakeState,
  type FakeSwitches,
  type FakeValidationCall,
  type FakeWorld,
} from "./state";
import { DEFAULT_SIGNING_KEY, signedEventRequest, signedInboundRequest, type SignOptions } from "./webhooks";

export type { Fault, FakeMailgunOptions, FakeState, FakeSwitches, FakeValidationCall } from "./state";

/** `setValidation`'s answer: a status (default 200) and/or a body, for the next `times` calls (default every call). */
export type ValidationOverrideInput = { status?: number; body?: object; times?: number };

/**
 * What `receivePreset` did (SHARED-FROM-DESIGN §7.8): stored at the fake (Mailgun's MX), or delivered "outside" (the
 * target isn't on the fake's domain or its otherDomains, e.g. contact@<main domain> in shared-From mode, or the fake was
 * started with `receivesMail: false`, MAIN-DOMAIN-DESIGN §7.8): nothing stored, no `stored` event, nothing posted. `to`
 * is the bare target address, `target` which header it came from.
 */
export type ReceivePresetResult =
  | {
      ok: true;
      stored: true;
      deliveredTo: "mailgun";
      to: string;
      target: PresetTarget;
      storageKey: string;
      messageUrl: string;
      fields: Record<string, string>;
    }
  | { ok: true; stored: false; deliveredTo: "outside"; to: string; target: PresetTarget };

/**
 * The fake Mailgun server (M3-DESIGN §6, research §15): a plain node:http server on 127.0.0.1 that emulates every
 * Mailgun endpoint the app uses, with switches for Mailgun's unverified behaviours and a fault queue per endpoint.
 * It never makes an outbound request except postToApp to a loopback app (CLI mode), and has no proxy code.
 */
export interface FakeMailgun {
  /** "http://127.0.0.1:<port>". */
  readonly origin: string;
  /** Every API request (admin calls excluded), oldest first; headers without Authorization. */
  readonly requests: FakeRequest[];
  /** Every accepted email, oldest first (`id` = what Mailgun answered, without angle brackets). */
  readonly messages: FakeMessage[];
  /** The next `times` requests to `route` (e.g. "POST /v3/:d/messages") get `fault`. */
  failNext(route: string, fault: Fault, times?: number): void;
  setNow(now: () => Date): void;
  /** Which DNS records Mailgun sees as valid; the rest are "unknown". */
  setDns(valid: "all" | DnsKind[]): void;
  disableQueue(reason: string, until?: Date): void;
  /** Adds a `delivered` event (code 650 in test mode) and returns its webhook event-data. */
  deliver(messageId: string, opts?: { at?: Date }): Record<string, unknown>;
  tempFail(messageId: string, opts?: { at?: Date }): Record<string, unknown>;
  /** A permanent failure; `reason` "bounce" (default) or "hardfail" also adds the address to the bounces list. */
  bounce(messageId: string, opts?: { reason?: string; code?: number; at?: Date }): Record<string, unknown>;
  complain(messageId: string, opts?: { at?: Date }): Record<string, unknown>;
  unsubscribe(messageId: string, opts?: { at?: Date }): Record<string, unknown>;
  /**
   * Stores an inbound email and its `stored` Logs event; `fields` is the notify form (without signature fields). Takes
   * any recipient on purpose (tests feed it odd mail); `receivePreset` models where mail really lands.
   */
  receive(input: ReceiveInput): { storageKey: string; messageUrl: string; fields: Record<string, string> };
  /**
   * A preset answer (inbound-presets.ts) to one of the fake's sent messages (by Mailgun's id or our Message-Id), sent to
   * the preset's real target or `opts.to`, with `opts.overrides` on top. Stored like `receive()` only when the target is
   * on the fake's domain or its otherDomains; otherwise `deliveredTo: "outside"` and nothing is stored. Throws when the
   * fake has no such message. Posts nothing (use `signedInboundRequest` with the returned `fields` for the app).
   */
  receivePreset(
    preset: InboundPreset,
    messageId: string,
    opts?: { to?: PresetTarget; overrides?: Partial<ReceiveInput> },
  ): ReceivePresetResult;
  /** The domain whose DKIM key signs (FakeMailgunOptions.dkimAuthority; the domain itself by default). */
  readonly dkimAuthority: string;
  signedEventRequest(appUrl: string, eventData: object, opts?: SignOptions): Request;
  signedInboundRequest(appUrl: string, fields: Record<string, string>, opts?: SignOptions & { multipart?: boolean }): Request;
  state(): FakeState;
  reset(): void;
  close(): Promise<void>;
  // extras for tests and the admin API
  setSwitches(changes: Partial<FakeSwitches>): void;
  setMonthlyLimit(limit: { limit: number; current: number } | null): void;
  enableQueue(): void;
  /** Marks a certificate expired (default: the tracking host). */
  expireCertificate(host?: string): void;
  /** Adds an address to one of Mailgun's lists directly. */
  addSuppression(list: "bounces" | "complaints" | "unsubscribes", address: string, opts?: { createdAt?: Date; code?: string; error?: string }): void;
  /** Current fake time. */
  now(): Date;
  readonly options: Readonly<ResolvedOptions>;
  // address validation (M5-DESIGN §7.1)
  /** Every answered validate request, oldest first (`billable` = a 200 answer); the only place addresses appear. */
  readonly validations: readonly FakeValidationCall[];
  /**
   * The next `times` validations of `address` (default: every one) answer with this status and/or body, before the
   * address's own rule; once used up, the address's own rule answers again.
   */
  setValidation(address: string, answer: ValidationOverrideInput): void;
}

/**
 * One email arriving at the fake (M4-DESIGN §7.3, research replies-and-auto-replies §9). `text` is the message's text;
 * the optional fields shape it like the auto-replies, bounce notices and failed parses real mail servers produce.
 */
export type ReceiveInput = {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** The id it answers (angle brackets optional); also the default References. */
  inReplyTo?: string;
  references?: string[];
  /** Extra headers, added after the standard ones (e.g. ["Auto-Submitted", "auto-replied"]). */
  headers?: Array<[string, string]>;
  at?: Date;
  /**
   * SMTP MAIL FROM ("" or "<>" = the null sender of automatic mail): the notify field `sender`, the stored `sender`, a
   * header `X-Envelope-From: <…>` (or `<>`) and the Logs `stored` event's `envelope.sender`. Default: the From address,
   * with no X-Envelope-From header.
   */
  envelopeSender?: string;
  /** Mailgun's stripped-text: null leaves the field out (Mailgun's parse failed). Default `text`. */
  strippedText?: string | null;
  /** Mailgun's body-plain. Default `text`. */
  bodyPlain?: string;
  /** Replaces the default `Content-Type: text/plain; charset=utf-8` header (e.g. a multipart/report). */
  contentType?: string;
  /** A fixed Message-Id (angle brackets optional) instead of a random one (forwards and twins). */
  messageId?: string;
  /** Display name in the From header ("Anna Berg" → `"Anna Berg" <anna@firma.de>`). */
  fromName?: string;
};

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Waits on real timers (the `delay` fault and slow validations). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** A display name as a quoted string ("Berg, Anna" stays one name). */
function quotedName(name: string): string {
  return `"${name.replace(/(["\\])/g, "\\$1")}"`;
}

function queryOf(url: URL): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of url.searchParams) (out[k] ??= []).push(v);
  return out;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function parseForm(contentType: string, raw: Buffer): Promise<Record<string, string[]> | null> {
  if (!/^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(contentType)) return null;
  const fd = await new Request("http://fake.local/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(raw),
  }).formData();
  const out: Record<string, string[]> = {};
  for (const [k, v] of fd) (out[k] ??= []).push(typeof v === "string" ? v : `[file ${v.name}]`);
  return out;
}

class FakeMailgunServer implements FakeMailgun {
  readonly requests: FakeRequest[] = [];
  readonly messages: FakeMessage[];
  readonly options: ResolvedOptions;
  origin = "";
  #server: http.Server;
  #sockets = new Set<Socket>();
  #hanging = new Set<http.ServerResponse>();
  #faults = new Map<string, Array<{ fault: Fault; left: number }>>();
  #nowFn: () => Date;
  #switches: FakeSwitches;
  #world: FakeWorld;
  /** Validate requests being handled right now (from arrival until the response ends or the socket closes). */
  #validateInFlight = 0;

  constructor(private readonly init: FakeMailgunOptions) {
    const plan = init.plan ?? "foundation";
    const free = plan === "free";
    this.options = {
      domain: (init.domain ?? "send.example.com").toLowerCase(),
      otherDomains: (init.otherDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean),
      region: init.region ?? "EU",
      apiKey: init.apiKey ?? "key-fake-api",
      sendingKey: init.sendingKey ?? null,
      plan,
      retentionDays: init.retentionDays ?? (free ? 1 : 5),
      maxMessageTtl: init.maxMessageTtl ?? 86_400,
      indexLagMs: init.indexLagMs ?? 0,
      appUrl: init.appUrl ?? null,
      // MAIN-DOMAIN-DESIGN §7.8: today's fake unless asked (receives mail, no daily limit, anyone may be sent to).
      receivesMail: init.receivesMail ?? true,
      dailyLimit: init.dailyLimit === undefined ? (free ? 100 : null) : init.dailyLimit === null ? null : Math.max(0, Math.floor(init.dailyLimit)),
      authorizedRecipients: init.authorizedRecipients
        ? init.authorizedRecipients.map((a) => a.trim().toLowerCase()).filter(Boolean)
        : null,
    };
    this.#nowFn = init.now ?? (() => new Date());
    this.#switches = { ...DEFAULT_SWITCHES, ...(init.switches ?? {}) };
    this.#world = createWorld({ ...init, domain: this.options.domain }, this.#nowFn());
    this.messages = this.#world.messages;
    this.#server = http.createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: `Fake Mailgun error: ${err instanceof Error ? err.message : String(err)}` }));
        }
      });
    });
    this.#server.on("connection", (s: Socket) => {
      this.#sockets.add(s);
      s.on("close", () => this.#sockets.delete(s));
    });
  }

  async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, "127.0.0.1", () => resolve());
    });
    const addr = this.#server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${addr.port}`;
  }

  now(): Date {
    return this.#nowFn();
  }

  // ───────────── request handling ─────────────

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const url = new URL(req.url ?? "/", this.origin || "http://127.0.0.1");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    const contentType = headers["content-type"] ?? "";
    const method = (req.method ?? "GET").toUpperCase();

    if (url.pathname.startsWith("/__fake/")) {
      const out = await handleAdmin(this, { method, path: url.pathname, body: raw.toString("utf8") });
      this.#send(res, out, false);
      return;
    }

    const text = raw.toString("utf8");
    let form: Record<string, string[]> | null = null;
    try {
      form = await parseForm(contentType, raw);
    } catch {
      form = null;
    }
    let parsedJson: unknown = undefined;
    if (/^application\/json/i.test(contentType) && text) {
      try {
        parsedJson = JSON.parse(text);
      } catch {
        parsedJson = undefined;
      }
    }
    const query = queryOf(url);
    const logged: Record<string, string> = { ...headers };
    delete logged.authorization;
    this.requests.push({
      method,
      path: url.pathname,
      query,
      body: form ?? (parsedJson !== undefined ? parsedJson : text || null),
      headers: logged,
    });

    const match = findRoute(method, url.pathname);
    if (!match) {
      res.writeHead(404, { "content-type": "text/plain", ...this.#rateHeaders() });
      res.end("404 page not found");
      return;
    }

    // Address validation (M5-DESIGN §7.1): every answer is recorded, requests in flight are counted (the peak is kept)
    // and, with the `validateMaxActive` switch, extra ones get 429 without a reset header, like Mailgun's limit on
    // active requests.
    const isValidate = match.route.pattern === VALIDATE_PATTERN;
    const validateAddress = isValidate ? (validationAddressOf({ query, form }) ?? "") : null;
    if (isValidate) {
      this.#validateInFlight += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.#validateInFlight -= 1;
      };
      res.once("finish", release);
      res.once("close", release);
      const v = this.#world.validation;
      v.peakInFlight = Math.max(v.peakInFlight, this.#validateInFlight);
      const max = this.#switches.validateMaxActive;
      if (typeof max === "number" && max >= 0 && this.#validateInFlight > max) {
        await this.#reply(res, { status: 429, body: { message: "Too many requests" } }, false, validateAddress);
        return;
      }
    }
    const rateHeaders = !(isValidate && this.#switches.validateNoRateHeaders);
    const reply = (out: HandlerResult) => this.#reply(res, out, rateHeaders, validateAddress);

    const routeKey = `${method} ${match.route.pattern}`;
    let fault = this.#popFault(routeKey);
    while (fault?.kind === "delay") {
      await wait(fault.ms);
      fault = fault.then ?? null;
    }
    if (fault?.kind === "hang") {
      this.#hanging.add(res);
      res.on("close", () => this.#hanging.delete(res));
      return;
    }
    if (fault?.kind === "status") {
      await reply({ status: fault.status, body: fault.body, headers: fault.headers });
      return;
    }
    if (fault?.kind === "businessVerification") {
      await reply({ status: 403, body: { message: `Domain ${this.options.domain} is not allowed to send: business verification is required` } });
      return;
    }

    // auth
    const auth = headers.authorization ?? "";
    const ok = (key: string | null) => Boolean(key) && auth === "Basic " + Buffer.from(`api:${key}`).toString("base64");
    const authorised = ok(this.options.apiKey) || (match.route.auth === "messages" && ok(this.options.sendingKey));
    if (!authorised) {
      if (match.route.auth === "messages") await reply({ status: 401, body: "Forbidden" });
      else await reply({ status: 401, body: { message: "Invalid private key" } });
      return;
    }

    // domain and region
    const hint = headers["x-outreach-region"];
    const region: FakeRegion = hint === "US" || hint === "EU" ? hint : this.options.region;
    if (match.route.domain) {
      const d = this.options.domain;
      const value = (match.params[match.route.domain] ?? "").toLowerCase();
      const known =
        match.route.domain === "d"
          ? value === d || this.options.otherDomains.includes(value)
          : value === `${this.#world.domain.webPrefix}.${d}`;
      if (!known || region !== this.options.region) {
        const body = match.route.domain === "host" ? { Description: "x509 cert not found" } : { message: "Domain not found" };
        this.#send(res, { status: 404, body }, true);
        return;
      }
    }

    const parsed: ParsedRequest = {
      method,
      path: url.pathname,
      url,
      query,
      headers,
      contentType,
      raw,
      form,
      json: parsedJson,
      text,
      params: match.params,
    };
    const ctx: FakeContext = {
      world: this.#world,
      switches: this.#switches,
      opts: this.options,
      now: () => this.now(),
      origin: this.origin,
      region,
      req: parsed,
      addEvent: (ev, lagMs) => this.#addEvent(ev, lagMs ?? 0),
    };
    const result = match.route.handler(ctx);
    const accepted = result.status >= 200 && result.status < 300;
    if (fault?.kind === "acceptThenDrop" && accepted) {
      req.socket.destroy();
      return;
    }
    if (fault?.kind === "acceptThenRedirect" && accepted) {
      this.#send(res, { status: 302, body: "", headers: { location: "http://127.0.0.1:1/somewhere-else" } }, true);
      return;
    }
    if (fault?.kind === "acceptWithoutId" && accepted) {
      this.#send(res, { status: 200, body: {} }, true);
      return;
    }
    await reply(result);
  }

  /**
   * Sends an answer: a validate request's answer is recorded first (`validateAddress` non-null; billable = 200), then
   * the answer waits its `delayMs` (a slow validation) and goes out, unless the client has gone meanwhile.
   */
  async #reply(res: http.ServerResponse, out: HandlerResult, rateHeaders: boolean, validateAddress: string | null): Promise<void> {
    if (validateAddress !== null) {
      recordValidation(this.#world, { address: validateAddress, at: this.now(), status: out.status, billable: out.status === 200 });
    }
    if (out.delayMs && out.delayMs > 0) await wait(out.delayMs);
    if (res.destroyed || res.writableEnded) return;
    this.#send(res, out, rateHeaders);
  }

  #rateHeaders(): Record<string, string> {
    return {
      "x-ratelimit-limit": "300",
      "x-ratelimit-remaining": "299",
      "x-ratelimit-reset": String(this.now().getTime() + 10_000),
    };
  }

  #send(res: http.ServerResponse, out: HandlerResult, rateHeaders: boolean): void {
    const headers: Record<string, string> = rateHeaders ? this.#rateHeaders() : {};
    let payload = "";
    if (typeof out.body === "string") {
      headers["content-type"] = "text/plain; charset=utf-8";
      payload = out.body;
    } else if (out.body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(out.body);
    }
    for (const [k, v] of Object.entries(out.headers ?? {})) {
      if (v === "") delete headers[k.toLowerCase()];
      else headers[k.toLowerCase()] = v;
    }
    res.writeHead(out.status, headers);
    res.end(payload);
  }

  #popFault(routeKey: string): Fault | null {
    const queue = this.#faults.get(routeKey);
    if (!queue?.length) return null;
    const head = queue[0]!;
    head.left -= 1;
    if (head.left <= 0) queue.shift();
    return head.fault;
  }

  #addEvent(ev: FakeEvent, lagMs: number): void {
    this.#world.events.push({ ev, visibleAt: new Date(ev.at.getTime() + Math.max(0, lagMs)) });
  }

  // ───────────── controls ─────────────

  failNext(route: string, fault: Fault, times = 1): void {
    const key = route.trim().replace(/\s+/, " ");
    const [method, pattern] = key.split(" ");
    const normalised = `${(method ?? "").toUpperCase()} ${pattern ?? ""}`;
    const queue = this.#faults.get(normalised) ?? [];
    queue.push({ fault, left: Math.max(1, Math.floor(times)) });
    this.#faults.set(normalised, queue);
  }

  setNow(now: () => Date): void {
    this.#nowFn = now;
  }

  setDns(valid: "all" | DnsKind[]): void {
    const all: DnsKind[] = ["spf", "dkim", "mx", "tracking"];
    for (const k of all) this.#world.dns[k] = valid === "all" || valid.includes(k);
  }

  disableQueue(reason: string, until?: Date): void {
    this.#world.queue = { regularDisabled: true, reason, until: until ?? null };
  }

  enableQueue(): void {
    this.#world.queue = { regularDisabled: false, reason: null, until: null };
  }

  setSwitches(changes: Partial<FakeSwitches>): void {
    Object.assign(this.#switches, changes);
  }

  setMonthlyLimit(limit: { limit: number; current: number } | null): void {
    this.#world.monthlyLimit = limit ? { ...limit } : null;
  }

  expireCertificate(host?: string): void {
    const h = host ?? `${this.#world.domain.webPrefix}.${this.options.domain}`;
    const cert = this.#world.certificates.get(h);
    if (cert) cert.status = "expired";
    else this.#world.certificates.set(h, { status: "expired", polls: 0, startedAt: this.now() });
  }

  addSuppression(
    list: "bounces" | "complaints" | "unsubscribes",
    address: string,
    opts: { createdAt?: Date; code?: string; error?: string } = {},
  ): void {
    const a = address.trim().toLowerCase();
    this.#world.suppressions[list].set(a, {
      address: a,
      createdAt: opts.createdAt ?? this.now(),
      ...(list === "bounces" ? { code: opts.code ?? "550", error: opts.error ?? "No such mailbox" } : {}),
      ...(list === "unsubscribes" ? { tags: ["*"] } : {}),
    });
  }

  #facts(messageId: string): MessageFacts {
    const id = stripBrackets(messageId).toLowerCase();
    let found = this.#world.messageFacts.get(id);
    let mailgunId = id;
    if (!found) {
      for (const [mid, f] of this.#world.messageFacts) {
        if (f.ourId === id) {
          found = f;
          mailgunId = mid;
          break;
        }
      }
    }
    if (!found) throw new Error(`The fake Mailgun server has no message ${messageId}.`);
    return {
      messageId: mailgunId,
      domain: this.options.domain,
      recipient: found.recipients[0]!,
      from: found.from,
      to: found.to,
      subject: found.subject,
      tags: found.tags,
      userVariables: found.userVariables,
      testMode: found.testMode,
    };
  }

  #emit(ev: FakeEvent): Record<string, unknown> {
    this.#addEvent(ev, 0);
    return toEventData(ev);
  }

  deliver(messageId: string, opts: { at?: Date } = {}): Record<string, unknown> {
    return this.#emit(deliveredEvent(this.#facts(messageId), opts.at ?? this.now()));
  }

  tempFail(messageId: string, opts: { at?: Date } = {}): Record<string, unknown> {
    return this.#emit(tempFailEvent(this.#facts(messageId), opts.at ?? this.now()));
  }

  bounce(messageId: string, opts: { reason?: string; code?: number; at?: Date } = {}): Record<string, unknown> {
    const facts = this.#facts(messageId);
    const at = opts.at ?? this.now();
    const reason = opts.reason ?? "bounce";
    if (reason === "bounce" || reason === "hardfail") {
      this.addSuppression("bounces", facts.recipient, {
        createdAt: at,
        code: String(opts.code ?? 550),
        error: "5.5.0 Requested action not taken: mailbox unavailable",
      });
    }
    return this.#emit(permanentFailEvent(facts, at, { reason, code: opts.code }));
  }

  complain(messageId: string, opts: { at?: Date } = {}): Record<string, unknown> {
    const facts = this.#facts(messageId);
    const at = opts.at ?? this.now();
    this.addSuppression("complaints", facts.recipient, { createdAt: at });
    return this.#emit(complainedEvent(facts, at));
  }

  unsubscribe(messageId: string, opts: { at?: Date } = {}): Record<string, unknown> {
    const facts = this.#facts(messageId);
    const at = opts.at ?? this.now();
    this.addSuppression("unsubscribes", facts.recipient, { createdAt: at });
    return this.#emit(unsubscribedEvent(facts, at));
  }

  receive(input: ReceiveInput): { storageKey: string; messageUrl: string; fields: Record<string, string> } {
    const at = input.at ?? this.now();
    const domain = this.options.domain;
    const key = crypto.randomBytes(24).toString("base64url");
    const messageUrl = `${this.origin}/v3/domains/${domain}/messages/${key}`;
    const fromBare = bareAddress(input.from);
    const from = input.fromName ? `${quotedName(input.fromName)} <${fromBare}>` : input.from;
    const recipient = bareAddress(input.to);
    const fromDomain = fromBare.split("@")[1] || "example.com";
    const messageId = input.messageId ? stripBrackets(input.messageId) : `${crypto.randomBytes(8).toString("hex")}@${fromDomain}`;
    // "" or "<>" is the null sender of automatic mail; anything else is a bare address.
    const envelope = input.envelopeSender === undefined ? null : input.envelopeSender.replace(/[<>\s]/g, "").toLowerCase();
    const sender = envelope ?? fromBare;
    const bodyPlain = input.bodyPlain ?? input.text;
    const stripped = input.strippedText === undefined ? input.text : input.strippedText;
    const headers: Array<[string, string]> = [
      ["Received", `from mail.${fromDomain} by mxa.mailgun.org with SMTP`],
      ["Mime-Version", "1.0"],
      ["From", from],
      ["To", input.to],
      ["Subject", input.subject],
      ["Date", at.toUTCString()],
      ["Message-Id", `<${messageId}>`],
    ];
    if (input.inReplyTo) headers.push(["In-Reply-To", `<${stripBrackets(input.inReplyTo)}>`]);
    const refs = input.references?.length
      ? input.references
      : input.inReplyTo
        ? [input.inReplyTo]
        : [];
    if (refs.length) headers.push(["References", refs.map((r) => `<${stripBrackets(r)}>`).join(" ")]);
    if (envelope !== null) headers.push(["X-Envelope-From", `<${envelope}>`]);
    for (const h of input.headers ?? []) headers.push([h[0], h[1]]);
    headers.push(["Content-Type", input.contentType ?? "text/plain; charset=utf-8"]);
    const strippedField: Record<string, string> = stripped === null ? {} : { "stripped-text": stripped };

    const topLevel: Record<string, string> = {};
    for (const [name, value] of headers) if (!(name in topLevel)) topLevel[name] = value;
    this.#world.stored.set(key, {
      key,
      storedAt: at,
      json: {
        ...topLevel,
        sender,
        recipients: recipient,
        from,
        subject: input.subject,
        "body-plain": bodyPlain,
        ...strippedField,
        "stripped-signature": "",
        "body-html": `<p>${bodyPlain}</p>`,
        "stripped-html": `<p>${stripped ?? bodyPlain}</p>`,
        "message-headers": headers.map(([n, v]) => [n, v]),
        "message-url": messageUrl,
        attachments: [],
        "content-id-map": {},
      },
      mime: {
        recipients: recipient,
        sender,
        from,
        subject: input.subject,
        "body-mime": `${headers.map(([n, v]) => `${n}: ${v}`).join("\r\n")}\r\n\r\n${bodyPlain}`,
      },
    });
    this.#addEvent(
      storedEvent({
        domain,
        recipient,
        messageId,
        from,
        to: input.to,
        subject: input.subject,
        storage: { key, url: messageUrl },
        at,
        envelopeSender: sender,
      }),
      0,
    );
    const fields: Record<string, string> = {
      domain,
      recipient,
      sender,
      from,
      subject: input.subject,
      "body-plain": bodyPlain,
      ...strippedField,
      "stripped-signature": "",
      "message-headers": JSON.stringify(headers),
      "message-url": messageUrl,
      attachments: "[]",
      "content-id-map": "{}",
    };
    return { storageKey: key, messageUrl, fields };
  }

  receivePreset(
    preset: InboundPreset,
    messageId: string,
    opts: { to?: PresetTarget; overrides?: Partial<ReceiveInput> } = {},
  ): ReceivePresetResult {
    const message = findSentMessage(this.messages, messageId);
    if (!message) throw new Error(`The fake Mailgun server has no sent message ${messageId}.`);
    const answer = presetInbound(preset, message, { to: opts.to });
    const input: ReceiveInput = { ...withoutTarget(answer), ...(opts.overrides ?? {}) };
    const to = bareAddress(input.to);
    if (!deliveredToFake(to, receivingDomains(this.options))) {
      return { ok: true, stored: false, deliveredTo: "outside", to, target: answer.target };
    }
    return { ok: true, stored: true, deliveredTo: "mailgun", to, target: answer.target, ...this.receive(input) };
  }

  get dkimAuthority(): string {
    return this.#world.dkimAuthority;
  }

  signedEventRequest(appUrl: string, eventData: object, opts: SignOptions = {}): Request {
    return signedEventRequest(appUrl, eventData, { key: this.#signingKey(), now: this.now(), ...opts });
  }

  signedInboundRequest(appUrl: string, fields: Record<string, string>, opts: SignOptions & { multipart?: boolean } = {}): Request {
    return signedInboundRequest(appUrl, fields, { key: this.#signingKey(), now: this.now(), ...opts });
  }

  /** The current signing key (after a regeneration, the new one), else the default. */
  #signingKey(): string {
    return this.#world.signingKey ?? DEFAULT_SIGNING_KEY;
  }

  state(): FakeState {
    const o = this.options;
    return snapshot(this.#world, this.now(), {
      receivesMail: o.receivesMail,
      plan: o.plan,
      dailyLimit: o.dailyLimit,
      authorizedRecipients: o.authorizedRecipients,
    });
  }

  get validations(): readonly FakeValidationCall[] {
    return this.#world.validation.calls;
  }

  setValidation(address: string, answer: ValidationOverrideInput): void {
    const key = address.trim().toLowerCase();
    if (!key) throw new Error("setValidation needs an address.");
    const times = answer.times === undefined ? null : Math.max(1, Math.floor(answer.times));
    this.#world.validation.overrides.set(key, { status: answer.status ?? null, body: answer.body ?? null, left: times });
  }

  reset(): void {
    this.#abortHanging();
    this.#nowFn = this.init.now ?? (() => new Date());
    this.#switches = { ...DEFAULT_SWITCHES, ...(this.init.switches ?? {}) };
    const fresh = createWorld({ ...this.init, domain: this.options.domain }, this.#nowFn());
    // Keep the same array objects, so `fake.messages` stays the live list.
    this.messages.length = 0;
    fresh.messages = this.messages;
    this.#world = fresh;
    this.requests.length = 0;
    this.#faults.clear();
  }

  #abortHanging(): void {
    for (const res of this.#hanging) res.socket?.destroy();
    this.#hanging.clear();
  }

  async close(): Promise<void> {
    this.#abortHanging();
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/**
 * The domains whose mail reaches the fake (Mailgun's MX): its domain and otherDomains, or none at all with
 * `receivesMail: false` (MAIN-DOMAIN-DESIGN §7.8: the domain's MX is a mail provider's, so every preset lands "outside").
 */
export function receivingDomains(o: Pick<ResolvedOptions, "domain" | "otherDomains" | "receivesMail">): string[] {
  return o.receivesMail ? [o.domain, ...o.otherDomains] : [];
}

/** Starts the fake on 127.0.0.1 (port 0 = any free port) and resolves once it listens. */
export async function startFakeMailgun(opts: FakeMailgunOptions = {}): Promise<FakeMailgun> {
  const fake = new FakeMailgunServer(opts);
  await fake.listen(opts.port ?? 0);
  return fake;
}
