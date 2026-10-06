import { normalizeMessageId, type NormalizedEvent } from "./events";

/**
 * Replies that reach Mailgun (research mailgun-api-reference §7, §13.2, mailgun-inbound-validation-domain.md,
 * M3-DESIGN §4.1.8). Three sources describe a reply: the `store(notify=…)` form POST, the stored-message JSON the
 * catch-up fetches, and (when the stored body has expired) the Logs `stored` event alone. Each becomes one
 * `ParsedInbound`, which the inbound store (P4) saves. Pure; never trusts a field's case or shape.
 *
 * M4 (M4-DESIGN §3.2): every parser also fills the SMTP envelope sender, the texts with their newlines kept
 * (stripped-text ≤ 8,000 and body-plain ≤ 16,000 characters) and `bodyAvailable`, and the header cap keeps the
 * headers the reply classifier reads first.
 */

/** One mail header as Mailgun lists it: [name, value], names in their original case. */
export type HeaderPair = [name: string, value: string];

/** One received reply, ready for the inbound store (P4). */
export type ParsedInbound = {
  /** The address the reply was sent to (SMTP RCPT TO), lowercase. */
  recipient: string;
  /** The From address as written (the store normalises it). */
  fromEmail: string;
  fromName: string | null;
  subject: string;
  /** stripped-text, else body-plain; whitespace collapsed; at most 300 characters. */
  snippet: string;
  /** No angle brackets, lowercase. */
  messageIdHeader: string | null;
  /** The first id of In-Reply-To, no angle brackets. */
  inReplyTo: string | null;
  /** The ids of References, oldest first, no angle brackets. */
  references: string[];
  /** Every header in order, capped at 200 pairs / 32 KB. */
  headers: HeaderPair[];
  /** The last path segment of message-url / storage.url. */
  storageKey: string | null;
  messageUrl: string | null;
  receivedAt: Date;
  /** M4: SMTP MAIL FROM ("" = the null sender <>); null when the source doesn't say. */
  envelopeSender?: string | null;
  /** M4: stripped-text with newlines kept (≤ 8,000 characters); null when Mailgun sent none. */
  strippedText?: string | null;
  /** M4: body-plain with newlines kept (≤ 16,000 characters). */
  bodyText?: string | null;
  /** M4: false when only Mailgun's log was left (parseStoredLogOnly). Default true. */
  bodyAvailable?: boolean;
};

const MAX_HEADER_PAIRS = 200;
const MAX_HEADER_CHARS = 32 * 1024;
const SNIPPET_MAX = 300;
const MAX_IDS = 100;
const SUBJECT_MAX = 1000;
/** M4: `strippedText` keeps at most this many characters (M4-DESIGN §3.2). */
export const STRIPPED_TEXT_MAX = 8_000;
/** M4: `bodyText` keeps at most this many characters. */
export const BODY_TEXT_MAX = 16_000;
const ENVELOPE_MAX = 320;

/**
 * Headers the reply classifier and the linker read (M4-DESIGN §3.2): when the 200-pair / 32 KB cap has to drop
 * headers, these are kept first (long DKIM/ARC blocks and `Received` chains come before them in real mail).
 */
const PRIORITY_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "auto-submitted",
  "precedence",
  "x-precedence",
  "x-envelope-from",
  "x-mailer",
  "x-failed-recipients",
  "x-loop",
  "x-ms-exchange-inbox-rules-loop",
  "feedback-id",
  "delivered-to",
  "x-mailgun-sflag",
  "x-mailgun-sscore",
  "x-mailgun-spf",
  "x-mailgun-dkim-check-result",
  "x-mail-autoreply",
  "x-fc-machinegenerated",
  "message-id",
  "in-reply-to",
  "references",
  "from",
  "to",
  "subject",
]);
/** Every `X-Auto*` (X-Autoreply, X-Auto-Response-Suppress, …), `List-*` and `X-Zendesk-*` header is kept first too. */
const PRIORITY_PREFIXES = ["x-auto", "list-", "x-zendesk-"] as const;

/** True for a header the cap keeps first (M4-DESIGN §3.2 allow-list); the name is matched case-insensitively. */
export function isPriorityHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  return PRIORITY_HEADERS.has(n) || PRIORITY_PREFIXES.some((p) => n.startsWith(p));
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Form fields with lowercase names (Mailgun's field names vary in case, e.g. `Content-id-map`). When two names differ
 * only in case, the first non-empty value wins.
 */
export function lowerKeys(fields: Record<string, string>): Record<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(fields)) {
    const key = k.toLowerCase();
    const value = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
    const current = out.get(key);
    if (current === undefined || (current === "" && value !== "")) out.set(key, value);
  }
  return Object.fromEntries(out);
}

