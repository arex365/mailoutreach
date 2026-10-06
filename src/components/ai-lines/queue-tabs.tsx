import Link from "next/link";
import { AI_QUEUE_TABS, type AiQueueTab } from "@/core/ai/types";
import { cn } from "@/lib/utils";
import { aiLinesHref, tabLabel } from "./format";

/**
 * Waiting (27) · Approved (140) · Rejected (12) · No line (9) · Failed (1): links (`?tab=`), so every tab has its own
 * address; the active tab has an orange underline ("selected"); the row scrolls sideways on a phone, inside the named
 * nav (min-w-0, so the row's full width never becomes the page's).
 */
export function AiQueueTabs({ active, counts }: { active: AiQueueTab; counts: Record<AiQueueTab, number> }) {
  return (
    <nav aria-label="AI line tabs" className="min-w-0 border-b border-border">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {AI_QUEUE_TABS.map((t) => {
          const isActive = t === active;
          return (
            <li key={t} className="shrink-0">
              <Link
                href={aiLinesHref(t)}
                scroll={false}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative inline-flex h-10 items-center rounded-t-md px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                  isActive && "font-medium text-foreground",
                )}
              >
                {tabLabel(t, counts[t] ?? 0)}
                {isActive ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
