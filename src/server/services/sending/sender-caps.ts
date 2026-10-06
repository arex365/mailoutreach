import { dbTx } from "@/server/db";
import { logActivity } from "@/server/activity";

/**
 * Per-sender daily limits (PLAN B6.6, M3-DESIGN §4.3.9, §5.4 "Per-sender limits"): User.dailyCap, on
 * top of the domain's daily limit. Empty = "No limit of their own". Only the Owner edits them, on
 * Settings › Limits & warm-up (the page's action checks that).
 */

export const SENDER_CAP_MIN = 1;
export const SENDER_CAP_MAX = 10_000;

export class SenderCapError extends Error {
  constructor(
    message: string,
    readonly userId: number | null = null,
  ) {
    super(message);
    this.name = "SenderCapError";
  }
}

export type SenderCapInput = { userId: number; dailyCap: number | null };

/** Plain text for the limit ("100", "No limit of their own"). */
function capText(cap: number | null): string {
  return cap === null ? "no limit of their own" : cap.toLocaleString("en-US");
}

/**
 * Saves the per-sender limits in one transaction: each value 1–10,000 or empty (null). Only changed
 * values are written, each logged as "settings.updated" ("Arslan set Ali's daily limit to 100").
 * Returns how many changed. Throws SenderCapError (plain words) for a bad value or an unknown user.
 */
export async function saveSenderCaps(
  actor: { id: number; name: string },
  caps: ReadonlyArray<SenderCapInput>,
): Promise<{ changed: number }> {
  const seen = new Set<number>();
  for (const c of caps) {
    if (!Number.isInteger(c.userId) || c.userId <= 0) throw new SenderCapError("That teammate doesn't exist any more. Refresh the page.");
    if (seen.has(c.userId)) throw new SenderCapError("Each teammate can only have one daily limit.", c.userId);
    seen.add(c.userId);
    if (c.dailyCap === null) continue;
    if (!Number.isInteger(c.dailyCap) || c.dailyCap < SENDER_CAP_MIN || c.dailyCap > SENDER_CAP_MAX) {
      throw new SenderCapError(
        `A daily limit must be a whole number from ${SENDER_CAP_MIN} to ${SENDER_CAP_MAX.toLocaleString("en-US")}, or empty for no limit of their own.`,
        c.userId,
      );
    }
  }
  if (caps.length === 0) return { changed: 0 };
  return dbTx(async (tx) => {
    const users = await tx.user.findMany({ where: { id: { in: [...seen] } }, select: { id: true, name: true, dailyCap: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    let changed = 0;
    for (const c of caps) {
      const user = byId.get(c.userId);
      if (!user) throw new SenderCapError("That teammate doesn't exist any more. Refresh the page.", c.userId);
      if (user.dailyCap === c.dailyCap) continue;
      await tx.user.update({ where: { id: user.id }, data: { dailyCap: c.dailyCap } });
      await logActivity(
        {
          actorId: actor.id,
          type: "settings.updated",
          summary:
            c.dailyCap === null
              ? `${actor.name} removed ${user.name}'s own daily limit`
              : `${actor.name} set ${user.name}'s daily limit to ${capText(c.dailyCap)}`,
          data: { key: "user.dailyCap", userId: user.id, from: user.dailyCap, to: c.dailyCap },
        },
        tx,
      );
      changed += 1;
    }
    return { changed };
  });
}
