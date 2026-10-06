import Link from "next/link";
import { Ban } from "lucide-react";
import { COMPANY_STATUSES, COMPANY_STATUS_LABELS, type CompanyStatusValue } from "@/core/labels";
import { cn } from "@/lib/utils";
import type { CompanyFilters } from "@/server/services/companies/filters";
import type { StatusCounts } from "@/server/services/companies/query";
import { statusHref } from "./url";

/**
 * Status tabs with counts (All / Not contacted / … / Do not contact). Each tab is a
 * link that keeps every other filter; the active tab has an orange underline.
 */
export function StatusTabs({ filters, counts }: { filters: CompanyFilters; counts: StatusCounts }) {
  const tabs: Array<{ status: CompanyStatusValue | undefined; label: string; count: number }> = [
    { status: undefined, label: "All", count: counts.all },
    ...COMPANY_STATUSES.map((s) => ({ status: s, label: COMPANY_STATUS_LABELS[s], count: counts.byStatus[s] })),
  ];
  return (
    <nav aria-label="Status" className="border-b border-border px-4 md:px-6">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const active = (filters.status ?? undefined) === t.status;
          return (
            <li key={t.label} className="shrink-0">
              <Link
                href={statusHref(filters, t.status)}
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative inline-flex h-10 items-center gap-1.5 rounded-t-md px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                  active && "font-medium text-foreground",
                )}
              >
                {t.status === "DO_NOT_CONTACT" ? <Ban className="size-3.5" aria-hidden /> : null}
                {t.label}
                <span className={cn("tabular text-xs", active ? "text-foreground/80" : "text-muted-foreground")}>
                  {t.count.toLocaleString("en-US")}
                </span>
                {/* Orange underline = selected. */}
                {active ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
