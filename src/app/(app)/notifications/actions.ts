"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import { markRead } from "@/server/notifications";

const idsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1, { error: "Pick a notification." }).max(500),
});

/** Marks some of your own notifications read (other people's are never touched). */
export async function markNotificationsReadAction(input: { ids: number[] }): Promise<ActionResult<{ count: number }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const { ids } = parseInput(idsSchema, input);
    const count = await markRead(user.id, ids);
    revalidatePath("/notifications");
    return { count };
  });
}

export async function markAllNotificationsReadAction(): Promise<ActionResult<{ count: number }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const count = await markRead(user.id, "all");
    revalidatePath("/notifications");
    return { count };
  }, "All notifications marked as read.");
}
