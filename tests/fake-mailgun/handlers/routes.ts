import crypto from "node:crypto";
import { routeJson, type FakeRoute } from "../state";
import { field, json, type FakeContext, type HandlerResult } from "./context";

/**
 * Routes, account-wide (research §6, §15). Expressions and actions are stored verbatim so tests can assert the exact
 * strings. `/match` evaluates `match_recipient("<python regex>")` (translated to a JS RegExp) and `catch_all()` in
 * priority order, then creation order, and answers the FIRST match only, like Mailgun.
 */

/** Routes in the order Mailgun evaluates them: priority ascending, then creation. */
function ordered(routes: FakeRoute[]): FakeRoute[] {
  return [...routes].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
}

/** `match_recipient("…")` / `match_recipient('…')` → a RegExp; `catch_all()` → "catch-all"; else null (no match). */
export function compileExpression(expression: string): RegExp | "catch-all" | null {
  const e = expression.trim();
  if (/^catch_all\(\s*\)$/.test(e)) return "catch-all";
  const m = /^match_recipient\(\s*(["'])([\s\S]*)\1\s*\)$/.exec(e);
  if (!m) return null;
  // Python-only named groups; everything the app writes (^ $ . \ + * ? [] () |) means the same in JS.
  const pattern = m[2]!.replace(/\(\?P</g, "(?<");
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function matchRouteFor(routes: FakeRoute[], address: string): FakeRoute | null {
  for (const r of ordered(routes)) {
    const c = compileExpression(r.expression);
    if (c === "catch-all") return r;
    if (c && c.test(address)) return r;
  }
  return null;
}

function readRoute(ctx: FakeContext): { priority?: number; description?: string; expression?: string; actions?: string[] } | HandlerResult {
  const form = ctx.req.form;
  if (!form) return json(400, { message: "Content-Type must be form data." });
  const out: { priority?: number; description?: string; expression?: string; actions?: string[] } = {};
  const p = field(form, "priority");
  if (p !== undefined) {
    const n = Number(p);
    if (!Number.isInteger(n)) return json(400, { message: "priority must be a whole number" });
    out.priority = n;
  }
  const d = field(form, "description");
  if (d !== undefined) out.description = d;
  const e = field(form, "expression");
  if (e !== undefined) out.expression = e;
  const actions = [...(form.action ?? []), ...(form.actions ?? [])];
  if (actions.length) out.actions = actions;
  if ((out.expression ?? "").length > 4096 || (out.actions ?? []).join(",").length > 4096) {
    return json(400, { message: "filter and action fields are limited to 4k characters" });
  }
  return out;
}

function isResult(v: unknown): v is HandlerResult {
  return typeof v === "object" && v !== null && "status" in v && typeof (v as HandlerResult).status === "number";
}

export function createRoute(ctx: FakeContext): HandlerResult {
  const input = readRoute(ctx);
  if (isResult(input)) return input;
  if (!input.expression) return json(400, { message: "expression is required" });
  // MAIN-DOMAIN-DESIGN §7.8 (text UNVERIFIED): the free plan has one inbound route, so a test can prove the app never
  // tries to make one in own-mailbox mode.
  if (ctx.opts.plan === "free" && ctx.world.routes.length >= 1) {
    return json(400, { message: "You've reached the inbound routes limit of your plan." });
  }
  ctx.world.routeSeq += 1;
  const route: FakeRoute = {
    id: crypto.randomBytes(12).toString("hex"),
    priority: input.priority ?? 0,
    description: input.description ?? "",
    expression: input.expression,
    actions: input.actions ?? [],
    createdAt: ctx.now(),
    seq: ctx.world.routeSeq,
  };
  ctx.world.routes.push(route);
  return json(200, { message: "Route has been created", route: routeJson(route) });
}

export function listRoutes(ctx: FakeContext): HandlerResult {
  const skip = Number(ctx.req.query.skip?.[0] ?? 0);
  const limit = Number(ctx.req.query.limit?.[0] ?? 100);
  if (!Number.isInteger(limit) || limit < 1) return json(400, { message: "The 'limit' parameter must be a positive number" });
  if (limit > 1000) return json(400, { message: "The 'limit' parameter can't be larger than 1000" });
  const all = [...ctx.world.routes].sort((a, b) => a.seq - b.seq);
  const start = Number.isInteger(skip) && skip > 0 ? skip : 0;
  return json(200, { total_count: all.length, items: all.slice(start, start + limit).map(routeJson) });
}

function find(ctx: FakeContext): FakeRoute | undefined {
  return ctx.world.routes.find((r) => r.id === ctx.req.params.id);
}

export function getRoute(ctx: FakeContext): HandlerResult {
  const r = find(ctx);
  return r ? json(200, { route: routeJson(r) }) : json(404, { message: "Route not found" });
}

export function updateRoute(ctx: FakeContext): HandlerResult {
  const r = find(ctx);
  if (!r) return json(404, { message: "Route not found" });
  const input = readRoute(ctx);
  if (isResult(input)) return input;
  if (input.priority !== undefined) r.priority = input.priority;
  if (input.description !== undefined) r.description = input.description;
  if (input.expression !== undefined) r.expression = input.expression;
  if (input.actions !== undefined) r.actions = input.actions;
  if (ctx.switches.putBareRoute) return json(200, routeJson(r));
  return json(200, { message: "Route has been updated", route: routeJson(r) });
}

export function deleteRoute(ctx: FakeContext): HandlerResult {
  const r = find(ctx);
  if (!r) return json(404, { message: "Route not found" });
  ctx.world.routes = ctx.world.routes.filter((x) => x.id !== r.id);
  return json(200, { message: "Route has been deleted", id: r.id });
}

export function matchRoute(ctx: FakeContext): HandlerResult {
  const address = ctx.req.query.address?.[0];
  if (!address) return json(400, { message: "address is required" });
  const r = matchRouteFor(ctx.world.routes, address);
  return r ? json(200, { route: routeJson(r) }) : json(404, { message: "Route not found" });
}
