import { z } from "zod";
import { Prisma, type AccessLinkPurpose, type Role } from "@/generated/prisma/client";
import { db, dbTx, dbWrite, type DbOrTx, type Tx } from "@/server/db";
import { logActivity } from "@/server/activity";
import { enqueueJob } from "@/server/jobs";
import { createNotification, notifyOwner, waitingReplyWhere } from "@/server/notifications";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { pausedExpiryFrom, setReservationExpiry } from "@/server/services/reservations";
import { parseEmail } from "@/core/email-address";
import { isValidTimeZone } from "@/core/geo/countries";
import { sendingDomainOf } from "@/core/mailgun/routes";
import {
  OWNER_ONLY_POPUP_GROUPS,
  POPUP_GROUPS,
  readNotifyPrefs,
  type NotifyPrefs,
  type PopupGroup,
} from "@/core/notification-types";
import { firstNameFrom, plural } from "@/core/text";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { randomToken, sha256 } from "@/lib/auth/tokens";

/**
 * Team and account rules (SPEC §1, PLAN.md A5 15–17, B10).
 * Pure database functions that take the acting user's id, so they work without a request
 * (Server Actions wrap them; integration tests call them directly).
 *
 *  - There is always exactly one active Owner. Ownership moves with transferOwnership().
 *  - The app sends no email of its own: invites and resets are links the Owner passes on.
 *  - Links are single use, revocable, and stored only as a SHA-256 hash.
 */

/** A plain-language problem the person can fix. Actions turn it into UserError. */
export class TeamError extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: Record<string, string[] | undefined>,
    readonly code?: "link-invalid" | "wrong-password",
  ) {
    super(message);
    this.name = "TeamError";
  }
}

export const INVITE_LINK_HOURS = 72;
export const RESET_LINK_HOURS = 24;
export const LINK_INVALID_MESSAGE = "This link has expired or was already used. Ask the Owner for a new one.";
export const FIELDS_NEED_FIXING = "Some details need fixing. Check the highlighted fields.";

const HOUR_MS = 3_600_000;

export function linkLifetimeHours(purpose: AccessLinkPurpose): number {
  return purpose === "INVITE" ? INVITE_LINK_HOURS : RESET_LINK_HOURS;
}

/** "Ali from Polygon Paradise" — the default sender display name. */
export function suggestedSenderName(name: string): string {
  const first = firstNameFrom(name) || name.trim();
  return `${first} from Polygon Paradise`;
}

// ───────────────────────────── team list ─────────────────────────────

export type MemberStatus = "ACTIVE" | "INVITED" | "OFF";

export function memberStatus(u: { active: boolean; passwordHash: string | null }): MemberStatus {
  if (!u.active) return "OFF";
  return u.passwordHash ? "ACTIVE" : "INVITED";
}

/** A campaign that still sends as someone (M4-DESIGN §9.8): scheduled, running or paused. */
export type ActiveCampaignRef = { id: number; name: string; status: ActiveCampaignStatus };
export type ActiveCampaignStatus = "SCHEDULED" | "RUNNING" | "PAUSED";

/** Campaign statuses that still send, or may again after a resume (listed in the switch-off dialog). */
const ACTIVE_CAMPAIGN_STATUSES: readonly ActiveCampaignStatus[] = ["SCHEDULED", "RUNNING", "PAUSED"];
/** The ones switching someone off pauses when the Owner chooses "Pause them" (a paused one stays paused). */
const PAUSABLE_STATUSES: readonly ActiveCampaignStatus[] = ["SCHEDULED", "RUNNING"];

export type TeamMember = {
  id: number;
  name: string;
  email: string;
  role: Role;
  status: MemberStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  /** The newest link that can still be used, if any. */
  pendingLink: { purpose: AccessLinkPurpose; expiresAt: Date } | null;
  /** Their scheduled, running and paused campaigns (they are the sender), oldest first: the switch-off dialog asks about them. */
  activeCampaigns: ActiveCampaignRef[];
  /**
   * Replies waiting for their answer (M4-DESIGN §4.1–§4.2: assigned to them, not answered yet, dry-run ones included),
   * which move to the Owner when they are switched off.
   */
  waitingReplies: number;
};

const STATUS_ORDER: Record<MemberStatus, number> = { ACTIVE: 0, INVITED: 1, OFF: 2 };

/**
 * Waiting replies assigned to a user (M4-DESIGN §4.2): the Team page's count and the rows deactivateUser moves to the
 * Owner. The shared rule (`waitingReplyWhere`, M6-DESIGN D9) with dry-run replies included, so the switch-off dialog's
 * "3 replies … move to you" counts exactly the rows that move.
 */
function waitingRepliesWhere(assignee: number | { in: number[] }): Prisma.InboundMessageWhereInput {
  return waitingReplyWhere({ assigneeId: assignee }, { dryRun: "include" });
}

