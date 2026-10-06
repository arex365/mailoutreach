import type { FakeSuppressionList, SuppressionEntry } from "../state";
import { json, rfc822Utc, type FakeContext, type HandlerResult } from "./context";

/**
 * Suppression lists (research §3, §15): GET pages with absolute `paging` URLs on the fake's origin
 * (`?page=next&address=<last>&limit=N`), `next` present even on the last page whose follow-up is empty; single
 * GET/DELETE by address; the JSON bulk POST of unsubscribes (fewer than 1,000 per call, upsert by address).
 */

const LABEL: Record<FakeSuppressionList, string> = { bounces: "Bounced", complaints: "Spam complaint", unsubscribes: "Unsubscribe" };

function itemJson(list: FakeSuppressionList, e: SuppressionEntry): Record<string, unknown> {
  if (list === "bounces") return { address: e.address, code: e.code ?? "550", error: e.error ?? "", created_at: rfc822Utc(e.createdAt) };
  if (list === "complaints") return { address: e.address, created_at: rfc822Utc(e.createdAt) };
  return { address: e.address, tags: e.tags ?? ["*"], created_at: rfc822Utc(e.createdAt) };
}

function listOf(ctx: FakeContext): FakeSuppressionList {
  return ctx.req.params.list as FakeSuppressionList;
}

export function listSuppressions(ctx: FakeContext): HandlerResult {
  const list = listOf(ctx);
  const q = ctx.req.query;
  const limit = q.limit?.[0] === undefined ? 100 : Number(q.limit[0]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return json(400, { message: "The 'limit' parameter must be between 1 and 1000" });
  }
  const page = q.page?.[0] ?? "";
  const pivot = (q.address?.[0] ?? "").toLowerCase();
  const all = [...ctx.world.suppressions[list].values()].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  let items: SuppressionEntry[];
  if (page === "next") items = all.filter((e) => e.address > pivot).slice(0, limit);
  else if (page === "previous") items = all.filter((e) => e.address < pivot).slice(-limit);
  else if (page === "last") items = all.slice(-limit);
  else items = all.slice(0, limit);

  const d = ctx.req.params.d!;
  const nextOrigin = ctx.switches.crossOriginNext ? "https://suppressions.invalid" : ctx.origin;
  const url = (origin: string, params: string) => `${origin}/v3/${encodeURIComponent(d)}/${list}?${params}`;
  const last = items.length ? items[items.length - 1]!.address : pivot;
  const firstAddr = items.length ? items[0]!.address : pivot;
  return json(200, {
    items: items.map((e) => itemJson(list, e)),
    paging: {
      first: url(ctx.origin, `page=first&limit=${limit}`),
      last: url(ctx.origin, `page=last&limit=${limit}`),
      next: url(nextOrigin, `page=next&address=${encodeURIComponent(last)}&limit=${limit}`),
      previous: url(ctx.origin, `page=previous&address=${encodeURIComponent(firstAddr)}&limit=${limit}`),
    },
  });
}

export function getSuppression(ctx: FakeContext): HandlerResult {
  const list = listOf(ctx);
  const e = ctx.world.suppressions[list].get((ctx.req.params.address ?? "").toLowerCase());
  if (!e) return json(404, { message: `Address not found in ${list} table` });
  return json(200, itemJson(list, e));
}

export function deleteSuppression(ctx: FakeContext): HandlerResult {
  const list = listOf(ctx);
  const address = (ctx.req.params.address ?? "").toLowerCase();
  if (!ctx.world.suppressions[list].delete(address)) return json(404, { message: `Address not found in ${list} table` });
  return json(200, { message: `${LABEL[list]} address has been removed`, address });
}

export function addUnsubscribes(ctx: FakeContext): HandlerResult {
  if (!ctx.req.contentType.startsWith("application/json")) {
    return json(400, { message: "The batch form needs Content-Type: application/json." });
  }
  const body = ctx.req.json;
  if (!Array.isArray(body)) return json(400, { message: "The body must be a JSON array of unsubscribes." });
  if (body.length >= 1000) return json(400, { message: "Batch size should be less than 1000" });
  const now = ctx.now();
  const entries: SuppressionEntry[] = [];
  for (const raw of body) {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (typeof o.address !== "string" || !o.address.includes("@")) return json(400, { message: "address is required" });
    const created = typeof o.created_at === "string" ? Date.parse(o.created_at) : NaN;
    const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : ["*"];
    entries.push({ address: o.address.trim().toLowerCase(), createdAt: Number.isNaN(created) ? now : new Date(created), tags });
  }
  for (const e of entries) ctx.world.suppressions.unsubscribes.set(e.address, e);
  return json(200, { message: `${entries.length} addresses have been added to the unsubscribes table` });
}
