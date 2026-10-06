import crypto from "node:crypto";
import { acceptedEvent, permanentFailEvent, type MessageFacts } from "../events";
import { sentInLast24h, type FakeSuppressionList } from "../state";
import { bareAddress, field, json, stripBrackets, type FakeContext, type HandlerResult } from "./context";

/**
 * POST /v3/{domain}/messages (research §1, §15). Validates like Mailgun, stores the message, answers with its id and
 * records an `accepted` event per recipient. It does NOT dedupe (neither does Mailgun). A recipient on a suppression
 * list gets a `failed` event with a `suppress-*` reason right away instead of ever being delivered.
 * MAIN-DOMAIN-DESIGN §7.8: with `authorizedRecipients` any other recipient → 403 (Free accounts are for test purposes);
 * past `dailyLimit` messages in the rolling 24 hours → 400 (the daily sending limit). Neither stores nor events anything.
 */

const OPTIONS_MAX_BYTES = 16_384;
const VALID_ADDRESS = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;

/** A Mailgun-style generated Message-ID: "20260923100000.1a2b3c4d5e6f@send.example.com". */
export function generatedMessageId(now: Date, domain: string): string {
  const ts = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${ts}.${crypto.randomBytes(6).toString("hex")}@${domain}`;
}

const SUPPRESS_REASON: Record<FakeSuppressionList, string> = {
  bounces: "suppress-bounce",
  unsubscribes: "suppress-unsubscribe",
  complaints: "suppress-complaint",
};

export function sendMessage(ctx: FakeContext): HandlerResult {
  const form = ctx.req.form;
  if (!form) return json(400, { message: "Content-Type must be multipart/form-data or application/x-www-form-urlencoded." });
  const from = field(form, "from");
  const toValues = form.to ?? [];
  const subject = field(form, "subject");
  if (!from) return json(400, { message: "from parameter is missing. " });
  if (!toValues.length || !toValues.join("").trim()) return json(400, { message: "to parameter is missing. " });
  if (subject === undefined) return json(400, { message: "subject parameter is missing. " });
  if (!field(form, "text") && !field(form, "html")) {
    return json(400, { message: "Need at least one of 'text', 'html', 'amp-html' or 'template' parameters specified." });
  }
  let optionBytes = 0;
  for (const [k, values] of Object.entries(form)) {
    if (!/^[ohv]:/.test(k)) continue;
    for (const v of values) optionBytes += Buffer.byteLength(k) + Buffer.byteLength(v);
  }
  if (optionBytes > OPTIONS_MAX_BYTES) {
    return json(400, { message: "Send options (parameters starting with o:, h:, or v:) are limited to 16KB total" });
  }
  const recipients = toValues
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
    .map(bareAddress);
  if (!recipients.length || recipients.some((r) => !VALID_ADDRESS.test(r))) {
    return json(400, { message: "to parameter is not a valid address. please check documentation." });
  }

  const now = ctx.now();
  const domain = ctx.world.domain.name;
  // MAIN-DOMAIN-DESIGN §7.8 (texts chosen for the tests, UNVERIFIED): a free account that may only send to authorized
  // recipients, and the plan's daily limit over the rolling 24 hours (test mode included). Nothing is stored or evented
  // for a refused message.
  const authorized = ctx.opts.authorizedRecipients;
  if (authorized && recipients.some((r) => !authorized.includes(r))) {
    return json(403, {
      message: `Domain ${domain} is not allowed to send: Free accounts are for test purposes only. Please upgrade or add the address to authorized recipients in Account Settings.`,
    });
  }
  const limit = ctx.opts.dailyLimit;
  if (limit !== null && sentInLast24h(ctx.world, now) >= limit) {
    return json(400, { message: `Domain ${domain} has reached its daily sending limit of ${limit} messages.` });
  }
  const ourId = field(form, "h:Message-Id") ? stripBrackets(field(form, "h:Message-Id")!).toLowerCase() : "";
  const id = !ourId || ctx.switches.rewriteMessageId ? generatedMessageId(now, domain) : ourId;
  const userVariables: Record<string, string> = {};
  for (const [k, values] of Object.entries(form)) if (k.startsWith("v:")) userVariables[k.slice(2)] = values[0] ?? "";
  const testMode = (field(form, "o:testmode") ?? "").toLowerCase() === "yes" || field(form, "o:testmode") === "true";
  const tags = form["o:tag"] ?? [];

  ctx.world.messages.push({ id, fields: structuredClone(form), receivedAt: now });
  ctx.world.messageFacts.set(id, {
    ourId: ourId || id,
    recipients,
    from,
    to: toValues.join(", "),
    subject,
    tags,
    userVariables,
    testMode,
  });
  for (const recipient of recipients) {
    const facts: MessageFacts = { messageId: id, domain, recipient, from, to: toValues.join(", "), subject, tags, userVariables, testMode };
    ctx.addEvent(acceptedEvent(facts, now), ctx.opts.indexLagMs);
    const list = (["bounces", "unsubscribes", "complaints"] as const).find((l) => ctx.world.suppressions[l].has(recipient));
    if (list) ctx.addEvent(permanentFailEvent(facts, now, { reason: SUPPRESS_REASON[list] }), ctx.opts.indexLagMs);
  }
  return json(200, { id: `<${id}>`, message: "Queued. Thank you." });
}
