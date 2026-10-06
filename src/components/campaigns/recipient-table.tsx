import Link from "next/link";
import Form from "next/form";
import { Pencil, Search, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  RECIPIENT_FILTERS,
  RECIPIENT_FILTER_LABELS,
  campaignPageHref,
  type RecipientCounts,
  type RecipientFilter,
  type RecipientRowView,
} from "./format";

/**
 * The people in a campaign: state filters with counts, a search box, and the table (cards on a
 * phone). Each person opens in the side panel (the address gets ?recipient=<id>). Server-rendered:
 * every link keeps the others' filter, search and page.
 */

export function RecipientFilters({
  campaignId,
  active,
  counts,
  q,
}: {
  campaignId: number;
  active: RecipientFilter;
  counts: RecipientCounts;
  q: string;
}) {
  const shown = RECIPIENT_FILTERS.filter((f) => f === "all" || f === "active" || counts[f] > 0 || f === active);
  return (
    <div className="grid gap-3">
      <nav aria-label="Show people" className="border-b border-border">
        <ul className="-mb-px flex gap-1 overflow-x-auto">
          {shown.map((f) => {
            const isActive = f === active;
            return (
              <li key={f} className="shrink-0">
                <Link
                  href={campaignPageHref(campaignId, { filter: f, q })}
                  scroll={false}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "relative inline-flex h-9 items-center gap-1.5 px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                    isActive && "font-medium text-foreground",
                  )}
                >
                  {RECIPIENT_FILTER_LABELS[f]}
                  <span className={cn("tabular text-xs", isActive ? "text-foreground/80" : "text-muted-foreground")}>
                    {counts[f].toLocaleString("en-US")}
                  </span>
                  {isActive ? <span aria-hidden className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <Form action={`/campaigns/${campaignId}`} scroll={false} replace className="flex max-w-md items-center gap-2" role="search">
        {active !== "all" ? <input type="hidden" name="filter" value={active} /> : null}
        <label htmlFor="recipient-search" className="sr-only">
          Search people in this campaign
        </label>
        <Input id="recipient-search" name="q" type="search" defaultValue={q} placeholder="Search name, email or company" autoComplete="off" />
        <Button type="submit" variant="outline">
          <Search aria-hidden />
          Search
        </Button>
        {q ? (
          <Button asChild variant="ghost">
            <Link href={campaignPageHref(campaignId, { filter: active })} scroll={false}>
              Clear
            </Link>
          </Button>
        ) : null}
      </Form>
    </div>
  );
}

function Flags({ row }: { row: RecipientRowView }) {
  if (!row.edited && !row.problem) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {row.problem ? (
        <span className="inline-flex h-5 items-center gap-1 rounded-full border border-destructive/40 px-1.5 text-[11px] font-medium text-destructive">
          <TriangleAlert className="size-3" aria-hidden />
          Needs a look
        </span>
      ) : null}
      {row.edited ? (
        <span
          className="inline-flex h-5 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] font-medium text-muted-foreground"
          title="Someone edited an email for this person only"
        >
          <Pencil className="size-3" aria-hidden />
          Edited
        </span>
      ) : null}
    </span>
  );
}

export function RecipientTable({ rows, selectedId }: { rows: RecipientRowView[]; selectedId: number | null }) {
  return (
    <div>
      {/* Laptop and tablet: a table. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">People in this campaign. Open a name to see their emails and timeline.</caption>
          <thead className="border-b border-border">
            <tr>
              {["Person", "Company", "Where they are", "Last email"].map((h) => (
                <th key={h} scope="col" className="h-10 px-2 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-0">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                data-state={selectedId === r.id ? "selected" : undefined}
                className={cn("border-b border-border align-top data-[state=selected]:bg-muted", r.leftOut && "text-muted-foreground")}
              >
                <td className="max-w-72 py-2 pr-2">
                  <div className="grid min-w-0 gap-0.5">
                    <Link href={r.href} scroll={false} className="truncate font-medium text-foreground underline-offset-4 hover:underline">
                      {r.name}
                    </Link>
                    <span className="truncate text-xs text-muted-foreground">{r.email}</span>
                  </div>
                </td>
                <td className="max-w-56 px-2 py-2">
                  {r.companyHref ? (
                    <Link href={r.companyHref} className="block truncate underline-offset-4 hover:underline">
                      {r.companyName}
                    </Link>
                  ) : (
                    <span className="block truncate text-muted-foreground">{r.companyName}</span>
                  )}
                </td>
                <td className="px-2 py-2">
                  <div className="grid gap-1">
                    <span>{r.stateText}</span>
                    <Flags row={r} />
                  </div>
                </td>
                <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">{r.lastSent ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: cards. */}
      <ul className="grid gap-2 md:hidden" aria-label="People in this campaign">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={r.href}
              scroll={false}
              className={cn(
                "grid gap-1 rounded-lg border border-border bg-card p-3 text-sm",
                selectedId === r.id && "border-foreground/30 bg-muted",
                r.leftOut && "text-muted-foreground",
              )}
            >
              <span className="truncate font-medium">{r.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {r.email} · {r.companyName}
              </span>
              <span>{r.stateText}</span>
              {r.lastSent ? <span className="text-xs text-muted-foreground">{r.lastSent}</span> : null}
              <Flags row={r} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
