import { cn } from "@/lib/utils";
import { CAMPAIGN_STATUS_LABELS, EMAIL_STATUS_LABELS, modeBadgeText, type CampaignStatusValue, type SendModeValue, type SendStatusValue } from "./format";

/**
 * Small word badges for the campaign screens. Always a word, muted colours, never orange (orange
 * is only for the one primary button and "selected" markers, PLAN.md A6).
 */

const PILL = "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium";

const STATUS_TONE: Record<CampaignStatusValue, string> = {
  DRAFT: "border-dashed border-border text-muted-foreground",
  SCHEDULED: "border-border text-foreground",
  RUNNING: "border-foreground/30 text-foreground",
  PAUSED: "border-warning/40 bg-warning/10 text-warning",
  FINISHED: "border-border bg-muted text-muted-foreground",
  CANCELLED: "border-border text-muted-foreground",
};

export function CampaignStatusBadge({ status, className }: { status: CampaignStatusValue; className?: string }) {
  return (
    <span className={cn(PILL, STATUS_TONE[status], className)}>
      {status === "RUNNING" ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {CAMPAIGN_STATUS_LABELS[status]}
    </span>
  );
}

/** "Dry run" and "Test" are neutral grey; "Live" is green (the same as the top bar's label). */
export function ModeBadge({ mode, className }: { mode: SendModeValue | null | undefined; className?: string }) {
  const live = mode === "LIVE";
  return (
    <span
      className={cn(PILL, live ? "border-success/40 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground", className)}
      title={mode === "DRY_RUN" || !mode ? "Dry run: nothing leaves this PC. The emails go to the dry-run outbox." : undefined}
    >
      {modeBadgeText(mode)}
    </span>
  );
}

const EMAIL_TONE: Record<SendStatusValue, string> = {
  QUEUED: "border-border text-muted-foreground",
  SENDING: "border-foreground/30 text-foreground",
  SENT: "border-border bg-muted text-foreground",
  FAILED: "border-destructive/40 text-destructive",
  CANCELLED: "border-border text-muted-foreground",
  SKIPPED: "border-border text-muted-foreground",
  UNKNOWN: "border-warning/40 text-warning",
  UNCONFIRMED: "border-warning/40 text-warning",
};

/** One email's state in the words of PLAN.md A6 ("Waiting to send", "Didn't send"…). */
export function EmailStatusBadge({ status, className }: { status: SendStatusValue | null; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center whitespace-nowrap rounded-full border px-1.5 text-[11px] font-medium", status ? EMAIL_TONE[status] : "border-dashed border-border text-muted-foreground", className)}>
      {status ? EMAIL_STATUS_LABELS[status] : "Not sent yet"}
    </span>
  );
}
