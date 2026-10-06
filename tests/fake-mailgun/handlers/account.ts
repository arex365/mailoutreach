import crypto from "node:crypto";
import { json, type FakeContext, type HandlerResult } from "./context";

/**
 * Account endpoints (research §5, §12, §15). The signing key POST exists only so a test can prove the app never calls
 * it (it would break every webhook in flight). The monthly limit is read-only for the Developer role, so PUT is 403.
 */

export function getSigningKey(ctx: FakeContext): HandlerResult {
  if (!ctx.world.signingKey) return json(400, { message: "could not get HSK for account" });
  return json(200, { http_signing_key: ctx.world.signingKey });
}

export function regenerateSigningKey(ctx: FakeContext): HandlerResult {
  ctx.world.signingKey = `key-fake-${crypto.randomBytes(12).toString("hex")}`;
  ctx.world.signingKeyRegenerated += 1;
  return json(200, { message: "regenerated HTTP signing key for account", http_signing_key: ctx.world.signingKey });
}

export function getMonthlyLimit(ctx: FakeContext): HandlerResult {
  const m = ctx.world.monthlyLimit;
  if (!m) return json(404, { message: "No threshold for account" });
  return json(200, { limit: m.limit, current: m.current, period: "1m" });
}

export function putMonthlyLimit(): HandlerResult {
  return json(403, { message: "Forbidden" });
}
