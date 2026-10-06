"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Info } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { TEAM_FROM_TEXTS, senderAddressWords } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { cn } from "@/lib/utils";
import { setSenderAction } from "@/app/(app)/campaigns/[id]/setup/actions";
import type { SenderChoice } from "@/server/services/campaigns/draft";
import { StepFooter } from "./step-footer";
import { StepIntro } from "./wizard-frame";

const OFFLINE = "Couldn't reach the app, so the sender didn't change. Check your connection and try again.";

/** "Replies reach Ali" / "Reply route not working" / null (no address yet). */
export function routeText(s: Pick<SenderChoice, "name" | "address" | "routeOk">): string | null {
  if (!s.address) return null;
  return s.routeOk ? `Replies reach ${s.name}` : "Reply route not working";
}

/** "Daily limit: 100" / "No limit of their own". */
export function dailyCapText(cap: number | null): string {
  return cap === null ? "No limit of their own" : `Daily limit: ${cap.toLocaleString("en-US")}`;
}

/**
 * Step 2, Sender: any active teammate can send (default: whoever started the draft). Shows how the
 * emails will look to recipients (display name, From line, the signature), each teammate's sending
 * address, their own daily limit and whether their reply route works (M3-DESIGN §5.8). When the
 * person who launches isn't the sender, the engine notifies the sender at launch.
 *
 * Shared From address (`teamFrom`, SHARED-FROM-DESIGN §3.7): "Recipients see" shows the shared From line, each
 * teammate's own address is their "Reply address" (F19), and two lines say where the From address is set and that
 * replies written straight to it don't reach the app. Without `teamFrom` the step is exactly as before.
 *
 * Own-mailbox mode (`ownMailbox`, MAIN-DOMAIN-DESIGN §3.7): "Recipients see" the From line (display name with the own
 * From); nobody has an address of their own or a reply route, so neither line shows; the bottom line says where names,
 * signatures, the From address and the limits are set, then the reminder that replies land only in the own mailbox
 * (live follow-ups wait for the day's inbox check). While no From fits, the From address problem shows instead.
 */