export async function listTeam(now = new Date()): Promise<TeamMember[]> {
  const users = await db.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      passwordHash: true,
      lastLoginAt: true,
      createdAt: true,
      accessLinks: {
        where: { usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { purpose: true, expiresAt: true },
      },
    },
  });
  const ids = users.map((u) => u.id);
  const [campaigns, waiting] = ids.length
    ? await Promise.all([
        db.campaign.findMany({
          where: { senderId: { in: ids }, status: { in: [...ACTIVE_CAMPAIGN_STATUSES] } },
          orderBy: { id: "asc" },
          select: { id: true, name: true, status: true, senderId: true },
        }),
        db.inboundMessage.groupBy({ by: ["assigneeId"], where: waitingRepliesWhere({ in: ids }), _count: { _all: true } }),
      ])
    : [[], []];
  const campaignsBySender = new Map<number, ActiveCampaignRef[]>();
  for (const c of campaigns) {
    if (c.senderId === null) continue;
    const list = campaignsBySender.get(c.senderId) ?? [];
    list.push({ id: c.id, name: c.name, status: c.status as ActiveCampaignStatus });
    campaignsBySender.set(c.senderId, list);
  }
  const waitingByUser = new Map(waiting.map((w) => [w.assigneeId, w._count._all]));
  return users
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      status: memberStatus(u),
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      pendingLink: u.accessLinks[0] ?? null,
      activeCampaigns: campaignsBySender.get(u.id) ?? [],
      waitingReplies: waitingByUser.get(u.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        Number(b.role === "OWNER") - Number(a.role === "OWNER") ||
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.name.localeCompare(b.name),
    );
}

// ───────────────────────────── helpers ─────────────────────────────

type ActingOwner = { id: number; name: string };

/** Re-checks inside the transaction that the actor is still the active Owner. */
async function loadActingOwner(tx: Tx, actorId: number): Promise<ActingOwner> {
  const actor = await tx.user.findUnique({
    where: { id: actorId },
    select: { id: true, name: true, role: true, active: true },
  });
  if (!actor || !actor.active || actor.role !== "OWNER") {
    throw new TeamError("Only the Owner can do this.");
  }
  return { id: actor.id, name: actor.name };
}

