import type { CompanyStatus } from "@/generated/prisma/client";
import { COMPANY_STATUS_LABELS } from "@/core/labels";
import { hasBeenLive } from "@/core/replies/kind";
import { countsAsEmailed } from "@/core/rules/mode";
import { THEY_REPLIED_TEXTS, type RepliesMode } from "@/core/sending/own-mailbox";
import { logActivity } from "@/server/activity";
import { db, dbTx, type DbOrTx } from "@/server/db";
import { finishCheck } from "@/server/services/campaigns/control";
import { STOPPABLE_STATES, stopCompany } from "@/server/services/mail-events/stops";
import { loadTeamFrom, type TeamFromState } from "@/server/services/mailgun/team-from";
import { ServiceError, loadActiveCompany, type Actor } from "./mutations";

/**
 * "They replied" (MAIN-DOMAIN-DESIGN O17, §2.9, §3.8): the one door for marking a reply the app never saw (own-mailbox
 * mode sends replies straight to the own mailbox; shared-From mode and the practice copy show it too). One click stops
 * every follow-up to the company in every campaign with the reply stop codes ("Stopped: they replied" for the person
 * named, "Stopped: someone at the company replied" for everyone else), also when the company is already Replied. The
 * status (Not contacted / Contacted → Replied) and `repliedAt` change only when the click counts as a real reply, by the
 * rule real replies follow (`process.ts`, M6-DESIGN §2.2): the company is in a campaign that counts as emailed, or nothing
 * was open to stop and the app has been live (or it is the practice copy). A click during the rehearsal before go-live
 * therefore never makes a test mailbox Replied, and the next live test still includes it.
 */

/** Who may be shown the button (O17): own-mailbox mode, shared-From mode or the practice copy; never real per-person mode. */
export function theyRepliedShown(team: Pick<TeamFromState, "replies" | "address">, practiceCopy: boolean): boolean {
  return team.replies === "own-mailbox" || team.address !== null || practiceCopy;
}

/** The settings the "counts as a real reply" rule reads (the ones reply processing reads, `loadReplyContext`). */
export type RepliedByHandSettings = { practiceCopy: boolean; everLive: boolean };

/** Settings "practice.copy", "sending.goLive" and "sending.goLiveAt" (one query). Pass `tx` inside a transaction. */
export async function loadRepliedByHandSettings(reader: DbOrTx = db): Promise<RepliedByHandSettings> {
  const rows = await reader.setting.findMany({
    where: { key: { in: ["practice.copy", "sending.goLive", "sending.goLiveAt"] } },
    select: { key: true, value: true },
  });
  const value = (key: string): unknown => rows.find((r) => r.key === key)?.value;
  return {
    practiceCopy: value("practice.copy") === true,
    everLive: hasBeenLive({ goLive: value("sending.goLive"), goLiveAt: value("sending.goLiveAt") }),
  };
}

/**
 * Whether a They replied click on this company counts as a real reply (§2.9 `countsAsReply`): an included recipient in a
 * campaign whose sends count as emailed (`countsAsEmailed`: LIVE launched after go-live, or the practice copy's dry
 * runs), or no open recipient to stop and the app has been live (`hasBeenLive`) or it is the practice copy, as a reply
 * linked only to the company (`process.ts`). The confirm dialog (`loadMarkRepliedFacts`) and the click use this same rule.
 */
export async function repliedByHandCountsAsReply(reader: DbOrTx, companyId: number, s: RepliedByHandSettings): Promise<boolean> {
  const campaigns = await reader.campaign.findMany({
    where: { recipients: { some: { companyId, included: true } } },
    select: { mode: true, launchedGoLive: true },
  });
  if (campaigns.some((c) => countsAsEmailed(c.mode, { practiceCopy: s.practiceCopy, launchedGoLive: c.launchedGoLive }))) return true;
  const open = await reader.campaignRecipient.count({ where: { companyId, included: true, state: { in: [...STOPPABLE_STATES] } } });
  return open === 0 && (s.practiceCopy || s.everLive);
}

/** What the They replied button and its confirm dialog need to know about a company. */
export type MarkRepliedFacts = {
  /** The click would count as a real reply (the status may change and `repliedAt` is written). */
  countsAsReply: boolean;
  status: CompanyStatus;
  /** Setting "practice.copy" (the campaign person panel also shows the button for dry runs there). */
  practiceCopy: boolean;
  replies: RepliesMode;
};

/**
 * The button's facts for one company, or null when it isn't shown: real per-person mode (`theyRepliedShown`), a company
 * that doesn't exist, was deleted or is Do not contact. Reads only (settings, the company, its campaigns).
 */
export async function loadMarkRepliedFacts(companyId: number, reader: DbOrTx = db): Promise<MarkRepliedFacts | null> {
  const [team, settings, company] = await Promise.all([
    loadTeamFrom(reader),
    loadRepliedByHandSettings(reader),
    reader.company.findUnique({ where: { id: companyId }, select: { status: true, deletedAt: true } }),
  ]);
  if (!company || company.deletedAt || company.status === "DO_NOT_CONTACT") return null;
  if (!theyRepliedShown(team, settings.practiceCopy)) return null;
  const countsAsReply = await repliedByHandCountsAsReply(reader, companyId, settings);
  return { countsAsReply, status: company.status, practiceCopy: settings.practiceCopy, replies: team.replies };
}

