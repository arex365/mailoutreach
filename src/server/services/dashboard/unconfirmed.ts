import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";

/**
 * The dashboard's "3 emails need a decision" item (M6-DESIGN §4.2 item 8): emails the app isn't sure were sent
 * ("Not sure it was sent", status UNCONFIRMED, M3-DESIGN §4.3.5), where someone chooses Retry or Skip. Read-only
 * (§0.2 rule 8): one count and one `findFirst`.
 */

/**
 * UNCONFIRMED emails of campaigns that weren't cancelled: a cancelled campaign's email can't be retried any more, so
 * nobody could ever clear the item.
 */
const NEEDS_DECISION: Prisma.OutboundEmailWhereInput = { status: "UNCONFIRMED", campaign: { status: { not: "CANCELLED" } } };

/** How many emails need a decision, and the campaign of the oldest one (where the item's Open link goes). */
export async function unconfirmedEmails(): Promise<{ count: number; firstCampaignId: number | null }> {
  const [count, first] = await Promise.all([
    db.outboundEmail.count({ where: NEEDS_DECISION }),
    db.outboundEmail.findFirst({ where: NEEDS_DECISION, orderBy: { id: "asc" }, select: { campaignId: true } }),
  ]);
  return { count, firstCampaignId: count > 0 ? (first?.campaignId ?? null) : null };
}
