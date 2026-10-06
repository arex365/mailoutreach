import { bareAddress, type HandlerResult } from "./handlers/context";
import {
  deliveredToFake,
  findSentMessage,
  INBOUND_PRESETS,
  isInboundPreset,
  isPresetTarget,
  presetInbound,
  withoutTarget,
} from "./inbound-presets";
import type { DnsKind, Fault, FakeSwitches } from "./state";
import type { FakeMailgun, ReceiveInput } from "./server";
import { postToApp } from "./webhooks";

/**
 * The fake's admin API for the lead's manual browser checks (M3-DESIGN §6.3, M4-DESIGN §7.3). No auth, JSON bodies,
 * served only on 127.0.0.1 and never logged in `fake.requests`:
 *   GET  /__fake/messages, /__fake/state, /__fake/requests
 *   POST /__fake/deliver|tempfail|bounce|complain|unsubscribe {messageId, webhook?: true, reason?, code?}
 *   POST /__fake/inbound {from, to, subject, text, inReplyTo?, references?, headers?: [[name, value]], at?: ISO,
 *                         envelopeSender?, strippedText?: string | null, bodyPlain?, contentType?, messageId?,
 *                         fromName?, notify?: true}
 *   POST /__fake/inbound {preset: "reply" | "out-of-office" | "unclear" | "bounce-notice" | "new-email" | "spam",
 *                         inReplyTo: <one of the fake's sent messages>, to?: "reply-to" | "from",
 *                         …any field above to override, notify?: true}
 *     A preset goes to its real target (inbound-presets.ts: the Reply-To, else the From; new-email and bounce-notice
 *     always the From), or to `to: "reply-to" | "from"`. When that address isn't on the fake's domain or its
 *     otherDomains (e.g. contact@<main domain> in shared-From mode), nothing is stored or posted and the answer is
 *     {ok: true, stored: false, deliveredTo: "outside", to} (SHARED-FROM-DESIGN §7.8). A fake started with
 *     --mx-elsewhere (receivesMail: false, MAIN-DOMAIN-DESIGN §7.8) answers "outside" for every preset. Stored answers
 *     carry {ok: true, stored: true, deliveredTo: "mailgun", to, storageKey, messageUrl, fields}.
 *   POST /__fake/fail-next {route, fault, times?}   POST /__fake/dns {valid: "all" | ["spf", …]}
 *   POST /__fake/queue {disabled, reason?, until?}  POST /__fake/clock {now: ISO | null}
 *   POST /__fake/switches {…}                       POST /__fake/reset
 *   POST /__fake/validation {address, body?, status?, times?}   (M5: the next answers for one address)
 * `webhook: true` / `notify: true` post a signed request to the app given with --app (loopback only).
 * GET /__fake/state includes `validations` ({billableThisMonth, byAddress, peakInFlight}) and (MAIN-DOMAIN-DESIGN §7.8)
 * `receivesMail`, `plan`, `dailyLimit`, `authorizedRecipients` and `sentLast24h`.
 */

type AdminRequest = { method: string; path: string; body: string };

/** The fields of an admin inbound body that override (or, without a preset, make up) the received email. */
function inboundOverrides(body: Record<string, unknown>): Partial<ReceiveInput> | string {
  const out: Partial<ReceiveInput> = {};
  for (const k of ["from", "to", "subject", "text", "envelopeSender", "bodyPlain", "contentType", "messageId", "fromName"] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== "string") return `${k} must be text.`;
    out[k] = v;
  }
  if (body.strippedText !== undefined) {
    if (body.strippedText !== null && typeof body.strippedText !== "string") return "strippedText must be text or null.";
    out.strippedText = body.strippedText;
  }
  if (body.references !== undefined) {
    if (!Array.isArray(body.references)) return "references must be a list of ids.";
    out.references = body.references.filter((r): r is string => typeof r === "string");
  }
  if (body.headers !== undefined) {
    const list = body.headers;
    if (!Array.isArray(list) || !list.every((h) => Array.isArray(h) && h.length === 2 && typeof h[0] === "string" && typeof h[1] === "string")) {
      return 'headers must look like [["Auto-Submitted", "auto-replied"]].';
    }
    out.headers = (list as Array<[string, string]>).map(([n, v]) => [n, v]);
  }
  if (body.at !== undefined) {
    if (typeof body.at !== "string" || Number.isNaN(Date.parse(body.at))) return "at must be an ISO date.";
    out.at = new Date(body.at);
  }
  return out;
}

