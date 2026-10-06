"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/forms/field";
import { clearSecondFolderAction, saveSecondFolderAction } from "./actions";

/** The field's hint (M6-DESIGN §3.4): where a second copy helps, and the install-services.bat step after saving. */
const HINT =
  "A folder on another drive, a USB stick or a OneDrive folder, for example D:\\Backups (not a network folder or a mapped network drive). After saving, run install-services.bat on the office PC if the app runs as a Windows service.";

/** The call never reached the app (no connection, the office PC restarting): the same words as the other settings. */
export const SECOND_FOLDER_OFFLINE = {
  save: "Couldn't reach the app, so nothing was saved. Check your connection and try again.",
  clear: "Couldn't reach the app, so nothing changed. Check your connection and try again.",
} as const;

/**
 * Second backup folder: the Owner can change it; everyone else sees it read-only. After a save the toast says the first
 * copy is being made, and a warning about the folder (OneDrive, a USB stick, the same drive, no access yet) stays
 * under the field until the next change.
 */
export function SecondFolderForm({ value, canEdit }: { value: string | null; canEdit: boolean }) {
  const router = useRouter();
  const [folder, setFolder] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!canEdit) {
    return (
      <div className="grid gap-1 text-sm">
        <p className={value ? "break-all font-mono text-xs" : "text-muted-foreground"}>{value ?? "Not set up."}</p>
        <p className="text-muted-foreground">Only the Owner can change this.</p>
      </div>
    );
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setWarning(null);
    startTransition(async () => {
      try {
        const res = await saveSecondFolderAction({ folder });
        if (!res.ok) {
          setError(res.fieldErrors?.folder?.[0] ?? res.error);
          return;
        }
        setFolder(res.data.folder);
        setWarning(res.data.warning);
        toast.success(res.message ?? "Saved.");
        router.refresh();
      } catch {
        // The typed folder stays in the field (a thrown call would otherwise reach the error screen).
        setError(SECOND_FOLDER_OFFLINE.save);
      }
    });
  }

  function clear() {
    setError(null);
    setWarning(null);
    startTransition(async () => {
      try {
        const res = await clearSecondFolderAction();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setFolder("");
        toast.success(res.message ?? "Saved.");
        router.refresh();
      } catch {
        setError(SECOND_FOLDER_OFFLINE.clear);
      }
    });
  }

  const unchanged = folder.trim() === (value ?? "");
  return (
    <form onSubmit={save} className="grid gap-3" noValidate>
      <Field label="Second folder" htmlFor="second-folder" hint={HINT} error={error ?? undefined}>
        <Input
          id="second-folder"
          name="folder"
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value);
            setWarning(null);
          }}
          placeholder="D:\Backups"
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-sm"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "second-folder-error" : "second-folder-hint"}
        />
      </Field>
      {warning ? (
        <p role="status" className="text-sm text-warning">
          {warning}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={pending || !folder.trim() || unchanged}>
          {pending ? "Checking the folder…" : "Save folder"}
        </Button>
        {value ? (
          <Button type="button" variant="ghost" onClick={clear} disabled={pending}>
            Stop copying
          </Button>
        ) : null}
      </div>
    </form>
  );
}