async function loadTarget(tx: Tx, targetId: number) {
  const target = await tx.user.findUnique({
    where: { id: targetId },
    select: { id: true, name: true, email: true, role: true, active: true, passwordHash: true },
  });
  if (!target) throw new TeamError("That teammate doesn't exist any more. Refresh the page and try again.");
  return target;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Reply routes forward to each sender's reply inbox, or to the Owner's for someone switched off (PLAN B6.10), so a
 * change of inbox or of who is active needs a route sync (job "mailgun.syncRoutes", M3-DESIGN §4.5.7). Only queued while
 * a sending domain is connected and the change can matter: the person has a sending address, or is the Owner (whose
 * inbox also gets the catch-all). Never fails the change itself. Own-mailbox mode (MAIN-DOMAIN-DESIGN O8,
 * `loadTeamFrom().replies`): no route exists or is ever made, so nothing is queued.
 */
async function queueRouteSync(userId: number, actorId: number | null, isOwner: boolean): Promise<void> {
  try {
    if ((await loadTeamFrom()).replies === "own-mailbox") return;
    if ((await db.sendingDomain.count({ where: { active: true } })) === 0) return;
    if (!isOwner && (await db.senderAddress.count({ where: { userId } })) === 0) return;
    await enqueueJob({ type: "mailgun.syncRoutes", payload: {}, dedupeKey: "mailgun:routes", priority: 30, createdById: actorId });
  } catch (err) {
    console.error("[users] couldn't queue the reply route sync", err);
  }
}

async function revokeOpenLinks(tx: Tx, userId: number, now: Date): Promise<number> {
  const res = await tx.accessLink.updateMany({
    where: { userId, usedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  return res.count;
}

const nameSchema = z
  .string()
  .trim()
  .min(1, { error: "Enter a name." })
  .max(100, { error: "Use 100 characters or fewer." });

// ───────────────────────────── invites and links ─────────────────────────────

export type IssuedLink = {
  user: { id: number; name: string; email: string };
  purpose: AccessLinkPurpose;
  /** The raw token: shown once, never stored. */
  token: string;
  expiresAt: Date;
};

/** Creates a Member with no password yet, plus a 72-hour invite link. */
export async function inviteUser(
  actorId: number,
  input: { name: string; email: string },
  now = new Date(),
): Promise<IssuedLink> {
  const fieldErrors: Record<string, string[]> = {};
  const nameRes = nameSchema.safeParse(input.name ?? "");
  if (!nameRes.success) fieldErrors.name = [nameRes.error.issues[0]?.message ?? "Enter a name."];
  const parsed = parseEmail(input.email ?? "");
  if (!parsed) fieldErrors.email = ["Enter a valid email address, for example ali@example.com."];
  if (!nameRes.success || !parsed) throw new TeamError(FIELDS_NEED_FIXING, fieldErrors);

  const name = nameRes.data;
  const email = parsed.norm;
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + INVITE_LINK_HOURS * HOUR_MS);

  try {
    const user = await dbTx(async (tx) => {
      const actor = await loadActingOwner(tx, actorId);
      const existing = await tx.user.findUnique({ where: { email }, select: { name: true, active: true } });
      if (existing) {
        const msg = existing.active
          ? `${existing.name} already uses ${email}. Each person needs their own email address.`
          : `${email} belongs to ${existing.name}, who is switched off. Switch them back on in the list instead.`;
        throw new TeamError(msg, { email: [msg] });
      }
      const created = await tx.user.create({
        data: {
          email,
          name,
          role: "MEMBER",
          passwordHash: null,
          senderDisplayName: suggestedSenderName(name),
          replyInbox: email,
        },
        select: { id: true, name: true, email: true },
      });
      await tx.accessLink.create({
        data: { userId: created.id, purpose: "INVITE", tokenHash: sha256(token), expiresAt, createdById: actor.id },
      });
      await logActivity(
        {
          actorId: actor.id,
          type: "user.invited",
          summary: `${actor.name} invited ${created.name} (${created.email})`,
          data: { userId: created.id },
        },
        tx,
      );
      return created;
    });
    return { user, purpose: "INVITE", token, expiresAt };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const msg = `Someone on the team already uses ${email}. Each person needs their own email address.`;
      throw new TeamError(msg, { email: [msg] });
    }
    throw err;
  }
}

/**
 * A fresh invite link (for someone who hasn't chosen a password yet) or a 24-hour
 * password reset link. Any older unused links for that person stop working.
 */
export async function issueAccessLink(
  actorId: number,
  targetId: number,
  purpose: AccessLinkPurpose,
  now = new Date(),
): Promise<IssuedLink> {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + linkLifetimeHours(purpose) * HOUR_MS);
  const user = await dbTx(async (tx) => {
    const actor = await loadActingOwner(tx, actorId);
    const target = await loadTarget(tx, targetId);
    if (!target.active) {
      throw new TeamError(`${target.name} is switched off. Switch them back on first.`);
    }
    if (purpose === "INVITE" && target.passwordHash) {
      throw new TeamError(`${target.name} has already chosen a password. Use "Reset password link" instead.`);
    }
    if (purpose === "RESET" && !target.passwordHash) {
      throw new TeamError(`${target.name} hasn't accepted their invite yet. Use "New invite link" instead.`);
    }
    await revokeOpenLinks(tx, target.id, now);
    await tx.accessLink.create({
      data: { userId: target.id, purpose, tokenHash: sha256(token), expiresAt, createdById: actor.id },
    });
    await logActivity(
      {
        actorId: actor.id,
        type: purpose === "INVITE" ? "user.invited" : "user.passwordReset",
        summary:
          purpose === "INVITE"
            ? `${actor.name} made a new invite link for ${target.name}`
            : `${actor.name} made a password reset link for ${target.name}`,
        data: { userId: target.id },
      },
      tx,
    );
    return { id: target.id, name: target.name, email: target.email };
  });
  return { user, purpose, token, expiresAt };
}

export type UsableLink = {
  linkId: number;
  purpose: AccessLinkPurpose;
  expiresAt: Date;
  user: { id: number; name: string; email: string; role: Role };
};

/** Finds a link that can still be used: right purpose, not used, not revoked, not expired, person active. */
export async function findUsableAccessLink(
  token: string,
  purpose: AccessLinkPurpose,
  now = new Date(),
  reader: DbOrTx = db,
): Promise<UsableLink | null> {
  if (typeof token !== "string" || token.length < 16 || token.length > 200) return null;
  const link = await reader.accessLink.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, name: true, email: true, role: true, active: true } } },
  });
  if (!link) return null;
  if (link.purpose !== purpose || link.usedAt || link.revokedAt) return null;
  if (link.expiresAt.getTime() <= now.getTime()) return null;
  if (!link.user.active) return null;
  const { active: _active, ...user } = link.user;
  return { linkId: link.id, purpose: link.purpose, expiresAt: link.expiresAt, user };
}

/**
 * Invite accepted / password reset: sets the password, uses up the link (and any other open
 * links for that person), signs them out everywhere and clears their failed sign-ins.
 * The caller then creates the new session.
 */
