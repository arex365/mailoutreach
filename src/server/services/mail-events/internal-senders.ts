import { normalizeEmail } from "@/core/email-address";
import { db, type DbOrTx } from "@/server/db";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";

/**
 * Who counts as "us" when a message reaches our reply addresses (M4-DESIGN §3.3.0, §3.3.1, §2.5.1 step 2). One place, so
 * the sending guard (which must hold nothing for these) and the reply processor (which files them as TEST_REPLY) always
 * agree:
 *  - internal: a user's login email or reply inbox (switched-off users included), any SenderAddress (retired ones
 *    included), or any address on one of our SendingDomains: a team member forwarding or noting something. In
 *    shared-From mode also the shared From address and any address on its domain (SHARED-FROM-DESIGN F16: mail from
 *    contact@ or another mailbox of the main domain is the team's own, never a prospect reply), and in own-mailbox mode
 *    the own From and its domain (MAIN-DOMAIN-DESIGN §1.5: `loadTeamFrom().evidenceFrom`). Except when
 *    the message answers one of our emails that went to that very address: a test-list mailbox (or a contact) that is
 *    also someone's login email is answering the email it got, so it is a reply like any other. A forward of Anna's
 *    reply by Ali still points at the email to Anna, so it stays internal;
 *  - test sender (for a thread that hits a TestSend): that test's `to`, a user's login email or reply inbox, or an
 *    address on the test list (Setting "sending.testList"). A prospect answering a forwarded test email is neither.
 */

export type InternalSenders = {
  /**
   * True for our own addresses and anything on our sending domains (and, in shared-From mode, on the From address's
   * domain), unless the address is one of `threadRecipients`: the addresses our emails in the message's thread went to
   * (the email it answers). Then it's a reply, not a note.
   */
  isInternal(email: string, threadRecipients?: readonly string[]): boolean;
  /** True when a reply to a test email comes from where test replies come from (the test's `to`, a user, the test list). */
  isTestSender(email: string, testSendTo: string | null): boolean;
};

/** A bare address, lowercase: normalizeEmail when it parses, else the trimmed lowercase text. */
function norm(email: string | null | undefined): string {
  if (!email) return "";
  return normalizeEmail(email) ?? email.trim().toLowerCase();
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "";
}

/**
 * Loads the team's addresses, sender addresses, sending domains, the test list and the shared From address once (five
 * small reads through `reader`, which may be a transaction) and answers from memory.
 */
export async function internalSenders(reader: DbOrTx = db): Promise<InternalSenders> {
  const [users, senders, domains, testListRow, team] = await Promise.all([
    reader.user.findMany({ select: { email: true, replyInbox: true } }),
    reader.senderAddress.findMany({ select: { address: true } }),
    reader.sendingDomain.findMany({ select: { name: true } }),
    reader.setting.findUnique({ where: { key: "sending.testList" }, select: { value: true } }),
    loadTeamFrom(reader),
  ]);
  const userAddresses = new Set<string>();
  for (const u of users) {
    for (const a of [u.email, u.replyInbox]) {
      const n = norm(a);
      if (n) userAddresses.add(n);
    }
  }
  const senderAddresses = new Set(senders.map((s) => norm(s.address)).filter(Boolean));
  /** Our sending domains and, in shared-From mode, the From address's domain: every address on them is the team's. */
  const internalDomains = new Set(domains.map((d) => d.name.trim().toLowerCase()).filter(Boolean));
  // Shared-From mode (F16): the shared From address is the team's, and so is every mailbox on its (main) domain. The
  // evidence From (MAIN-DOMAIN-DESIGN O4, §1.5) is that address, or the own From in own-mailbox mode (contact@ on the
  // sending domain itself); null in per-person mode.
  const teamFrom = norm(team.evidenceFrom);
  if (teamFrom) {
    senderAddresses.add(teamFrom);
    const fromDomain = domainOf(teamFrom);
    if (fromDomain) internalDomains.add(fromDomain);
  }
  const testList = new Set<string>();
  const list: unknown = testListRow?.value;
  if (Array.isArray(list)) {
    for (const a of list) {
      const n = typeof a === "string" ? norm(a) : "";
      if (n) testList.add(n);
    }
  }

  return {
    isInternal(email: string, threadRecipients: readonly string[] = []): boolean {
      const n = norm(email);
      if (!n) return false;
      if (threadRecipients.some((to) => norm(to) === n)) return false;
      return userAddresses.has(n) || senderAddresses.has(n) || internalDomains.has(domainOf(n));
    },
    isTestSender(email: string, testSendTo: string | null): boolean {
      const n = norm(email);
      if (!n) return false;
      const to = norm(testSendTo);
      return (to !== "" && n === to) || userAddresses.has(n) || testList.has(n);
    },
  };
}
