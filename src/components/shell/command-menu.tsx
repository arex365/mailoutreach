"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { Command as CommandPrimitive } from "cmdk";
import { Building2, Loader2, Search } from "lucide-react";
import { StatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { countryName } from "@/core/geo/display";
import type { CompanyStatusValue } from "@/core/labels";
import { normalizeText } from "@/core/text";
import { searchCompaniesAction } from "@/app/(app)/contacts/actions";
import { useGuardedNavigate, useGuardedRun } from "@/components/navigation/nav-guard";
import { useStartCampaign } from "@/components/campaign-wizard/new-campaign";
import { QUICK_LINKS, quickLinkBadge, type NavCounts, type QuickLink } from "./nav-items";
import { useNavCounts } from "./sidebar";

/**
 * "Search companies… Ctrl K" in the top bar ("Search or go to…" on a phone). Ctrl+K (Cmd+K
 * on a Mac) opens it from anywhere; typing searches company names, websites, people and
 * emails; Enter opens the company's panel on Contacts. The "Go to" list (QUICK_LINKS) jumps
 * to every screen of the sidebar, with the AI lines waiting for review as a neutral count; on
 * a phone it is the way to the screens that aren't in the bottom bar.
 */

type Result = { id: number; name: string; country: string | null; status: CompanyStatusValue };

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  // The "AI lines" count, kept current by the bell's poll (AI_WAITING_EVENT) while the dialog is closed too.
  const counts = useNavCounts(undefined);
  // Here rather than in the search panel, which closes (unmounts) before the draft is ready.
  const { start } = useStartCampaign();
  const run = useGuardedRun();

  function newCampaign(href: string) {
    // The open page's guard is asked first (unsaved template, Message step…).
    run(href, (mode) => start({ loading: "Starting a new campaign…", replace: mode === "replace" }));
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full max-w-sm justify-start gap-2 text-muted-foreground"
        onClick={() => setOpen(true)}
        aria-keyshortcuts="Control+K"
      >
        <Search className="size-4" aria-hidden />
        {/* On a phone this is also the way to AI lines, Templates, Import and Activity (the "Go to" list). */}
        <span className="truncate sm:hidden">Search or go to…</span>
        <span className="hidden truncate sm:inline">Search companies…</span>
        <kbd className="ml-auto hidden rounded border border-border px-1.5 font-mono text-[10px] sm:inline-block">Ctrl K</kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
          <DialogTitle className="sr-only">Search companies</DialogTitle>
          <DialogDescription className="sr-only">
            Type a company name, website, person or email. Use the arrow keys and Enter to open it.
          </DialogDescription>
          {open ? <SearchPanel onDone={() => setOpen(false)} onNewCampaign={newCampaign} counts={counts} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SearchPanel({
  onDone,
  onNewCampaign,
  counts,
}: {
  onDone: () => void;
  onNewCampaign: (href: string) => void;
  counts: NavCounts;
}) {
  // Asks the open page first when it has unsaved changes (template editor, campaign wizard…).
  const navigate = useGuardedNavigate();
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [searched, setSearched] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function runSearch(q: string) {
    const id = ++requestId.current;
    startTransition(async () => {
      const res = await searchCompaniesAction({ q });
      if (id !== requestId.current) return; // a newer search has started
      if (res.ok) {
        setResults(res.data);
        setError(null);
      } else {
        setResults([]);
        setError(res.error);
      }
      setSearched(q);
    });
  }

  function onQueryChange(next: string) {
    setQuery(next);
    if (timer.current) clearTimeout(timer.current);
    const q = next.trim();
    if (!q) {
      requestId.current++;
      setResults([]);
      setSearched("");
      setError(null);
      return;
    }
    timer.current = setTimeout(() => runSearch(q), 200);
  }

  function go(href: string) {
    onDone();
    navigate(href);
  }

  function openLink(link: QuickLink) {
    if (!link.startsCampaign) {
      go(link.href);
      return;
    }
    onDone();
    onNewCampaign(link.href);
  }

  function openCompany(id: number) {
    // Stay in the current Contacts view if we're on it; otherwise open All companies.
    if (pathname === "/contacts" && typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      p.set("company", String(id));
      go(`/contacts?${p.toString()}`);
    } else {
      go(`/contacts?company=${id}`);
    }
  }

  const q = query.trim();
  const qNorm = normalizeText(q);
  const links = qNorm ? QUICK_LINKS.filter((l) => normalizeText(l.label).includes(qNorm)) : QUICK_LINKS;
  const waiting = Boolean(q) && (pending || searched !== q);

  return (
    <CommandPrimitive shouldFilter={false} loop className="flex flex-col bg-popover text-popover-foreground" label="Search companies">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <CommandPrimitive.Input
          value={query}
          onValueChange={onQueryChange}
          placeholder="Search companies, websites, people, emails…"
          className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          autoFocus
        />
        {waiting ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Searching" /> : null}
      </div>
      <CommandPrimitive.List className="max-h-[min(60vh,24rem)] overflow-y-auto p-1">
        {error ? <p className="px-3 py-4 text-sm text-destructive">{error}</p> : null}
        {q && !waiting && !error && results.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No companies match &ldquo;{q}&rdquo;.</p>
        ) : null}
        {results.length ? (
          <CommandPrimitive.Group
            heading="Companies"
            className="**:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground"
          >
            {results.map((r) => (
              <CommandPrimitive.Item
                key={r.id}
                value={`company-${r.id}`}
                onSelect={() => openCompany(r.id)}
                className="flex cursor-default items-center gap-3 rounded-md px-2 py-2 text-sm outline-none select-none data-[selected=true]:bg-accent"
              >
                <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate font-medium">{r.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    C-{r.id}
                    {r.country ? ` · ${countryName(r.country)}` : ""}
                  </span>
                </span>
                <StatusBadge status={r.status} className="shrink-0" />
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.Group>
        ) : null}
        {links.length ? (
          <CommandPrimitive.Group
            heading="Go to"
            className="**:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground"
          >
            {links.map((l) => {
              const Icon = l.icon;
              const badge = quickLinkBadge(l, counts);
              return (
                <CommandPrimitive.Item
                  key={l.href}
                  value={`link-${l.href}`}
                  onSelect={() => openLink(l)}
                  className="flex cursor-default items-center gap-3 rounded-md px-2 py-2 text-sm outline-none select-none data-[selected=true]:bg-accent"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {l.label}
                  {badge ? (
                    <>
                      <span className="sr-only">, {badge} waiting for review</span>
                      {/* Neutral, never orange, as in the sidebar. */}
                      <span
                        aria-hidden
                        data-nav-badge
                        className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] leading-none font-semibold text-foreground tabular"
                      >
                        {badge}
                      </span>
                    </>
                  ) : null}
                </CommandPrimitive.Item>
              );
            })}
          </CommandPrimitive.Group>
        ) : null}
      </CommandPrimitive.List>
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span>
          <kbd className="font-mono">↑</kbd> <kbd className="font-mono">↓</kbd> to move · <kbd className="font-mono">Enter</kbd> to open
        </span>
        <span>
          <kbd className="font-mono">Esc</kbd> to close
        </span>
      </div>
    </CommandPrimitive>
  );
}