export function SenderStep({
  campaignId,
  senders,
  selectedId,
  viewerId,
  teamFrom = null,
  ownMailbox = null,
}: {
  campaignId: number;
  senders: SenderChoice[];
  selectedId: number | null;
  viewerId: number;
  /** The shared From address, or null in per-person mode. */
  teamFrom?: string | null;
  /** Own-mailbox mode: the own From (null while none fits) and, then, why test and live campaigns can't start. */
  ownMailbox?: { from: string | null; problem: string | null } | null;
}) {
  const [selected, setSelected] = useState<number | null>(selectedId);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [, startTransition] = useTransition();
  const chosen = senders.find((s) => s.id === selected) ?? null;
  const missingSender = selected !== null && !chosen;
  const words = senderAddressWords(Boolean(teamFrom));
  const own = ownMailbox !== null;

  function choose(value: string) {
    const id = Number(value);
    if (!Number.isInteger(id) || id === selected) return;
    const previous = selected;
    setSelected(id);
    setStatus("saving");
    startTransition(async () => {
      try {
        const res = await setSenderAction({ campaignId, senderId: id });
        if (!res.ok) {
          setSelected(previous);
          setStatus("idle");
          toast.error(res.error);
          return;
        }
        setStatus("saved");
      } catch {
        setSelected(previous);
        setStatus("idle");
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <div className="flex flex-1 flex-col">
      <StepIntro title="Who sends it">
        {own ? (
          <>The emails go out in this teammate&apos;s name, with their signature.</>
        ) : (
          <>The emails go out in this teammate&apos;s name, with their signature, and replies go to them.</>
        )}
      </StepIntro>

      {missingSender ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          The sender chosen before can&apos;t send any more (their account is switched off). Pick someone else.
        </p>
      ) : null}

      <RadioGroup
        value={selected !== null && chosen ? String(selected) : ""}
        onValueChange={choose}
        aria-label="Sender"
        className="grid max-w-4xl gap-3 md:grid-cols-2"
      >
        {senders.map((s) => {
          const id = `sender-${s.id}`;
          const isSelected = s.id === selected;
          return (
            <label
              key={s.id}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/40",
                isSelected && "border-primary/60",
              )}
            >
              <RadioGroupItem id={id} value={String(s.id)} className="mt-1" />
              <span className="grid min-w-0 flex-1 gap-2">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{s.name}</span>
                  {s.id === viewerId ? <span className="text-xs text-muted-foreground">You</span> : null}
                </span>
                <span className="grid gap-0.5 text-sm">
                  <span className="text-xs text-muted-foreground">Recipients see</span>
                  <span className="break-words">{s.fromLine}</span>
                </span>
                {own ? (
                  // Own-mailbox mode: no address of their own and no reply route (MAIN-DOMAIN-DESIGN §3.7).
                  <span className="text-xs text-muted-foreground">{dailyCapText(s.dailyCap)}</span>
                ) : (
                  <span className="grid gap-0.5 text-sm">
                    <span className="text-xs text-muted-foreground">{words.label}</span>
                    {s.address ? (
                      <span className="break-words">{s.address}</span>
                    ) : (
                      <span className="text-muted-foreground">{words.noneYet}</span>
                    )}
                    <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span>{dailyCapText(s.dailyCap)}</span>
                      {routeText(s) ? <span className={cn(!s.routeOk && "text-warning")}>{routeText(s)}</span> : null}
                    </span>
                  </span>
                )}
                <span className="grid gap-0.5 text-sm">
                  <span className="text-xs text-muted-foreground">Signature</span>
                  {s.signature.trim() ? (
                    <span className="text-sm leading-relaxed break-words whitespace-pre-wrap">{s.signature}</span>
                  ) : (
                    <span className="text-sm text-warning">
                      No signature yet, so {"{{sender_signature}}"} is empty. {s.id === viewerId ? "Add yours" : "They can add one"} in
                      Settings › My profile.
                    </span>
                  )}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>

      <div className="mt-4 grid max-w-4xl gap-2 text-sm text-muted-foreground">
        {chosen && chosen.id !== viewerId ? (
          <p className="flex items-start gap-2">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            {own ? (
              <>{chosen.name} gets a notification when you launch the campaign.</>
            ) : (
              <>
                {chosen.name} gets a notification when you launch the campaign, and replies go to {chosen.name}&apos;s inbox.
              </>
            )}
          </p>
        ) : null}
        {!own && chosen && !chosen.address ? (
          <p className="flex items-start gap-2">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            {teamFrom ? (
              <span>
                {chosen.name} has no {words.lower} yet: a dry run goes out without one, and test mode and live campaigns need
                one. {chosen.id === viewerId ? "Add yours" : `${chosen.name} can add one`} in Settings › My profile.
              </span>
            ) : (
              <span>
                {chosen.name} has no sending address yet: a dry run shows a placeholder address, and test mode and live campaigns
                need one. {chosen.id === viewerId ? "Add yours" : `${chosen.name} can add one`} in Settings › My profile.
              </span>
            )}
          </p>
        ) : null}
        {ownMailbox ? (
          <OwnMailboxLines from={ownMailbox.from} problem={ownMailbox.problem} />
        ) : teamFrom ? (
          <>
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {words.plural}, display names and signatures are set in{" "}
                <Link href="/settings/profile" className="underline underline-offset-3 hover:text-foreground">
                  Settings › My profile
                </Link>
                . The From address ({teamFrom}) is set by the Owner in Settings › Sending &amp; Mailgun. The Owner sets each
                teammate&apos;s own daily limit in Settings › Limits &amp; warm-up.
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">{TEAM_FROM_TEXTS.followUpReminder(teamFrom)}</span>
            </p>
          </>
        ) : (
          <p className="flex items-start gap-2">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Sending addresses, display names and signatures are set in{" "}
              <Link href="/settings/profile" className="underline underline-offset-3 hover:text-foreground">
                Settings › My profile
              </Link>
              . The Owner sets each teammate&apos;s own daily limit in Settings › Limits &amp; warm-up.
            </span>
          </p>
        )}
      </div>

      <StepFooter
        campaignId={campaignId}
        current="sender"
        note={
          <span aria-live="polite">{status === "saving" ? "Saving…" : status === "saved" && chosen ? `${chosen.name} will send it. Saved.` : null}</span>
        }
      />
    </div>
  );
}

/**
 * Own-mailbox mode's bottom lines (MAIN-DOMAIN-DESIGN §3.7): where names, signatures, the From address and the limits
 * are set, then the reminder that replies come only to the own From (live follow-ups wait for the day's inbox check).
 * While no From fits, the From address problem instead (test and live campaigns can't start without it).
 */
function OwnMailboxLines({ from, problem }: { from: string | null; problem: string | null }) {
  if (!from) {
    return problem ? (
      <p className="flex items-start gap-2 text-warning">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">{problem}</span>
      </p>
    ) : null;
  }
  return (
    <>
      <p className="flex items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">{OWN_MAILBOX_TEXTS.senderStepInfo(from)}</span>
      </p>
      <p className="flex items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">{OWN_MAILBOX_TEXTS.followUpReminder(from)}</span>
      </p>
    </>
  );
}