export type MarkRepliedInput = {
  companyId: number;
  /** The person who replied: "Stopped: they replied" for them, and their `repliedAt`. */
  personId?: number | null;
  /** When they replied (deferred "When did they reply?", §1.6); default the click time. */
  at?: Date;
};

export type MarkRepliedResult = {
  /** How many people's follow-ups stopped now. */
  stopped: number;
  /** The status became Replied. */
  statusChanged: boolean;
  companyName: string;
};

/** The person's name as the company panel shows it ("General inbox" for a nameless role address). */
function personLabel(p: { name: string; email: string | null; isGeneric: boolean }): string {
  return p.isGeneric ? p.name || "General inbox" : p.name || p.email || "No name";
}

/**
 * Marks a company as replied by hand (O17), in one transaction: refuses a deleted company (today's sentence), a company
 * marked Do not contact, and a person who isn't (any more) at the company; stops every open recipient there in every
 * campaign through `stopCompany` with the reply codes and no InboundMessage; when the click counts as a real reply,
 * Not contacted / Contacted → Replied (compare-and-set, activity `company.status` with `markedReplied: true`) and
 * `repliedAt` of the company and the person moved forward to `at`; always the activity `company.markedReplied`. After the
 * commit, the campaigns it stopped someone in are finished when nothing is left (best effort, as `setCompanyStatus`).
 */
export async function markRepliedByHand(actor: Actor, input: MarkRepliedInput, now: Date = new Date()): Promise<MarkRepliedResult> {
  const at = input.at ?? now;
  const res = await dbTx(async (tx) => {
    const c = await loadActiveCompany(tx, input.companyId);
    if (c.status === "DO_NOT_CONTACT") throw new ServiceError(THEY_REPLIED_TEXTS.doNotContact);
    let person: { id: number; name: string; email: string | null; emailNorm: string | null; isGeneric: boolean } | null = null;
    if (input.personId) {
      const p = await tx.person.findUnique({
        where: { id: input.personId },
        select: { id: true, companyId: true, name: true, email: true, emailNorm: true, isGeneric: true, deletedAt: true },
      });
      if (!p || p.companyId !== c.id || p.deletedAt) throw new ServiceError(THEY_REPLIED_TEXTS.personGone);
      person = p;
    }

    const settings = await loadRepliedByHandSettings(tx);
    // Decided before the stop: "nothing was open" means nothing was open when the click came.
    const countsAsReply = await repliedByHandCountsAsReply(tx, c.id, settings);
    const stop = await stopCompany(tx, {
      companyId: c.id,
      replierPersonIds: person ? [person.id] : [],
      replierEmails: person?.emailNorm ? [person.emailNorm] : [],
      inboundId: null,
      now,
    });

    let statusTo: CompanyStatus = c.status;
    if (countsAsReply) {
      if (c.status === "NOT_CONTACTED" || c.status === "CONTACTED") {
        const from: CompanyStatus = c.status;
        const updated = await tx.company.updateMany({ where: { id: c.id, status: from }, data: { status: "REPLIED" } });
        if (updated.count === 1) {
          statusTo = "REPLIED";
          await logActivity(
            {
              actorId: actor.id,
              type: "company.status",
              summary: `${actor.name} set status to ${COMPANY_STATUS_LABELS.REPLIED}`,
              companyId: c.id,
              personId: person?.id ?? null,
              data: { from, to: "REPLIED", markedReplied: true },
            },
            tx,
          );
        }
      }
      // Forward only, as a processed reply (effects.ts).
      await tx.company.updateMany({
        where: { id: c.id, OR: [{ repliedAt: null }, { repliedAt: { lt: at } }] },
        data: { repliedAt: at },
      });
      if (person) {
        await tx.person.updateMany({
          where: { id: person.id, deletedAt: null, OR: [{ repliedAt: null }, { repliedAt: { lt: at } }] },
          data: { repliedAt: at },
        });
      }
    }

    await logActivity(
      {
        actorId: actor.id,
        type: "company.markedReplied",
        summary: THEY_REPLIED_TEXTS.activity(actor.name, c.name, person ? personLabel(person) : null),
        companyId: c.id,
        personId: person?.id ?? null,
        data: {
          personId: person?.id ?? null,
          stopped: stop.stopped,
          statusFrom: c.status,
          statusTo,
          at: at.toISOString(),
          countsAsReply,
        },
      },
      tx,
    );
    return { stopped: stop.stopped, statusChanged: statusTo !== c.status, companyName: c.name, campaignIds: stop.campaignIds };
  });
  // Best effort after the commit: finishCheck logs its own failure and answers false.
  for (const campaignId of res.campaignIds) await finishCheck(campaignId, { now });
  return { stopped: res.stopped, statusChanged: res.statusChanged, companyName: res.companyName };
}
