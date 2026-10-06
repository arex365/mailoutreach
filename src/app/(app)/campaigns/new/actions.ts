"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError, runAction, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import { wizardHref } from "@/components/campaign-wizard/steps";
import { AUDIENCE_MAX_COMPANIES } from "@/server/services/campaigns/audience";
import { createDraft } from "@/server/services/campaigns/draft";
import { CampaignError } from "@/server/services/campaigns/errors";

/**
 * Campaigns › "New campaign", a list's "Email this list", and the "Start a new campaign?" page at
 * /campaigns/new: a new draft (blank, or with every company in the list and named after it), then
 * the wizard opens at Audience. Drafts are only ever started by a click (a POST): opening a link
 * never creates one. Starting the same way twice within a few seconds reuses the first draft.
 */
export async function createDraftAction(input?: { listId?: number | null }): Promise<ActionResult<{ id: number; href: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const parsed = z.number().int().positive().nullable().optional().safeParse(input?.listId);
    if (!parsed.success) throw new UserError("That list link doesn't look right. Open the list on Contacts and try again.");
    try {
      const res = await createDraft(
        { id: user.id, name: user.name },
        { listId: parsed.data ?? null, timeZone: user.timeZone, reuseWithinMs: 10_000 },
      );
      const notice = res.listMissing ? "list-gone" : res.added && res.added.capped > 0 ? "capped" : null;
      revalidatePath("/campaigns");
      return { id: res.id, href: wizardHref(res.id, "audience", { notice }) };
    } catch (err) {
      if (err instanceof CampaignError) throw new UserError(err.message);
      throw err;
    }
  });
}

/**
 * Contacts › "Email these companies": a new draft campaign with exactly the ticked companies (ids
 * travel in the request body, never in the URL, so up to 10,000 work), then the wizard opens.
 */
export async function createDraftFromCompaniesAction(input: { companyIds: number[] }): Promise<ActionResult<{ id: number; href: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const parsed = z.array(z.number().int().positive()).safeParse(input?.companyIds);
    if (!parsed.success) {
      throw new UserError("Something about the ticked companies didn't look right. Reload the page and tick them again.");
    }
    const ids = [...new Set(parsed.data)];
    if (ids.length === 0) throw new UserError("Tick at least one company first.");
    if (ids.length > AUDIENCE_MAX_COMPANIES) {
      throw new UserError(
        `A campaign can have up to ${AUDIENCE_MAX_COMPANIES.toLocaleString("en-US")} companies (you ticked ${ids.length.toLocaleString("en-US")}). Tick fewer and try again.`,
      );
    }
    try {
      const res = await createDraft(
        { id: user.id, name: user.name },
        { companyIds: ids, timeZone: user.timeZone, reuseWithinMs: 10_000 },
      );
      revalidatePath("/campaigns");
      return { id: res.id, href: wizardHref(res.id, "audience") };
    } catch (err) {
      if (err instanceof CampaignError) throw new UserError(err.message);
      throw err;
    }
  });
}
