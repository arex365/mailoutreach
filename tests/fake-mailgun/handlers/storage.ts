import { json, type FakeContext, type HandlerResult } from "./context";

/**
 * Stored inbound emails (research §7, §15): GET /v3/domains/{d}/messages/{key} on the fake's origin (where
 * `message-url` and Logs `storage.url` point). Default Accept → the JSON with the raw headers as top-level keys and
 * `message-headers` as a real array; `Accept: message/rfc2822` → `{recipients, sender, from, subject, body-mime}`.
 * After the domain's message_ttl (fake clock) → 404 "Message not found".
 */
export function getStoredMessage(ctx: FakeContext): HandlerResult {
  const stored = ctx.world.stored.get(ctx.req.params.key ?? "");
  const ttlMs = ctx.world.domain.messageTtl * 1000;
  if (!stored || ctx.now().getTime() - stored.storedAt.getTime() > ttlMs) {
    return json(404, { message: "Message not found" });
  }
  if ((ctx.req.headers.accept ?? "").includes("message/rfc2822")) return json(200, { ...stored.mime });
  return json(200, structuredClone(stored.json));
}
