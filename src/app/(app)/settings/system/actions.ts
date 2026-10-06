"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireOwnerAction } from "@/lib/auth/dal";
import { logActivity } from "@/server/activity";
import { dbTx } from "@/server/db";
import { enqueueJob } from "@/server/jobs";
import { getSetting, setSettingIn } from "@/server/settings";
import { checkPublicAddress, checkTunnel } from "@/server/services/checks/tunnel";

/**
 * Settings › System actions (Owner only). "Check now" on the Remote access card runs the remote-access checks right
 * away in the web process (cloudflared on this PC and the three checks through the public address), instead of
 * waiting for the background sender's next round. "We don't use Cloudflare Access" (M6-DESIGN §2.8, G7) saves the
 * Owner's Access choice, which the Domain checklist's remote-access row and the go-live card read.
 */
export async function checkRemoteAccessAction(): Promise<ActionResult<{ state: string; publicOk: boolean | null }>> {
  return runAction(async () => {
    await requireOwnerAction();
    const now = new Date();
    const tunnel = await checkTunnel({ now, metrics: true });
    const pub = await checkPublicAddress({ now });
    // The dashboard's "Remote access is down" item reads the same state (M6-DESIGN §5.1 R5).
    revalidatePath("/", "layout");
    return { state: tunnel.state, publicOk: pub.publicCheck ? pub.publicCheck.ok : null };
  }, "Checked.");
}

const accessChoiceSchema = z.object({ accessOff: z.boolean({ error: "Choose whether you use Cloudflare Access." }) });

/**
 * Saves "We don't use Cloudflare Access" (Setting "remoteAccess.accessOff") with its activity in one transaction, then
 * queues a domain check (the same dedupe key and priority as Check again) so the remote-access row follows at once.
 * Saving the value it already has changes nothing.
 */
export async function saveAccessChoiceAction(input: { accessOff: boolean }): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { accessOff } = parseInput(accessChoiceSchema, input);
    const before = (await getSetting("remoteAccess.accessOff")) === true;
    if (before === accessOff) {
      message = "Nothing changed, so there was nothing to save.";
      return null;
    }
    await dbTx(async (tx) => {
      await setSettingIn(tx, "remoteAccess.accessOff", accessOff, user.id);
      await logActivity(
        {
          actorId: user.id,
          type: "settings.updated",
          summary: `${user.name} turned ${accessOff ? "off" : "on"} the Cloudflare Access check`,
          data: { key: "remoteAccess.accessOff", from: before, to: accessOff },
        },
        tx,
      );
    });
    await enqueueJob({ type: "mailgun.checkDomain", payload: {}, dedupeKey: "mailgun:domain-check", priority: 20, createdById: user.id });
    // The checklist row, the go-live card and the dashboard's checklist item all read it.
    revalidatePath("/", "layout");
    message = "Saved. The Domain checklist checks remote access again in a minute.";
    return null;
  });
  return res.ok ? { ...res, message } : res;
}
