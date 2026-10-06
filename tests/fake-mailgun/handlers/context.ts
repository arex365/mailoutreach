import type { FakeEvent } from "../events";
import type { FakePlan, FakeRegion, FakeSwitches, FakeWorld } from "../state";

/** What every endpoint handler of the fake gets, and what it answers. */

export type ParsedRequest = {
  method: string;
  path: string;
  url: URL;
  query: Record<string, string[]>;
  /** Lowercase names. */
  headers: Record<string, string>;
  contentType: string;
  raw: Buffer;
  /** Multipart or urlencoded fields (null for other bodies). */
  form: Record<string, string[]> | null;
  /** The parsed JSON body; undefined when the body isn't JSON (or doesn't parse). */
  json: unknown;
  text: string;
  /** Path parameters of the matched route (":d", ":id"…), decoded. */
  params: Record<string, string>;
};

export type ResolvedOptions = {
  domain: string;
  /** Older sending domains the fake also answers for (lowercase). */
  otherDomains: string[];
  region: FakeRegion;
  apiKey: string;
  sendingKey: string | null;
  plan: FakePlan;
  retentionDays: number;
  maxMessageTtl: number;
  indexLagMs: number;
  appUrl: string | null;
  // MAIN-DOMAIN-DESIGN §7.8 (defaults: true, 100 on free / null otherwise, null).
  /** False: the domain's MX isn't Mailgun's; presets to the fake's domains land "outside". */
  receivesMail: boolean;
  /** Messages allowed in the rolling 24 hours (test mode included); null = no limit. */
  dailyLimit: number | null;
  /** Lowercase; null = anyone may be sent to. */
  authorizedRecipients: string[] | null;
};

export type FakeContext = {
  world: FakeWorld;
  switches: FakeSwitches;
  opts: ResolvedOptions;
  now(): Date;
  /** "http://127.0.0.1:<port>". */
  origin: string;
  /** The region the request was made for (header x-outreach-region, else the fake's own). */
  region: FakeRegion;
  req: ParsedRequest;
  /** Records an event; it shows up in Logs after `lagMs` (default: none). */
  addEvent(ev: FakeEvent, lagMs?: number): void;
};

export type HandlerResult = {
  status: number;
  /** An object/array is sent as JSON; a string as text/plain. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Answer only after this many ms on real timers (handlers are synchronous; the server waits). */
  delayMs?: number;
};

export type Handler = (ctx: FakeContext) => HandlerResult;

export function json(status: number, body: unknown): HandlerResult {
  return { status, body };
}

/** The first value of a form field. */
export function field(form: Record<string, string[]> | null, name: string): string | undefined {
  return form?.[name]?.[0];
}

/** "true"/"yes" → true, "false"/"no" → false, else undefined. */
export function formBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "yes") return true;
  if (s === "false" || s === "no") return false;
  return undefined;
}

/** The bare, lowercase address of "Name <a@b.c>" or "a@b.c". */
export function bareAddress(v: string): string {
  const m = /<([^>]+)>/.exec(v);
  return (m ? m[1]! : v).trim().toLowerCase();
}

export function stripBrackets(id: string): string {
  return id.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/** RFC 822 with "UTC", as Mailgun writes suppression dates ("Thu, 11 Dec 2025 01:49:40 UTC"). */
export function rfc822Utc(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "UTC");
}
