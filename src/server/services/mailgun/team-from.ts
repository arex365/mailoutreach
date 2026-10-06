import { TEAM_FROM_TEXTS, validateTeamFromAddress } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS, repliesOf, validateOwnMailboxFrom, type RepliesMode } from "@/core/sending/own-mailbox";
import { db, type DbOrTx } from "@/server/db";

/**
 * The shared From address as every reader sees it (SHARED-FROM-DESIGN §2.2, §7.5): Setting "mailgun.fromAddress" checked
 * against "mailgun.domain". Nobody reads the setting raw; `address` is null in per-person mode and whenever the saved
 * value doesn't fit (then `problem` says why, and TEST/LIVE launches, test sends and the reply test refuse: fail closed).
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §2.2, O3, O4): Setting "mailgun.replies" is read in the same query (through
 * `repliesOf`). In that mode `address` stays null (it means "shared-From mode" to thirty readers), the saved From is
 * checked with `validateOwnMailboxFrom` and, when it fits, is `ownFrom`; `evidenceFrom` is the From this way of sending
 * uses (the shared From or the own From), the one test emails, the reply test, the live test and go-live belong to.
 */

export type TeamFromState = {
  /** The shared From address when it is saved and fits the sending domain; null in per-person mode or when broken. Always null in own-mailbox mode. */
  address: string | null;
  /** What is saved (lowercase), even when it doesn't fit; null = nothing saved. */
  saved: string | null;
  /** Setting "mailgun.domain". */
  domain: string | null;
  /**
   * Set when something is saved but doesn't fit (TEAM_FROM_TEXTS.misfit / notConnected): TEST/LIVE must refuse. In
   * own-mailbox mode also when nothing is saved (OWN_MAILBOX_TEXTS.fromMissing) or it isn't on the sending domain
   * (OWN_MAILBOX_TEXTS.misfit).
   */
  problem: string | null;
  /**
   * Since when evidence counts (its row's updatedAt): when the From address last changed, or the sending domain or its
   * region did (a domain change re-writes the row with its own value, `restartEvidence` in connect.ts, review SETTING-1).
   * The reply test, the pasted original, the live test and the go-live checklist's freshness count only what happened
   * at or after it.
   */
  changedAt: Date | null;
  /** MAIN-DOMAIN-DESIGN O1: Setting "mailgun.replies" through repliesOf ("app" when missing or anything else). */
  replies: RepliesMode;
  /** MAIN-DOMAIN-DESIGN O3: own-mailbox mode, the saved From when it fits (exactly on the sending domain); else null. */
  ownFrom: string | null;
  /** MAIN-DOMAIN-DESIGN O4, O15: `address ?? ownFrom`, the From this way of sending uses; null in per-person mode. */
  evidenceFrom: string | null;
};

/**
 * Reads Settings "mailgun.fromAddress", "mailgun.domain" and "mailgun.replies" (one query) and checks the From against
 * the domain with the mode's rules (MAIN-DOMAIN-DESIGN §2.2's table). Settings only (no Mailgun, no secrets, no
 * writes): the dashboard may call it. Pass `tx` to read inside an open transaction.
 */
export async function loadTeamFrom(reader: DbOrTx = db): Promise<TeamFromState> {
  const rows = await reader.setting.findMany({
    where: { key: { in: ["mailgun.fromAddress", "mailgun.domain", "mailgun.replies"] } },
    select: { key: true, value: true, updatedAt: true },
  });
  const fromRow = rows.find((r) => r.key === "mailgun.fromAddress");
  const domainRow = rows.find((r) => r.key === "mailgun.domain");
  const replies = repliesOf(rows.find((r) => r.key === "mailgun.replies")?.value);
  const saved = typeof fromRow?.value === "string" && fromRow.value.trim() ? fromRow.value.trim().toLowerCase() : null;
  const domain = typeof domainRow?.value === "string" && domainRow.value.trim() ? domainRow.value.trim().toLowerCase() : null;
  const changedAt = fromRow?.updatedAt ?? null;
  const base = { saved, domain, changedAt, replies };

  if (replies === "own-mailbox") {
    if (!domain) {
      return { ...base, address: null, ownFrom: null, evidenceFrom: null, problem: saved ? TEAM_FROM_TEXTS.notConnected : null };
    }
    if (!saved) return { ...base, address: null, ownFrom: null, evidenceFrom: null, problem: OWN_MAILBOX_TEXTS.fromMissing(domain) };
    const own = validateOwnMailboxFrom(saved, domain);
    if (own.ok && own.address) return { ...base, address: null, ownFrom: own.address, evidenceFrom: own.address, problem: null };
    return { ...base, address: null, ownFrom: null, evidenceFrom: null, problem: OWN_MAILBOX_TEXTS.misfit(saved, domain) };
  }

  if (!saved) return { ...base, address: null, ownFrom: null, evidenceFrom: null, problem: null };
  const v = validateTeamFromAddress(saved, domain);
  if (v.ok && v.address) return { ...base, address: v.address, ownFrom: null, evidenceFrom: v.address, problem: null };
  return {
    ...base,
    address: null,
    ownFrom: null,
    evidenceFrom: null,
    problem: domain ? TEAM_FROM_TEXTS.misfit(saved, domain) : TEAM_FROM_TEXTS.notConnected,
  };
}
