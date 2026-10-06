import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { SendModeValue } from "@/core/rules/mode";
import { DraftTitle } from "./draft-title";
import { WizardStepper } from "./stepper";
import type { WizardStepKey } from "./steps";

/**
 * The wizard's mode badge (M3-DESIGN §5.8, M6-DESIGN §2.7): "Dry run", "Test mode", and "Live (test list only)" before
 * go-live, "Live" after it. Every wizard page passes today's go-live.
 */
export function wizardModeText(mode: SendModeValue, goLive = false): string {
  if (mode === "LIVE") return goLive ? "Live" : "Live (test list only)";
  if (mode === "TEST") return "Test mode";
  return "Dry run";
}

/**
 * The frame around every wizard step: back to Campaigns, the draft's name (rename / delete), a
 * short line about the draft with the mode it would launch with, the stepper, then the step itself
 * (which ends with its StepFooter). What stops a launch in this mode is shown on the Schedule step.
 */
export function WizardFrame({
  campaign,
  current,
  mode,
  goLive = false,
  children,
}: {
  campaign: { id: number; name: string; wizardStep: number };
  current: WizardStepKey;
  /** The mode it would launch with (Setting "sending.mode"). */
  mode: SendModeValue;
  /** Setting "sending.goLive" (the badge reads "Live" instead of "Live (test list only)" after go-live). */
  goLive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
      <div className="px-4 pt-6 pb-2 md:px-6">
        <Link href="/campaigns" className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
          Campaigns
        </Link>
        <DraftTitle key={campaign.name} campaignId={campaign.id} name={campaign.name} />
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>Draft</span>
          <span aria-hidden>·</span>
          <span className="inline-flex h-5 items-center rounded-full border border-border px-1.5 text-[11px] font-medium text-foreground">
            {wizardModeText(mode, goLive)}
          </span>
          <span aria-hidden>·</span>
          <span>Changes save automatically</span>
        </p>
        <WizardStepper campaignId={campaign.id} current={current} furthest={campaign.wizardStep} className="mt-5" />
      </div>
      <div className="flex flex-1 flex-col px-4 pt-4 md:px-6">{children}</div>
    </div>
  );
}

/** A step's heading and one-line explanation. */
export function StepIntro({ title, children, actions }: { title: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {children ? <div className="mt-1 max-w-3xl text-sm text-muted-foreground">{children}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
