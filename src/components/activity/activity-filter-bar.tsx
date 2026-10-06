"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABELS,
  activityFiltersToParams,
  hasActivityFilters,
  type ActivityFilters,
  type ActivityKind,
} from "./activity-filters";

const EVERYONE = "everyone";

/**
 * Filters for the Activity page. The URL holds the state, so filtered views can be shared and reloaded.
 * The fields update at once (draft) while the page loads the new results.
 */
export function ActivityFilterBar({
  filters,
  people,
}: {
  filters: ActivityFilters;
  people: Array<{ id: number; name: string; active: boolean }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<ActivityFilters>(filters);

  // When the address changes some other way (Back button, a link), show those filters.
  const incoming = activityFiltersToParams({ ...filters, page: 1 }).toString();
  const [shown, setShown] = useState(incoming);
  if (incoming !== shown) {
    setShown(incoming);
    setDraft(filters);
  }

  function apply(patch: Partial<ActivityFilters>) {
    const next: ActivityFilters = { ...draft, ...patch, page: 1 };
    if (next.from && next.to && next.from > next.to) [next.from, next.to] = [next.to, next.from];
    setDraft(next);
    const qs = activityFiltersToParams(next).toString();
    startTransition(() => router.push(qs ? `/activity?${qs}` : "/activity"));
  }

  const personValue = draft.person === null ? EVERYONE : String(draft.person);

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending || undefined}>
      <div className="grid gap-1.5">
        <Label htmlFor="activity-person">Who</Label>
        <Select
          value={personValue}
          onValueChange={(v) => apply({ person: v === EVERYONE ? null : v === "system" ? "system" : Number(v) })}
        >
          <SelectTrigger id="activity-person" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-72">
            <SelectItem value={EVERYONE}>Everyone</SelectItem>
            <SelectSeparator />
            {people.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.active ? p.name : `${p.name} (switched off)`}
              </SelectItem>
            ))}
            <SelectItem value="system">System (the app itself)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="activity-kind">What</Label>
        <Select value={draft.kind} onValueChange={(v) => apply({ kind: v as ActivityKind })}>
          <SelectTrigger id="activity-kind" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {ACTIVITY_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {ACTIVITY_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="activity-from">From</Label>
        <Input
          id="activity-from"
          type="date"
          className="w-40"
          value={draft.from ?? ""}
          max={draft.to ?? undefined}
          onChange={(e) => apply({ from: e.target.value || null })}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="activity-to">To</Label>
        <Input
          id="activity-to"
          type="date"
          className="w-40"
          value={draft.to ?? ""}
          min={draft.from ?? undefined}
          onChange={(e) => apply({ to: e.target.value || null })}
        />
      </div>
      {hasActivityFilters(draft) ? (
        <Button variant="ghost" onClick={() => apply({ person: null, kind: "all", from: null, to: null })}>
          <X aria-hidden /> Clear filters
        </Button>
      ) : null}
    </div>
  );
}
