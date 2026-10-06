"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { ChevronsUpDown, Loader2, Search, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { searchRecipientsAction } from "@/app/(app)/campaigns/[id]/setup/actions";
import type { RecipientOption } from "@/server/services/campaigns/draft";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/**
 * "Preview for: Anna Berg · Acme 3D ▾": picks one of this campaign's people (ticked people first;
 * searches company, name and address). Like the templates' contact picker, limited to the campaign.
 */
export function RecipientPicker({
  campaignId,
  id,
  value,
  onChange,
  className,
}: {
  campaignId: number;
  id?: string;
  value: RecipientOption | null;
  onChange: (option: RecipientOption) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("h-auto min-h-8 w-full justify-between gap-2 py-1.5 text-left", className)}
        >
          {value ? (
            <span className="grid min-w-0">
              <span className="truncate font-medium">{value.name}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {value.companyName} · {value.email}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Pick someone in this campaign</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        {open ? (
          <RecipientSearch
            campaignId={campaignId}
            selectedId={value?.personId ?? null}
            onPick={(p) => {
              onChange(p);
              setOpen(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function RecipientSearch({
  campaignId,
  selectedId,
  onPick,
}: {
  campaignId: number;
  selectedId: number | null;
  onPick: (p: RecipientOption) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecipientOption[]>([]);
  const [searched, setSearched] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

  function runSearch(q: string) {
    const rid = ++requestId.current;
    startTransition(async () => {
      try {
        const res = await searchRecipientsAction({ campaignId, q });
        if (rid !== requestId.current) return;
        if (res.ok) {
          setResults(res.data);
          setError(null);
        } else {
          setResults([]);
          setError(res.error);
        }
      } catch {
        if (rid === requestId.current) setError(OFFLINE);
      }
      if (rid === requestId.current) setSearched(q);
    });
  }

  // The first people show as soon as the list opens.
  useEffect(() => {
    runSearch("");
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the list opens
  }, []);

  function onQueryChange(next: string) {
    setQuery(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runSearch(next.trim()), 200);
  }

  const q = query.trim();
  const waiting = pending || searched !== q;

  return (
    <CommandPrimitive shouldFilter={false} loop label="Pick someone to preview" className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <CommandPrimitive.Input
          value={query}
          onValueChange={onQueryChange}
          placeholder="Search name, email or company…"
          className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          autoFocus
        />
        {waiting ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Searching" /> : null}
      </div>
      <CommandPrimitive.List className="max-h-72 overflow-y-auto p-1">
        {error ? <p className="px-3 py-3 text-sm text-destructive">{error}</p> : null}
        {!waiting && !error && results.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">
            {q ? `Nobody in this campaign matches “${q}”.` : "Nobody in this campaign yet. Add companies in the Audience step."}
          </p>
        ) : null}
        {results.map((p) => (
          <CommandPrimitive.Item
            key={p.personId}
            value={`recipient-${p.personId}`}
            onSelect={() => onPick(p)}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[selected=true]:bg-accent",
              p.personId === selectedId && "font-medium",
            )}
          >
            <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="grid min-w-0 flex-1">
              <span className="truncate">
                {p.name}
                {p.ticked ? null : <span className="text-xs text-muted-foreground"> · not ticked</span>}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {p.companyName} · {p.email}
              </span>
            </span>
          </CommandPrimitive.Item>
        ))}
      </CommandPrimitive.List>
    </CommandPrimitive>
  );
}
