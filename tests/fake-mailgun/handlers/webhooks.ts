import { WEBHOOK_TYPE_NAMES, webhooksJson, type WebhookTypeName } from "../state";
import { field, json, type FakeContext, type HandlerResult } from "./context";

/**
 * Webhook registration (research §4, §15): v3 GET (with the `legacyUrlField` switch answering `{url}`), v4 POST / PUT
 * (urlencoded `url` + repeated `event_types`) and DELETE `?url=`. Every v4 answer is the whole mapping. At most 3 URLs
 * per type.
 */

const MAX_URLS_PER_TYPE = 3;

export function getWebhooks(ctx: FakeContext): HandlerResult {
  return json(200, webhooksJson(ctx.world, ctx.switches.legacyUrlField));
}

function readInput(ctx: FakeContext): { url: string; types: WebhookTypeName[] } | HandlerResult {
  const form = ctx.req.form;
  const url = field(form, "url");
  const types = form?.event_types ?? [];
  if (!url || !types.length) return json(400, { Reason: "invalid parameters: url and event_types are required" });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return json(400, { Reason: `invalid parameters: ${url} is not a valid url: invalid URL scheme` });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return json(400, { Reason: `invalid parameters: ${url} is not a valid url: invalid URL scheme` });
  }
  const bad = types.find((t) => !(WEBHOOK_TYPE_NAMES as readonly string[]).includes(t));
  if (bad) return json(400, { Reason: `invalid parameters: unknown event type '${bad}'` });
  return { url, types: [...new Set(types)] as WebhookTypeName[] };
}

function isResult(v: unknown): v is HandlerResult {
  return typeof v === "object" && v !== null && "status" in v;
}

export function createWebhook(ctx: FakeContext): HandlerResult {
  const input = readInput(ctx);
  if (isResult(input)) return input;
  for (const t of input.types) {
    const urls = ctx.world.webhooks.get(t) ?? [];
    if (urls.includes(input.url)) {
      return json(400, { Reason: `Webhook for event type '${t}' with URL '${input.url}' already exists` });
    }
    if (urls.length >= MAX_URLS_PER_TYPE) return json(400, { Reason: "too many urls" });
  }
  for (const t of input.types) ctx.world.webhooks.set(t, [...(ctx.world.webhooks.get(t) ?? []), input.url]);
  return json(200, webhooksJson(ctx.world, false));
}

export function updateWebhook(ctx: FakeContext): HandlerResult {
  const input = readInput(ctx);
  if (isResult(input)) return input;
  const known = [...ctx.world.webhooks.values()].some((urls) => urls.includes(input.url));
  if (!known) return json(404, { Description: "Webhook not found" });
  for (const t of input.types) {
    const urls = ctx.world.webhooks.get(t) ?? [];
    if (!urls.includes(input.url) && urls.length >= MAX_URLS_PER_TYPE) return json(400, { Reason: "too many urls" });
  }
  for (const [t, urls] of ctx.world.webhooks) ctx.world.webhooks.set(t, urls.filter((u) => u !== input.url));
  for (const t of input.types) ctx.world.webhooks.set(t, [...(ctx.world.webhooks.get(t) ?? []), input.url]);
  return json(200, webhooksJson(ctx.world, false));
}

export function deleteWebhook(ctx: FakeContext): HandlerResult {
  const urls = ctx.req.query.url ?? [];
  if (!urls.length) return json(400, { Field: "url" });
  for (const [t, list] of ctx.world.webhooks) ctx.world.webhooks.set(t, list.filter((u) => !urls.includes(u)));
  return json(200, webhooksJson(ctx.world, false));
}
