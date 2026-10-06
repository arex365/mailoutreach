"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { simulateEmailAction, simulateReplyAction } from "@/app/(app)/campaigns/outbox/actions";

type Kind = "delivered" | "bounce" | "complaint" | "unsubscribe";
type ReplyKind = "reply" | "out-of-office" | "unclear";

type ButtonDef = { group: "event"; kind: Kind; label: string } | { group: "reply"; kind: ReplyKind; label: string };

/** The Simulate row's buttons, in order (M4-DESIGN §9.5): Mailgun's reports first, then the person's answers. */
export const SIMULATE_BUTTONS: readonly ButtonDef[] = [
  { group: "event", kind: "delivered", label: "Delivered" },
  { group: "event", kind: "bounce", label: "Bounce" },
  { group: "event", kind: "complaint", label: "Complaint" },
  { group: "event", kind: "unsubscribe", label: "Unsubscribe" },
  { group: "reply", kind: "reply", label: "Reply" },
  { group: "reply", kind: "out-of-office", label: "Out-of-office" },
  { group: "reply", kind: "unclear", label: "Unclear reply" },
];

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/**
 * The dry-run outbox's "Simulate" row (M3-DESIGN §5.9, M4-DESIGN §7.1, §9.5): pretend Mailgun reported back about this
 * email, or that the person answered it, to see what the app does. Each kind can be simulated once per email; the
 * results line shows what the email now records and the replies linked to it.
 *
 * `replies` (default true): false hides the Reply, Out-of-office and Unclear reply buttons (own-mailbox mode, where
 * replies never pass through the app, MAIN-DOMAIN-DESIGN O19, §3.7); Delivered, Bounce, Complaint and Unsubscribe stay.
 */
export function SimulateButtons({
  emailId,
  done,
  repliesDone = [],
  resultLine,
  practiceCopy,
  replies = true,
}: {
  emailId: number;
  done: Kind[];
  repliesDone?: ReplyKind[];
  resultLine: string;
  practiceCopy: boolean;
  /** False: only Mailgun's reports can be simulated (own-mailbox mode). */
  replies?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function simulate(b: ButtonDef) {
    setError(null);
    setRunning(b.kind);
    startTransition(async () => {
      try {
        const res =
          b.group === "event" ? await simulateEmailAction({ emailId, kind: b.kind }) : await simulateReplyAction({ emailId, kind: b.kind });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.data.message);
        router.refresh();
      } catch {
        setError(OFFLINE);
      } finally {
        setRunning(null);
      }
    });
  }

  const isDone = (b: ButtonDef) => (b.group === "event" ? done.includes(b.kind) : repliesDone.includes(b.kind));
  const buttons = replies ? SIMULATE_BUTTONS : SIMULATE_BUTTONS.filter((b) => b.group === "event");

  return (
    <section aria-labelledby={`simulate-${emailId}`} className="grid gap-2 rounded-lg border border-border p-4">
      <h3 id={`simulate-${emailId}`} className="text-sm font-medium">
        Simulate
      </h3>
      <p className="text-sm text-muted-foreground">
        {replies ? "Test what happens when Mailgun reports back, or when the person answers." : "Test what happens when Mailgun reports back."}{" "}
        {practiceCopy
          ? "In the practice copy this changes the person too, like a real event."
          : "In a dry run this only changes this campaign."}
      </p>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <Button
            key={b.kind}
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || isDone(b)}
            aria-pressed={isDone(b) ? true : undefined}
            onClick={() => simulate(b)}
          >
            {running === b.kind ? "Simulating…" : b.label}
          </Button>
        ))}
      </div>
      <p className="text-sm" role="status" aria-live="polite">
        <span className="text-muted-foreground">Results: </span>
        {resultLine}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
