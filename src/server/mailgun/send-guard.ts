import { normalizeEmail } from "@/core/email-address";
import { MailgunError } from "./errors";
import type { SendMessageInput } from "./types";

/**
 * The test-list guard inside the Mailgun client (M3-DESIGN §4.2.3 step 1, PLAN B6.5, M6-DESIGN §2.3). The sending loop,
 * the launch and the test sends check the same rule first; this last check sits in MailgunClient.sendMessage itself,
 * so no code path can reach Mailgun with an address that isn't allowed. Pure: no database, no network.
 */

/** Characters that would turn `to` into more than one recipient or a display-name form. */
const NOT_A_BARE_ADDRESS = /[,;<>"\s]/;

/** Shortens an address for a message, so a huge value can't flood the logs. */
function shown(address: string): string {
  const a = address.trim();
  return a.length > 120 ? `${a.slice(0, 117)}…` : a || "(empty)";
}

function guardError(sentence: string): MailgunError {
  return new MailgunError({ kind: "guard", requestStarted: false, message: sentence, mailgunMessage: "" });
}

/** True when `to` is exactly one bare address, already normalised (what Mailgun gets is what the guard checked). */
export function isSingleBareAddress(to: string): boolean {
  if (typeof to !== "string" || !to || NOT_A_BARE_ADDRESS.test(to)) return false;
  return normalizeEmail(to) === to;
}

/**
 * True when a campaign email may reach anyone (M6-DESIGN §2.3): only after go-live, outside Mailgun's test mode, and
 * when the email says it isn't test-list only (`testListOnly === false`, its campaign launched after go-live). A missing
 * flag fails closed.
 */
function mayReachAnyone(msg: Pick<SendMessageInput, "purpose" | "guard" | "testMode" | "testListOnly">): boolean {
  return msg.purpose === "campaign" && msg.guard.goLive && msg.testMode !== true && msg.testListOnly === false;
}

/**
 * Throws MailgunError {kind: "guard", requestStarted: false} unless:
 *  - `to` is one bare, normalised address (no lists, no `Name <addr>`), and
 *  - a "Send me a test" email goes to the acting user's own reply inbox (always), and
 *  - every other email goes to an address on the test list, except a campaign email that may reach anyone: after
 *    go-live, not in Mailgun's test mode, and `testListOnly: false` (its campaign was launched after go-live).
 * So the reply test, test mode (G3), a live campaign launched before go-live and a campaign email without the flag stay
 * on the test list for good (M6-DESIGN §2.3).
 */
export function checkSendGuard(msg: Pick<SendMessageInput, "to" | "purpose" | "guard" | "testMode" | "testListOnly">): void {
  const to = msg.to;
  if (!isSingleBareAddress(to)) {
    throw guardError(`Stopped by the test-list guard: ${shown(String(to ?? ""))} isn't one plain email address.`);
  }
  if (msg.purpose === "self-test") {
    const own = msg.guard.ownInbox ? normalizeEmail(msg.guard.ownInbox) : null;
    if (!own || own !== to) {
      throw guardError(`Stopped by the test-list guard: ${shown(to)} isn't your own reply inbox.`);
    }
    return;
  }
  if (mayReachAnyone(msg)) return;
  if (!msg.guard.testList.has(to)) {
    throw guardError(`Stopped by the test-list guard: ${shown(to)} isn't on your test list.`);
  }
}
