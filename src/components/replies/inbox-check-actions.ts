"use server";

import { revalidatePath } from "next/cache";
import { INBOX_CHECK_TEXTS } from "@/core/sending/own-mailbox";
import { UserError, runAction, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import { ServiceError } from "@/server/services/companies/mutations";
import { markInboxChecked } from "@/server/services/sending/inbox-check";

/**
 * "I've read contact@polygonparadise.com" on the Notifications page's inbox check card (MAIN-DOMAIN-DESIGN O33, §3.9).
 * Open to everyone signed in (whoever reads the own mailbox; the activity names who clicked), listed on purpose in
 * EVERYONE_ACTIONS (tests/integration/security/owner-actions.test.ts). No input. The whole layout is refreshed: the
 * dashboard's inbox-check item and the campaign pages' waiting lines change with it.
 */
export async function markInboxCheckedAction(): Promise<ActionResult<{ at: string }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    try {
      const res = await markInboxChecked({ id: user.id, name: user.name });
      revalidatePath("/", "layout");
      return { at: res.at.toISOString() };
    } catch (err) {
      if (err instanceof ServiceError) throw new UserError(err.message);
      throw err;
    }
  }, INBOX_CHECK_TEXTS.done);
}
