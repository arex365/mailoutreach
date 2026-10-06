"use client";

import { useMemo } from "react";
import {
  columnVisibilityFeature,
  createColumnHelper,
  functionalUpdate,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnVisibilityState,
  type PaginationState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { SortKey } from "@/server/services/companies/filters";
import { pageSummary, peopleSummary } from "./format";
import type { ContactRow } from "./types";

/**
 * The companies table. The server does the sorting and paging (manual mode);
 * TanStack Table handles the columns, their visibility and the sort/page state.
 * On phones (< 768 px) the same rows show as compact cards.
 */

type ColumnMetaInfo = {
  label: string;
  sortKey?: SortKey;
  /** Sort direction on first click (dates start newest first). */
  firstDir?: "asc" | "desc";
  cellClassName?: string;
  headClassName?: string;
};

const features = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
  rowPaginationFeature,
  columnMeta: {} as ColumnMetaInfo,
});

const helper = createColumnHelper<typeof features, ContactRow>();

/** Column id ↔ server sort key. */
const SORT_COLUMN: Record<SortKey, string> = {
  name: "company",
  country: "country",
  niche: "niche",
  priority: "priority",
  people: "people",
  lastEmailed: "lastEmailed",
  created: "created",
};

export const HIDEABLE_COLUMNS: Array<{ id: string; label: string }> = [
  { id: "country", label: "Country" },
  { id: "niche", label: "Niche" },
  { id: "priority", label: "Priority" },
  { id: "tags", label: "Tags" },
  { id: "created", label: "Added" },
];

/** Columns that hide first on narrower laptop screens. */
export const NARROW_HIDDEN = new Set(["country", "niche", "priority", "tags"]);

const Dash = () => (
  <span className="text-muted-foreground" aria-label="None">
    —
  </span>
);

function PeopleCell({ row }: { row: ContactRow }) {
  const s = peopleSummary(row.peopleCount, row.emailCount);
  if (s.missingEmail) {
    const title =
      row.peopleCount === 0
        ? "No people yet"
        : `${row.peopleCount} ${row.peopleCount === 1 ? "person" : "people"}, none with an email address`;
    return (
      <span className="text-warning/80" title={title}>
        {s.text}
      </span>
    );
  }
  return <span className="tabular">{s.text}</span>;
}

function buildColumns(
  customColumns: Array<{ key: string; label: string }>,
  onOpen: (row: ContactRow, e: React.MouseEvent) => void,
  companyHref: (id: number) => string,
) {
  return [
    helper.display({
      id: "company",
      header: "Company",
      enableHiding: false,
      meta: { label: "Company", sortKey: "name", firstDir: "asc", cellClassName: "min-w-52 max-w-80 whitespace-normal" },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="grid min-w-0 gap-0.5">
            <a
              href={companyHref(r.id)}
              onClick={(e) => onOpen(r, e)}
              className="truncate font-medium text-foreground underline-offset-4 hover:underline"
            >
              {r.name}
            </a>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="tabular shrink-0">{r.code}</span>
              {r.subline ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate">{r.subline}</span>
                </>
              ) : null}
            </span>
          </div>
        );
      },
    }),
    helper.display({
      id: "status",
      header: "Status",
      enableHiding: false,
      // Not sortable: the status tabs above the table do that job.
      meta: { label: "Status" },
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    }),
    helper.display({
      id: "people",
      header: "People",
      enableHiding: false,
      meta: { label: "People", sortKey: "people", firstDir: "desc" },
      cell: ({ row }) => <PeopleCell row={row.original} />,
    }),
    helper.display({
      id: "lastEmailed",
      header: "Last emailed",
      enableHiding: false,
      meta: { label: "Last emailed", sortKey: "lastEmailed", firstDir: "desc" },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <span className={cn(r.lastEmailedLabel === "Never" && "text-muted-foreground")} title={r.lastEmailedTitle ?? undefined}>
            {r.lastEmailedLabel}
          </span>
        );
      },
    }),
    helper.display({
      id: "sequence",
      header: "Sequence",
      enableHiding: false,
      meta: { label: "Sequence", cellClassName: "max-w-72 truncate" },
      // The company's current campaign sequence ("Waiting for follow-up 1 on 14 Oct", "Finished"…).
      cell: ({ row }) => {
        const r = row.original;
        if (!r.sequenceLabel) {
          return (
            <span className="text-muted-foreground" title="Not in a campaign yet">
              —
            </span>
          );
        }
        return <span title={r.sequenceTitle ? `${r.sequenceLabel} · ${r.sequenceTitle}` : r.sequenceLabel}>{r.sequenceLabel}</span>;
      },
    }),
    helper.display({
      id: "country",
      header: "Country",
      meta: { label: "Country", sortKey: "country", firstDir: "asc", cellClassName: "max-w-40 truncate" },
      cell: ({ row }) => (row.original.countryName ? <span title={row.original.countryName}>{row.original.countryName}</span> : <Dash />),
    }),
    helper.display({
      id: "niche",
      header: "Niche",
      meta: { label: "Niche", sortKey: "niche", firstDir: "asc", cellClassName: "max-w-40 truncate" },
      cell: ({ row }) => (row.original.niche ? <span title={row.original.niche}>{row.original.niche}</span> : <Dash />),
    }),
    helper.display({
      id: "priority",
      header: "Priority",
      meta: { label: "Priority", sortKey: "priority", firstDir: "asc" },
      cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
    }),
    helper.display({
      id: "tags",
      header: "Tags",
      meta: { label: "Tags", cellClassName: "max-w-56" },
      cell: ({ row }) => {
        const tags = row.original.tags;
        if (tags.length === 0) return <Dash />;
        const shown = tags.slice(0, 3);
        return (
          <span className="flex flex-wrap gap-1" title={tags.map((t) => t.name).join(", ")}>
            {shown.map((t) => (
              <span key={t.id} className="inline-flex h-5 max-w-28 items-center truncate rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">
                {t.name}
              </span>
            ))}
            {tags.length > 3 ? <span className="text-[11px] text-muted-foreground">+{tags.length - 3}</span> : null}
          </span>
        );
      },
    }),
    helper.display({
      id: "created",
      header: "Added",
      meta: { label: "Added", sortKey: "created", firstDir: "desc" },
      cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.addedLabel}</span>,
    }),
    ...customColumns.map((c) =>
      helper.display({
        id: `cf:${c.key}`,
        header: c.label,
        meta: { label: c.label, cellClassName: "max-w-48 truncate" },
        cell: ({ row }) => {
          const v = row.original.custom[c.key];
          return v ? <span title={v}>{v}</span> : <Dash />;
        },
      }),
    ),
  ];
}

