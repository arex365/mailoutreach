import { handleInboundWebhook } from "@/server/services/mail-events/webhook";

/**
 * POST /api/webhooks/mailgun/inbound — public, no session (PLAN B7, B10): a reply stored by Mailgun, posted by the
 * reply routes' store(notify=…). The HMAC signature is the credential; all checks live in handleInboundWebhook
 * (M3-DESIGN §4.4.1). Allowlisted in tests/unit/security/auth-coverage.test.ts. Never isSameOrigin.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleInboundWebhook(request);
}