/** Every [name, value] pair of a header list, uncapped. */
function allPairs(v: unknown): HeaderPair[] {
  let list: unknown = v;
  if (typeof v === "string") {
    try {
      list = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: HeaderPair[] = [];
  for (const item of list) {
    if (!Array.isArray(item) || item.length < 2 || typeof item[0] !== "string") continue;
    const name = item[0].trim();
    if (!name) continue;
    const raw: unknown = item[1];
    const value =
      typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    out.push([name, value]);
  }
  return out;
}

/**
 * At most 200 pairs and 32 KB; a header that doesn't fit is left out, later small ones still fit. The allow-listed
 * headers (`isPriorityHeader`) get the room first, then the rest in order; the kept pairs stay in the message's order.
 */
function capPairs(pairs: readonly HeaderPair[]): HeaderPair[] {
  const keep = new Array<boolean>(pairs.length).fill(false);
  let count = 0;
  let size = 0;
  const pass = (priority: boolean) => {
    for (let i = 0; i < pairs.length; i++) {
      if (count >= MAX_HEADER_PAIRS) return;
      const [name, value] = pairs[i]!;
      if (isPriorityHeader(name) !== priority) continue;
      const n = name.length + value.length;
      if (size + n > MAX_HEADER_CHARS) continue;
      size += n;
      count++;
      keep[i] = true;
    }
  };
  pass(true);
  pass(false);
  return pairs.filter((_, i) => keep[i]).map(([name, value]) => [name, value] as HeaderPair);
}

/**
 * `message-headers`: a JSON-encoded string in the notify POST, a real array in the stored-message JSON. Returns the
 * [name, value] pairs in order (names may repeat, e.g. `Subject` and `subject`), capped at 200 pairs / 32 KB with the
 * allow-listed headers kept first. Anything unreadable gives [].
 */
export function parseMessageHeaders(v: string | unknown[] | null | undefined): HeaderPair[] {
  return capPairs(allPairs(v));
}

/** Every value of a header, in order; the name is matched case-insensitively. */
export function headerValues(headers: readonly HeaderPair[], name: string): string[] {
  const want = name.toLowerCase();
  return headers.filter(([n]) => n.toLowerCase() === want).map(([, v]) => v);
}

/**
 * The Message-IDs in a Message-Id, In-Reply-To or References value, in order, without angle brackets, lowercase and
 * without duplicates. Values without angle brackets are split on spaces and commas (ids must contain "@").
 */
export function extractMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    const id = normalizeMessageId(candidate);
    if (!id || /\s/.test(id) || seen.has(id) || out.length >= MAX_IDS) return;
    seen.add(id);
    out.push(id);
  };
  const re = /<([^<>]*)>/g;
  let found = false;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    found = true;
    add(m[1]!);
  }
  if (!found) {
    for (const token of value.split(/[\s,]+/)) if (token.includes("@")) add(token);
  }
  return out;
}

/** RFC 2047 encoded words ("=?UTF-8?B?…?=", "=?iso-8859-1?Q?…?="), as mail headers may carry them. */
function decodeMimeWords(v: string): string {
  if (!v.includes("=?")) return v;
  const word = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  // Whitespace between two encoded words is not part of the text (RFC 2047 §6.2).
  const joined = v.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g, "$1");
  return joined.replace(word, (all, charset: string, enc: string, data: string) => {
    try {
      let bytes: Uint8Array;
      if (enc.toUpperCase() === "B") {
        const bin = atob(data);
        bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } else {
        const q = data.replace(/_/g, " ");
        const list: number[] = [];
        for (let i = 0; i < q.length; i++) {
          if (q[i] === "=" && /^[0-9a-fA-F]{2}$/.test(q.slice(i + 1, i + 3))) {
            list.push(parseInt(q.slice(i + 1, i + 3), 16));
            i += 2;
          } else list.push(q.charCodeAt(i) & 0xff);
        }
        bytes = Uint8Array.from(list);
      }
      const label = charset.split("*")[0]!.toLowerCase();
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder(label);
      } catch {
        decoder = new TextDecoder("utf-8");
      }
      return decoder.decode(bytes);
    } catch {
      return all;
    }
  });
}

