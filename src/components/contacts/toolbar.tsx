"use client";

import { useEffect, useRef, useState } from "react";
import { Columns3, Download, FileSpreadsheet, FileText, Keyboard, PanelLeftClose, PanelLeftOpen, Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { plural } from "@/core/text";
import { cn } from "@/lib/utils";
import { PAGE_SIZES, type CompanyFilters } from "@/server/services/companies/filters";
import { useContacts } from "./contacts-provider";
import { ExportForClaudeDialog } from "./export-for-claude-dialog";
import { FiltersPopover } from "./filters-popover";
import { ListPicker } from "./list-sidebar";
import { sidebarHiddenStore, useStore } from "./storage";
import type { FilterOptions, ListSummary } from "./types";
import { exportViewHref, resetPage } from "./url";

export type ColumnChoice = { id: string; label: string; visible: boolean };

type ToolbarProps = {
  filters: CompanyFilters;
  options: FilterOptions;
  total: number;
  columns: ColumnChoice[];
  onToggleColumn: (id: string, visible: boolean) => void;
  onResetColumns: () => void;
  onShowShortcuts: () => void;
  sidebar: { allCount: number; missingEmailCount: number; lists: ListSummary[] };
  /** The search box, so "/" can focus it. */
  searchRef: React.Ref<HTMLInputElement>;
};

export function ContactsToolbar({
  filters,
  options,
  total,
  columns,
  onToggleColumn,
  onResetColumns,
  onShowShortcuts,
  sidebar,
  searchRef,
}: ToolbarProps) {
  const { navigate } = useContacts();
  const sidebarHidden = useStore(sidebarHiddenStore);
  const active = { view: filters.view ?? "all", listId: filters.listId } as const;

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 md:px-6">
      <ListPicker {...sidebar} active={active} className={cn(!sidebarHidden && "md:hidden")} />
      <SearchBox inputRef={searchRef} value={filters.q ?? ""} />
      <FiltersPopover filters={filters} options={options} />
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <ColumnsMenu columns={columns} onToggle={onToggleColumn} onReset={onResetColumns} />
        <Select
          value={String(filters.pageSize)}
          onValueChange={(v) =>
            navigate((p) => {
              if (v === "50") p.delete("size");
              else p.set("size", v);
              resetPage(p);
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Companies per page" className="w-[6.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} a page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ExportMenu filters={filters} total={total} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden md:inline-flex"
              aria-label={sidebarHidden ? "Show lists" : "Hide lists"}
              onClick={() => sidebarHiddenStore.set((h) => !h)}
            >
              {sidebarHidden ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{sidebarHidden ? "Show lists" : "Hide lists"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="hidden md:inline-flex" aria-label="Keyboard shortcuts" onClick={onShowShortcuts}>
              <Keyboard className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Keyboard shortcuts (?)</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/** Search across company name, website, and people's names and emails. Waits 300 ms after typing. */
function SearchBox({ value: serverValue, inputRef }: { value: string; inputRef: React.Ref<HTMLInputElement> }) {
  const { navigate } = useContacts();
  const [value, setValue] = useState(serverValue);
  // The last search this box asked for (state for rendering, ref for timers), and the
  // server value we last reacted to.
  const [sent, setSent] = useState(serverValue);
  const [seen, setSeen] = useState(serverValue);
  const sentRef = useRef(serverValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A search changed from elsewhere (chip removed, Back button, sidebar link): show it.
  if (serverValue !== seen) {
    setSeen(serverValue);
    if (serverValue !== sent) {
      setValue(serverValue);
      setSent(serverValue);
    }
  }

  useEffect(() => {
    sentRef.current = sent;
  }, [sent]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function send(next: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const q = next.trim();
    if (q === sentRef.current.trim()) return;
    sentRef.current = q;
    setSent(q);
    navigate(
      (p) => {
        if (q) p.set("q", q);
        else p.delete("q");
        resetPage(p);
      },
      { replace: true },
    );
  }

  return (
    <div className="relative w-full min-w-44 flex-1 sm:w-auto sm:max-w-xs">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => send(next), 300);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            send(value);
          } else if (e.key === "Escape" && value) {
            e.preventDefault();
            setValue("");
            send("");
          }
        }}
        placeholder="Search name, website, people, emails"
        aria-label="Search companies"
        autoComplete="off"
        spellCheck={false}
        className="h-7 w-full rounded-lg border border-input bg-input/30 pr-14 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setValue("");
            send("");
          }}
          className="absolute top-1/2 right-7 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground sm:block">
        /
      </kbd>
    </div>
  );
}

function ColumnsMenu({
  columns,
  onToggle,
  onReset,
}: {
  columns: ColumnChoice[];
  onToggle: (id: string, visible: boolean) => void;
  onReset: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Columns3 className="size-3.5" aria-hidden />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Show these columns</DropdownMenuLabel>
        <p className="px-1.5 pb-1 text-xs text-muted-foreground">Company, Status, People, Last emailed and Sequence always show.</p>
        {columns.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={c.visible}
            onCheckedChange={(checked) => onToggle(c.id, checked === true)}
            onSelect={(e) => e.preventDefault()}
          >
            <span className="truncate">{c.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onReset}>Reset to automatic</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Export menu. On the Missing email view it also offers "Export for Claude", which opens the
 * round-trip dialog (download, instruction, import) instead of downloading at once (M5-DESIGN §4.1).
 */
function ExportMenu({ filters, total }: { filters: CompanyFilters; total: number }) {
  const [claudeOpen, setClaudeOpen] = useState(false);
  const missingEmail = filters.view === "missing-email";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Download className="size-3.5" aria-hidden />
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>
            Everything in this view ({plural(total, "company", "companies")})
          </DropdownMenuLabel>
          <DropdownMenuItem asChild disabled={total === 0}>
            <a href={exportViewHref(filters, "csv")}>
              <FileText className="size-4" aria-hidden /> CSV file
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild disabled={total === 0}>
            <a href={exportViewHref(filters, "xlsx")}>
              <FileSpreadsheet className="size-4" aria-hidden /> Excel file (.xlsx)
            </a>
          </DropdownMenuItem>
          {missingEmail ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={total === 0} className="flex-col items-start gap-0" onSelect={() => setClaudeOpen(true)}>
                <span className="flex items-center gap-1.5">
                  <Sparkles className="size-4" aria-hidden /> Export for Claude
                </span>
                <span className="pl-5.5 text-xs text-muted-foreground">A CSV to ask Claude to find missing emails</span>
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <p className="px-1.5 py-1 text-xs text-muted-foreground">To export only some companies, tick them and use Export in the bar below.</p>
        </DropdownMenuContent>
      </DropdownMenu>
      {missingEmail ? (
        <ExportForClaudeDialog open={claudeOpen} onOpenChange={setClaudeOpen} filters={filters} total={total} />
      ) : null}
    </>
  );
}
