"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseInput, runAction, UserError, type ActionResult } from "@/lib/action";
import { requireOwnerAction, requireUserAction } from "@/lib/auth/dal";
import { logActivity } from "@/server/activity";
import {
  checkSecondFolder,
  currentInstanceId,
  enqueueManualBackup,
  writeSecondFolderMarker,
} from "@/server/services/backups";
import { getSetting, setSetting } from "@/server/settings";
import { getWorkerStatus } from "@/server/worker-status";

const PAGE = "/settings/backups";

/** The sentences of the second-folder actions (M6-DESIGN §3.4). */
const TEXTS = {
  practiceCopy: "The practice copy doesn't copy its backups to a second folder.",
  saved: "Saved. The first copy is being made now; this page shows whether it worked.",
  services:
    "If the app runs as a Windows service, run install-services.bat on the office PC so the background sender may write there.",
  cleared: "Backups are no longer copied to a second folder.",
} as const;

/** "Back up now" (everyone): queues a manual backup for the background sender. */
export async function backUpNowAction(): Promise<ActionResult<{ jobId: number; workerRunning: boolean }>> {
  return runAction(async () => {
    const user = await requireUserAction();
    const job = await enqueueManualBackup(user.id);
    const worker = await getWorkerStatus();
    revalidatePath(PAGE);
    return { jobId: job.id, workerRunning: worker.running };
  });
}

const folderSchema = z.object({
  folder: z
    .string({ error: "Enter the full path of a folder, for example D:\\Backups." })
    .trim()
    .min(1, { error: "Enter the full path of a folder, for example D:\\Backups." })
    .max(300, { error: "That path is too long. Pick a folder with a shorter path." }),
});

/**
 * Owner only (M6-DESIGN §3.4): every daily and Back up now backup is also copied to this folder. Refused in the
 * practice copy and for the folders checkSecondFolder refuses. Saved even when the web app can't write there yet (a
 * warning says to run install-services.bat); where it can, the folder gets its marker file at once. Either way the
 * first copy is queued now (one Back up now), so the page shows whether the background sender can write there.
 */
export async function saveSecondFolderAction(input: { folder: string }): Promise<ActionResult<{ folder: string; warning: string | null }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { folder } = parseInput(folderSchema, input);
    if ((await getSetting("practice.copy")) === true) throw new UserError(TEXTS.practiceCopy);
    const check = await checkSecondFolder(folder);
    if (!check.ok) throw new UserError(check.error, { folder: [check.error] });
    const previous = await getSetting("backups.secondFolder");
    if (previous !== check.folder) {
      await setSetting("backups.secondFolder", check.folder, user.id);
      await logActivity({
        actorId: user.id,
        type: "settings.updated",
        summary: `${user.name} set the second backup folder to ${check.folder}`,
        data: { key: "backups.secondFolder" },
      });
    }
    const cantWriteYet = check.warning !== null && check.warning.includes("install-services.bat");
    if (!cantWriteYet) {
      const instanceId = await currentInstanceId();
      if (instanceId) {
        // Where the web app may write, the marker goes in now; otherwise runBackup writes it at the first copy.
        await writeSecondFolderMarker(check.folder, instanceId).catch(() => undefined);
      }
    }
    await enqueueManualBackup(user.id);
    message = [TEXTS.saved, check.warning, cantWriteYet ? null : TEXTS.services].filter(Boolean).join(" ");
    revalidatePath("/", "layout");
    return { folder: check.folder, warning: check.warning };
  });
  return res.ok ? { ...res, message } : res;
}

/** Owner only: stop copying backups to a second folder. */
export async function clearSecondFolderAction(): Promise<ActionResult<null>> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    const previous = await getSetting("backups.secondFolder");
    if (previous) {
      await setSetting("backups.secondFolder", null, user.id);
      await logActivity({
        actorId: user.id,
        type: "settings.updated",
        summary: `${user.name} stopped copying backups to ${previous}`,
        data: { key: "backups.secondFolder" },
      });
    }
    revalidatePath("/", "layout");
    return null;
  }, TEXTS.cleared);
}
