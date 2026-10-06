import type { JobHandler } from "@/server/jobs";
import { isBackupKind, runBackup, type BackupKindValue } from "@/server/services/backups";
import { recordTaskSuccess } from "../periodic";
import type { JobDefinition } from "./types";

/** Payload of "backup.run": { kind: "AUTO" | "MANUAL" | "PRE_UPDATE" | "PRE_RESTORE" }. */
export function backupKindFromPayload(payload: unknown): BackupKindValue {
  const kind = payload && typeof payload === "object" ? (payload as { kind?: unknown }).kind : undefined;
  if (kind === undefined) return "MANUAL";
  if (!isBackupKind(kind)) throw new Error(`This backup task has an unknown kind ("${String(kind)}").`);
  return kind;
}

export const runBackupJob: JobHandler = async (payload, ctx) => {
  const kind = backupKindFromPayload(payload);
  const result = await runBackup({ kind, userId: kind === "MANUAL" ? ctx.createdById : null });
  if (kind === "AUTO") await recordTaskSuccess("backup.daily");
  return {
    summary: result.summary,
    fileName: result.fileName,
    sizeBytes: result.sizeBytes,
    kind: result.kind,
    copiedTo: result.copiedTo,
    copyError: result.copyError,
    removed: result.removed.length,
  };
};

const WHAT_TO_DO = "Check free disk space on the office PC, then click Back up now in Settings › Backups.";

export const backupJob: JobDefinition = {
  handler: runBackupJob,
  label: "The backup",
  whatToDo: WHAT_TO_DO,
  link: "/settings/backups",
  failureNotice: (payload, error) => {
    let kind: BackupKindValue = "MANUAL";
    try {
      kind = backupKindFromPayload(payload);
    } catch {
      /* keep the generic wording */
    }
    const what = kind === "AUTO" ? "The daily backup" : kind === "PRE_UPDATE" ? "The backup before the update" : "The backup";
    return {
      type: "backup.failed",
      title: `${what} failed`,
      body: `${what} failed: ${error.replace(/\.+$/, "")}. ${WHAT_TO_DO}`,
      link: "/settings/backups",
    };
  },
};
