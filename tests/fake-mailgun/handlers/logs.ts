import crypto from "node:crypto";
import { toLogItem, type FakeEvent } from "../events";
import { json, stripBrackets, type FakeContext, type HandlerResult } from "./context";

/**
 * POST /v1/analytics/logs (research §2, §15). JSON body; `start`+`end` or `end`+`duration`; filters by the window,
 * `events`, retention and the AND predicates the app uses; sorted by timestamp; paged with opaque tokens that encode
 * the offset and a hash of the body (a changed body mid-walk is a 400). `next` is present while more items remain;
 * a page past the end is empty with no `next` (switch `nextOnLastPage`: the last non-empty page still has one).
 */

type Predicate = { attribute: string; comparator: string; value: string };

const SUPPORTED = new Set(["domain", "message_id", "user_variables", "event", "severity", "recipient", "tag"]);

function rfc2822(d: Date): string {
  return d.toUTCString().slice(0, 25) + " -0000";
}

/** "2h" / "1d" / "30m" → ms, else null. */
function durationMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)([mhd])$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
}

function bodyHash(body: Record<string, unknown>): string {
  const pagination = { ...((body.pagination as Record<string, unknown>) ?? {}) };
  delete pagination.token;
  return crypto.createHash("sha1").update(JSON.stringify({ ...body, pagination })).digest("hex").slice(0, 16);
}

function makeToken(offset: number, hash: string): string {
  return Buffer.from(JSON.stringify({ o: offset, h: hash })).toString("base64url");
}

function readToken(token: string, hash: string): number | null {
  try {
    const t = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { o?: unknown; h?: unknown };
    if (typeof t.o !== "number" || t.h !== hash) return null;
    return t.o;
  } catch {
    return null;
  }
}

function matches(ev: FakeEvent, p: Predicate, ctx: FakeContext): boolean {
  const cmp = (actual: string, expected: string): boolean => {
    const a = actual.toLowerCase();
    const e = expected.toLowerCase();
    switch (p.comparator) {
      case "=":
        return a === e;
      case "!=":
        return a !== e;
      case "contains":
        return a.includes(e);
      case "not contains":
        return !a.includes(e);
      default:
        return false;
    }
  };
  switch (p.attribute) {
    case "domain":
      return cmp(ev.domain, p.value);
    case "message_id": {
      const bracketed = p.value.trim().startsWith("<");
      if (ctx.switches.bracketedMessageIdFilter && !bracketed) return false;
      return cmp(ev.messageId, stripBrackets(p.value));
    }
    case "user_variables":
      if (ctx.switches.brokenContainsFilter) return false;
      return cmp(JSON.stringify(ev.userVariables), p.value);
    case "event":
      return cmp(ev.event, p.value);
    case "severity":
      return cmp(ev.severity ?? "", p.value);
    case "recipient":
      return cmp(ev.recipient, p.value);
    case "tag":
      return ev.tags.some((t) => cmp(t, p.value));
    default:
      return false;
  }
}

export function queryLogs(ctx: FakeContext): HandlerResult {
  const body = ctx.req.json;
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { message: "Request body must be JSON." });
  const b = body as Record<string, unknown>;
  const pagination = (b.pagination && typeof b.pagination === "object" ? b.pagination : {}) as Record<string, unknown>;
  const limit = pagination.limit === undefined ? 100 : Number(pagination.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return json(400, { message: "pagination.limit must be between 1 and 100" });
  }
  if (ctx.switches.strictDuration && b.duration === undefined) return json(400, { message: "duration is required" });

  const now = ctx.now();
  const end = typeof b.end === "string" ? new Date(Date.parse(b.end)) : now;
  if (Number.isNaN(end.getTime())) return json(400, { message: "end is not a valid RFC 2822 date" });
  let start: Date;
  if (b.duration !== undefined) {
    const ms = durationMs(b.duration);
    if (ms === null) return json(400, { message: "duration must look like 2h or 1d" });
    start = new Date(end.getTime() - ms);
  } else {
    start = typeof b.start === "string" ? new Date(Date.parse(b.start)) : new Date(end.getTime() - 86_400_000);
    if (Number.isNaN(start.getTime())) return json(400, { message: "start is not a valid RFC 2822 date" });
  }

  const events = Array.isArray(b.events) ? (b.events as unknown[]).filter((e): e is string => typeof e === "string") : [];
  const predicates: Predicate[] = [];
  const and = (b.filter && typeof b.filter === "object" ? (b.filter as Record<string, unknown>).AND : undefined) as unknown;
  if (and !== undefined) {
    if (!Array.isArray(and)) return json(400, { message: "filter.AND must be an array" });
    for (const raw of and) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const values = Array.isArray(p.values) ? (p.values as Array<Record<string, unknown>>) : [];
      const value = values[0]?.value;
      if (typeof p.attribute !== "string" || typeof p.comparator !== "string" || typeof value !== "string") {
        return json(400, { message: "every filter needs attribute, comparator and values[{label, value}]" });
      }
      if (!SUPPORTED.has(p.attribute)) return json(400, { message: `the fake doesn't support filter attribute ${p.attribute}` });
      predicates.push({ attribute: p.attribute, comparator: p.comparator, value });
    }
  }

  const retentionStart = now.getTime() - ctx.opts.retentionDays * 86_400_000;
  const sort = pagination.sort === "timestamp:desc" ? "desc" : "asc";
  const found = ctx.world.events
    .filter((e) => e.visibleAt.getTime() <= now.getTime())
    .map((e) => e.ev)
    .filter((ev) => ev.at.getTime() >= start.getTime() && ev.at.getTime() <= end.getTime())
    .filter((ev) => ev.at.getTime() >= retentionStart)
    .filter((ev) => events.length === 0 || events.includes(ev.event))
    .filter((ev) => predicates.every((p) => matches(ev, p, ctx)))
    .map((ev, i) => ({ ev, i }))
    .sort((x, y) => (x.ev.at.getTime() - y.ev.at.getTime()) * (sort === "asc" ? 1 : -1) || x.i - y.i)
    .map((x) => x.ev);

  const hash = bodyHash(b);
  let offset = 0;
  if (typeof pagination.token === "string" && pagination.token) {
    const o = readToken(pagination.token, hash);
    if (o === null) return json(400, { message: "invalid pagination token" });
    offset = o;
  }
  const page = found.slice(offset, offset + limit);
  const more = offset + page.length < found.length;
  const next = page.length > 0 && (more || ctx.switches.nextOnLastPage) ? makeToken(offset + limit, hash) : undefined;
  return json(200, {
    start: rfc2822(start),
    end: rfc2822(end),
    items: page.map(toLogItem),
    pagination: { ...(next ? { next } : {}), first: makeToken(0, hash), total: found.length },
    aggregates: {},
  });
}
