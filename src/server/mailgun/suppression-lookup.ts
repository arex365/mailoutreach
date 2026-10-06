import { normalizeEmail } from "@/core/email-address";
import { db } from "../db";
import type { MailgunContext } from "./context";
import type { SuppressionList } from "./types";

/**
 * Which do-not-email lists hold each address (M3-DESIGN §4.2.4): the app's own Suppression table ("local") and
 * Mailgun's three lists on the context's domain. Mailgun won't forward replies to an address on its lists, so the
 * domain check (P4) and the route sync (P5) use this for reply inboxes.
 */

const LISTS: readonly SuppressionList[] = ["bounces", "complaints", "unsubscribes"];
const IN_CHUNK = 400;

/**
 * One entry per valid input address (normalised, duplicates merged), in list order: [] when it is on no list.
 * Invalid addresses are left out. Mailgun errors (network, auth…) are thrown: the caller shows "couldn't check".
 */
export async function suppressionListsFor(
  addresses: string[],
  ctx: MailgunContext,
): Promise<Map<string, Array<"local" | SuppressionList>>> {
  const out = new Map<string, Array<"local" | SuppressionList>>();
  for (const a of addresses) {
    const n = normalizeEmail(a);
    if (n && !out.has(n)) out.set(n, []);
  }
  const norms = [...out.keys()];
  for (let i = 0; i < norms.length; i += IN_CHUNK) {
    const rows = await db.suppression.findMany({
      where: { emailNorm: { in: norms.slice(i, i + IN_CHUNK) } },
      select: { emailNorm: true },
    });
    for (const r of rows) out.get(r.emailNorm)?.push("local");
  }
  // A few reply inboxes at most: one small GET per list, one after the other so Mailgun isn't flooded.
  for (const address of norms) {
    for (const list of LISTS) {
      const item = await ctx.client.getSuppression(ctx.domain, list, address);
      if (item) out.get(address)!.push(list);
    }
  }
  return out;
}