export async function acceptAccessLink(
  input: { token: string; purpose: AccessLinkPurpose; password: string; confirm: string },
  now = new Date(),
): Promise<UsableLink["user"]> {
  const pre = await findUsableAccessLink(input.token, input.purpose, now);
  if (!pre) throw new TeamError(LINK_INVALID_MESSAGE, undefined, "link-invalid");

  const fieldErrors: Record<string, string[]> = {};
  const problem = passwordProblem(input.password ?? "");
  if (problem) fieldErrors.password = [problem];
  if ((input.password ?? "") !== (input.confirm ?? "")) fieldErrors.confirm = ["The two passwords don't match."];
  if (Object.keys(fieldErrors).length > 0) throw new TeamError(FIELDS_NEED_FIXING, fieldErrors);

  // Hash outside the transaction (it takes ~50 ms on purpose).
  const passwordHash = await hashPassword(input.password);

  return dbTx(async (tx) => {
    const link = await findUsableAccessLink(input.token, input.purpose, now, tx);
    if (!link) throw new TeamError(LINK_INVALID_MESSAGE, undefined, "link-invalid");
    // Compare-and-set: only one request can use a link.
    const claimed = await tx.accessLink.updateMany({
      where: { id: link.linkId, usedAt: null, revokedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw new TeamError(LINK_INVALID_MESSAGE, undefined, "link-invalid");
    await revokeOpenLinks(tx, link.user.id, now);
    await tx.user.update({ where: { id: link.user.id }, data: { passwordHash, lastLoginAt: now } });
    await tx.session.deleteMany({ where: { userId: link.user.id } });
    await tx.loginAttempt.deleteMany({ where: { emailNorm: link.user.email, success: false } });

    const name = link.user.name;
    if (input.purpose === "INVITE") {
      await logActivity(
        { actorId: link.user.id, type: "user.joined", summary: `${name} accepted the invite and joined the team` },
        tx,
      );
      if (link.user.role !== "OWNER") {
        await notifyOwner(
          { type: "user.joined", title: `${name} joined the team`, body: `${name} chose a password and signed in.`, link: "/settings/team" },
          tx,
        );
      }
    } else {
      await logActivity(
        { actorId: link.user.id, type: "user.passwordReset", summary: `${name} chose a new password with a reset link` },
        tx,
      );
      if (link.user.role !== "OWNER") {
        await notifyOwner(
          {
            type: "user.passwordReset",
            title: `${name} chose a new password`,
            body: "They used the reset link you made and were signed out on their other devices.",
            link: "/settings/team",
          },
          tx,
        );
      }
    }
    return link.user;
  });
}

// ───────────────────────────── switch off / on, ownership ─────────────────────────────

/** What happens to a switched-off teammate's campaigns (M4-DESIGN §9.8): pause them (default), or let them finish. */
export type SwitchOffCampaigns = "pause" | "finish";

export type DeactivateResult = {
  id: number;
  name: string;
  /** Their scheduled, running and paused campaigns at the moment they were switched off. */
  campaigns: ActiveCampaignRef[];
  /** How many of those were paused now ("pause" only: every scheduled or running one, in the switch-off's transaction). */
  paused: number;
  /** How many of their replies waiting for an answer moved to the Owner. */
  movedReplies: number;
};

/** The reason stored on each campaign paused because its sender was switched off (M4-DESIGN §9.8). */
export function switchedOffPauseReason(name: string): string {
  return `Paused because ${name} was switched off`;
}

/**
 * Switches a teammate off: signed out everywhere, open links revoked, history kept. Their reply routes are then
 * pointed at the Owner's inbox (a route sync is queued). In the same transaction their unanswered replies waiting for
 * an answer are reassigned to the Owner (M4-DESIGN §4.2), so they never fall out of every "Yours" list and bell count.
 *
 * Their campaigns (the ones they are the sender of): with `campaigns: "pause"` (the default, and the old call shape)
 * every scheduled or running one is paused in the same transaction, the way `pauseCampaign` pauses it (reservations
 * expire after the paused-expiry setting, one `campaign.paused` entry each), with the reason "Paused because Ali was
 * switched off". So the switch-off and the pauses happen together or not at all: a campaign can never keep sending
 * from a switched-off address because its pause failed afterwards. With "finish" they keep going, follow-ups included,
 * and replies reach the Owner through the repointed route. A paused campaign stays paused with its own reason.
 */
export async function deactivateUser(
  actorId: number,
  targetId: number,
  now = new Date(),
  opts: { campaigns?: SwitchOffCampaigns } = {},
): Promise<DeactivateResult> {
  const choice: SwitchOffCampaigns = opts.campaigns === "finish" ? "finish" : "pause";
  // Read before the transaction (a setting): when a paused campaign's reservations expire.
  const pausedExpiry = choice === "pause" ? await pausedExpiryFrom(now) : null;
  const res = await dbTx(async (tx) => {
    const actor = await loadActingOwner(tx, actorId);
    if (targetId === actor.id) {
      throw new TeamError("You can't switch yourself off. If you're leaving, make someone else the Owner first.");
    }
    const target = await loadTarget(tx, targetId);
    if (target.role === "OWNER") {
      throw new TeamError("The Owner can't be switched off. Make someone else the Owner first.");
    }
    if (!target.active) throw new TeamError(`${target.name} is already switched off.`);
    const ownersLeft = await tx.user.count({ where: { role: "OWNER", active: true, id: { not: target.id } } });
    if (ownersLeft < 1) {
      throw new TeamError("There must always be an active Owner. Make someone else the Owner first.");
    }
    await tx.user.update({ where: { id: target.id }, data: { active: false } });
    await tx.session.deleteMany({ where: { userId: target.id } });
    await revokeOpenLinks(tx, target.id, now);
    // The actor is the active Owner (loadActingOwner): their waiting replies become the Owner's.
    const moved = await tx.inboundMessage.updateMany({ where: waitingRepliesWhere(target.id), data: { assigneeId: actor.id } });
    const campaigns = await tx.campaign.findMany({
      where: { senderId: target.id, status: { in: [...ACTIVE_CAMPAIGN_STATUSES] } },
      orderBy: { id: "asc" },
      select: { id: true, name: true, status: true, mode: true },
    });
    const movedText =
      moved.count > 0
        ? `; ${target.name}'s ${plural(moved.count, "reply", "replies")} waiting for an answer moved to ${actor.name}`
        : "";
    await logActivity(
      {
        actorId: actor.id,
        type: "user.deactivated",
        summary: `${actor.name} switched off ${target.name}${movedText}`,
        data: { userId: target.id, campaigns: choice, campaignIds: campaigns.map((c) => c.id), movedReplies: moved.count },
      },
      tx,
    );
    let paused = 0;
    if (choice === "pause") {
      const reason = switchedOffPauseReason(target.name);
      for (const c of campaigns) {
        if (!PAUSABLE_STATUSES.includes(c.status as ActiveCampaignStatus)) continue;
        // As pauseCampaign does it, inside this transaction (the write lock is held, so nothing changed since the read).
        const set = await tx.campaign.updateMany({
          where: { id: c.id, status: { in: [...PAUSABLE_STATUSES] } },
          data: { status: "PAUSED", pausedAt: now, pauseReason: reason },
        });
        if (set.count !== 1) continue;
        await setReservationExpiry(tx, c.id, pausedExpiry);
        await logActivity(
          { actorId: actor.id, type: "campaign.paused", summary: `${actor.name} paused ${c.name}`, campaignId: c.id, data: { reason }, mode: c.mode },
          tx,
        );
        paused++;
      }
    }
    return {
      id: target.id,
      name: target.name,
      movedReplies: moved.count,
      paused,
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status as ActiveCampaignStatus })),
    };
  });
  await queueRouteSync(res.id, actorId, false);
  return res;
}

