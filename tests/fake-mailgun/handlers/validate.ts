import { fakeValidationBody, isSlowAddress } from "../../../src/core/verification/fake-rules";
import type { FakeSwitches, FakeWorld } from "../state";
import { field, formBool, json, type FakeContext, type HandlerResult, type ParsedRequest } from "./context";

/**
 * GET (and POST) /v4/address/validate (M5-DESIGN §7.1, research verification-reference §11): account-level, no domain.
 * Answers come from `fakeValidationBody` (shared with the in-process test checker), after an override set with
 * `setValidation` (rule order: override → domain → local part, so an override that runs out falls back to the
 * address's own rule). The switches shape `engagement` and `did_you_mean`; `slow…` addresses answer after
 * `validateSlowMs`. The server records every answered request (billable = a 200) and enforces `validateMaxActive`.
 * Bulk, preview and every /v3/address/* path stay unrouted: they get the plain `404 page not found`.
 */

/** The route pattern, also the fault key: `fake.failNext("GET /v4/address/validate", …)`. */
export const VALIDATE_PATTERN = "/v4/address/validate";

/** The `address` of a validate request: the query (GET), or the form or the query (POST). */
export function validationAddressOf(req: Pick<ParsedRequest, "query" | "form">): string | undefined {
  return req.query.address?.[0] ?? field(req.form, "address");
}

/** `provider_lookup` (default true): only an explicit "false"/"no" turns it off. */
function providerLookupOf(req: Pick<ParsedRequest, "query" | "form">): boolean {
  const raw = req.query.provider_lookup?.[0] ?? field(req.form, "provider_lookup");
  return formBool(raw) !== false;
}

/** The default body for an override that gives a status but no body. */
function defaultBodyFor(status: number): object {
  if (status === 429) return { message: "Too many requests" };
  if (status >= 500) return { message: "Internal Server Error" };
  if (status === 401) return { message: "Invalid private key" };
  return { message: "Bad request" };
}

/** Takes one answer from the address's override, if it has one left. */
function takeOverride(world: FakeWorld, address: string): HandlerResult | null {
  const o = world.validation.overrides.get(address);
  if (!o) return null;
  if (o.left !== null) {
    o.left -= 1;
    if (o.left <= 0) world.validation.overrides.delete(address);
  }
  const status = o.status ?? 200;
  return { status, body: o.body ?? (status === 200 ? {} : defaultBodyFor(status)) };
}

/** The switches' changes to a 200 answer with a `result` (the v3-shaped body is left as it is). */
function applySwitches(body: unknown, switches: FakeSwitches): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("result" in body)) return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (switches.validateDidYouMeanNull && !("did_you_mean" in out)) out.did_you_mean = null;
  if (switches.validateEngagement === "empty") out.engagement = {};
  else if (switches.validateEngagement === "null") out.engagement = null;
  else if (switches.validateEngagement === "absent") delete out.engagement;
  return out;
}

export function validate(ctx: FakeContext): HandlerResult {
  const address = validationAddressOf(ctx.req);
  const key = (address ?? "").trim().toLowerCase();
  const override = key ? takeOverride(ctx.world, key) : null;
  if (override) return override;
  const answer = fakeValidationBody(address ?? "", {
    callsSoFar: ctx.world.validation.byAddress.get(key) ?? 0,
    providerLookup: providerLookupOf(ctx.req),
  });
  const result = json(answer.status, answer.status === 200 ? applySwitches(answer.body, ctx.switches) : answer.body);
  if (answer.status === 200 && isSlowAddress(address ?? "")) result.delayMs = Math.max(0, ctx.switches.validateSlowMs);
  return result;
}
