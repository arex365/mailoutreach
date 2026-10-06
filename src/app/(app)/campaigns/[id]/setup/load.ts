import "server-only";
import { notFound, redirect } from "next/navigation";
import { getSetting } from "@/server/settings";
import { getDraftInfo, type DraftInfo } from "@/server/services/campaigns/draft";
import { draftSendingMode } from "@/server/services/campaigns/audience";

/**
 * Every wizard page (after requireUser()): the draft from the URL, or 404; a campaign that is no
 * longer a draft opens its campaign page instead (only drafts open the wizard). With the mode it
 * would launch with and today's go-live (Setting "sending.goLive"), so every page's badge reads
 * "Live" or "Live (test list only)" alike (M6-DESIGN §2.7).
 */
export async function loadWizardDraft(
  idParam: string,
): Promise<DraftInfo & { mode: Awaited<ReturnType<typeof draftSendingMode>>; goLive: boolean }> {
  const id = Number.parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== idParam) notFound();
  const [info, mode, goLive] = await Promise.all([getDraftInfo(id), draftSendingMode(), getSetting("sending.goLive")]);
  if (!info) notFound();
  if (info.status !== "DRAFT") redirect(`/campaigns/${id}`);
  return { ...info, mode, goLive: goLive === true };
}

/** The time this request is handled (pages pass it down for "in 2 days"-style wording). */
export function requestTime(): Date {
  return new Date();
}

/** First value of a search parameter. */
export function param(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** A positive whole number from a search parameter, or undefined. */
export function positiveInt(v: string | string[] | undefined): number | undefined {
  const s = param(v);
  if (!s || !/^\d{1,9}$/.test(s)) return undefined;
  const n = Number(s);
  return n > 0 ? n : undefined;
}
