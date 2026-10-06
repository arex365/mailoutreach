"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FormError } from "@/components/forms/field";
import { pauseAllAction } from "@/app/(app)/settings/sending/actions";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/** "Pause all sending" (M3-DESIGN §5.2): stops every campaign, dry runs included, after a confirmation with an optional reason. */
export function PauseAllButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pause(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await pauseAllAction({ why: why.trim() || null });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.message ?? "All sending is paused.");
        setOpen(false);
        setWhy("");
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Pause all sending
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={pause} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Pause all sending?</DialogTitle>
              <DialogDescription>
                Nothing is sent, not even to the dry-run outbox, until you click Resume. Campaigns stay as they are.
              </DialogDescription>
            </DialogHeader>
            <Field label="Why (optional)" htmlFor="pause-why" hint="Shown in the top bar, for example “checking a complaint”.">
              <Input id="pause-why" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={100} autoComplete="off" />
            </Field>
            <FormError message={error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? "Pausing…" : "Pause all sending"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
