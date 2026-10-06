import type { CampaignStatus } from "@/generated/prisma/client";
import { db, dbTx, type DbOrTx, type Tx } from "@/server/db";
import { logActivity } from "@/server/activity";
import { createNotification } from "@/server/notifications";
import { getSetting } from "@/server/settings";
import { plural } from "@/core/text";
import { DAY_MS, reservedText } from "@/core/rules/team-rule";

/**
 * Company reservations (PLAN.md A5.2, B6.1): while a campaign is working through a company, no
 * other campaign may email it ("Waiting in Sara's campaign 'Norway prints'").
 *
 *  - Taken at launch with a conditional insert (at most one active reservation per company).
 *    Only campaigns whose sends count as "emailed" take them (countsAsEmailed, M3-DESIGN §1.7):
 *    live campaigns after go-live, and dry runs in the practice copy. Drafts, test campaigns, dry
 *    runs on real data and live campaigns before go-live (they only reach the test list) never do;
 *    the callers (launch, the sending loop, resume, retry) decide.
 *  - Released when all of that company's recipients in the campaign are finished or stopped, or
 *    when the campaign finishes or is cancelled.
 *  - A campaign paused for longer than Setting "reservations.pausedExpiryDays" (default 14) loses
 *    them: pausing sets expiresAt, resuming clears it, and the worker's sweep releases expired
 *    rows and tells the person who launched the campaign and the Owner.
 *
 * Active = releasedAt is null, expiresAt is null or in the future, and the campaign is scheduled,
 * running or paused, or is a draft that took it less than LAUNCH_HOLD_MS ago (a launch in progress:
 * reservations are taken before the campaign's status flips; a launch that fails releases them, and
 * one cut short by a power cut stops counting after this window). There is no partial unique index
 * on SQLite, so every insert happens inside a transaction that first reads the company's
 * reservations: SQLite lets only one writer commit at a time and refuses a stale read-then-write
 * (SQLITE_BUSY, retried by dbTx), so two launches can never both reserve the same company.
 */

export const RESERVING_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ["SCHEDULED", "RUNNING", "PAUSED"];
/** How long a draft's reservations count while its launch is in progress. */
export const LAUNCH_HOLD_MS = 15 * 60_000;
const IN_CHUNK = 400;

/** Who holds a company. */
export type ReservationHolder = {
  reservationId: number;
  companyId: number;
  campaignId: number;
  campaignName: string;
  /** The campaign's sender, else the person who created it. */
  ownerName: string | null;
  /** "Waiting in Sara's campaign 'Norway prints'". */
  text: string;
};

type ReservationRow = {
  id: number;
  companyId: number;
  campaignId: number;
  reservedAt: Date;
  releasedAt: Date | null;
  expiresAt: Date | null;
  campaign: { name: string; status: CampaignStatus; sender: { name: string } | null; createdBy: { name: string } };
};

const reservationSelect = {
  id: true,
  companyId: true,
  campaignId: true,
  reservedAt: true,
  releasedAt: true,
  expiresAt: true,
  campaign: { select: { name: true, status: true, sender: { select: { name: true } }, createdBy: { select: { name: true } } } },
} as const;

export function isActiveReservation(
  r: { reservedAt?: Date; releasedAt: Date | null; expiresAt: Date | null; campaign?: { status: CampaignStatus } },
  now: Date,
): boolean {
  if (r.releasedAt) return false;
  if (r.expiresAt && r.expiresAt.getTime() <= now.getTime()) return false;
  if (r.campaign) {
    if (r.campaign.status === "DRAFT") {
      // A launch in progress (its status flips last).
      return Boolean(r.reservedAt) && now.getTime() - r.reservedAt!.getTime() < LAUNCH_HOLD_MS;
    }
    if (!RESERVING_CAMPAIGN_STATUSES.includes(r.campaign.status)) return false;
  }
  return true;
}

function toHolder(r: ReservationRow): ReservationHolder {
  const ownerName = r.campaign.sender?.name ?? r.campaign.createdBy.name ?? null;
  return {
    reservationId: r.id,
    companyId: r.companyId,
    campaignId: r.campaignId,
    campaignName: r.campaign.name,
    ownerName,
    text: reservedText(ownerName, r.campaign.name),
  };
}

async function loadOpenReservations(reader: DbOrTx, companyIds: readonly number[]): Promise<ReservationRow[]> {
  const ids = [...new Set(companyIds)];
  const out: ReservationRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    out.push(
      ...(await reader.companyReservation.findMany({
        where: { companyId: { in: ids.slice(i, i + IN_CHUNK) }, releasedAt: null },
        select: reservationSelect,
        orderBy: { id: "asc" },
      })),
    );
  }
  return out;
}

/**
 * Active reservations on these companies, by company id. `excludeCampaignId`'s own reservations are
 * left out (a campaign never blocks itself).
 */