/** Switches a teammate back on; their reply routes forward to their own inbox again (a route sync is queued). */
export async function reactivateUser(actorId: number, targetId: number): Promise<{ id: number; name: string }> {
  const res = await dbTx(async (tx) => {
    const actor = await loadActingOwner(tx, actorId);
    const target = await loadTarget(tx, targetId);
    if (target.active) throw new TeamError(`${target.name} is already switched on.`);
    await tx.user.update({ where: { id: target.id }, data: { active: true } });
    await logActivity(
      {
        actorId: actor.id,
        type: "user.reactivated",
        summary: `${actor.name} switched ${target.name} back on`,
        data: { userId: target.id },
      },
      tx,
    );
    await createNotification(
      {
        userId: target.id,
        type: "user.reactivated",
        title: "Your account is switched back on",
        body: `${actor.name} switched your account back on. Welcome back.`,
        link: "/settings/profile",
      },
      tx,
    );
    return { id: target.id, name: target.name };
  });
  await queueRouteSync(res.id, actorId, false);
  return res;
}

/**
 * Makes a teammate the Owner; the current Owner becomes a Member. Exactly one Owner, always.
 * The new Owner's unused links stop working: a reset link the old Owner made (and saw) must not let
 * them, or anyone they pasted it to, take the Owner account back.
 * The catch-all, dmarc@ and switched-off teammates' reply routes forward to the Owner's inbox (PLAN B6.10), so a route
 * sync is queued to point them at the new Owner.
 */
export async function transferOwnership(
  actorId: number,
  targetId: number,
  now = new Date(),
): Promise<{ id: number; name: string }> {
  const res = await dbTx(async (tx) => {
    const actor = await loadActingOwner(tx, actorId);
    if (targetId === actor.id) throw new TeamError("You're already the Owner.");
    const target = await loadTarget(tx, targetId);
    if (!target.active) throw new TeamError(`${target.name} is switched off. Switch them back on first.`);
    if (!target.passwordHash) {
      throw new TeamError(`${target.name} hasn't accepted their invite yet. They can become the Owner once they've signed in.`);
    }
    const promoted = await tx.user.updateMany({
      where: { id: target.id, role: "MEMBER", active: true },
      data: { role: "OWNER" },
    });
    const demoted = await tx.user.updateMany({ where: { id: actor.id, role: "OWNER" }, data: { role: "MEMBER" } });
    if (promoted.count !== 1 || demoted.count !== 1) {
      throw new TeamError("The team changed while you were doing this. Refresh the page and try again.");
    }
    const owners = await tx.user.count({ where: { role: "OWNER" } });
    if (owners !== 1) {
      throw new TeamError("There must be exactly one Owner. Refresh the page and try again.");
    }
    const revokedLinks = await revokeOpenLinks(tx, target.id, now);
    await logActivity(
      {
        actorId: actor.id,
        type: "user.ownershipTransferred",
        summary:
          revokedLinks > 0
            ? `${actor.name} made ${target.name} the Owner; ${target.name}'s unused ${revokedLinks === 1 ? "link was" : "links were"} cancelled`
            : `${actor.name} made ${target.name} the Owner`,
        data: { fromUserId: actor.id, toUserId: target.id, revokedLinks },
      },
      tx,
    );
    await createNotification(
      {
        userId: target.id,
        type: "user.ownershipTransferred",
        title: "You're now the Owner",
        body: `${actor.name} made you the Owner. You can now change settings, keys, limits and the team.`,
        link: "/settings/team",
      },
      tx,
    );
    return { id: target.id, name: target.name };
  });
  await queueRouteSync(res.id, actorId, true);
  return res;
}