/**
 * The email an admin inbound body describes: a preset answer to one of the fake's sent messages with the explicit
 * fields on top, or (without a preset) the explicit fields alone, which then need from, to, subject and text. A
 * plain sentence when the body can't be used.
 */
export function adminInboundInput(fake: FakeMailgun, body: Record<string, unknown>): ReceiveInput | string {
  const overrides = inboundOverrides(body);
  if (typeof overrides === "string") return overrides;
  if (body.preset !== undefined) {
    if (!isInboundPreset(body.preset)) return `preset must be one of ${INBOUND_PRESETS.join(", ")}.`;
    if (typeof body.inReplyTo !== "string" || !body.inReplyTo.trim()) {
      return "inReplyTo is required with a preset: the id of one of the fake's sent messages (GET /__fake/messages).";
    }
    const message = findSentMessage(fake.messages, body.inReplyTo);
    if (!message) return `The fake has no sent message ${body.inReplyTo}. Use an id from GET /__fake/messages.`;
    // `to: "reply-to" | "from"` picks the target; any other `to` is an explicit address that overrides it.
    const target = isPresetTarget(body.to) ? body.to : undefined;
    if (target) delete overrides.to;
    return { ...withoutTarget(presetInbound(body.preset, message, { to: target })), ...overrides };
  }
  for (const k of ["from", "to", "subject", "text"] as const) if (typeof overrides[k] !== "string") return `${k} is required.`;
  return {
    from: overrides.from!,
    to: overrides.to!,
    subject: overrides.subject!,
    text: overrides.text!,
    ...overrides,
    ...(typeof body.inReplyTo === "string" ? { inReplyTo: body.inReplyTo } : {}),
  };
}

const DNS_KINDS: readonly DnsKind[] = ["spf", "dkim", "mx", "tracking"];

function ok(body: unknown): HandlerResult {
  return { status: 200, body };
}

function bad(error: string, status = 400): HandlerResult {
  return { status, body: { error } };
}

function appEndpoint(fake: FakeMailgun, path: string): string | null {
  const app = fake.options.appUrl;
  return app ? app.replace(/\/+$/, "") + path : null;
}

