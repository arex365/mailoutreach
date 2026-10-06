import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** "Previous · Page 2 of 5 · Next" for server-paginated lists (Activity, Notifications). */
export function Pager({
  page,
  pageCount,
  hrefFor,
  total,
  noun,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
  total: number;
  noun: [string, string];
}) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 pt-4">
      <p className="text-sm text-muted-foreground tabular">
        Page {page} of {pageCount} · {total.toLocaleString("en-US")} {total === 1 ? noun[0] : noun[1]}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page - 1)} rel="prev">
              <ChevronLeft aria-hidden /> Newer
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <ChevronLeft aria-hidden /> Newer
          </Button>
        )}
        {page < pageCount ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page + 1)} rel="next">
              Older <ChevronRight aria-hidden />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Older <ChevronRight aria-hidden />
          </Button>
        )}
      </div>
    </nav>
  );
}
