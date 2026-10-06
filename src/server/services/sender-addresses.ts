import { Prisma } from "@/generated/prisma/client";
import { validateLocalPart } from "@/core/sender-address";
import { senderAddressWords } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS, type RepliesMode } from "@/core/sending/own-mailbox";
import { logActivity } from "../activity";
import { db, dbTx, type DbOrTx } from "../db";
import { enqueueJob } from "../jobs";
import { notifyOwner } from "../notifications";
import { loadTeamFrom, type TeamFromState } from "./mailgun/team-from";

/**
 * Each teammate's sending address (PLAN B6.10, B10, M3-DESIGN §4.5.7): `<local part>@<sending domain>`, one current
 * address per user on the active domain. Changing it retires the old one (its reply route stays, so late replies still
 * arrive), creates or reactivates the new one and asks for a route sync. It can't change while that person's test or
 * live campaigns are scheduled, running or paused, and a name used by anyone else (even a retired address) stays theirs.
 *
 * Shared-From mode (SHARED-FROM-DESIGN §3.6, F19): while a shared From address is saved and fits the sending domain
 * (`loadTeamFrom().address`), the same address is the Reply-To of that person's emails, so every sentence here calls it
 * "reply address" (`senderAddressWords(true)`); in per-person mode the words stay exactly as before ("sending
 * address"). The text functions take `teamFrom` (absent = per-person mode).
 *
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN O5, §2.4, `loadTeamFrom().replies`): every email comes from the own From with each
 * person's display name, so nobody has an address of their own. `setSenderLocalPart` refuses
 * (`OWN_MAILBOX_TEXTS.noSendingAddress`) and creates nothing, so no route sync is ever queued from here in that mode;
 * `getSenderAddressInfo` carries the mode and the own From for My profile.
 */

/** A plain problem with the sending address; `field` is set when it belongs next to the input. */
export class SenderAddressError extends Error {
  constructor(
    message: string,
    readonly field: "senderLocalPart" | null = "senderLocalPart",
  ) {
    super(message);
    this.name = "SenderAddressError";
  }
}

export type SenderAddressInfo = {
  address: string | null;
  localPart: string | null;
  /** The active sending domain, or null before the Owner connects Mailgun. */
  domain: string | null;
  routeStatus: string | null;
  routeCheckedAt: Date | null;
  routeError: string | null;
  /** Names of this user's test or live campaigns that are scheduled, running or paused (the address can't change). */
  blockedBy: string[];
  /**
   * The shared From address while one is saved and fits the sending domain (`loadTeamFrom().address`): the address above
   * is then the Reply-To and is called "Reply address" (SHARED-FROM-DESIGN §3.6). Null = per-person mode.
   */
  teamFrom: string | null;
  /** MAIN-DOMAIN-DESIGN O1: how the app sends (`loadTeamFrom().replies`); "own-mailbox" = nobody has an address of their own. */
  replies: RepliesMode;
  /** MAIN-DOMAIN-DESIGN O3, §3.7: own-mailbox mode, the own From when one fits (`loadTeamFrom().ownFrom`); else null. */
  ownFrom: string | null;
};

/**
 * Own-mailbox mode's refusal (MAIN-DOMAIN-DESIGN §2.4): "Nobody needs an address of their own: every email comes from
 * contact@… with each person's display name." Without a fitting own From the saved one is named, else the setting's place.
 */
export function noSendingAddressText(team: Pick<TeamFromState, "ownFrom" | "saved">): string {
  return OWN_MAILBOX_TEXTS.noSendingAddress(team.ownFrom ?? team.saved ?? "the From address in Settings › Sending & Mailgun");
}

export const SENDER_ADDRESS_TEXTS = {
  /** The same sentence in both modes (SHARED-FROM-DESIGN §3.6: no From address can be saved before a domain exists). */
  noDomain: "Your sending address is set up once the Owner connects the sending domain in Settings › Sending & Mailgun.",
  /** Per-person mode; `senderAddressNotYoursText(teamFrom)` gives the sentence for either mode. */
  notYours: "Only the Owner can change someone else's sending address.",
  gone: "That teammate doesn't exist any more. Refresh the page and try again.",
} as const;

/** "Only the Owner can change someone else's sending address." / "…reply address." in shared-From mode. */
export function senderAddressNotYoursText(teamFrom = false): string {
  return `Only the Owner can change someone else's ${senderAddressWords(teamFrom).lower}.`;
}