export async function handleAdmin(fake: FakeMailgun, req: AdminRequest): Promise<HandlerResult> {
  const action = req.path.replace(/^\/__fake\//, "").replace(/\/+$/, "");
  let body: Record<string, unknown> = {};
  if (req.body.trim()) {
    try {
      const parsed: unknown = JSON.parse(req.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      else return bad("Send a JSON object.");
    } catch {
      return bad("The body isn't valid JSON.");
    }
  }

  try {
    if (req.method === "GET") {
      if (action === "messages") return ok({ messages: fake.messages });
      if (action === "state") return ok(fake.state());
      if (action === "requests") return ok({ requests: fake.requests });
      return bad(`Unknown admin endpoint GET /__fake/${action}.`, 404);
    }
    if (req.method !== "POST") return bad("Use GET or POST.", 405);

    switch (action) {
      case "deliver":
      case "tempfail":
      case "bounce":
      case "complain":
      case "unsubscribe": {
        const messageId = typeof body.messageId === "string" ? body.messageId : "";
        if (!messageId) return bad("messageId is required.");
        const at = typeof body.at === "string" ? new Date(body.at) : undefined;
        const eventData =
          action === "deliver"
            ? fake.deliver(messageId, { at })
            : action === "tempfail"
              ? fake.tempFail(messageId, { at })
              : action === "bounce"
                ? fake.bounce(messageId, {
                    at,
                    reason: typeof body.reason === "string" ? body.reason : undefined,
                    code: typeof body.code === "number" ? body.code : undefined,
                  })
                : action === "complain"
                  ? fake.complain(messageId, { at })
                  : fake.unsubscribe(messageId, { at });
        if (body.webhook !== true) return ok({ eventData });
        const url = appEndpoint(fake, "/api/webhooks/mailgun/events");
        if (!url) return bad("Start the fake with --app http://127.0.0.1:<port> to post webhooks to the app.");
        const webhook = await postToApp(fake.signedEventRequest(url, eventData));
        return ok({ eventData, webhook });
      }
      case "inbound": {
        const input = adminInboundInput(fake, body);
        if (typeof input === "string") return bad(input);
        const to = bareAddress(input.to);
        // A preset addressed outside the fake's domains lands in a mail provider's inbox: nothing reaches Mailgun. With
        // `receivesMail: false` (MAIN-DOMAIN-DESIGN §7.8) the fake's own domains are outside too (their MX isn't Mailgun's).
        const receiving = fake.options.receivesMail ? [fake.options.domain, ...fake.options.otherDomains] : [];
        if (body.preset !== undefined && !deliveredToFake(to, receiving)) {
          return ok({ ok: true, stored: false, deliveredTo: "outside", to });
        }
        const received = { ok: true, stored: true, deliveredTo: "mailgun", to, ...fake.receive(input) };
        if (body.notify !== true) return ok(received);
        const url = appEndpoint(fake, "/api/webhooks/mailgun/inbound");
        if (!url) return bad("Start the fake with --app http://127.0.0.1:<port> to post replies to the app.");
        const notify = await postToApp(fake.signedInboundRequest(url, received.fields));
        return ok({ ...received, notify });
      }
      case "fail-next": {
        if (typeof body.route !== "string" || !body.fault || typeof body.fault !== "object") {
          return bad('Send {"route": "POST /v3/:d/messages", "fault": {"kind": "hang"}}.');
        }
        fake.failNext(body.route, body.fault as Fault, typeof body.times === "number" ? body.times : 1);
        return ok({ queued: true });
      }
      case "dns": {
        const valid = body.valid;
        if (valid === "all") fake.setDns("all");
        else if (Array.isArray(valid) && valid.every((v) => (DNS_KINDS as readonly unknown[]).includes(v))) fake.setDns(valid as DnsKind[]);
        else return bad('valid must be "all" or a list of spf, dkim, mx, tracking.');
        return ok({ dns: fake.state().dns });
      }
      case "queue": {
        if (body.disabled === true) {
          const until = typeof body.until === "string" ? new Date(body.until) : undefined;
          fake.disableQueue(typeof body.reason === "string" ? body.reason : "Disabled by the fake", until);
        } else {
          fake.enableQueue();
        }
        return ok({ queue: fake.state().queue });
      }
      case "clock": {
        if (body.now === null || body.now === undefined) {
          fake.setNow(() => new Date());
        } else if (typeof body.now === "string" && !Number.isNaN(Date.parse(body.now))) {
          const fixed = new Date(body.now);
          fake.setNow(() => new Date(fixed));
        } else {
          return bad("now must be an ISO date or null.");
        }
        return ok({ now: fake.now().toISOString() });
      }
      case "switches":
        fake.setSwitches(body as Partial<FakeSwitches>);
        return ok({ switches: body });
      case "validation": {
        if (typeof body.address !== "string" || !body.address.trim()) return bad("address is required.");
        if (body.status !== undefined && (typeof body.status !== "number" || !Number.isInteger(body.status))) return bad("status must be a whole number.");
        if (body.body !== undefined && (!body.body || typeof body.body !== "object" || Array.isArray(body.body))) return bad("body must be a JSON object.");
        if (body.times !== undefined && (typeof body.times !== "number" || body.times < 1)) return bad("times must be 1 or more.");
        if (body.status === undefined && body.body === undefined) return bad("Send a status, a body or both.");
        fake.setValidation(body.address, {
          ...(typeof body.status === "number" ? { status: body.status } : {}),
          ...(body.body !== undefined ? { body: body.body as object } : {}),
          ...(typeof body.times === "number" ? { times: body.times } : {}),
        });
        return ok({ validation: { address: body.address.trim().toLowerCase() } });
      }
      case "reset":
        fake.reset();
        return ok({ reset: true });
      default:
        return bad(`Unknown admin endpoint POST /__fake/${action}.`, 404);
    }
  } catch (err) {
    return bad(err instanceof Error ? err.message : String(err));
  }
}
