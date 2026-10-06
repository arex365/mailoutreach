"use client";

import { useId, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { GO_LIVE_COPY } from "@/core/sending/go-live-copy";
import type { GoLiveCardView } from "../types";
import { GoLiveDialog } from "./go-live-dialog";

/**
 * Settings › Sending & Mailgun › Go live (M6-DESIGN §2.5; anchor #go-live, after "Test list"), in its four states:
 * the practice copy (the description alone); not live with blockers (the switch off and disabled, "Before going live:",
 * "Recommended first:" and the guide line); not live and ready (turning the switch on opens the confirmation); live
 * (the switch on and disabled, the warm-up line and "This can't be switched off."). A checked switch shows the
 * "selected" fill, which isn't a button, so the page keeps one orange button (§5.1 R1). Shared From address
 * (SHARED-FROM-DESIGN §3.3): live, the From line comes first under the live line; the dialog gets the spam-placement
 * tick when the view has one. Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.4): the dialog also gets the replies tick and,
 * while unsubscribe links use http, the http-links tick.
 */
export function GoLiveCard({ view }: { view: GoLiveCardView }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const live = view.state === "live";
  const listsId = `${id}-lists`;

  return (
    <Card id="go-live" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>{view.title}</CardTitle>
        <CardDescription>{view.description}</CardDescription>
      </CardHeader>
      {view.state === "practice" ? null : (
        <CardContent className="grid gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-switch`}
              checked={live}
              disabled={view.state !== "ready"}
              onCheckedChange={(on) => {
                if (on) setOpen(true);
              }}
              aria-describedby={view.blockers.length > 0 || view.recommendations.length > 0 ? listsId : undefined}
            />
            <Label htmlFor={`${id}-switch`} className={cn(view.state === "ready" ? undefined : "text-muted-foreground")}>
              {GO_LIVE_COPY.switchLabel}
            </Label>
          </div>

          {live ? (
            <div className="grid gap-1.5 text-sm">
              {view.fromLine ? <p className="[overflow-wrap:anywhere]">{view.fromLine}</p> : null}
              {view.warmupLine ? <p>{view.warmupLine}</p> : null}
              {view.cantSwitchOff ? <p className="text-muted-foreground">{view.cantSwitchOff}</p> : null}
            </div>
          ) : null}

          {view.blockers.length > 0 || view.recommendations.length > 0 ? (
            <div id={listsId} className="grid gap-3 text-sm">
              {view.blockers.length > 0 ? (
                <div className="grid gap-1">
                  <p className="font-medium">{GO_LIVE_COPY.blockersHeading}</p>
                  <ul className="grid gap-0.5 pl-4">
                    {view.blockers.map((b) => (
                      <li key={b} className="list-disc break-words">
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {view.recommendations.length > 0 ? (
                <div className="grid gap-1">
                  <p className="font-medium">{GO_LIVE_COPY.recommendationsHeading}</p>
                  <ul className="grid gap-0.5 pl-4 text-muted-foreground">
                    {view.recommendations.map((r) => (
                      <li key={r} className="list-disc break-words">
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {view.guideLine ? <p className="text-sm text-muted-foreground">{view.guideLine}</p> : null}
        </CardContent>
      )}
      {view.state === "ready" ? (
        <GoLiveDialog
          open={open}
          onOpenChange={setOpen}
          items={view.dialogItems}
          spamPlacementTick={view.spamPlacementTick ?? null}
          ownMailboxTick={view.ownMailboxTick ?? null}
          httpLinksTick={view.httpLinksTick ?? null}
        />
      ) : null}
    </Card>
  );
}