export async function findActiveReservations(
  reader: DbOrTx,
  companyIds: readonly number[],
  now: Date = new Date(),
  excludeCampaignId: number | null = null,
): Promise<Map<number, ReservationHolder>> {
  const out = new Map<number, ReservationHolder>();
  for (const r of await loadOpenReservations(reader, companyIds)) {
    if (r.campaignId === excludeCampaignId || !isActiveReservation(r, now)) continue;
    if (!out.has(r.companyId)) out.set(r.companyId, toHolder(r));
  }
  return out;
}

export type TakeReservationsResult = {
  /** Companies this campaign now holds (newly or already). */
  taken: number[];
  /** Companies another campaign holds, with who holds them. */
  lost: ReservationHolder[];
};

/**
 * A paused campaign's reservation whose expiry has passed but that the worker's sweep hasn't let go
 * of yet. It no longer blocks anyone, but only expirePausedReservations() releases it: that's what
 * tells the launcher and the Owner, and logs it.
 */
function awaitingExpirySweep(r: ReservationRow, now: Date): boolean {
  return r.campaign.status === "PAUSED" && r.expiresAt !== null && r.expiresAt.getTime() <= now.getTime();
}

/**
 * Reserves companies for a campaign, inside the caller's transaction. Companies another active
 * campaign holds are returned in `lost`. Stale rows of other campaigns (a campaign that has ended,
 * or a draft whose launch hold lapsed) are released on the way; a paused campaign's expired rows
 * are left for expirePausedReservations(), which tells people. Safe to call again for companies
 * the campaign already holds. The campaign's own expiry is only cleared while it isn't paused.
 */
export async function takeReservations(
  tx: Tx,
  campaignId: number,
  companyIds: readonly number[],
  now: Date = new Date(),
): Promise<TakeReservationsResult> {
  const ids = [...new Set(companyIds)];
  if (ids.length === 0) return { taken: [], lost: [] };
  const rows = await loadOpenReservations(tx, ids);
  const mine = new Set<number>();
  const held = new Map<number, ReservationHolder>();
  const stale: number[] = [];
  const mineExpiring: ReservationRow[] = [];
  for (const r of rows) {
    if (r.campaignId === campaignId) {
      mine.add(r.companyId);
      if (r.expiresAt && r.campaign.status !== "PAUSED") mineExpiring.push(r);
      continue;
    }
    if (isActiveReservation(r, now)) {
      if (!held.has(r.companyId)) held.set(r.companyId, toHolder(r));
    } else if (!awaitingExpirySweep(r, now)) {
      stale.push(r.id);
    }
  }
  // Never revive our own expired row for a company someone else took meanwhile.
  const keepMine: number[] = [];
  for (const r of mineExpiring) {
    if (held.has(r.companyId) && !isActiveReservation(r, now)) stale.push(r.id);
    else keepMine.push(r.id);
  }
  if (stale.length > 0) {
    await tx.companyReservation.updateMany({ where: { id: { in: stale }, releasedAt: null }, data: { releasedAt: now } });
  }
  if (keepMine.length > 0) {
    await tx.companyReservation.updateMany({ where: { id: { in: keepMine } }, data: { expiresAt: null } });
  }
  const taken: number[] = [];
  const lost: ReservationHolder[] = [];
  const toCreate: number[] = [];
  for (const companyId of ids) {
    const holder = held.get(companyId);
    if (holder) lost.push(holder);
    else {
      taken.push(companyId);
      if (!mine.has(companyId)) toCreate.push(companyId);
    }
  }
  if (toCreate.length > 0) {
    await tx.companyReservation.createMany({ data: toCreate.map((companyId) => ({ companyId, campaignId, reservedAt: now })) });
  }
  return { taken, lost };
}

/**
 * Send time (B6.1): a campaign that takes reservations must hold the company's. Takes it again when
 * it's free (e.g. it expired while the campaign was paused); returns the holder when another
 * campaign has it.
 */
export async function ensureReservation(
  campaignId: number,
  companyId: number,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; holder: ReservationHolder }> {
  const res = await dbTx((tx) => takeReservations(tx, campaignId, [companyId], now));
  const holder = res.lost[0];
  return holder ? { ok: false, holder } : { ok: true };
}

/**
 * Releases the campaign's reservation on a company once every included recipient there is
 * finished or stopped. Returns true when a reservation was released.
 */
export async function releaseCompanyIfDone(tx: Tx, campaignId: number, companyId: number, now: Date = new Date()): Promise<boolean> {
  const open = await tx.campaignRecipient.count({
    where: { campaignId, companyId, included: true, state: { notIn: ["FINISHED", "STOPPED", "EXCLUDED"] } },
  });
  if (open > 0) return false;
  const res = await tx.companyReservation.updateMany({
    where: { campaignId, companyId, releasedAt: null },
    data: { releasedAt: now },
  });
  return res.count > 0;
}

/** Releases every reservation a campaign holds (it finished or was cancelled). Returns how many. */
export async function releaseCampaignReservations(tx: Tx, campaignId: number, now: Date = new Date()): Promise<number> {
  const res = await tx.companyReservation.updateMany({ where: { campaignId, releasedAt: null }, data: { releasedAt: now } });
  return res.count;
}

