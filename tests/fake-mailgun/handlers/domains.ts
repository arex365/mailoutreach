import { dnsRecords, domainJson } from "../state";
import { field, formBool, json, type FakeContext, type HandlerResult } from "./context";

/**
 * The domain endpoints (research §8, §11, §15): GET /v4/domains/{d}, PUT …/verify, PUT /v4/domains/{d} (multipart, one
 * or more fields) and GET /v3/domains/{d}/sending_queues. Defaults: state "unverified", every record "unknown",
 * web_scheme http, spam_action disabled, message_ttl 86,400, webhooks_redact_pii false.
 */

function domainBody(ctx: FakeContext, message?: string): Record<string, unknown> {
  // MAIN-DOMAIN-DESIGN §7.8: with receivesMail false the receiving (MX) records stay "unverified".
  const records = dnsRecords(ctx.world, ctx.opts.region, { receivesMail: ctx.opts.receivesMail });
  return {
    ...(message ? { message } : {}),
    domain: domainJson(ctx.world),
    receiving_dns_records: records.receiving,
    sending_dns_records: records.sending,
  };
}

export function getDomain(ctx: FakeContext): HandlerResult {
  return json(200, domainBody(ctx));
}

export function verifyDomain(ctx: FakeContext): HandlerResult {
  if (ctx.switches.verifyRateLimited) return json(429, { message: "Too many requests" });
  const { spf, dkim, tracking } = ctx.world.dns;
  ctx.world.domain.state = spf && dkim && tracking ? "active" : "unverified";
  return json(200, domainBody(ctx, "Domain DNS records have been updated"));
}

export function updateDomain(ctx: FakeContext): HandlerResult {
  const form = ctx.req.form;
  if (!form) return json(400, { message: "Content-Type must be multipart/form-data." });
  const d = ctx.world.domain;
  const scheme = field(form, "web_scheme");
  if (scheme !== undefined) {
    if (scheme !== "http" && scheme !== "https") return json(400, { message: "web_scheme must be http or https" });
    const cert = ctx.world.certificates.get(`${d.webPrefix}.${d.name}`);
    if (scheme === "https" && cert?.status !== "active") {
      return json(400, { message: "web_scheme https needs an active tracking certificate first" });
    }
  }
  const spam = field(form, "spam_action");
  if (spam !== undefined && spam !== "disabled" && spam !== "tag" && spam !== "block") {
    return json(400, { message: "spam_action must be one of: disabled, tag, block" });
  }
  const ttlRaw = field(form, "message_ttl");
  let ttl: number | undefined;
  if (ttlRaw !== undefined) {
    ttl = Number(ttlRaw);
    if (!Number.isInteger(ttl) || ttl < 0) return json(400, { message: "message_ttl must be a whole number of seconds" });
    if (ttl > ctx.opts.maxMessageTtl) {
      return json(400, { message: `message_ttl can't be larger than ${ctx.opts.maxMessageTtl} on your plan` });
    }
  }
  const prefix = field(form, "web_prefix");
  if (prefix !== undefined && !/^[a-z0-9-]+$/i.test(prefix)) return json(400, { message: "web_prefix must be a single label" });
  if (scheme !== undefined) d.webScheme = scheme as "http" | "https";
  if (spam !== undefined) d.spamAction = spam as "disabled" | "tag" | "block";
  if (ttl !== undefined) d.messageTtl = ttl;
  if (prefix !== undefined) d.webPrefix = prefix.toLowerCase();
  const flags = [
    ["wildcard", "wildcard"],
    ["webhooks_redact_pii", "webhooksRedactPii"],
    ["require_tls", "requireTls"],
    ["use_automatic_sender_security", "useAutomaticSenderSecurity"],
  ] as const;
  for (const [name, key] of flags) {
    const v = formBool(field(form, name));
    if (v !== undefined) d[key] = v;
  }
  return json(200, domainBody(ctx, "Domain has been updated"));
}

export function getSendingQueues(ctx: FakeContext): HandlerResult {
  const q = ctx.world.queue;
  return json(200, {
    regular: q.regularDisabled
      ? { is_disabled: true, disabled: { ...(q.until ? { until: q.until.toUTCString() } : {}), reason: q.reason ?? "" } }
      : { is_disabled: false },
    scheduled: { is_disabled: false },
  });
}
