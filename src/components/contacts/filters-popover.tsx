"use client";

import { useId, useState } from "react";
import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PRIORITIES, PRIORITY_LABELS } from "@/core/labels";
import { normalizeText } from "@/core/text";
import { cn } from "@/lib/utils";
import type { CompanyFilters } from "@/server/services/companies/filters";
import { useContacts } from "./contacts-provider";
import type { FilterOptions } from "./types";
import { clearFilterParams, resetPage, toggleCsvValue } from "./url";

/** Number of filters in use (not counting the status tab or search box). */
export function countPopoverFilters(f: CompanyFilters): number {
  return (
    (f.tagIds?.length ?? 0) +
    (f.countries?.length ?? 0) +
    (f.niches?.length ?? 0) +
    (f.priorities?.length ?? 0) +
    (f.emailed ? 1 : 0) +
    (f.hasEmail ? 1 : 0) +
    (f.firstContactedById ? 1 : 0)
  );
}

/** The Filters popover: tag, country, niche, priority, emailed, has email, first contacted by. */
export function FiltersPopover({ filters, options }: { filters: CompanyFilters; options: FilterOptions }) {
  const { navigate } = useContacts();
  const count = countPopoverFilters(filters);

  function toggle(key: string, value: string, on: boolean) {
    navigate((p) => {
      toggleCsvValue(p, key, value, on);
      resetPage(p);
    });
  }
  function setSingle(key: string, value: string | null) {
    navigate((p) => {
      if (value) p.set(key, value);
      else p.delete(key);
      resetPage(p);
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Filter className="size-3.5" aria-hidden />
          Filters
          {count > 0 ? (
            <span className="tabular rounded-sm bg-secondary px-1.5 text-xs text-foreground" aria-label={`${count} in use`}>
              {count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(75vh,40rem)] w-[min(92vw,26rem)] gap-4 overflow-y-auto p-3">
        <CheckList
          title="Tags"
          emptyText="No tags yet. Tick companies and choose Tag to add one."
          options={options.tags.map((t) => ({ value: String(t.id), label: t.name }))}
          selected={(filters.tagIds ?? []).map(String)}
          onToggle={(v, on) => toggle("tag", v, on)}
        />
        <CheckList
          title="Country"
          emptyText="No company has a country yet."
          options={options.countries.map((c) => ({ value: c.code, label: c.name }))}
          selected={filters.countries ?? []}
          onToggle={(v, on) => toggle("country", v, on)}
        />
        <CheckList
          title="Niche"
          emptyText="No company has a niche yet."
          options={options.niches.map((n) => ({ value: n, label: n }))}
          selected={filters.niches ?? []}
          onToggle={(v, on) => toggle("niche", v, on)}
        />
        <CheckList
          title="Priority"
          inline
          options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
          selected={filters.priorities ?? []}
          onToggle={(v, on) => toggle("priority", v, on)}
        />
        <Segmented
          title="Emailed"
          value={filters.emailed ?? ""}
          options={[
            { value: "", label: "Any" },
            { value: "yes", label: "Emailed" },
            { value: "no", label: "Never emailed" },
          ]}
          onChange={(v) => setSingle("emailed", v || null)}
        />
        <Segmented
          title="Email address"
          value={filters.hasEmail ?? ""}
          options={[
            { value: "", label: "Any" },
            { value: "yes", label: "Has email" },
            { value: "no", label: "Missing email" },
          ]}
          onChange={(v) => setSingle("hasEmail", v || null)}
        />
        <FirstContactedBy
          users={options.users}
          value={filters.firstContactedById ?? null}
          onChange={(id) => setSingle("by", id ? String(id) : null)}
        />
        {count > 0 ? (
          <div className="flex justify-end border-t border-border pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                navigate((p) => {
                  for (const k of ["tag", "country", "niche", "priority", "emailed", "hasEmail", "by"]) p.delete(k);
                  resetPage(p);
                })
              }
            >
              Reset these filters
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function CheckList({
  title,
  options,
  selected,
  onToggle,
  emptyText,
  inline,
}: {
  title: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string, on: boolean) => void;
  emptyText?: string;
  inline?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const q = normalizeText(query);
  const shown = q ? options.filter((o) => normalizeText(o.label).includes(q)) : options;
  const selectedSet = new Set(selected);
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{title}</legend>
      {options.length === 0 ? <p className="text-xs text-muted-foreground">{emptyText}</p> : null}
      {options.length > 8 ? (
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Find a ${title.toLowerCase()}…`}
          aria-label={`Find a ${title.toLowerCase()}`}
          className="h-7 text-sm"
        />
      ) : null}
      <div className={cn(inline ? "flex flex-wrap gap-x-4 gap-y-2" : "grid max-h-40 gap-1.5 overflow-y-auto pr-1")}>
        {shown.map((o, i) => {
          const cid = `${id}-${i}`;
          return (
            <label key={o.value} htmlFor={cid} className="flex cursor-pointer items-center gap-2 py-0.5 text-sm">
              <Checkbox id={cid} checked={selectedSet.has(o.value)} onCheckedChange={(c) => onToggle(o.value, c === true)} />
              <span className="min-w-0 truncate">{o.label}</span>
            </label>
          );
        })}
        {q && shown.length === 0 ? <p className="text-xs text-muted-foreground">Nothing matches &ldquo;{query}&rdquo;.</p> : null}
      </div>
    </fieldset>
  );
}

function Segmented({
  title,
  value,
  options,
  onChange,
}: {
  title: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <span id={id} className="text-xs font-medium text-muted-foreground">
        {title}
      </span>
      <div role="group" aria-labelledby={id} className="inline-flex w-fit rounded-lg border border-border p-0.5">
        {options.map((o) => {
          const checked = o.value === value;
          return (
            <button
              key={o.value || "any"}
              type="button"
              aria-pressed={checked}
              onClick={() => onChange(o.value)}
              className={cn(
                "h-7 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                checked && "bg-secondary font-medium text-foreground",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FirstContactedBy({
  users,
  value,
  onChange,
}: {
  users: Array<{ id: number; name: string }>;
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        First contacted by
      </label>
      <Select value={value ? String(value) : "anyone"} onValueChange={(v) => onChange(v === "anyone" ? null : Number(v))}>
        <SelectTrigger id={id} size="sm" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="anyone">Anyone</SelectItem>
          {users.map((u) => (
            <SelectItem key={u.id} value={String(u.id)}>
              {u.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Chips for the filters in use, each removable, plus "Clear filters". */
export function FilterChips({ filters, options }: { filters: CompanyFilters; options: FilterOptions }) {
  const { navigate } = useContacts();
  const chips: Array<{ key: string; label: string; remove: (p: URLSearchParams) => void }> = [];
  if (filters.q) chips.push({ key: "q", label: `Search: "${filters.q}"`, remove: (p) => p.delete("q") });
  const tagName = new Map(options.tags.map((t) => [t.id, t.name]));
  for (const id of filters.tagIds ?? []) {
    chips.push({ key: `tag-${id}`, label: `Tag: ${tagName.get(id) ?? `#${id}`}`, remove: (p) => toggleCsvValue(p, "tag", String(id), false) });
  }
  const countryName = new Map(options.countries.map((c) => [c.code, c.name]));
  for (const code of filters.countries ?? []) {
    chips.push({ key: `country-${code}`, label: `Country: ${countryName.get(code) ?? code}`, remove: (p) => toggleCsvValue(p, "country", code, false) });
  }
  for (const n of filters.niches ?? []) {
    chips.push({ key: `niche-${n}`, label: `Niche: ${n}`, remove: (p) => toggleCsvValue(p, "niche", n, false) });
  }
  for (const pr of filters.priorities ?? []) {
    chips.push({ key: `priority-${pr}`, label: `Priority: ${PRIORITY_LABELS[pr]}`, remove: (p) => toggleCsvValue(p, "priority", pr, false) });
  }
  if (filters.emailed) {
    chips.push({ key: "emailed", label: filters.emailed === "yes" ? "Emailed" : "Never emailed", remove: (p) => p.delete("emailed") });
  }
  if (filters.hasEmail) {
    chips.push({ key: "hasEmail", label: filters.hasEmail === "yes" ? "Has email" : "Missing email", remove: (p) => p.delete("hasEmail") });
  }
  if (filters.firstContactedById) {
    const who = options.users.find((u) => u.id === filters.firstContactedById)?.name ?? "someone";
    chips.push({ key: "by", label: `First contacted by ${who}`, remove: (p) => p.delete("by") });
  }
  if (chips.length === 0 && !filters.status) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 md:px-6">
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-card pr-1 pl-2.5 text-xs"
        >
          <span className="max-w-60 truncate">{c.label}</span>
          <button
            type="button"
            aria-label={`Remove filter ${c.label}`}
            className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() =>
              navigate((p) => {
                c.remove(p);
                resetPage(p);
              })
            }
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <Button variant="ghost" size="xs" onClick={() => navigate((p) => clearFilterParams(p))}>
        Clear filters
      </Button>
    </div>
  );
}
