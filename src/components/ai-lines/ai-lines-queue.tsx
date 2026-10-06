import Link from "next/link";
import type { AiQueueTab } from "@/core/ai/types";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/page-header";
import { ListPager } from "@/components/campaigns/pager";
import { DraftCard } from "./draft-card";
import { aiLinesHref, EMPTY_TABS, pagerNoun, type DraftCardDisplay } from "./format";
import { AiQueueTabs } from "./queue-tabs";

/**
 * The review queue on the AI lines page (docs/dev/M5-DESIGN.md §6.7): the tabs with their counts, 20 cards per page
 * with the existing pager, and each tab's empty state with one next step. `emptyPrimary`: the Waiting tab's
 * [Go to Contacts] is the page's orange button unless something else is (Resume drafting while paused).
 */
export function AiLinesQueue({
  tab,
  counts,
  cards,
  page,
  pageCount,
  emptyPrimary,
}: {
  tab: AiQueueTab;
  counts: Record<AiQueueTab, number>;
  cards: DraftCardDisplay[];
  page: number;
  pageCount: number;
  emptyPrimary: boolean;
}) {
  const empty = EMPTY_TABS[tab];
  return (
    // grid-cols-1 (minmax(0, 1fr)), not the implicit auto column: the five tabs are wider than a phone, and an auto
    // column would take their full width and widen the page instead of letting the row scroll.
    <div className="grid grid-cols-1 gap-4">
      <AiQueueTabs active={tab} counts={counts} />
      {cards.length === 0 ? (
        <EmptyState
          title={empty.title}
          description={empty.description ?? undefined}
          actions={
            empty.next === "contacts" ? (
              <Button asChild variant={emptyPrimary ? "default" : "outline"}>
                <Link href="/contacts">Go to Contacts</Link>
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link href={aiLinesHref("waiting")}>Open the Waiting tab</Link>
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {cards.map((card) => (
            // A new status or Undo window is a new card (its local state starts again).
            <DraftCard key={`${card.id}:${card.status}:${card.canUndoUntil ?? ""}`} card={card} />
          ))}
        </div>
      )}
      <ListPager
        page={page}
        pageCount={pageCount}
        total={counts[tab] ?? 0}
        noun={pagerNoun(tab)}
        hrefFor={(p) => aiLinesHref(tab, p)}
      />
    </div>
  );
}