/** A launch that failed half-way gives back what it reserved (only while the campaign is still a draft). */
export async function releaseDraftReservations(campaignId: number, now: Date = new Date()): Promise<number> {
  return dbTx(async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (!c || c.status !== "DRAFT") return 0;
    return releaseCampaignReservations(tx, campaignId, now);
  });
}

/** Pausing sets the expiry (now + Setting "reservations.pausedExpiryDays"); resuming uses clearReservationExpiry. */
export async function setReservationExpiry(tx: Tx, campaignId: number, expiresAt: Date | null): Promise<number> {
  const res = await tx.companyReservation.updateMany({ where: { campaignId, releasedAt: null }, data: { expiresAt } });
  return res.count;
}

/**
 * Resuming: the campaign's reservations stop expiring. One that already expired (the sweep hadn't
 * let go of it yet) is released instead when another campaign has taken that company meanwhile,
 * so a company is never held by two campaigns. Returns how many were released.
 */
export async function clearReservationExpiry(tx: Tx, campaignId: number, now: Date = new Date()): Promise<number> {
  const expired = await tx.companyReservation.findMany({
    where: { campaignId, releasedAt: null, expiresAt: { lte: now } },
    select: { id: true, companyId: true },
  });
  let released = 0;
  if (expired.length > 0) {
    const takenByOthers = await findActiveReservations(tx, expired.map((r) => r.companyId), now, campaignId);
    const lostIds = expired.filter((r) => takenByOthers.has(r.companyId)).map((r) => r.id);
    for (let i = 0; i < lostIds.length; i += IN_CHUNK) {
      const res = await tx.companyReservation.updateMany({
        where: { id: { in: lostIds.slice(i, i + IN_CHUNK) }, releasedAt: null },
        data: { releasedAt: now },
      });
      released += res.count;
    }
  }
  await setReservationExpiry(tx, campaignId, null);
  return released;
}

/** When a campaign paused now should lose its reservations, or null when they never expire. */
export async function pausedExpiryFrom(now: Date): Promise<Date | null> {
  const days = Number(await getSetting("reservations.pausedExpiryDays"));
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() + days * DAY_MS);
}

/** Who launched a campaign (from its "campaign.launched" activity), else who created it. */
export async function campaignLauncherId(campaignId: number): Promise<number | null> {
  const launched = await db.activityLog.findFirst({
    where: { campaignId, type: "campaign.launched", actorId: { not: null } },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    select: { actorId: true },
  });
  if (launched?.actorId) return launched.actorId;
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { createdById: true } });
  return c?.createdById ?? null;
}

export type ExpiryResult = { released: number; campaigns: number[] };

/**
 * The worker's sweep: releases reservations whose expiry has passed (their campaign has been paused
 * too long) and tells the person who launched each campaign and the Owner, once per sweep.
 */
export async function expirePausedReservations(now: Date = new Date()): Promise<ExpiryResult> {
  const due = await db.companyReservation.findMany({
    where: { releasedAt: null, expiresAt: { lte: now } },
    select: { campaignId: true },
    distinct: ["campaignId"],
    take: 100,
  });
  const result: ExpiryResult = { released: 0, campaigns: [] };
  if (due.length === 0) return result;
  const days = Number(await getSetting("reservations.pausedExpiryDays"));
  const owner = await db.user.findFirst({ where: { role: "OWNER", active: true }, select: { id: true }, orderBy: { id: "asc" } });
  for (const { campaignId } of due) {
    const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { id: true, name: true } });
    if (!campaign) continue;
    const launcherId = await campaignLauncherId(campaignId);
    const released = await dbTx(async (tx) => {
      const res = await tx.companyReservation.updateMany({
        where: { campaignId, releasedAt: null, expiresAt: { lte: now } },
        data: { releasedAt: now },
      });
      if (res.count === 0) return 0;
      const companies = plural(res.count, "company", "companies");
      const pausedFor = Number.isFinite(days) && days > 0 ? `more than ${plural(days, "day", "days")}` : "a long time";
      await logActivity(
        {
          actorId: null,
          type: "campaign.reservationsExpired",
          summary: `${campaign.name} was paused for ${pausedFor}, so its ${companies} are free for other campaigns again`,
          campaignId,
          data: { released: res.count },
        },
        tx,
      );
      const recipients = new Set<number>();
      if (launcherId) recipients.add(launcherId);
      if (owner) recipients.add(owner.id);
      for (const userId of recipients) {
        await createNotification(
          {
            userId,
            type: "campaign.reservationsExpired",
            title: `${campaign.name} no longer holds its companies`,
            body:
              `It has been paused for ${pausedFor}, so its ${companies} are free for other campaigns again. ` +
              "When you resume it, each company is checked again before its next email.",
            link: `/campaigns/${campaignId}`,
          },
          tx,
        );
      }
      return res.count;
    });
    if (released > 0) {
      result.released += released;
      result.campaigns.push(campaignId);
    }
  }
  return result;
}
