import { bareAddress, stripBrackets } from "../../fake-mailgun/handlers/context";
import type { FakeMailgun, ReceiveInput } from "../../fake-mailgun/server";

/**
 * Reply helpers for the Milestone 4 integration tests (M4-DESIGN §7.3). Call createTestDb() (and connectFakeMailgun(),
 * which saves the fake's signing key as the app's webhook key) first: the app's modules are imported lazily.
 *
 *   const posted = await replyTo(mg.fake, emailId, { text: "Yes please" });   // the prospect answers one of our emails
 *   const auto = await postInbound(mg.fake, vectorInput(V03, { ids: { [A]: email.messageId } }));
 *   await processPendingInbound({ now });                                      // the event lane's work
 *
 * Everything goes through the fake Mailgun (which also stores the message and its Logs `stored` event, so the same
 * reply can be recovered by the catch-up) and the app's real inbound webhook handler with a valid signature.
 */

/** The public URL the signed requests are addressed to (only the path matters in-process). */
export const INBOUND_URL = "http://127.0.0.1:3000/api/webhooks/mailgun/inbound";
/** The address replies go to when a test doesn't say (a sender address on the fake's default domain). */
export const DEFAULT_REPLY_ADDRESS = "ali@send.example.com";

export type PostedInbound = {
  /** The webhook's HTTP status (200 when stored, or when a duplicate was ignored). */
  status: number;
  /** The InboundMessage stored for it (found by its storage key), or null. */
  id: number | null;
  storageKey: string;
  messageUrl: string;
  /** The notify form the fake built (without the signature fields). */
  fields: Record<string, string>;
};

/**
 * The fake receives `input` (stored message + Logs `stored` event) and posts its signed notify form to the app's inbound
 * webhook in-process. Default: through `handleInboundWebhook` with the fake's clock as "now" (so a test with a fixed
 * clock passes the 24-hour freshness check); `viaRoute: true` goes through the route file's own POST instead, signed
 * with the real time. `multipart: true` sends multipart/form-data.
 */
export async function postInbound(
  fake: FakeMailgun,
  input: ReceiveInput,
  opts: { viaRoute?: boolean; multipart?: boolean } = {},
): Promise<PostedInbound> {
  const received = fake.receive(input);
  let res: Response;
  if (opts.viaRoute) {
    const { POST } = await import("@/app/api/webhooks/mailgun/inbound/route");
    const timestamp = String(Math.floor(Date.now() / 1000));
    res = await POST(fake.signedInboundRequest(INBOUND_URL, received.fields, { multipart: opts.multipart, timestamp }));
  } else {
    const { handleInboundWebhook } = await import("@/server/services/mail-events/webhook");
    res = await handleInboundWebhook(fake.signedInboundRequest(INBOUND_URL, received.fields, { multipart: opts.multipart }), { now: fake.now() });
  }
  const { db } = await import("@/server/db");
  const row = await db.inboundMessage.findUnique({ where: { storageKey: received.storageKey }, select: { id: true } });
  return { status: res.status, id: row?.id ?? null, ...received };
}

/** What a reply needs from the email it answers (an OutboundEmail row, or its id). */
export type ReplyTarget = {
  toEmail: string;
  /** The full From line ("Ali Khan <ali@send.example.com>"): the reply goes to its address unless there is a Reply-To. */
  fromAddress: string;
  /**
   * The Reply-To the email was sent with (shared-From mode, SHARED-FROM-DESIGN §7.8): the reply goes there. Null or
   * absent = per-person mode (to the From address).
   */
  replyTo?: string | null;
  subject: string;
  messageId: string;
  providerId?: string | null;
  /** Space-separated ids, as stored. */
  references?: string | null;
  mode?: "DRY_RUN" | "TEST" | "LIVE";
};

/**
 * The Message-ID the person received: Mailgun's own id when it rewrote ours on a TEST/LIVE email, else ours. A dry run's
 * provider id ("dry-run:<id>") is never an id, so a dry-run row threads to its `messageId` (the practice-copy tests).
 */
export function receivedIdOf(email: Pick<ReplyTarget, "messageId" | "providerId" | "mode">): string {
  const provider = email.providerId ?? "";
  const usable = email.mode !== "DRY_RUN" && provider.includes("@") && !provider.startsWith("dry-run:");
  return stripBrackets(usable ? provider : email.messageId).toLowerCase();
}

/**
 * A reply from the person to `email`: from their address to the sender's (the Reply-To when the email had one, else the
 * From address), "Re: <subject>", In-Reply-To = the id they received and References = the email's References plus that
 * id, a short human text. `overrides` replace any field.
 */
export function replyInput(email: ReplyTarget, overrides: Partial<ReceiveInput> = {}): ReceiveInput {
  const received = receivedIdOf(email);
  const chain = (email.references ?? "").split(/\s+/).map(stripBrackets).filter((s) => s.includes("@"));
  return {
    from: email.toEmail,
    to: bareAddress(email.replyTo || email.fromAddress),
    subject: `Re: ${email.subject}`,
    text: "Thanks, this sounds interesting. Could you send your prices?",
    inReplyTo: received,
    references: [...new Set([...chain, received])],
    ...overrides,
  };
}

