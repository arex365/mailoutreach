"use server";

import { z } from "zod";
import { parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import type { PopupGroup } from "@/core/notification-types";
import { setPopupGroups } from "@/server/services/users";
import { withTeamErrors } from "../team-errors";

/**
 * Settings › Notifications (M4-DESIGN §5.4, §9.6, §9.10), for everyone. Only "What pops up" is saved on the server
 * (per account); whether pop-ups are on at all is chosen per browser and never reaches the server.
 */

const schema = z.object({
  groups: z.array(z.string().max(40), { error: "Choose what pops up." }).max(20, { error: "Choose what pops up." }),
});

/**
 * Saves which kinds of notification also pop up on screen ("What pops up"). Unknown groups are ignored, and a
 * Member's "Sending paused, bounce and spam warnings" choice is dropped (Owner only). Replaces setDesktopRepliesAction.
 */
export async function savePopupGroupsAction(input: { groups: string[] }): Promise<ActionResult<{ groups: PopupGroup[] }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const { groups } = parseInput(schema, input);
    const prefs = await withTeamErrors(() => setPopupGroups(user.id, groups, user.role));
    return { groups: prefs.popupGroups };
  }, "Saved.");
}
