import { countsAsEmailed, type SendModeValue } from "@/core/rules/mode";
import type { InboundKindValue, LinkTarget, Nature, ReplyScope } from "./types";

/**
 * What a processed message is stored as, and which recipients it may change (M4-DESIGN §3.5, §3.6). Pure and
 * browser-safe.
 */

/**
 * `InboundMessage.kind` from the classifier's nature and the link (M4-DESIGN §3.5):
 *
 * | Nature \ link | email or company | test (TestSend) or internal sender | none |
 * |---|---|---|---|
 * | REPLY | REPLY | TEST_REPLY | UNLINKED |
 * | POSSIBLE | POSSIBLE_REPLY | TEST_REPLY | UNLINKED (the card says "may be automatic") |
 * | AUTO | AUTO_REPLY | TEST_REPLY | AUTO_REPLY (null links) |
 * | BOUNCE | BOUNCE_NOTICE | TEST_REPLY | BOUNCE_NOTICE (null links) |
 */
export function storedKind(nature: Nature, link: LinkTarget): InboundKindValue {
  if (link === "test") return "TEST_REPLY";
  const linked = link === "email" || link === "company";
  switch (nature) {
    case "AUTO":
      return "AUTO_REPLY";
    case "BOUNCE":
      return "BOUNCE_NOTICE";
    case "POSSIBLE":
      return linked ? "POSSIBLE_REPLY" : "UNLINKED";
    default:
      return linked ? "REPLY" : "UNLINKED";
  }
}

/**
 * The app has been live at least once (review GOLIVE-01): live today (Setting "sending.goLive"), or went live before
 * (Setting "sending.goLiveAt", written only by goLive() and kept by a sending-domain change, G8). A reply linked only
 * to a company may make it Replied from then on.
 */
export function hasBeenLive(settings: { goLive: unknown; goLiveAt: unknown }): boolean {
  if (settings.goLive === true) return true;
  return typeof settings.goLiveAt === "string" && Number.isFinite(Date.parse(settings.goLiveAt));
}

/** The prefix of a reply notification's title for a dry-run or test-mode reply (B6.5). */
export type ReplyLabel = "" | "Dry run: " | "Test: ";

/**
 * The title prefix from the stored scope and the linked email's mode: "Dry run: " / "Test: " for campaign-scope
 * replies (M4-DESIGN §3.6), nothing otherwise.
 */
export function replyLabel(scope: ReplyScope | string | null | undefined, mode: SendModeValue | null | undefined): ReplyLabel {
  if (scope !== "campaign") return "";
  if (mode === "TEST") return "Test: ";
  if (mode === "DRY_RUN") return "Dry run: ";
  return "";
}

/**
 * Which recipients a reply may change, and whether it may set the company Replied (M4-DESIGN §3.6). Stored on the row
 * when it is processed; every later decision uses the stored values, never today's settings.
 *
 * | Linked email | Scope | Changes status | Label |
 * |---|---|---|---|
 * | LIVE of a campaign launched after go-live | real | yes | — |
 * | LIVE of a campaign launched before go-live (a test-list mailbox) | real | no, also after go-live | — |
 * | DRY_RUN in the practice copy (any source) | real | yes | — |
 * | DRY_RUN on real data (simulated replies only) | campaign | no | Dry run: |
 * | TEST (Mailgun's test mode) | campaign | no | Test: |
 * | none, but a company (known contact, fail-safe, by hand) | real | practice copy, or the app has been live | — |
 * | TestSend or internal sender | none | no | — |
 * | none (unlinked) | none | no | — |
 *
 * A linked email is "emailed" by its own campaign's launch flag (`launchedGoLive`, M6-DESIGN §2.2), never by today's
 * switch, so a late reply to a test email sent before go-live never marks a test mailbox Replied. The company branch
 * has no email to judge by: it asks whether the app has been live at least once (`everLive`, `hasBeenLive`), not
 * whether it is live today, because a sending-domain change switches go-live off (G8) while the prospects emailed
 * before stay emailed (review GOLIVE-01).
 *
 * `simulated` doesn't change the outcome: a real message never links to a dry run on real data (§3.3.1), and a
 * simulated one there gets campaign scope like any dry-run link.
 */
export function replyScope(input: {
  mode: SendModeValue | null;
  link: LinkTarget;
  simulated: boolean;
  practiceCopy: boolean;
  /** The app has been live at least once (`hasBeenLive`): only for a company link without an email. */
  everLive: boolean;
  /** The linked email's `Campaign.launchedGoLive` (null without an email or for a draft). */
  launchedGoLive: boolean | null;
}): { scope: ReplyScope; changesStatus: boolean; label: ReplyLabel } {
  if (input.link === "test" || input.link === "none") return { scope: "none", changesStatus: false, label: "" };
  if (input.link === "company" || input.mode === null) {
    return { scope: "real", changesStatus: input.practiceCopy || input.everLive, label: "" };
  }
  if (input.mode === "LIVE" || (input.mode === "DRY_RUN" && input.practiceCopy)) {
    const changesStatus = countsAsEmailed(input.mode, { practiceCopy: input.practiceCopy, launchedGoLive: input.launchedGoLive });
    return { scope: "real", changesStatus, label: "" };
  }
  return { scope: "campaign", changesStatus: false, label: replyLabel("campaign", input.mode) };
}