/** Loads the fields a reply needs from an OutboundEmail row. */
async function loadTarget(emailId: number): Promise<ReplyTarget> {
  const { db } = await import("@/server/db");
  return db.outboundEmail.findUniqueOrThrow({
    where: { id: emailId },
    select: { toEmail: true, fromAddress: true, replyTo: true, subject: true, messageId: true, providerId: true, references: true, mode: true },
  });
}

/**
 * The person answers one of our emails (an OutboundEmail row or its id; dry-run rows too, threaded to their
 * `messageId`): `replyInput` at the fake's current time, posted with `postInbound`.
 */
export async function replyTo(
  fake: FakeMailgun,
  email: number | ReplyTarget,
  overrides: Partial<ReceiveInput> = {},
  opts: { viaRoute?: boolean; multipart?: boolean } = {},
): Promise<PostedInbound> {
  const target = typeof email === "number" ? await loadTarget(email) : email;
  return postInbound(fake, { at: fake.now(), ...replyInput(target, overrides) }, opts);
}

/** The fields of a research vector (docs/dev/research/replies-and-auto-replies.md Appendix B, a ClassifyInput). */
export type VectorFields = {
  subject: string;
  fromEmail: string;
  fromName?: string | null;
  envelopeSender?: string | null;
  headers: ReadonlyArray<readonly [string, string]>;
  strippedText?: string | null;
  bodyPlain?: string | null;
  snippet?: string;
  bodyAvailable?: boolean;
};

/** A research vector (`{ id, in: ClassifyInput, … }`) or its input alone. */
export type Vector = VectorFields | { in: VectorFields };

/** The ids of a Message-Id / In-Reply-To / References value, without brackets, lowercase. */
function idsIn(value: string): string[] {
  const bracketed = [...value.matchAll(/<([^<>]+)>/g)].map((m) => m[1]!.trim().toLowerCase());
  return bracketed.length ? bracketed : value.split(/[\s,]+/).filter((s) => s.includes("@")).map((s) => stripBrackets(s).toLowerCase());
}

/**
 * A research vector as a fake inbound email (M4-DESIGN §7.3): the vector's From header (else fromName + fromEmail),
 * subject, envelope sender, stripped-text (absent when the vector has none: Mailgun's parse failed) and body-plain; its
 * In-Reply-To, References, Message-Id and Content-Type headers become the matching fields, every other header is passed
 * on. `ids` swaps the research's Message-IDs (e.g. `pp.4f1c…@send.polygonparadise.com`) for real ones everywhere,
 * texts included (bounce notices quote the original id); `to` is our address it reached (default ali@send.example.com);
 * `overrides` replace any field. A vector with `bodyAvailable: false` is a Logs-only recovery: receive it, let the
 * stored body expire (fake.setNow past the message retention) and run the catch-up.
 */
export function vectorInput(
  vector: Vector,
  opts: { to?: string; ids?: Readonly<Record<string, string>>; overrides?: Partial<ReceiveInput> } = {},
): ReceiveInput {
  const v = "in" in vector ? vector.in : vector;
  const map = new Map(Object.entries(opts.ids ?? {}).map(([k, val]) => [stripBrackets(k).toLowerCase(), stripBrackets(val)]));
  const swapId = (id: string) => map.get(id.toLowerCase()) ?? id;
  const swapText = (text: string) => {
    let out = text;
    for (const [from, to] of map) out = out.split(from).join(to);
    return out;
  };
  let from = v.fromName ? `${v.fromName} <${v.fromEmail}>` : v.fromEmail;
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  let messageId: string | undefined;
  let contentType: string | undefined;
  const headers: Array<[string, string]> = [];
  for (const [name, value] of v.headers) {
    const n = name.toLowerCase();
    if (n === "from") from = value;
    else if (n === "in-reply-to") inReplyTo = idsIn(value).map(swapId)[0];
    else if (n === "references") references = idsIn(value).map(swapId);
    else if (n === "message-id") messageId = idsIn(value)[0];
    else if (n === "content-type") contentType = value;
    else headers.push([name, swapText(value)]);
  }
  const stripped = typeof v.strippedText === "string" ? swapText(v.strippedText) : null;
  const plain = swapText(v.bodyPlain ?? v.strippedText ?? v.snippet ?? "");
  return {
    from,
    to: opts.to ?? DEFAULT_REPLY_ADDRESS,
    subject: v.subject,
    text: stripped ?? plain,
    strippedText: stripped,
    bodyPlain: plain,
    headers,
    ...(typeof v.envelopeSender === "string" ? { envelopeSender: v.envelopeSender } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references?.length ? { references } : {}),
    ...(messageId ? { messageId } : {}),
    ...(contentType ? { contentType } : {}),
    ...opts.overrides,
  };
}
