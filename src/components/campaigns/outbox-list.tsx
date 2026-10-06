import Link from "next/link";
import { cn } from "@/lib/utils";

/** One outbox row, labels ready. */
export type OutboxRowView = {
  id: number;
  href: string;
  subject: string;
  to: string;
  companyName: string;
  campaignName: string;
  stepTitle: string;
  sentAt: string;
  sentAtIso: string;
  sentAgo: string;
};

/**
 * The dry-run outbox list, newest first: subject, who it was for, which campaign and step, and
 * when it "went". Each email opens in the side panel (?open=<id>). Server-rendered.
 */
export function OutboxList({ rows, openId }: { rows: OutboxRowView[]; openId: number | null }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card" aria-label="Emails in the dry-run outbox">
      {rows.map((r) => (
        <li key={r.id}>
          <Link
            href={r.href}
            scroll={false}
            aria-current={openId === r.id ? "true" : undefined}
            className={cn(
              "grid gap-1 px-4 py-3 text-sm transition-colors hover:bg-muted/50 md:grid-cols-[minmax(0,1fr)_auto] md:gap-x-4",
              openId === r.id && "bg-muted",
            )}
          >
            <span className="min-w-0 truncate font-medium">{r.subject || "No subject"}</span>
            <time dateTime={r.sentAtIso} title={r.sentAt} className="text-xs text-muted-foreground tabular md:row-span-2 md:text-right md:text-sm">
              {r.sentAgo}
            </time>
            <span className="min-w-0 truncate text-muted-foreground">
              To {r.to} · {r.companyName} · {r.campaignName}, {r.stepTitle.toLowerCase()}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
