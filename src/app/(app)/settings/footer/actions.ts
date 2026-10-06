"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireOwnerAction } from "@/lib/auth/dal";
import { logActivity } from "@/server/activity";
import { getSettings, setSetting } from "@/server/settings";
import { validateFooter, type FooterValues } from "@/components/settings/footer/footer-format";

/**
 * Server Action for Settings › Email footer (M3-DESIGN §5.6), Owner only: the company name, postal
 * address, unsubscribe line and portfolio link that end every email. Logged with who changed it.
 */

const footerInput = z.object({
  companyName: z.string(),
  address: z.string(),
  unsubscribeText: z.string(),
  portfolioUrl: z.string(),
});

export async function saveFooterAction(input: z.input<typeof footerInput>): Promise<ActionResult<FooterValues>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const raw = parseInput(footerInput, input);
    const checked = validateFooter(raw);
    if (!checked.ok) {
      const fieldErrors = Object.fromEntries(Object.entries(checked.errors).map(([k, v]) => [k, v ? [v] : undefined]));
      throw new UserError("Some details need fixing. Check the highlighted fields.", fieldErrors);
    }
    const v = checked.value;
    const current = await getSettings(["footer.companyName", "footer.address", "footer.unsubscribeText", "portfolioUrl"] as const);
    const changed: string[] = [];
    if (current["footer.companyName"] !== v.companyName) {
      await setSetting("footer.companyName", v.companyName, user.id);
      changed.push("the company name");
    }
    if (current["footer.address"] !== v.address) {
      await setSetting("footer.address", v.address, user.id);
      changed.push("the address");
    }
    if (current["footer.unsubscribeText"] !== v.unsubscribeText) {
      await setSetting("footer.unsubscribeText", v.unsubscribeText, user.id);
      changed.push("the unsubscribe line");
    }
    if (current["portfolioUrl"] !== v.portfolioUrl) {
      await setSetting("portfolioUrl", v.portfolioUrl, user.id);
      changed.push("the portfolio link");
    }
    if (changed.length > 0) {
      const list = changed.length === 1 ? changed[0]! : `${changed.slice(0, -1).join(", ")} and ${changed[changed.length - 1]}`;
      await logActivity({
        actorId: user.id,
        type: "settings.updated",
        summary: `${user.name} changed the email footer (${list})`,
        data: { page: "footer", changed },
      });
    }
    revalidatePath("/settings/footer");
    return v;
  }, "Footer saved. Emails prepared from now on use it.");
}
