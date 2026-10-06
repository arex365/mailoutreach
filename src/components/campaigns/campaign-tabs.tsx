import Link from "next/link";
import { cn } from "@/lib/utils";
import { CAMPAIGN_TABS, CAMPAIGN_TAB_LABELS, campaignsHref, type CampaignTab, type CampaignTabCounts } from "./format";

/**
 * Drafts / Scheduled / Running / Paused / Finished (+ Cancelled once there is one), each with its
 * count. Links, so every tab has its own address; the active tab has an orange underline.
 */
export function CampaignTabs({ active, counts }: { active: CampaignTab; counts: CampaignTabCounts }) {
  const tabs = CAMPAIGN_TABS.filter((t) => t !== "cancelled" || counts.cancelled > 0 || active === "cancelled");
  return (
    <nav aria-label="Campaign status" className="border-b border-border px-4 md:px-6">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const isActive = t === active;
          return (
            <li key={t} className="shrink-0">
              <Link
                href={campaignsHref(t)}
                scroll={false}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative inline-flex h-10 items-center gap-1.5 rounded-t-md px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                  isActive && "font-medium text-foreground",
                )}
              >
                {CAMPAIGN_TAB_LABELS[t]}
                <span className={cn("tabular text-xs", isActive ? "text-foreground/80" : "text-muted-foreground")}>
                  {counts[t].toLocaleString("en-US")}
                </span>
                {isActive ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
