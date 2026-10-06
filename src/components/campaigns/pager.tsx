import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** "Page 2 of 5 · 230 people" with Previous / Next links (server-paginated lists). Hidden for one page. */
export function ListPager({
  page,
  pageCount,
  total,
  noun,
  hrefFor,
  labels = ["Previous", "Next"],
}: {
  page: number;
  pageCount: number;
  total: number;
  noun: [string, string];
  hrefFor: (page: number) => string;
  labels?: [string, string];
}) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <p className="text-sm text-muted-foreground tabular">
        Page {page.toLocaleString("en-US")} of {pageCount.toLocaleString("en-US")} · {total.toLocaleString("en-US")}{" "}
        {total === 1 ? noun[0] : noun[1]}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page - 1)} rel="prev" scroll={false}>
              <ChevronLeft aria-hidden /> {labels[0]}
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <ChevronLeft aria-hidden /> {labels[0]}
          </Button>
        )}
        {page < pageCount ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page + 1)} rel="next" scroll={false}>
              {labels[1]} <ChevronRight aria-hidden />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            {labels[1]} <ChevronRight aria-hidden />
          </Button>
        )}
      </div>
    </nav>
  );
}
