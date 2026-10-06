import type { FakeCertificate } from "../state";
import { json, type FakeContext, type HandlerResult } from "./context";

/**
 * The tracking certificate (research §9, §15), one state machine per host: none → (POST) processing → active on the
 * `certPolls`-th status call (switch `certFails`: error instead). POST: 402 on the basic and free plans, 400 unless the tracking
 * CNAME is valid, 409 when already started. PUT (regenerate): 409 while valid, 429 while processing ("already in
 * progress", not a rate limit), 202 for an expired or failed certificate.
 */

const PEM = "-----BEGIN CERTIFICATE-----\nMIIFakeCertificateForTheFakeMailgunServer\n-----END CERTIFICATE-----";

function started(host: string): HandlerResult {
  return json(202, { message: "Initiated x509 key pair generation", location: `/v2/x509/${host}/status` });
}

function notStarted(host: string): HandlerResult {
  return json(404, { Description: `Please initiate x509 key pair generation at POST /v2/x509/${host}` });
}

/** Plans without a tracking certificate: basic, and free (MAIN-DOMAIN-DESIGN §7.8, as basic). */
function notInPlan(ctx: FakeContext): boolean {
  return ctx.opts.plan === "basic" || ctx.opts.plan === "free";
}

export function startCertificate(ctx: FakeContext): HandlerResult {
  const host = ctx.req.params.host!;
  if (notInPlan(ctx)) return json(402, { Reason: "upgrade your account to enable this feature" });
  if (!ctx.world.dns.tracking) return json(400, { Reason: "invalid CNAME record" });
  const cert = ctx.world.certificates.get(host);
  if (cert && (cert.status === "processing" || cert.status === "active")) {
    return json(409, { Description: `x509 key pair generation has already been initiated for ${host}` });
  }
  ctx.world.certificates.set(host, { status: "processing", polls: 0, startedAt: ctx.now() });
  return started(host);
}

export function certificateStatus(ctx: FakeContext): HandlerResult {
  const host = ctx.req.params.host!;
  const cert = ctx.world.certificates.get(host);
  if (!cert) return notStarted(host);
  if (cert.status === "processing") {
    cert.polls += 1;
    if (cert.polls >= Math.max(1, ctx.switches.certPolls)) cert.status = ctx.switches.certFails ? "error" : "active";
  }
  return json(200, statusBody(cert));
}

function statusBody(cert: FakeCertificate): Record<string, unknown> {
  switch (cert.status) {
    case "processing":
      return { status: "processing", error: "Waiting for x509 key pair generation" };
    case "active":
      return { status: "active", error: null, certificate: PEM };
    case "expired":
      return { status: "expired", error: "x509 certificate has expired", certificate: PEM };
    default:
      return { status: "error", error: "TLS x509 key pair generation failed, please contact support", certificate: PEM };
  }
}

export function regenerateCertificate(ctx: FakeContext): HandlerResult {
  const host = ctx.req.params.host!;
  if (notInPlan(ctx)) return json(402, { Reason: "upgrade your account to enable this feature" });
  const cert = ctx.world.certificates.get(host);
  if (!cert) return notStarted(host);
  if (cert.status === "processing") {
    return json(429, { Description: `x509 key pair generation job is already in progress for ${host}` });
  }
  if (cert.status === "active") {
    return json(409, { Description: "x509 certificate is still valid until 2027-12-31 23:00:00 +0000 UTC" });
  }
  ctx.world.certificates.set(host, { status: "processing", polls: 0, startedAt: ctx.now() });
  return started(host);
}