// ───────────────────────────── my profile ─────────────────────────────

export type ProfileInput = {
  name: string;
  senderDisplayName: string;
  replyInbox: string;
  signature: string;
  timeZone: string;
};

const profileSchema = z.object({
  name: nameSchema,
  senderDisplayName: z
    .string()
    .trim()
    .min(1, { error: "Enter the name people see in their inbox, for example \"Ali from Polygon Paradise\"." })
    .max(100, { error: "Use 100 characters or fewer." })
    .refine((v) => !/[<>"\r\n]/.test(v), { error: "Leave out quotes and < > characters." }),
  replyInbox: z.string().trim().min(1, { error: "Enter the inbox where you read your email." }).max(254),
  signature: z.string().max(2000, { error: "Keep your signature under 2,000 characters." }),
  timeZone: z.string().refine((v) => isValidTimeZone(v), { error: "Pick a time zone from the list." }),
});

/** "Your reply inbox can't be on the sending domain <d>: …" (a route would forward replies back to Mailgun, in a loop). */
export function replyInboxOnSendingDomainText(domain: string): string {
  return `Your reply inbox can't be on the sending domain ${domain}: replies would go round in circles. Use your normal mailbox, such as Gmail or Outlook.com.`;
}

/**
 * Checks a profile without saving it: the cleaned values, or the field errors. `sendingDomains` are the sending domains
 * the reply inbox may not be on (or under).
 */
export function checkProfileInput(
  input: ProfileInput,
  sendingDomains: readonly string[] = [],
): { ok: true; next: ProfileInput } | { ok: false; fieldErrors: Record<string, string[] | undefined> } {
  const res = profileSchema.safeParse(input);
  const fieldErrors: Record<string, string[] | undefined> = res.success ? {} : { ...z.flattenError(res.error).fieldErrors };
  const inbox = parseEmail(input.replyInbox ?? "");
  if (!inbox && !fieldErrors.replyInbox) {
    fieldErrors.replyInbox = ["Enter a valid email address, for example ali@gmail.com."];
  }
  const loop = inbox ? sendingDomainOf(inbox.email, sendingDomains) : null;
  if (loop && !fieldErrors.replyInbox) fieldErrors.replyInbox = [replyInboxOnSendingDomainText(loop)];
  if (!res.success || !inbox || loop) return { ok: false, fieldErrors };
  return {
    ok: true,
    next: {
      name: res.data.name,
      senderDisplayName: res.data.senderDisplayName,
      replyInbox: inbox.email,
      signature: res.data.signature.replace(/\r\n?/g, "\n").trimEnd(),
      timeZone: res.data.timeZone,
    },
  };
}

/**
 * The loop domains: every sending domain the app knows (current and older ones), where no reply inbox may be (their
 * routes forward replies to it). Own-mailbox mode (MAIN-DOMAIN-DESIGN O9, §3.7): the active domain has no route, so it
 * is left out and an inbox on it (contact@…) is allowed; older domains' routes still forward, so they stay.
 */
export async function sendingDomainNames(): Promise<string[]> {
  const [rows, team] = await Promise.all([db.sendingDomain.findMany({ select: { name: true, active: true } }), loadTeamFrom()]);
  if (team.replies !== "own-mailbox") return rows.map((d) => d.name);
  const current = (team.domain ?? "").trim().toLowerCase();
  return rows.filter((d) => !d.active && d.name.trim().toLowerCase() !== current).map((d) => d.name);
}

/**
 * Saves the user's own profile. The reply inbox may not be on (or under) a sending domain; when it changes, the
 * Owner is told (for a Member) and the reply routes are synced so replies go to the new inbox.
 */
export async function updateProfile(
  userId: number,
  input: ProfileInput,
): Promise<{ changed: Array<keyof ProfileInput> }> {
  const checked = checkProfileInput(input, await sendingDomainNames());
  if (!checked.ok) throw new TeamError(FIELDS_NEED_FIXING, checked.fieldErrors);
  const next = checked.next;

  const res = await dbTx(async (tx) => {
    const current = await tx.user.findUnique({
      where: { id: userId },
      select: { name: true, role: true, active: true, senderDisplayName: true, replyInbox: true, signature: true, timeZone: true },
    });
    if (!current || !current.active) throw new TeamError("Your session has ended. Please sign in again.");
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => (current[k] ?? "") !== next[k]);
    if (changed.length === 0) return { changed, isOwner: current.role === "OWNER" };
    await tx.user.update({ where: { id: userId }, data: next });
    await logActivity(
      {
        actorId: userId,
        type: "user.profile",
        summary: `${next.name} updated their profile`,
        data: { changed },
      },
      tx,
    );
    if (changed.includes("replyInbox") && current.role !== "OWNER") {
      await notifyOwner(
        {
          type: "user.replyInbox",
          title: `${next.name} changed their reply inbox`,
          body: `Replies to ${next.name}'s campaigns will now be forwarded to ${next.replyInbox}.`,
          link: "/settings/team",
        },
        tx,
      );
    }
    return { changed, isOwner: current.role === "OWNER" };
  });
  if (res.changed.includes("replyInbox")) await queueRouteSync(userId, userId, res.isOwner);
  return { changed: res.changed };
}

/** Changes your own password. Your other devices are signed out; this one stays signed in. */
export async function changeOwnPassword(
  userId: number,
  input: { current: string; password: string; confirm: string },
  keepSessionId: number | null,
  now = new Date(),
): Promise<void> {
  const fieldErrors: Record<string, string[]> = {};
  const problem = passwordProblem(input.password ?? "");
  if (problem) fieldErrors.password = [problem];
  else if (input.password === input.current) fieldErrors.password = ["Choose a password that's different from your current one."];
  if ((input.password ?? "") !== (input.confirm ?? "")) fieldErrors.confirm = ["The two passwords don't match."];

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, active: true, passwordHash: true },
  });
  if (!user || !user.active) throw new TeamError("Your session has ended. Please sign in again.");
  const currentOk = await verifyPassword(user.passwordHash, input.current ?? "");
  if (!currentOk) {
    throw new TeamError(
      "Your current password isn't right. Check it and try again.",
      { ...fieldErrors, current: ["That isn't your current password."] },
      "wrong-password",
    );
  }
  if (Object.keys(fieldErrors).length > 0) throw new TeamError(FIELDS_NEED_FIXING, fieldErrors);

  const passwordHash = await hashPassword(input.password);
  await dbTx(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.session.deleteMany({
      where: { userId, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    });
    await tx.accessLink.updateMany({
      where: { userId, purpose: "RESET", usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    await logActivity({ actorId: userId, type: "user.passwordChanged", summary: `${user.name} changed their password` }, tx);
  });
}

// ───────────────────────────── notification preferences ─────────────────────────────

/**
 * `User.notifyPrefs` (M4-DESIGN §5.4, §8.1): `{ popupGroups, desktopReplies }`, parsed by the contract's
 * `readNotifyPrefs` (@/core/notification-types). `popupGroups` chooses what pops up (replies by default);
 * `desktopReplies` is Milestones 1–3's switch, now only the default of each browser's own pop-up switch.
 */
export { readNotifyPrefs };
export type { NotifyPrefs };

export async function getNotifyPrefs(userId: number): Promise<NotifyPrefs> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { notifyPrefs: true } });
  return readNotifyPrefs(u?.notifyPrefs);
}

