"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { ChevronsUpDown, Loader2, Search, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { searchPreviewPeopleAction } from "@/app/(app)/templates/actions";

/** A real contact to preview an email for (see searchPeopleForPreview in the templates service). */
export type PreviewPersonOption = { id: number; name: string; email: string; companyId: number; companyName: string };

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/**
 * "Preview for: Anna Berg · Acme 3D ▾": searches people with an email address (company name,
 * website, people's names and emails). Reused by the campaign wizard.
 */
export function PersonPicker({
  id,
  value,
  onChange,
  className,
}: {
  id?: string;
  value: PreviewPersonOption | null;
  onChange: (person: PreviewPersonOption) => void;
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
            <span className="text-muted-foreground">Pick a contact</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        {open ? (
          <PeopleSearch
            selectedId={value?.id ?? null}
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

function PeopleSearch({ selectedId, onPick }: { selectedId: number | null; onPick: (p: PreviewPersonOption) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PreviewPersonOption[]>([]);
  const [searched, setSearched] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

  function runSearch(q: string) {
    const rid = ++requestId.current;
    startTransition(async () => {
      try {
        const res = await searchPreviewPeopleAction({ q });
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

  // The most recently changed people show as soon as the list opens.
  useEffect(() => {
    runSearch("");
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function onQueryChange(next: string) {
    setQuery(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runSearch(next.trim()), 200);
  }

  const q = query.trim();
  const waiting = pending || searched !== q;

  return (
    <CommandPrimitive shouldFilter={false} loop label="Pick a contact to preview" className="flex flex-col">
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
            {q ? `No contacts with an email match “${q}”.` : "No contacts with an email address yet. Import some on the Import page."}
          </p>
        ) : null}
        {results.map((p) => (
          <CommandPrimitive.Item
            key={p.id}
            value={`person-${p.id}`}
            onSelect={() => onPick(p)}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[selected=true]:bg-accent",
              p.id === selectedId && "font-medium",
            )}
          >
            <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="grid min-w-0 flex-1">
              <span className="truncate">{p.name}</span>
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
