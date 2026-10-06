"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { ColumnVisibilityState } from "@tanstack/react-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { plural } from "@/core/text";
import { selectAllMatchingAction } from "@/app/(app)/contacts/actions";
import type { CompanyFilters, SortKey } from "@/server/services/companies/filters";
import { BulkBar } from "./bulk-bar";
import { CompaniesTable, HIDEABLE_COLUMNS, NARROW_HIDDEN } from "./companies-table";
import { useContacts } from "./contacts-provider";
import { FilterChips } from "./filters-popover";
import { ShortcutHelp } from "./shortcut-help";
import { SELECTION_LIMIT, columnOverridesStore, selection, useIsNarrower, useSelection, useStore } from "./storage";
import { ContactsToolbar, type ColumnChoice } from "./toolbar";
import type { ContactRow, EmptyKind, FilterOptions, ListSummary } from "./types";
import { clearFilterParams, contactsHref, resetPage, viewHref, withCompany } from "./url";

type ContactsViewProps = {
  rows: ContactRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  filters: CompanyFilters;
  options: FilterOptions;
  sidebar: { allCount: number; missingEmailCount: number; lists: ListSummary[] };
  empty: EmptyKind;
};

/** Below this width Country, Niche, Priority and Tags hide first (the Columns button brings them back). */
const FULL_TABLE_WIDTH = 1150;

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * The interactive part of Contacts: toolbar, filter chips, the table, paging,
 * ticking across pages, bulk actions and keyboard shortcuts.
 */
