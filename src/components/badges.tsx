import { ArrowDown, Ban } from "lucide-react";
import {
  COMPANY_STATUS_LABELS,
  PRIORITY_LABELS,
  VERIFICATION_LABELS,
  type CompanyStatusValue,
  type PriorityValue,
} from "@/core/labels";
import { cn } from "@/lib/utils";

/** Status chips always show the word (never colour alone). Muted colours, never orange. */
const STATUS_CLASSES: Record<CompanyStatusValue, string> = {
  NOT_CONTACTED: "text-status-not-contacted border-status-not-contacted/30 bg-status-not-contacted/10",
  CONTACTED: "text-status-contacted border-status-contacted/30 bg-status-contacted/10",
  REPLIED: "text-status-replied border-status-replied/30 bg-status-replied/10",
  CLIENT: "text-status-client border-status-client/30 bg-status-client/10",
  NOT_INTERESTED: "text-status-not-interested border-status-not-interested/30 bg-status-not-interested/10",
  DO_NOT_CONTACT: "text-status-do-not-contact border-status-do-not-contact/40 bg-status-do-not-contact/10",
};

export function StatusBadge({ status, className }: { status: CompanyStatusValue; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-xs font-medium",
        STATUS_CLASSES[status],
        className,
      )}
    >
      {status === "DO_NOT_CONTACT" ? <Ban className="size-3" aria-hidden /> : null}
      {COMPANY_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Priority as a word. High is bold, Low carries a small down arrow: both stay at full text
 * contrast (a faded "Low" failed the 4.5:1 contrast check on ticked and hovered rows), so they're
 * told apart by weight and shape, never by colour alone.
 */
export function PriorityBadge({ priority, className }: { priority: PriorityValue; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-0.5 whitespace-nowrap rounded-md px-1.5 text-xs",
        priority === "HIGH" ? "font-semibold text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {priority === "LOW" ? <ArrowDown className="size-3" aria-hidden /> : null}
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

/** What each address check result means, for the badge's tooltip (M5-DESIGN §2.3, §6.5). */
export const VERIFICATION_TIPS: Readonly<Record<string, string>> = {
  VALID: "The address check says this mailbox exists.",
  RISKY: "The address check rated this address high risk.",
  CATCH_ALL: "The mail server accepts every address, so nobody can confirm this person exists.",
  UNKNOWN: "The address check got no answer.",
  INVALID: "The address check says this address doesn't exist.",
  DO_NOT_SEND: "The address check says not to email this address.",
};

/** The tooltip of an address check badge: what the result means, or that the address wasn't checked yet. */
export function verificationTip(status: string | null | undefined): string {
  if (!status) return "This address hasn't been checked yet.";
  return VERIFICATION_TIPS[status] ?? "The result of the last address check.";
}

export function VerificationBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const label = status ? (VERIFICATION_LABELS[status] ?? status) : "Not checked";
  const tone =
    status === "VALID"
      ? "text-success border-success/30"
      : status === "INVALID" || status === "DO_NOT_SEND"
        ? "text-destructive border-destructive/40"
        : status === "RISKY" || status === "CATCH_ALL"
          ? "text-warning border-warning/30"
          : "text-muted-foreground border-border";
  return (
    <span
      className={cn("inline-flex h-5 items-center whitespace-nowrap rounded-full border px-1.5 text-[11px] font-medium", tone, className)}
      title={verificationTip(status)}
    >
      {label}
    </span>
  );
}

/** Small neutral pill for flags like Unsubscribed / Bounced / Complained / Replied. */
export function FlagBadge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "danger" | "good" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center whitespace-nowrap rounded-full border px-1.5 text-[11px] font-medium",
        tone === "danger" && "border-destructive/40 text-destructive",
        tone === "good" && "border-success/30 text-success",
        tone === "neutral" && "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