type CompaniesTableProps = {
  rows: ContactRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  sort: SortKey;
  dir: "asc" | "desc";
  customColumns: Array<{ key: string; label: string }>;
  columnVisibility: ColumnVisibilityState;
  onColumnVisibilityChange: (next: ColumnVisibilityState) => void;
  onSortChange: (sort: SortKey, dir: "asc" | "desc") => void;
  onPageChange: (page: number) => void;
  selected: ReadonlySet<number>;
  onToggleRow: (id: number) => void;
  onTogglePage: (on: boolean) => void;
  onOpen: (id: number) => void;
  /** Shareable link that opens a company's panel over this view. */
  companyHref: (id: number) => string;
  loading: boolean;
};

export function CompaniesTable(props: CompaniesTableProps) {
  const {
    rows,
    total,
    page,
    pageCount,
    pageSize,
    sort,
    dir,
    customColumns,
    columnVisibility,
    onColumnVisibilityChange,
    onSortChange,
    onPageChange,
    selected,
    onToggleRow,
    onTogglePage,
    onOpen,
    companyHref,
    loading,
  } = props;

  const columns = useMemo(
    () =>
      buildColumns(
        customColumns,
        (row, e) => {
          // Plain clicks open the panel in place; Ctrl/middle-click still opens a new tab.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
            e.stopPropagation();
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          onOpen(row.id);
        },
        companyHref,
      ),
    [customColumns, onOpen, companyHref],
  );

  const sorting: SortingState = [{ id: SORT_COLUMN[sort], desc: dir === "desc" }];
  const pagination: PaginationState = { pageIndex: page - 1, pageSize };

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (r) => String(r.id),
    manualSorting: true,
    manualPagination: true,
    enableSortingRemoval: false,
    enableMultiSort: false,
    rowCount: total,
    state: { columnVisibility, sorting, pagination },
    onColumnVisibilityChange: (updater: Updater<ColumnVisibilityState>) =>
      onColumnVisibilityChange(functionalUpdate(updater, columnVisibility)),
    onSortingChange: (updater: Updater<SortingState>) => {
      const next = functionalUpdate(updater, sorting)[0];
      if (!next) return;
      const key = (Object.keys(SORT_COLUMN) as SortKey[]).find((k) => SORT_COLUMN[k] === next.id);
      if (key) onSortChange(key, next.desc ? "desc" : "asc");
    },
    onPaginationChange: (updater: Updater<PaginationState>) => {
      const next = functionalUpdate(updater, pagination);
      if (next.pageIndex !== pagination.pageIndex) onPageChange(next.pageIndex + 1);
    },
  });

  const pageIds = rows.map((r) => r.id);
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;
  const headerChecked: boolean | "indeterminate" =
    selectedOnPage === 0 ? false : selectedOnPage === pageIds.length ? true : "indeterminate";

  function toggleSort(columnId: string, meta: ColumnMetaInfo) {
    if (!meta.sortKey) return;
    const current = table.getColumn(columnId)?.getIsSorted();
    const desc = current ? current === "asc" : meta.firstDir === "desc";
    table.setSorting([{ id: columnId, desc }]);
  }

  return (
    <div aria-busy={loading || undefined} className={cn("transition-opacity", loading && "opacity-60")}>
      {/* Laptop and tablet: a table. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full caption-bottom text-sm">
          <caption className="sr-only">Companies. Click a row or press Enter to open a company.</caption>
          <thead className="border-b border-border">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                <th scope="col" className="h-10 w-10 pl-4 text-left md:pl-6">
                  <Checkbox
                    checked={headerChecked}
                    onCheckedChange={(c) => onTogglePage(c === true)}
                    aria-label={headerChecked === true ? "Untick every company on this page" : "Tick every company on this page"}
                    disabled={rows.length === 0}
                  />
                </th>
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta as ColumnMetaInfo | undefined;
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={meta?.sortKey ? (sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none") : undefined}
                      className={cn("h-10 px-2 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground", meta?.headClassName)}
                    >
                      {meta?.sortKey ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(h.column.id, meta)}
                          className={cn(
                            "-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent hover:text-foreground",
                            sorted && "text-foreground",
                          )}
                        >
                          {meta.label}
                          {sorted === "asc" ? (
                            <ArrowUp className="size-3.5" aria-hidden />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="size-3.5" aria-hidden />
                          ) : (
                            <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
                          )}
                        </button>
                      ) : h.isPlaceholder ? null : (
                        <table.FlexRender header={h} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, i) => {
              const r = row.original;
              const isSelected = selected.has(r.id);
              return (
                <tr
                  key={row.id}
                  data-row-index={i}
                  data-company-id={r.id}
                  data-state={isSelected ? "selected" : undefined}
                  tabIndex={-1}
                  aria-selected={isSelected}
                  onClick={() => onOpen(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.target === e.currentTarget) {
                      e.preventDefault();
                      onOpen(r.id);
                    }
                  }}
                  className="cursor-pointer border-b border-border transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:-outline-offset-2 data-[state=selected]:bg-muted"
                >
                  <td className="w-10 py-2 pl-4 align-middle md:pl-6" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={isSelected} onCheckedChange={() => onToggleRow(r.id)} aria-label={`Tick ${r.name}`} />
                  </td>
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as ColumnMetaInfo | undefined;
                    return (
                      <td key={cell.id} className={cn("px-2 py-2 align-middle whitespace-nowrap", meta?.cellClassName)}>
                        <table.FlexRender cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Phones: cards. grid-cols-1 (minmax(0, 1fr)) and min-w-0 down to the text, not the implicit auto column: a long
          company name or website host ends in "…" instead of widening the page. */}
      <ul className="grid grid-cols-1 gap-2 px-4 md:hidden" aria-label="Companies">
        {rows.map((r, i) => {
          const isSelected = selected.has(r.id);
          const people = peopleSummary(r.peopleCount, r.emailCount);
          return (
            <li
              key={r.id}
              data-row-index={i}
              data-company-id={r.id}
              tabIndex={-1}
              className={cn(
                "flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-3 focus-visible:-outline-offset-2",
                isSelected && "border-foreground/30 bg-muted",
              )}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target === e.currentTarget) {
                  e.preventDefault();
                  onOpen(r.id);
                }
              }}
            >
              <Checkbox checked={isSelected} onCheckedChange={() => onToggleRow(r.id)} aria-label={`Tick ${r.name}`} className="mt-0.5" />
              <button type="button" className="grid min-w-0 flex-1 grid-cols-1 gap-1.5 text-left" onClick={() => onOpen(r.id)}>
                <span className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {r.code}
                      {r.subline ? ` · ${r.subline}` : ""}
                    </span>
                  </span>
                  <StatusBadge status={r.status} className="shrink-0" />
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className={cn(people.missingEmail && "text-warning/80")}>{people.text}</span>
                  <span>{r.lastEmailedLabel === "Never" ? "Never emailed" : `Emailed: ${r.lastEmailedLabel}`}</span>
                  {r.countryName ? <span>{r.countryName}</span> : null}
                  {r.sequenceLabel ? <span className="basis-full truncate">{r.sequenceLabel}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm md:px-6">
        <p className="tabular text-muted-foreground" aria-live="polite">
          {pageSummary(page, pageCount, total)}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronLeft className="size-4" aria-hidden />
            Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