/** The first entry of an address list: splits on commas outside quotes, angle brackets and comments. */
function firstListEntry(v: string): string {
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === "\\" && quoted) {
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") angle++;
    else if (!quoted && c === ">") angle = Math.max(0, angle - 1);
    else if (!quoted && c === "(") paren++;
    else if (!quoted && c === ")") paren = Math.max(0, paren - 1);
    else if (c === "," && !quoted && angle === 0 && paren === 0) return v.slice(0, i);
  }
  return v;
}

const EMAIL_LIKE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+$/;

function cleanName(v: string): string | null {
  let name = v.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  name = name.replace(/\s+/g, " ").trim();
  return name ? name : null;
}

/**
 * A From/To header value → the first address and its display name: `Anna Berg <anna@firma.de>`,
 * `"Berg, Anna" <anna@firma.de>`, `<anna@firma.de>`, `anna@firma.de (Anna Berg)` or a bare address. Encoded words
 * are decoded. Null when there is no usable address.
 */
export function parseAddressHeader(v: string): { email: string; name: string | null } | null {
  if (typeof v !== "string") return null;
  const entry = firstListEntry(decodeMimeWords(v)).trim();
  if (!entry) return null;
  let email: string;
  let name: string | null = null;
  const angle = /^(.*?)<\s*([^<>]*?)\s*>\s*(?:\((.*)\))?\s*$/.exec(entry);
  if (angle) {
    email = angle[2]!;
    name = cleanName(angle[1]!) ?? (angle[3] ? cleanName(angle[3]) : null);
  } else {
    const paren = /^([^\s()<>]+)\s*\((.*)\)\s*$/.exec(entry);
    if (paren) {
      email = paren[1]!;
      name = cleanName(paren[2]!);
    } else {
      email = entry;
    }
  }
  email = email.replace(/^mailto:/i, "").trim();
  if (!EMAIL_LIKE.test(email)) return null;
  if (name && name.toLowerCase() === email.toLowerCase()) name = null;
  return { email, name };
}

/** stripped-text or body-plain, whitespace collapsed, at most 300 characters. */
function snippetOf(v: string | null | undefined): string {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return s.length <= SNIPPET_MAX ? s : `${s.slice(0, SNIPPET_MAX - 1).trimEnd()}…`;
}

/** The last path segment of a storage URL (the storage key). */
function storageKeyOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? "";
  }
  const last = path.split("/").filter(Boolean).pop();
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function firstHeader(headers: readonly HeaderPair[], name: string): string | null {
  const v = headerValues(headers, name)[0];
  return v !== undefined && v.trim() !== "" ? v : null;
}

function firstId(v: string | null | undefined): string | null {
  if (!v) return null;
  return extractMessageIds(v)[0] ?? normalizeMessageId(v);
}

