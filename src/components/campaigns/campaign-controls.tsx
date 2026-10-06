"use client";

import { useState } from "react";
import { Ban, Pause, Play } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cancelCampaignAction, pauseCampaignAction, resumeCampaignAction } from "@/app/(app)/campaigns/[id]/actions";
import type { CampaignStatusValue } from "./format";
import { useHoldLiveRefresh } from "./live-refresh";
import { useCampaignAction } from "./use-campaign-action";

/**
 * Pause / Resume / Cancel for one campaign (the engine decides; its message is toasted).
 * Resume is the page's primary button while the campaign is paused; Cancel asks first.
 */
export function CampaignControls({ campaignId, name, status }: { campaignId: number; name: string; status: CampaignStatusValue }) {
  const { pending, run } = useCampaignAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  useHoldLiveRefresh(confirmCancel);

  const canPause = status === "RUNNING" || status === "SCHEDULED";
  const canResume = status === "PAUSED";
  const canCancel = status === "RUNNING" || status === "SCHEDULED" || status === "PAUSED";
  if (!canPause && !canResume && !canCancel) return null;

  return (
    <>
      {canResume ? (
        <Button disabled={pending} onClick={() => run(() => resumeCampaignAction({ campaignId }), { toastError: true })}>
          <Play aria-hidden />
          {pending ? "Resuming…" : "Resume"}
        </Button>
      ) : null}
      {canPause ? (
        <Button variant="outline" disabled={pending} onClick={() => run(() => pauseCampaignAction({ campaignId }), { toastError: true })}>
          <Pause aria-hidden />
          {pending ? "Pausing…" : "Pause"}
        </Button>
      ) : null}
      {canCancel ? (
        <Button variant="destructive" disabled={pending} onClick={() => setConfirmCancel(true)}>
          <Ban aria-hidden />
          Cancel campaign
        </Button>
      ) : null}
      <AlertDialog
        open={confirmCancel}
        onOpenChange={(open) => {
          if (!pending) setConfirmCancel(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel &ldquo;{name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Emails waiting to send won&apos;t be sent, and nobody in this campaign gets anything more from it. Emails
              already sent stay where they are. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep the campaign</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                run(() => cancelCampaignAction({ campaignId }), { toastError: true, onSuccess: () => setConfirmCancel(false) });
              }}
            >
              {pending ? "Cancelling…" : "Cancel campaign"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