/**
 * Saves the pop-up groups of one account ("What pops up", M4-DESIGN §5.4). Unknown groups are dropped, the order is
 * the fixed one of POPUP_GROUPS, and Owner-only groups ("sending") are dropped for a Member. Other keys of
 * `notifyPrefs` (the legacy `desktopReplies`) are kept.
 */
export async function setPopupGroups(userId: number, groups: readonly string[], role: Role): Promise<NotifyPrefs> {
  const wanted: PopupGroup[] = POPUP_GROUPS.filter(
    (g) => groups.includes(g) && (role === "OWNER" || !OWNER_ONLY_POPUP_GROUPS.includes(g)),
  );
  return setNotifyPrefs(userId, { popupGroups: wanted });
}

/** Merges `patch` into `User.notifyPrefs`, keeping every other key; returns the preferences as read back. */
export async function setNotifyPrefs(userId: number, patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  return dbTx(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { notifyPrefs: true } });
    if (!u) throw new TeamError("Your session has ended. Please sign in again.");
    const existing =
      u.notifyPrefs && typeof u.notifyPrefs === "object" && !Array.isArray(u.notifyPrefs)
        ? (u.notifyPrefs as Record<string, Prisma.JsonValue>)
        : {};
    const merged = { ...existing, ...patch } as Prisma.InputJsonObject;
    await tx.user.update({ where: { id: userId }, data: { notifyPrefs: merged } });
    return readNotifyPrefs(merged);
  });
}

// ───────────────────────────── link throttling ─────────────────────────────

