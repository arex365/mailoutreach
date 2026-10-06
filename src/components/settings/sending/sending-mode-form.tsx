"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { FormError } from "@/components/forms/field";
import { cn } from "@/lib/utils";
import { setSendingModeAction } from "@/app/(app)/settings/sending/actions";
import { liveConfirmText, stillSendingWarning } from "./texts";
import type { ModeOptionView, SendingModeKey } from "../types";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/**
 * Settings › Sending & Mailgun › Sending mode (M3-DESIGN §5.2): Dry run, Test mode, Live ("Live (test list only)"
 * before go-live, M6-DESIGN §2.7). A mode that can't be chosen yet shows what's missing. Switching to Live asks first
 * (who real email reaches, before or after go-live); switching away while test or live campaigns are still sending
 * warns (never blocks). "Save mode" is an outline button: the page's orange action is elsewhere.
 */
export function SendingModeForm({
  current,
  options,
  testList,
  activeCampaigns,
  goLive = false,
  ownMailbox = false,
}: {
  current: SendingModeKey;
  options: ModeOptionView[];
  testList: string[];
  activeCampaigns: Array<{ name: string; mode: string }>;
  /** Setting "sending.goLive": the Live confirmation says who real email reaches. */
  goLive?: boolean;
  /** Own-mailbox mode (review SCREENS-11): the Live confirmation names "your inbox for test emails". Absent = app mode. */
  ownMailbox?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<SendingModeKey>(current);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const warning = current !== "DRY_RUN" && mode !== current ? stillSendingWarning(activeCampaigns) : null;

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await setSendingModeAction({ mode });
        if (!res.ok) {
          setError(res.error);
          setConfirming(false);
          return;
        }
        toast.success(res.message ?? "Saved.");
        setConfirming(false);
        router.refresh();
      } catch {
        setError(OFFLINE);
        setConfirming(false);
      }
    });
  }

  function onSave() {
    if (mode === current) {
      toast.success("Nothing changed, so there was nothing to save.");
      return;
    }
    if (mode === "LIVE" || warning) setConfirming(true);
    else save();
  }

  return (
    <div className="grid gap-4">
      <FormError message={error} />
      <RadioGroup value={mode} onValueChange={(v) => setMode(v as SendingModeKey)} className="grid gap-3" aria-label="Sending mode">
        {options.map((o) => {
          const disabled = o.key !== current && o.blockers.length > 0;
          const id = `mode-${o.key}`;
          return (
            <div
              key={o.key}
              className={cn("grid gap-1.5 rounded-lg border p-3", mode === o.key ? "border-foreground/30" : "border-border", disabled && "opacity-80")}
            >
              <div className="flex items-start gap-2.5">
                <RadioGroupItem id={id} value={o.key} disabled={disabled} className="mt-0.5" aria-describedby={`${id}-text`} />
                <div className="grid gap-1">
                  <Label htmlFor={id} className="font-medium">
                    {o.title}
                    {o.key === current ? <span className="ml-2 text-xs font-normal text-muted-foreground">Current</span> : null}
                  </Label>
                  <p id={`${id}-text`} className="text-sm text-muted-foreground">
                    {o.text}
                  </p>
                </div>
              </div>
              {o.blockers.length > 0 ? (
                <div className="grid gap-1 pl-6.5 text-sm">
                  <p className="font-medium">{o.key === current ? "Not ready any more:" : "Not available yet:"}</p>
                  <ul className="grid gap-0.5 pl-4">
                    {o.blockers.map((b) => (
                      <li key={b} className="list-disc">
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {o.warnings.map((w) => (
                <p key={w} className="flex items-start gap-1.5 pl-6.5 text-sm text-warning">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {w}
                </p>
              ))}
            </div>
          );
        })}
      </RadioGroup>
      <div>
        <Button variant="outline" onClick={onSave} disabled={pending}>
          {pending ? "Saving…" : "Save mode"}
        </Button>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{mode === "LIVE" ? "Switch to live?" : "Change the sending mode?"}</DialogTitle>
            <DialogDescription asChild>
              <div className="grid gap-2">
                {mode === "LIVE" ? <p>{liveConfirmText(testList, goLive, ownMailbox)}</p> : null}
                {warning ? <p className="text-warning">{warning}</p> : null}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : mode === "LIVE" ? "Switch to live" : "Save mode"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
