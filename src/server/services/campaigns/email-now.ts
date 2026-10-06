import { db } from "@/server/db";
import { loadAudienceSnapshot, type Actor } from "./audience";
import { createDraft, deleteDraft, loadLaunchSummary, launchDraft } from "./draft";
import { CampaignError } from "./errors";

/**
 * "Email now" (company panel): one click makes a one-company campaign from the master template and launches it at
 * once. It is the ordinary wizard done for you, so every rule still applies: the launch's mode checks, the daily
 * limit, the recipient's sending hours, the 30-day rule, Do not contact, the test-list guard and the address checks.
 * "Now" means first in the queue: the background sender picks it up within seconds when it may send.
 *
 * Nobody can be emailed → the draft is deleted again and the reason is thrown in plain words. Something the wizard can
 * fix (no sender, missing details, Mailgun not ready) → the draft is kept and its wizard step is returned.
 */

export type EmailNowResult =
  | { launched: true; campaignId: number; message: string }
  | { launched: false; campaignId: number; step: "audience" | "sender" | "message" | "review" | "schedule"; problem: string };

export async function emailCompanyNow(
  actor: Actor,
  companyId: number,
  opts: { timeZone?: string; now?: Date } = {},
): Promise<EmailNowResult> {
  const company = await db.company.findFirst({ where: { id: companyId, deletedAt: null }, select: { id: true, name: true } });
  if (!company) throw new CampaignError("This company doesn't exist any more. Refresh the page.", "not-found");

  // A double click within a few seconds reuses the first draft (createDraft's own guard), so it never sends twice.
  const draft = await createDraft(actor, {
    companyIds: [company.id],
    name: `Email now: ${company.name}`,
    timeZone: opts.timeZone,
    reuseWithinMs: 10_000,
    now: opts.now,
  });

  const snap = await loadAudienceSnapshot(draft.id, { now: opts.now });
  if (snap.totals.people === 0) {
    const view = snap.companies.find((c) => c.companyId === company.id);
    const reason =
      view?.blockedReason ?? view?.emptyReason ?? view?.people.find((p) => p.reason)?.reason ?? "Nobody at this company can be emailed right now.";
    await deleteDraft(actor, draft.id).catch(() => undefined);
    throw new CampaignError(`${company.name} can't be emailed: ${reason}`, "nobody");
  }

  const summary = await loadLaunchSummary(draft.id, { now: opts.now });
  const problem = summary.problems[0];
  if (problem) return { launched: false, campaignId: draft.id, step: problem.step, problem: problem.text };
  if (summary.modeBlockers.length > 0) {
    return { launched: false, campaignId: draft.id, step: "schedule", problem: summary.modeBlockers[0]! };
  }

  const res = await launchDraft(actor, draft.id, { now: opts.now });
  return { launched: true, campaignId: draft.id, message: res.message };
}
