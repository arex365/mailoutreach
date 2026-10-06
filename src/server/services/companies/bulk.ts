import { COMPANY_STATUS_LABELS, PRIORITY_LABELS, type CompanyStatusValue, type PriorityValue } from "@/core/labels";
import { logActivities, type ActivityInput } from "@/server/activity";
import { dbTx, pauseForOtherWriters } from "@/server/db";
import { finishCheck } from "@/server/services/campaigns/control";
import { stopCompaniesForStatus } from "@/server/services/mail-events/stops";
import { findOrCreateTag } from "@/server/services/tags";
import { priorityRank } from "./filters";
import { isStopStatus } from "./mutations";

/**
 * Bulk actions on ticked companies (PLAN.md A6 "Bulk actions on the ticked rows only").
 * Always an explicit id list (never "whatever matches"), at most BULK_LIMIT ids,
 * written in chunks of BULK_CHUNK per transaction (PLAN.md B5), with one activity
 * entry per changed company naming who did it. Soft-deleted companies are skipped.
 */

export const BULK_LIMIT = 10_000;
export const BULK_CHUNK = 500;

export type Actor = { id: number; name: string };

export type BulkResult = {
  /** Distinct ids asked for. */
  requested: number;
  /** Companies actually changed. */
  changed: number;
  /** Companies found but already in the wanted state. */
  unchanged: number;
  /** Ids that don't exist or were deleted. */
  missing: number;
};

export class BulkLimitError extends Error {
  constructor(count: number) {
    super(`You can change up to ${BULK_LIMIT.toLocaleString("en-US")} companies at a time (you ticked ${count.toLocaleString("en-US")}). Tick fewer and try again.`);
    this.name = "BulkLimitError";
  }
}

/** Distinct positive integer ids, in the order given. Throws BulkLimitError over the cap. */
export function cleanIds(ids: readonly number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > BULK_LIMIT) throw new BulkLimitError(out.length);
  return out;
}

