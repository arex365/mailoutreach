import type { Prisma } from "@/generated/prisma/client";

/**
 * "Emailed" as a database filter (M6-DESIGN §2.2): the OutboundEmail rows whose sends count as "emailed" for the 30-day
 * rule, the same rule as `countsAsEmailed` (@/core/rules/mode) row by row. A LIVE send counts only when its campaign
 * was launched after go-live (`Campaign.launchedGoLive`), so test-list sends made before go-live never become history,
 * also after the switch; a dry run counts only in the practice copy; Mailgun's test mode never does.
 *
 * The condition joins the campaign on its primary key, so the history queries keep their
 * `(companyId | companyDomain | toNorm, sentAt)` indexes (tests/integration/sending/query-plans.test.ts). Callers
 * combine it with their own conditions through `AND: [emailedSendWhere(p)]`, so its `OR` never collides with theirs.
 * ExternalSend rows (sends found in Mailgun's logs after a restore) are a separate table and always count.
 */

/** OutboundEmail rows that count as "emailed" (M6-DESIGN §2.2): DRY_RUN in the practice copy, LIVE of a campaign launched after go-live. */
export function emailedSendWhere(practiceCopy: boolean): Prisma.OutboundEmailWhereInput {
  const live: Prisma.OutboundEmailWhereInput = { mode: "LIVE", campaign: { launchedGoLive: true } };
  return practiceCopy ? { OR: [{ mode: "DRY_RUN" }, live] } : live;
}