/** "You can't change your sending address while your campaigns are running or paused (<names>). …" ("reply address" in shared-From mode). */
export function senderAddressBlockedText(names: string[], teamFrom = false): string {
  return `You can't change your ${senderAddressWords(teamFrom).lower} while your campaigns are running or paused (${names.join(", ")}). Wait until they finish, or ask the Owner to cancel them.`;
}

/** My profile's toast after the address changed: "Profile saved. Your sending address is now <address>; …". */
export function profileSavedWithAddressText(address: string, teamFrom = false): string {
  return `Profile saved. Your ${senderAddressWords(teamFrom).lower} is now ${address}; its reply route is being set up.`;
}

/** My profile, the rest saved but the address refused: "Your profile is saved, but your sending address didn't change: <why>". */
export function profileSavedAddressUnchangedText(why: string, teamFrom = false): string {
  return `Your profile is saved, but your ${senderAddressWords(teamFrom).lower} didn't change: ${why}`;
}

/** Settings › Limits & warm-up, the per-sender list's empty state (M6-DESIGN R8, SHARED-FROM-DESIGN §3.6). */
export function noSenderAddressesText(teamFrom = false): string {
  return `Nobody has a ${senderAddressWords(teamFrom).lower} yet. Each person adds one in Settings › My profile.`;
}

/** The activity summary of a new address: yours ("Ali set their sending address to …") or someone else's (the Owner). */
export function senderAddressActivityText(
  i: { actorName: string; userName: string; self: boolean; address: string },
  teamFrom = false,
): string {
  const words = senderAddressWords(teamFrom).lower;
  return i.self ? `${i.userName} set their ${words} to ${i.address}` : `${i.actorName} set ${i.userName}'s ${words} to ${i.address}`;
}

/** The Owner's notice when a Member changed their own address (§3.6). */
export function senderAddressNoticeText(name: string, address: string, teamFrom = false): { title: string; body: string } {
  return teamFrom
    ? { title: `${name} changed their reply address`, body: `From now on, replies to ${name}'s campaigns go to ${address}.` }
    : { title: `${name} changed their sending address`, body: `From now on ${name}'s campaigns come from ${address}.` };
}

/** "Someone else already uses <addr>. Pick another name." */
export function senderAddressTakenText(address: string): string {
  return `Someone else already uses ${address}. Pick another name.`;
}

/**
 * The active sending domain: Setting "mailgun.domain" when it has an active row, else any active row. Reads only
 * through `reader`, so it is safe inside a transaction.
 */
export async function activeSendingDomain(reader: DbOrTx = db): Promise<{ id: number; name: string } | null> {
  const setting = await reader.setting.findUnique({ where: { key: "mailgun.domain" }, select: { value: true } });
  const name = (typeof setting?.value === "string" ? setting.value : "").trim().toLowerCase();
  if (name) {
    const row = await reader.sendingDomain.findUnique({ where: { name }, select: { id: true, name: true, active: true } });
    if (row?.active) return { id: row.id, name: row.name };
  }
  return reader.sendingDomain.findFirst({ where: { active: true }, orderBy: { id: "desc" }, select: { id: true, name: true } });
}

/** Test/live campaigns of this sender that are scheduled, running or paused. */
async function blockingCampaigns(reader: DbOrTx, userId: number): Promise<string[]> {
  const rows = await reader.campaign.findMany({
    where: { senderId: userId, mode: { in: ["TEST", "LIVE"] }, status: { in: ["SCHEDULED", "RUNNING", "PAUSED"] } },
    select: { name: true },
    orderBy: { id: "asc" },
    take: 10,
  });
  return rows.map((r) => r.name);
}

/**
 * The user's current sending address on the active domain, its reply route, what blocks a change and, in shared-From
 * mode, the shared From address (the words on screen follow it). Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.7): `replies`
 * and `ownFrom` tell My profile to show the From line instead of the field.
 */
export async function getSenderAddressInfo(userId: number): Promise<SenderAddressInfo> {
  const [domain, blockedBy, team] = await Promise.all([activeSendingDomain(), blockingCampaigns(db, userId), loadTeamFrom()]);
  const teamFrom = team.address;
  const mode = { replies: team.replies, ownFrom: team.ownFrom };
  if (!domain) {
    return { address: null, localPart: null, domain: null, routeStatus: null, routeCheckedAt: null, routeError: null, blockedBy, teamFrom, ...mode };
  }
  const row = await db.senderAddress.findFirst({
    where: { userId, domainId: domain.id, retiredAt: null },
    orderBy: { id: "desc" },
    select: { address: true, localPart: true, routeStatus: true, routeCheckedAt: true, routeError: true },
  });
  return {
    address: row?.address ?? null,
    localPart: row?.localPart ?? null,
    domain: domain.name,
    routeStatus: row?.routeStatus ?? null,
    routeCheckedAt: row?.routeCheckedAt ?? null,
    routeError: row?.routeError ?? null,
    blockedBy,
    teamFrom,
    ...mode,
  };
}