export function chunk<T>(items: readonly T[], size = BULK_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function emptyResult(requested: number): BulkResult {
  return { requested, changed: 0, unchanged: 0, missing: 0 };
}

/** Companies per transaction when a bulk status change also stops their follow-ups (M4-DESIGN §2.7). */
export const BULK_STOP_CHUNK = 50;

/** Between two transactions: lets the process's other work and the other process (the worker) write too. */
const yieldToEventLoop = pauseForOtherWriters;

/**
 * Set status on ticked companies. Companies already at that status are left alone. Replied, Client, Not interested
 * and Do not contact also stop the follow-ups of the companies that really changed, in every campaign, inside the
 * same transaction as their status (M4-DESIGN §2.7, D18); those changes run in transactions of at most 50 companies
 * with a pause between them, and campaigns left with nothing to send finish at the end.
 */
export async function bulkSetStatus(
  ids: readonly number[],
  status: CompanyStatusValue,
  actor: Actor,
  opts: { now?: Date } = {},
): Promise<BulkResult> {
  const clean = cleanIds(ids);
  const result = emptyResult(clean.length);
  const label = COMPANY_STATUS_LABELS[status];
  const now = opts.now ?? new Date();
  const stops = isStopStatus(status);
  const touched = new Set<number>();
  for (const part of chunk(clean, stops ? BULK_STOP_CHUNK : BULK_CHUNK)) {
    await dbTx(async (tx) => {
      const rows = await tx.company.findMany({
        where: { id: { in: part }, deletedAt: null },
        select: { id: true, status: true },
      });
      const toChange = rows.filter((r) => r.status !== status);
      if (toChange.length) {
        await tx.company.updateMany({ where: { id: { in: toChange.map((r) => r.id) } }, data: { status } });
        await logActivities(
          toChange.map<ActivityInput>((r) => ({
            actorId: actor.id,
            type: "company.status",
            summary: `${actor.name} set status to ${label}`,
            companyId: r.id,
            data: { from: r.status, to: status, bulk: true },
          })),
          tx,
        );
        if (stops) {
          const stopped = await stopCompaniesForStatus(tx, { companyIds: toChange.map((r) => r.id), status, now });
          for (const id of stopped.campaignIds) touched.add(id);
        }
      }
      result.changed += toChange.length;
      result.unchanged += rows.length - toChange.length;
      result.missing += part.length - rows.length;
    });
    if (stops) await yieldToEventLoop();
  }
  for (const campaignId of [...touched].sort((a, b) => a - b)) await finishCheck(campaignId, { now });
  return result;
}

/** Set priority (and the matching sort rank) on ticked companies. */
export async function bulkSetPriority(ids: readonly number[], priority: PriorityValue, actor: Actor): Promise<BulkResult> {
  const clean = cleanIds(ids);
  const result = emptyResult(clean.length);
  const label = PRIORITY_LABELS[priority];
  for (const part of chunk(clean)) {
    await dbTx(async (tx) => {
      const rows = await tx.company.findMany({
        where: { id: { in: part }, deletedAt: null },
        select: { id: true, priority: true },
      });
      const toChange = rows.filter((r) => r.priority !== priority);
      if (toChange.length) {
        await tx.company.updateMany({
          where: { id: { in: toChange.map((r) => r.id) } },
          data: { priority, priorityRank: priorityRank(priority) },
        });
        await logActivities(
          toChange.map<ActivityInput>((r) => ({
            actorId: actor.id,
            type: "company.priority",
            summary: `${actor.name} set priority to ${label}`,
            companyId: r.id,
            data: { from: r.priority, to: priority, bulk: true },
          })),
          tx,
        );
      }
      result.changed += toChange.length;
      result.unchanged += rows.length - toChange.length;
      result.missing += part.length - rows.length;
    });
  }
  return result;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Plain messages with a next step (a teammate may have deleted it a moment ago). */
export const LIST_GONE = "That list doesn't exist any more: someone may have just deleted it. Refresh the page to see the current lists.";
export const TAG_GONE = "That tag doesn't exist any more: someone may have just removed it. Refresh the page to see the current tags.";

/** Adds ticked companies to a list. Companies already in it are counted as unchanged. */
export async function bulkAddToList(ids: readonly number[], listId: number, actor: Actor): Promise<BulkResult & { listName: string }> {
  const clean = cleanIds(ids);
  const result = emptyResult(clean.length);
  let listName = "";
  for (const part of chunk(clean)) {
    await dbTx(async (tx) => {
      const list = await tx.list.findUnique({ where: { id: listId }, select: { id: true, name: true } });
      if (!list) throw new NotFoundError(LIST_GONE);
      listName = list.name;
      const rows = await tx.company.findMany({ where: { id: { in: part }, deletedAt: null }, select: { id: true } });
      const found = rows.map((r) => r.id);
      const already = await tx.companyList.findMany({
        where: { listId, companyId: { in: found } },
        select: { companyId: true },
      });
      const alreadySet = new Set(already.map((a) => a.companyId));
      const toAdd = found.filter((id) => !alreadySet.has(id));
      if (toAdd.length) {
        await tx.companyList.createMany({ data: toAdd.map((companyId) => ({ companyId, listId, addedById: actor.id })) });
        await logActivities(
          toAdd.map<ActivityInput>((companyId) => ({
            actorId: actor.id,
            type: "company.lists",
            summary: `${actor.name} added this company to the list "${list.name}"`,
            companyId,
            data: { listId, action: "added" },
          })),
          tx,
        );
      }
      result.changed += toAdd.length;
      result.unchanged += found.length - toAdd.length;
      result.missing += part.length - found.length;
    });
  }
  if (!listName) {
    // No ids at all: still confirm the list exists so the caller can report it.
    await dbTx(async (tx) => {
      const list = await tx.list.findUnique({ where: { id: listId }, select: { name: true } });
      if (!list) throw new NotFoundError(LIST_GONE);
      listName = list.name;
    });
  }
  return { ...result, listName };
}

/** Removes ticked companies from a list (the companies themselves stay). */
export async function bulkRemoveFromList(ids: readonly number[], listId: number, actor: Actor): Promise<BulkResult & { listName: string }> {
  const clean = cleanIds(ids);
  const result = emptyResult(clean.length);
  let listName = "";
  for (const part of chunk(clean)) {
    await dbTx(async (tx) => {
      const list = await tx.list.findUnique({ where: { id: listId }, select: { id: true, name: true } });
      if (!list) throw new NotFoundError(LIST_GONE);
      listName = list.name;
      const rows = await tx.company.findMany({ where: { id: { in: part }, deletedAt: null }, select: { id: true } });
      const found = rows.map((r) => r.id);
      const members = await tx.companyList.findMany({
        where: { listId, companyId: { in: found } },
        select: { companyId: true },
      });
      const toRemove = members.map((m) => m.companyId);
      if (toRemove.length) {
        await tx.companyList.deleteMany({ where: { listId, companyId: { in: toRemove } } });
        await logActivities(
          toRemove.map<ActivityInput>((companyId) => ({
            actorId: actor.id,
            type: "company.lists",
            summary: `${actor.name} removed this company from the list "${list.name}"`,
            companyId,
            data: { listId, action: "removed" },
          })),
          tx,
        );
      }
      result.changed += toRemove.length;
      result.unchanged += found.length - toRemove.length;
      result.missing += part.length - found.length;
    });
  }
  if (!listName) {
    await dbTx(async (tx) => {
      const list = await tx.list.findUnique({ where: { id: listId }, select: { name: true } });
      if (!list) throw new NotFoundError(LIST_GONE);
      listName = list.name;
    });
  }
  return { ...result, listName };
}

export type TagBulkResult = BulkResult & { tag: { id: number; name: string }; tagCreated: boolean };

/** Tags ticked companies, creating the tag if it's new. */
export async function bulkAddTag(
  ids: readonly number[],
  tagName: string,
  actor: Actor,
): Promise<{ ok: true; result: TagBulkResult } | { ok: false; error: string }> {
  const clean = cleanIds(ids);
  const found = await findOrCreateTag(tagName);
  if (!found.ok) return found;
  const { tag } = found;
  const result = emptyResult(clean.length);
  for (const part of chunk(clean)) {
    await dbTx(async (tx) => {
      const rows = await tx.company.findMany({ where: { id: { in: part }, deletedAt: null }, select: { id: true } });
      const companyIds = rows.map((r) => r.id);
      const already = await tx.companyTag.findMany({
        where: { tagId: tag.id, companyId: { in: companyIds } },
        select: { companyId: true },
      });
      const alreadySet = new Set(already.map((a) => a.companyId));
      const toAdd = companyIds.filter((id) => !alreadySet.has(id));
      if (toAdd.length) {
        await tx.companyTag.createMany({ data: toAdd.map((companyId) => ({ companyId, tagId: tag.id })) });
        await logActivities(
          toAdd.map<ActivityInput>((companyId) => ({
            actorId: actor.id,
            type: "company.tags",
            summary: `${actor.name} added the tag "${tag.name}"`,
            companyId,
            data: { tagId: tag.id, action: "added" },
          })),
          tx,
        );
      }
      result.changed += toAdd.length;
      result.unchanged += companyIds.length - toAdd.length;
      result.missing += part.length - companyIds.length;
    });
  }
  return { ok: true, result: { ...result, tag, tagCreated: found.created } };
}

/** Removes a tag from ticked companies (the tag itself stays for other companies). */
export async function bulkRemoveTag(ids: readonly number[], tagId: number, actor: Actor): Promise<BulkResult & { tagName: string }> {
  const clean = cleanIds(ids);
  const result = emptyResult(clean.length);
  let tagName = "";
  await dbTx(async (tx) => {
    const tag = await tx.tag.findUnique({ where: { id: tagId }, select: { name: true } });
    if (!tag) throw new NotFoundError(TAG_GONE);
    tagName = tag.name;
  });
  for (const part of chunk(clean)) {
    await dbTx(async (tx) => {
      const rows = await tx.company.findMany({ where: { id: { in: part }, deletedAt: null }, select: { id: true } });
      const companyIds = rows.map((r) => r.id);
      const members = await tx.companyTag.findMany({
        where: { tagId, companyId: { in: companyIds } },
        select: { companyId: true },
      });
      const toRemove = members.map((m) => m.companyId);
      if (toRemove.length) {
        await tx.companyTag.deleteMany({ where: { tagId, companyId: { in: toRemove } } });
        await logActivities(
          toRemove.map<ActivityInput>((companyId) => ({
            actorId: actor.id,
            type: "company.tags",
            summary: `${actor.name} removed the tag "${tagName}"`,
            companyId,
            data: { tagId, action: "removed" },
          })),
          tx,
        );
      }
      result.changed += toRemove.length;
      result.unchanged += companyIds.length - toRemove.length;
      result.missing += part.length - companyIds.length;
    });
  }
  return { ...result, tagName };
}

/**
 * Soft-deletes ticked companies: they disappear from every list and view, but their
 * people and email history stay, so the 30-day rule and unsubscribes still apply.
 */
export async function bulkDelete(ids: readonly number[], actor: Actor): Promise<BulkResult> {
  const clean = cleanIds(ids);
  const result = emptyResult(clean.length);
  const now = new Date();
  for (const part of chunk(clean)) {
    await dbTx(async (tx) => {
      const rows = await tx.company.findMany({ where: { id: { in: part }, deletedAt: null }, select: { id: true } });
      const toDelete = rows.map((r) => r.id);
      if (toDelete.length) {
        await tx.company.updateMany({ where: { id: { in: toDelete }, deletedAt: null }, data: { deletedAt: now } });
        await logActivities(
          toDelete.map<ActivityInput>((companyId) => ({
            actorId: actor.id,
            type: "company.deleted",
            summary: `${actor.name} deleted this company`,
            companyId,
            data: { bulk: true },
          })),
          tx,
        );
      }
      result.changed += toDelete.length;
      result.missing += part.length - toDelete.length;
    });
  }
  return result;
}
