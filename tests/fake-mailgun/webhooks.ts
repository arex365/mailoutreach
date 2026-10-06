import crypto from "node:crypto";

/**
 * Signed requests "from Mailgun" to OUR app (M3-DESIGN §6.1, research §13, §15). Its own HMAC, independent of
 * src/core/mailgun/signature.ts, so a bug there can't hide itself in the tests.
 *
 * signedEventRequest / signedInboundRequest build standard `Request` objects that route-handler tests pass straight to
 * `POST(request)`; postToApp sends one over HTTP, only ever to a loopback address (the CLI's `--app`).
 */

/** HMAC-SHA256 of timestamp + token (no separator) with the webhook signing key, lowercase hex (research §13.3). */
export function hmacSignature(signingKey: string, timestamp: string, token: string): string {
  return crypto.createHmac("sha256", signingKey).update(timestamp + token).digest("hex");
}

/** 50 random hex characters, like Mailgun's tokens. */
export function randomToken(): string {
  return crypto.randomBytes(25).toString("hex");
}

/** Changes one hex digit, so the signature is still well-formed but wrong. */
function tampered(signature: string): string {
  const last = signature.slice(-1);
  return signature.slice(0, -1) + (last === "0" ? "1" : "0");
}

/** The fake's default webhook signing key (FakeMailgunOptions.signingKey). */
export const DEFAULT_SIGNING_KEY = "key-fake-signing";

export type SignOptions = {
  /** Default: now in whole seconds. A number is sent as a JSON number (tests the app's String() normalisation). */
  timestamp?: string | number;
  token?: string;
  /** Send a wrong signature. */
  tamper?: boolean;
  /** The signing key; default "key-fake-signing". */
  key?: string;
  /** The clock for the default timestamp. */
  now?: Date;
};

function signatureBlock(opts: SignOptions): { timestamp: string | number; token: string; signature: string } {
  const timestamp = opts.timestamp ?? String(Math.floor((opts.now ?? new Date()).getTime() / 1000));
  const token = opts.token ?? randomToken();
  const sig = hmacSignature(opts.key ?? DEFAULT_SIGNING_KEY, String(timestamp), token);
  return { timestamp, token, signature: opts.tamper ? tampered(sig) : sig };
}

/** POST <appUrl> with `{"signature": {...}, "event-data": {...}}` as JSON, signed with `opts.key`. */
export function signedEventRequest(appUrl: string, eventData: object, opts: SignOptions = {}): Request {
  const body = { signature: signatureBlock(opts), "event-data": eventData };
  return new Request(appUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "mailgun/treq-16.12.0" },
    body: JSON.stringify(body),
  });
}

/** POST <appUrl> with the inbound notify form (flat `timestamp`, `token`, `signature`), urlencoded or multipart. */
export function signedInboundRequest(
  appUrl: string,
  fields: Record<string, string>,
  opts: SignOptions & { multipart?: boolean } = {},
): Request {
  const sig = signatureBlock(opts);
  const all: Record<string, string> = { ...fields, timestamp: String(sig.timestamp), token: sig.token, signature: sig.signature };
  if (opts.multipart) {
    const form = new FormData();
    for (const [k, v] of Object.entries(all)) form.append(k, v);
    return new Request(appUrl, { method: "POST", body: form });
  }
  return new Request(appUrl, { method: "POST", body: new URLSearchParams(all) });
}

/** Throws unless `url` is http(s) on 127.0.0.1, localhost or [::1]: the fake never calls anything else. */
export function assertLoopbackUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || !/^https?:$/.test(u.protocol)) {
    throw new Error(`The fake Mailgun server only posts to this PC (127.0.0.1), not to ${u.origin}.`);
  }
}

/** Sends a built request to the app over HTTP (CLI mode). Loopback only. */
export async function postToApp(request: Request): Promise<{ status: number; body: string }> {
  assertLoopbackUrl(request.url);
  const res = await fetch(request, { redirect: "manual" });
  return { status: res.status, body: await res.text() };
}