/**
 * Sets `<input>@<active domain>` as the user's sending address. Checks, in order: the name itself
 * (validateLocalPart), who may change it (the user, or the Owner), an active sending domain, no test/live campaign of
 * this sender scheduled/running/paused, and nobody else using the address (retired addresses included). Then, in one
 * transaction: retire the current address, create the new one (or reactivate this user's own retired one), log
 * `user.senderAddress` and, when a Member changed their own, tell the Owner. Afterwards a route sync is queued.
 * Throws SenderAddressError with the plain sentence. In shared-From mode every sentence says "reply address" (§3.6).
 * Own-mailbox mode (MAIN-DOMAIN-DESIGN §2.4): refused before anything else (`noSendingAddressText`, not tied to the
 * field), and again inside the transaction: nothing is created and no route sync is queued.
 */
export async function setSenderLocalPart(
  actor: { id: number; name: string; role: "OWNER" | "MEMBER" },
  userId: number,
  input: string,
): Promise<{ changed: boolean; address: string }> {
  const before = await loadTeamFrom();
  if (before.replies === "own-mailbox") throw new SenderAddressError(noSendingAddressText(before), null);
  const v = validateLocalPart(input);
  if (!v.ok) throw new SenderAddressError(v.error);
  if (actor.id !== userId && actor.role !== "OWNER") {
    throw new SenderAddressError(senderAddressNotYoursText(before.address !== null), null);
  }
  const localPart = v.localPart;

  let result: { changed: boolean; address: string };
  try {
    result = await dbTx(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true } });
      if (!user) throw new SenderAddressError(SENDER_ADDRESS_TEXTS.gone, null);
      // Read in the same transaction as the change: the mode may have switched meanwhile (own-mailbox refuses), and the
      // words match the From address at that moment.
      const team = await loadTeamFrom(tx);
      if (team.replies === "own-mailbox") throw new SenderAddressError(noSendingAddressText(team), null);
      const domain = await activeSendingDomain(tx);
      if (!domain) throw new SenderAddressError(SENDER_ADDRESS_TEXTS.noDomain);
      const address = `${localPart}@${domain.name}`;
      const currentRows = await tx.senderAddress.findMany({
        where: { userId, domainId: domain.id, retiredAt: null },
        select: { id: true, address: true },
      });
      if (currentRows.length === 1 && currentRows[0]!.address === address) return { changed: false, address };

      const teamFrom = team.address !== null;
      const blocked = await blockingCampaigns(tx, userId);
      if (blocked.length > 0) throw new SenderAddressError(senderAddressBlockedText(blocked, teamFrom));
      const taken = await tx.senderAddress.findUnique({ where: { address }, select: { id: true, userId: true } });
      if (taken && taken.userId !== userId) throw new SenderAddressError(senderAddressTakenText(address));

      const now = new Date();
      await tx.senderAddress.updateMany({
        where: { userId, domainId: domain.id, retiredAt: null, address: { not: address } },
        data: { retiredAt: now },
      });
      if (taken) {
        const own = await tx.senderAddress.findUniqueOrThrow({ where: { id: taken.id }, select: { routeStatus: true } });
        await tx.senderAddress.update({ where: { id: taken.id }, data: { retiredAt: null, routeStatus: own.routeStatus ?? "pending" } });
      } else {
        await tx.senderAddress.create({ data: { userId, domainId: domain.id, localPart, address, routeStatus: "pending" } });
      }

      const self = actor.id === userId;
      await logActivity(
        {
          actorId: actor.id,
          type: "user.senderAddress",
          summary: senderAddressActivityText({ actorName: actor.name, userName: user.name, self, address }, teamFrom),
          data: { userId, address, previous: currentRows.map((r) => r.address) },
        },
        tx,
      );
      if (self && user.role !== "OWNER") {
        await notifyOwner({ type: "user.senderAddress", ...senderAddressNoticeText(user.name, address, teamFrom), link: "/settings/team" }, tx);
      }
      return { changed: true, address };
    });
  } catch (err) {
    // Another request took the same address between the check and the insert.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new SenderAddressError("Someone else just took that address. Pick another name.");
    }
    throw err;
  }

  if (result.changed) {
    await enqueueJob({ type: "mailgun.syncRoutes", payload: {}, dedupeKey: "mailgun:routes", priority: 30, createdById: actor.id });
  }
  return result;
}