/**
 * Wrong or expired link attempts reuse LoginAttempt with this pseudo-address.
 *  - A usable link ALWAYS works: the limit only applies once a link has turned out not to work.
 *  - The limit is per source (10 in 15 minutes). There is no total across all sources: links are 256-bit
 *    random, so a total adds no protection and would only let anyone block everyone's links (including the
 *    one reset-password.bat prints).
 *  - Above LINK_FAILURES_RECORD_CAP failures in the window nothing more is stored, so the table can't be flooded.
 */
export const LINK_THROTTLE_KEY = "__link__";
const LINK_THROTTLE_WINDOW_MS = 15 * 60_000;
const LINK_THROTTLE_PER_SOURCE = 10;
const LINK_FAILURES_RECORD_CAP = 1000;

export const LINK_THROTTLED_MESSAGE = "Too many tries with links that don't work. Wait 15 minutes, then open the newest link again.";

export async function linkAttemptsBlocked(sourceKey: string, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - LINK_THROTTLE_WINDOW_MS);
  const fromSource = await db.loginAttempt.count({
    where: { emailNorm: LINK_THROTTLE_KEY, sourceKey, success: false, at: { gte: since } },
  });
  return fromSource >= LINK_THROTTLE_PER_SOURCE;
}

export async function recordLinkFailure(sourceKey: string, now = new Date()): Promise<void> {
  const since = new Date(now.getTime() - LINK_THROTTLE_WINDOW_MS);
  await dbWrite(async (c) => {
    const total = await c.loginAttempt.count({ where: { emailNorm: LINK_THROTTLE_KEY, success: false, at: { gte: since } } });
    if (total >= LINK_FAILURES_RECORD_CAP) return;
    await c.loginAttempt.create({ data: { emailNorm: LINK_THROTTLE_KEY, sourceKey, success: false, at: now } });
  });
}

/**
 * The public "accept invite" / "reset password" step for one request source (PLAN.md A5, B10).
 * A usable link always goes through, whatever the throttle says. Only a link that doesn't work counts
 * against the source, and a source with too many of those gets LINK_THROTTLED_MESSAGE instead.
 */
export async function acceptAccessLinkFrom(
  sourceKey: string,
  input: { token: string; purpose: AccessLinkPurpose; password: string; confirm: string },
  now = new Date(),
): Promise<UsableLink["user"]> {
  try {
    return await acceptAccessLink(input, now);
  } catch (err) {
    if (err instanceof TeamError && err.code === "link-invalid") {
      if (await linkAttemptsBlocked(sourceKey, now)) throw new TeamError(LINK_THROTTLED_MESSAGE, undefined, "link-invalid");
      await recordLinkFailure(sourceKey, now);
    }
    throw err;
  }
}

// ───────────────────────────── link addresses ─────────────────────────────

/** A Host header value we're willing to put in a link (host or host:port), or null. */
export function cleanRequestHost(host: string | null | undefined): string | null {
  const h = (host ?? "").split(",")[0]!.trim().toLowerCase();
  if (!h || h.length > 255) return null;
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/.test(h)) return null;
  return h;
}

export function isLocalOnlyHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name === "[::1]" || name.startsWith("127.") || name === "0.0.0.0";
}

export type AccessLinkUrls = {
  /** The link to send: the public https address when set, otherwise the office address. */
  primary: { kind: "public" | "office"; url: string };
  /** The office-network version, when it differs from the primary link. */
  office: string | null;
  /** True when the office link uses localhost, which only works on the PC itself. */
  officeIsLocalOnly: boolean;
};

export function accessLinkPath(purpose: AccessLinkPurpose, token: string): string {
  return `${purpose === "INVITE" ? "/invite" : "/reset"}/${encodeURIComponent(token)}`;
}

/**
 * Invite/reset links (PLAN.md B1): APP_PUBLIC_URL when set, plus the LAN form built from the
 * request's Host (always http: the office address has no certificate). Never from request.url.
 */
export function buildAccessLinkUrls(opts: {
  purpose: AccessLinkPurpose;
  token: string;
  publicUrl: string | null;
  requestHost: string | null;
}): AccessLinkUrls {
  const path = accessLinkPath(opts.purpose, opts.token);
  const base = opts.publicUrl ? opts.publicUrl.replace(/\/+$/, "") : null;
  let publicHost: string | null = null;
  if (base) {
    try {
      publicHost = new URL(base).host.toLowerCase();
    } catch {
      publicHost = null;
    }
  }
  const host = cleanRequestHost(opts.requestHost);
  const officeHost = host && host !== publicHost ? host : null;
  const office = officeHost ? `http://${officeHost}${path}` : null;
  const officeIsLocalOnly = officeHost ? isLocalOnlyHost(officeHost) : false;
  if (base && publicHost) {
    return { primary: { kind: "public", url: base + path }, office, officeIsLocalOnly };
  }
  const fallbackHost = officeHost ?? "localhost:3000";
  return {
    primary: { kind: "office", url: `http://${fallbackHost}${path}` },
    office: null,
    officeIsLocalOnly: isLocalOnlyHost(fallbackHost),
  };
}