function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** At most `max` characters, never ending in half of a surrogate pair. */
function capText(v: string, max: number): string {
  if (v.length <= max) return v;
  const cut = v.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * A text field with its line structure kept (`\r\n` and `\r` become `\n`), at most `max` characters. Missing gives
 * null; with `blankIsNull`, a field of only whitespace gives null too.
 */
function keptText(v: string | null | undefined, max: number, blankIsNull: boolean): string | null {
  if (typeof v !== "string") return null;
  if (blankIsNull && v.trim() === "") return null;
  return capText(v.replace(/\r\n?/g, "\n"), max);
}

/**
 * SMTP MAIL FROM as Mailgun reports it (M4-DESIGN §3.2): "" for the null sender (`""`, `"<>"`, or only angle brackets
 * and spaces), null when the source doesn't say (missing), otherwise the bare address, lowercased.
 */
export function parseEnvelopeSender(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (/^[<>\s]*$/.test(t)) return "";
  const bare = parseAddressHeader(t)?.email ?? t.replace(/^<+|>+$/g, "").trim();
  return capText(bare.toLowerCase(), ENVELOPE_MAX);
}

/** The envelope sender from the source's own field when it has one, else the `X-Envelope-From` header, else null. */
function envelopeOf(field: string | undefined, headers: readonly HeaderPair[]): string | null {
  if (typeof field === "string") return parseEnvelopeSender(field);
  const header = headerValues(headers, "X-Envelope-From")[0];
  return header === undefined ? null : parseEnvelopeSender(header);
}

/** The fields every source shares, once the source-specific ones are found. */
function assemble(input: {
  recipient: string | null;
  from: string | null;
  sender: string | null;
  subject: string | null;
  body: string | null;
  headers: HeaderPair[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  messageUrl: string | null;
  storageKey: string | null;
  receivedAt: Date;
  envelopeSender: string | null;
  strippedText: string | null;
  bodyText: string | null;
  bodyAvailable: boolean;
}): ParsedInbound | null {
  const recipientRaw = nonEmpty(input.recipient);
  if (!recipientRaw) return null;
  const recipient = (parseAddressHeader(recipientRaw)?.email ?? recipientRaw.trim()).toLowerCase();
  const fromParsed = input.from ? parseAddressHeader(input.from) : null;
  const senderParsed = input.sender ? parseAddressHeader(input.sender) : null;
  const fromEmail = fromParsed?.email ?? senderParsed?.email ?? nonEmpty(input.from)?.trim() ?? nonEmpty(input.sender)?.trim();
  if (!fromEmail) return null;
  return {
    recipient,
    fromEmail,
    fromName: fromParsed?.name ?? null,
    subject: decodeMimeWords(input.subject ?? "").trim().slice(0, SUBJECT_MAX),
    snippet: snippetOf(input.body),
    messageIdHeader: firstId(input.messageId),
    inReplyTo: extractMessageIds(input.inReplyTo)[0] ?? null,
    references: extractMessageIds(input.references),
    headers: capPairs(input.headers),
    storageKey: input.storageKey ?? storageKeyOf(input.messageUrl),
    messageUrl: nonEmpty(input.messageUrl)?.trim() ?? null,
    receivedAt: input.receivedAt,
    envelopeSender: input.envelopeSender,
    strippedText: input.strippedText,
    bodyText: input.bodyText,
    bodyAvailable: input.bodyAvailable,
  };
}

/** The signed form timestamp (epoch seconds) when it is readable and not in the future, else `now`. */
function formTime(v: string | undefined, now: Date): Date {
  const n = v ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return now;
  const ms = Math.round(n * 1000);
  return ms <= now.getTime() ? new Date(ms) : now;
}

/**
 * The `store(notify=…)` POST (urlencoded or multipart, read with `request.formData()`) → ParsedInbound. Message-Id,
 * In-Reply-To and References come from `message-headers` (top-level fields only as a fallback). `receivedAt` is the
 * signed timestamp (Mailgun's retries keep the original one), else `now`. M4: the envelope sender from `sender` (else
 * the `X-Envelope-From` header), `stripped-text` and `body-plain` with their newlines. Null when there is no
 * recipient or sender.
 */
export function parseInboundForm(fields: Record<string, string>, now: Date): ParsedInbound | null {
  const f = lowerKeys(fields);
  const headers = allPairs(f["message-headers"]);
  return assemble({
    envelopeSender: envelopeOf(f.sender, headers),
    strippedText: keptText(f["stripped-text"], STRIPPED_TEXT_MAX, true),
    bodyText: keptText(f["body-plain"], BODY_TEXT_MAX, false),
    bodyAvailable: true,
    recipient: nonEmpty(f.recipient) ?? firstHeader(headers, "To"),
    from: nonEmpty(f.from) ?? firstHeader(headers, "From"),
    sender: nonEmpty(f.sender),
    subject: nonEmpty(f.subject) ?? firstHeader(headers, "Subject"),
    body: nonEmpty(f["stripped-text"]) ?? f["body-plain"] ?? "",
    headers,
    messageId: firstHeader(headers, "Message-Id") ?? nonEmpty(f["message-id"]),
    inReplyTo: firstHeader(headers, "In-Reply-To") ?? nonEmpty(f["in-reply-to"]),
    references: firstHeader(headers, "References") ?? nonEmpty(f.references),
    messageUrl: nonEmpty(f["message-url"]),
    storageKey: null,
    receivedAt: formTime(f.timestamp, now),
  });
}

/**
 * A stored message fetched from Mailgun (`GET <storage url>`, default Accept: JSON with the raw headers as top-level
 * keys in varying case, and `message-headers` as a real array) → ParsedInbound. `fallback` supplies what the Logs
 * `stored` event knew: the recipient, the storage key and the time. M4: the envelope sender from `sender` (else the
 * `X-Envelope-From` header), `stripped-text` and `body-plain` with their newlines. Null when unreadable.
 */
export function parseStoredMessage(
  json: unknown,
  fallback: { recipient?: string | null; storageKey?: string | null; at: Date },
): ParsedInbound | null {
  if (!isObj(json)) return null;
  const strings: Record<string, string> = {};
  let rawHeaders: unknown = null;
  for (const [k, v] of Object.entries(json)) {
    if (k.toLowerCase() === "message-headers") rawHeaders ??= v;
    else if (typeof v === "string") strings[k] = v;
  }
  const f = lowerKeys(strings);
  const headers = allPairs(rawHeaders);
  return assemble({
    envelopeSender: envelopeOf(f.sender, headers),
    strippedText: keptText(f["stripped-text"], STRIPPED_TEXT_MAX, true),
    bodyText: keptText(f["body-plain"], BODY_TEXT_MAX, false),
    bodyAvailable: true,
    recipient: nonEmpty(fallback.recipient) ?? nonEmpty(f.recipients) ?? nonEmpty(f.recipient) ?? nonEmpty(f.to) ?? firstHeader(headers, "To"),
    from: nonEmpty(f.from) ?? firstHeader(headers, "From"),
    sender: nonEmpty(f.sender),
    subject: nonEmpty(f.subject) ?? firstHeader(headers, "Subject"),
    body: nonEmpty(f["stripped-text"]) ?? f["body-plain"] ?? "",
    headers,
    messageId: firstHeader(headers, "Message-Id") ?? nonEmpty(f["message-id"]),
    inReplyTo: firstHeader(headers, "In-Reply-To") ?? nonEmpty(f["in-reply-to"]),
    references: firstHeader(headers, "References") ?? nonEmpty(f.references),
    messageUrl: nonEmpty(f["message-url"]),
    storageKey: nonEmpty(fallback.storageKey) ?? null,
    receivedAt: fallback.at,
  });
}

function isNormalizedEvent(v: unknown): v is NormalizedEvent {
  return isObj(v) && typeof v.dedupeKey === "string" && "raw" in v && v.occurredAt instanceof Date;
}

/**
 * A reply whose stored body has expired: only the Logs `stored` event is left (a raw item, or the NormalizedEvent
 * made from it). Builds the reply from the event's `message.headers`, with an empty snippet, no text and
 * `bodyAvailable: false` (M4: the classifier then files it as a possible reply). The envelope sender comes from
 * `envelope.sender`, else the `X-Envelope-From` header. Null when unreadable.
 */
export function parseStoredLogOnly(item: NormalizedEvent | unknown): ParsedInbound | null {
  let raw: unknown = item;
  let at: Date | null = null;
  let recipient: string | null = null;
  if (isNormalizedEvent(item)) {
    raw = item.raw;
    at = item.occurredAt;
    recipient = item.recipient;
  }
  if (!isObj(raw)) return null;
  if (!at) {
    const iso = typeof raw["@timestamp"] === "string" ? Date.parse(raw["@timestamp"]) : Number.NaN;
    const secs = typeof raw.timestamp === "number" ? raw.timestamp * 1000 : Number.NaN;
    const ms = Number.isFinite(iso) ? iso : secs;
    if (!Number.isFinite(ms)) return null;
    at = new Date(ms);
  }
  const message = isObj(raw.message) ? raw.message : {};
  const h = isObj(message.headers) ? message.headers : {};
  const headers: HeaderPair[] = [];
  for (const [k, v] of Object.entries(h)) if (typeof v === "string") headers.push([k, v]);
  const envelope = isObj(raw.envelope) ? raw.envelope : {};
  const storage = isObj(raw.storage) ? raw.storage : {};
  const urls = Array.isArray(storage.url)
    ? storage.url.filter((u): u is string => typeof u === "string")
    : typeof storage.url === "string"
      ? [storage.url]
      : [];
  return assemble({
    envelopeSender: envelopeOf(typeof envelope.sender === "string" ? envelope.sender : undefined, headers),
    strippedText: null,
    bodyText: null,
    bodyAvailable: false,
    recipient: nonEmpty(recipient) ?? (typeof raw.recipient === "string" ? nonEmpty(raw.recipient) : null) ?? firstHeader(headers, "to"),
    from: firstHeader(headers, "from"),
    sender: typeof envelope.sender === "string" ? nonEmpty(envelope.sender) : null,
    subject: firstHeader(headers, "subject"),
    body: "",
    headers,
    messageId: firstHeader(headers, "message-id"),
    inReplyTo: firstHeader(headers, "in-reply-to"),
    references: firstHeader(headers, "references"),
    messageUrl: urls[0] ?? null,
    storageKey: typeof storage.key === "string" ? nonEmpty(storage.key) : null,
    receivedAt: at,
  });
}