export function ContactsView({ rows, total, page, pageCount, pageSize, filters, options, sidebar, empty }: ContactsViewProps) {
  const { navigate, openCompany, isNavigating, setAddOpen, currentSearch } = useContacts();
  const search = useSearchParams().toString();
  const selected = useSelection();
  const overrides = useStore(columnOverridesStore);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const narrow = useIsNarrower(rootRef, FULL_TABLE_WIDTH);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectingAll, startSelectAll] = useTransition();

  // ── Columns: automatic defaults, then whatever the viewer chose ──
  const customKeysOnPage = useMemo(() => new Set(rows.flatMap((r) => Object.keys(r.custom))), [rows]);
  const choices = useMemo(
    () => [...HIDEABLE_COLUMNS, ...options.customColumns.map((c) => ({ id: `cf:${c.key}`, label: c.label }))],
    [options.customColumns],
  );
  const columnVisibility = useMemo<ColumnVisibilityState>(() => {
    const vis: ColumnVisibilityState = {};
    for (const c of choices) {
      let auto: boolean;
      if (c.id.startsWith("cf:")) auto = customKeysOnPage.has(c.id.slice(3));
      else if (c.id === "created") auto = false;
      else auto = !(narrow && NARROW_HIDDEN.has(c.id));
      vis[c.id] = overrides[c.id] ?? auto;
    }
    return vis;
  }, [choices, customKeysOnPage, narrow, overrides]);
  const columnChoices: ColumnChoice[] = choices.map((c) => ({ ...c, visible: columnVisibility[c.id] !== false }));

  const setColumnVisible = useCallback((id: string, visible: boolean) => {
    columnOverridesStore.set((prev) => ({ ...prev, [id]: visible }));
  }, []);
  const onColumnVisibilityChange = useCallback(
    (next: ColumnVisibilityState) => {
      columnOverridesStore.set((prev) => {
        const out = { ...prev };
        for (const [id, v] of Object.entries(next)) if (columnVisibility[id] !== v) out[id] = v;
        return out;
      });
    },
    [columnVisibility],
  );

  // ── Sorting and paging go through the URL (the server does the work) ──
  const onSortChange = useCallback(
    (sort: SortKey, dir: "asc" | "desc") =>
      navigate((p) => {
        if (sort === "name") p.delete("sort");
        else p.set("sort", sort);
        if (dir === "asc") p.delete("dir");
        else p.set("dir", dir);
        resetPage(p);
      }),
    [navigate],
  );
  const onPageChange = useCallback(
    (next: number) => {
      listRef.current?.scrollIntoView({ block: "start" });
      navigate((p) => {
        if (next <= 1) p.delete("page");
        else p.set("page", String(next));
      });
    },
    [navigate],
  );

  const companyHref = useCallback((id: number) => contactsHref(withCompany(search, id)), [search]);

  // ── Ticks (they survive paging, filtering and reloads in this tab) ──
  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allPageTicked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const canTickAllMatching = allPageTicked && total > pageIds.length && selected.size < Math.min(total, SELECTION_LIMIT);

  function tickAllMatching() {
    startSelectAll(async () => {
      const res = await selectAllMatchingAction({ query: currentSearch() });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      selection.setMany(res.data.ids, true);
      toast.success(res.message ?? "Ticked.");
    });
  }

  // ── Keyboard: / search, j/k move, x tick, Enter open (on the row), ? help ──
  useEffect(() => {
    function visibleRows(): HTMLElement[] {
      const root = listRef.current;
      if (!root) return [];
      return Array.from(root.querySelectorAll<HTMLElement>("[data-row-index]")).filter((el) => el.offsetParent !== null);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-slot="popover-content"]')) return;
      if (document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')) return;

      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (e.key !== "j" && e.key !== "k" && e.key !== "x") return;
      const items = visibleRows();
      if (items.length === 0) return;
      const current = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-row-index]") : null;
      const index = current ? items.indexOf(current) : -1;
      if (e.key === "x") {
        if (!current) return;
        e.preventDefault();
        const id = Number(current.dataset.companyId);
        if (id) selection.toggle(id);
        return;
      }
      e.preventDefault();
      const step = e.key === "j" ? 1 : -1;
      const next = index === -1 ? (step === 1 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, index + step));
      const el = items[next];
      if (el) {
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: "nearest" });
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedIds = useMemo(() => [...selected], [selected]);

  return (
    <div ref={rootRef} className={selected.size > 0 ? "pb-24" : undefined}>
      <ContactsToolbar
        filters={filters}
        options={options}
        total={total}
        columns={columnChoices}
        onToggleColumn={setColumnVisible}
        onResetColumns={() => columnOverridesStore.set({})}
        onShowShortcuts={() => setHelpOpen(true)}
        sidebar={sidebar}
        searchRef={searchRef}
      />
      <FilterChips filters={filters} options={options} />

      {canTickAllMatching ? (
        <div className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm md:mx-6">
          <span>All {plural(pageIds.length, "company", "companies")} on this page are ticked.</span>
          <Button variant="outline" size="xs" onClick={tickAllMatching} disabled={selectingAll}>
            {selectingAll
              ? "Ticking…"
              : total > SELECTION_LIMIT
                ? `Tick the first ${SELECTION_LIMIT.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`
                : `Tick all ${plural(total, "company", "companies")} that match`}
          </Button>
        </div>
      ) : null}

      <div ref={listRef} className="scroll-mt-16">
        {rows.length === 0 ? (
          <EmptyView kind={empty} filters={filters} search={search} onAdd={() => setAddOpen(true)} onClear={() => navigate(clearFilterParams)} />
        ) : (
          <CompaniesTable
            rows={rows}
            total={total}
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            sort={filters.sort}
            dir={filters.dir}
            customColumns={options.customColumns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={onColumnVisibilityChange}
            onSortChange={onSortChange}
            onPageChange={onPageChange}
            selected={selected}
            onToggleRow={selection.toggle}
            onTogglePage={(on) => selection.setMany(pageIds, on)}
            onOpen={openCompany}
            companyHref={companyHref}
            loading={isNavigating}
          />
        )}
      </div>

      {selected.size > 0 ? (
        <BulkBar selectedIds={selectedIds} lists={sidebar.lists} tags={options.tags} currentListId={filters.listId} />
      ) : null}
      <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/** PLAN.md A6 empty states, each with one next step. */
function EmptyView({
  kind,
  filters,
  search,
  onAdd,
  onClear,
}: {
  kind: EmptyKind;
  filters: CompanyFilters;
  search: string;
  onAdd: () => void;
  onClear: () => void;
}) {
  const content = (() => {
    switch (kind) {
      case "no-companies":
        return (
          <EmptyState
            title="No companies yet."
            description="Import a spreadsheet or paste rows from Excel to get started."
            actions={
              <>
                <Button variant="outline" asChild>
                  <Link href="/import">Import companies</Link>
                </Button>
                <Button variant="outline" onClick={onAdd}>
                  Add a company
                </Button>
              </>
            }
          />
        );
      case "empty-list":
        return (
          <EmptyState
            title="This list is empty."
            description="Tick companies in All companies and choose Add to list, or import a file into this list."
            actions={
              <Button variant="outline" asChild>
                <Link href={viewHref(search, { view: "all" })} scroll={false}>
                  Go to All companies
                </Link>
              </Button>
            }
          />
        );
      case "deleted-list":
        return (
          <EmptyState
            title="This list was deleted."
            description="Someone deleted it, or the link is old. The companies that were in it are still in All companies."
            actions={
              <Button variant="outline" asChild>
                <Link href={viewHref(search, { view: "all" })} scroll={false}>
                  Go to All companies
                </Link>
              </Button>
            }
          />
        );
      case "no-missing":
        return <EmptyState title="Every company has an email address." />;
      case "no-match":
      default:
        return (
          <EmptyState
            title="No companies match these filters."
            description={filters.q ? `Nothing matches the search "${filters.q}" here.` : undefined}
            actions={
              <Button variant="outline" onClick={onClear}>
                Clear filters
              </Button>
            }
          />
        );
    }
  })();
  return <div className="px-4 py-10 md:px-6">{content}</div>;
}
