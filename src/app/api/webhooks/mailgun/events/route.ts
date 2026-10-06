import { handleEventWebhook } from "@/server/services/mail-events/webhook";

/**
 * POST /api/webhooks/mailgun/events — public, no session (PLAN B7, B10): Mailgun's delivery, bounce, complaint and
 * unsubscribe reports. The HMAC signature is the credential; all checks live in handleEventWebhook (M3-DESIGN §4.4.1).
 * Allowlisted in tests/unit/security/auth-coverage.test.ts. Never isSameOrigin: Mailgun is not a browser.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleEventWebhook(request);
}
