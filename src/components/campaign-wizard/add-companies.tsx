"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COMPANY_STATUSES, COMPANY_STATUS_LABELS, type CompanyStatusValue } from "@/core/labels";
import { normalizeText, plural } from "@/core/text";
import { cn } from "@/lib/utils";
import { addAudienceFilterAction, previewAudienceFilterAction } from "@/app/(app)/campaigns/[id]/setup/actions";
import type { FilterPreview } from "@/server/services/campaigns/audience";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

export type AudienceFilterOptions = {
  lists: Array<{ id: number; name: string; count: number }>;
  tags: Array<{ id: number; name: string }>;
  countries: Array<{ code: string; name: string }>;
  niches: string[];
};

type Choice = {
  listId: number | null;
  status: CompanyStatusValue | null;
  tagIds: number[];
  countries: string[];
  niches: string[];
};

const EMPTY: Choice = { listId: null, status: null, tagIds: [], countries: [], niches: [] };

function isEmpty(c: Choice): boolean {
  return !c.listId && !c.status && c.tagIds.length === 0 && c.countries.length === 0 && c.niches.length === 0;
}

/**
 * "Add companies": pick a list, status, tags, countries and niches (the Contacts filters), see how
 * many match and how many are new, then add them. Everyone at the added companies gets a row; the
 * engine's default person is ticked.
 */
export function AddCompanies({ campaignId, options }: { campaignId: number; options: AudienceFilterOptions }) {
  const id = useId();
  const [choice, setChoice] = useState<Choice>(EMPTY);
  const [preview, setPreview] = useState<FilterPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [counting, setCounting] = useState(false);
  const [adding, startAdding] = useTransition();
  const requestId = useRef(0);

  useEffect(() => {
    const rid = ++requestId.current;
    if (isEmpty(choice)) return;
    const timer = setTimeout(async () => {
      setCounting(true);
      try {
        const res = await previewAudienceFilterAction({ campaignId, filter: choice });
        if (rid !== requestId.current) return;
        if (res.ok) {
          setPreview(res.data);
          setPreviewError(null);
        } else {
          setPreviewError(res.error);
        }
      } catch {
        if (rid === requestId.current) setPreviewError(OFFLINE);
      } finally {
        if (rid === requestId.current) setCounting(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [campaignId, choice]);

  function update(patch: Partial<Choice>) {
    setChoice({ ...choice, ...patch });
    // The old count no longer applies: the button waits for the new one.
    setPreview(null);
    setPreviewError(null);
  }

  function add() {
    startAdding(async () => {
      try {
        const res = await addAudienceFilterAction({ campaignId, filter: choice });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Companies added.");
        setChoice(EMPTY);
        setPreview(null);
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  const shownPreview = isEmpty(choice) ? null : preview;
  const toAdd = shownPreview?.toAdd ?? 0;

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3 rounded-lg border border-border bg-card p-4">
      <div>
        <h3 id={`${id}-title`} className="text-sm font-medium">
          Add companies
        </h3>
        <p className="text-xs text-muted-foreground">
          Choose by list, status, tag, country or niche. Companies already in this campaign are skipped.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${id}-list`}>List</Label>
          <Select value={choice.listId ? String(choice.listId) : "any"} onValueChange={(v) => update({ listId: v === "any" ? null : Number(v) })}>
            <SelectTrigger id={`${id}-list`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="any">Any list</SelectItem>
              {options.lists.map((l) => (
                <SelectItem key={l.id} value={String(l.id)}>
                  {l.name} ({l.count.toLocaleString("en-US")})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${id}-status`}>Status</Label>
          <Select value={choice.status ?? "any"} onValueChange={(v) => update({ status: v === "any" ? null : (v as CompanyStatusValue) })}>
            <SelectTrigger id={`${id}-status`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="any">Any status</SelectItem>
              {COMPANY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {COMPANY_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CheckListPopover
          label="Tags"
          anyText="Any tag"
          emptyText="No tags yet. On Contacts, tick companies and choose Tag."
          options={options.tags.map((t) => ({ value: String(t.id), label: t.name }))}
          selected={choice.tagIds.map(String)}
          onChange={(v) => update({ tagIds: v.map(Number) })}
        />
        <CheckListPopover
          label="Countries"
          anyText="Any country"
          emptyText="No company has a country yet."
          options={options.countries.map((c) => ({ value: c.code, label: c.name }))}
          selected={choice.countries}
          onChange={(v) => update({ countries: v })}
        />
        <CheckListPopover
          label="Niches"
          anyText="Any niche"
          emptyText="No company has a niche yet."
          options={options.niches.map((n) => ({ value: n, label: n }))}
          selected={choice.niches}
          onChange={(v) => update({ niches: v })}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
          {isEmpty(choice) ? (
            "Pick at least one of the above."
          ) : previewError ? (
            <span className="text-destructive">{previewError}</span>
          ) : shownPreview ? (
            previewText(shownPreview)
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Counting…
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          {!isEmpty(choice) ? (
            <Button variant="ghost" size="sm" onClick={() => update(EMPTY)} disabled={adding}>
              Clear
            </Button>
          ) : null}
          <Button variant="outline" onClick={add} disabled={adding || counting || toAdd === 0}>
            <Plus aria-hidden />
            {adding ? "Adding…" : toAdd > 0 ? `Add ${plural(toAdd, "company", "companies")}` : "Add companies"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function previewText(p: FilterPreview): string {
  if (p.matching === 0) return "No companies match.";
  const parts = [`${plural(p.matching, "company matches", "companies match")}.`];
  if (p.alreadyIn > 0) parts.push(`${p.alreadyIn.toLocaleString("en-US")} ${p.alreadyIn === 1 ? "is" : "are"} already in this campaign.`);
  if (p.capped > 0) parts.push(`${p.capped.toLocaleString("en-US")} won't fit: a campaign can have up to 10,000 companies.`);
  return parts.join(" ");
}

/** A button that opens a searchable list of checkboxes ("Countries: Germany, Norway"). */
function CheckListPopover({
  label,
  anyText,
  emptyText,
  options,
  selected,
  onChange,
}: {
  label: string;
  anyText: string;
  emptyText: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const q = normalizeText(query);
  const shown = useMemo(() => (q ? options.filter((o) => normalizeText(o.label).includes(q)) : options), [options, q]);
  const selectedSet = new Set(selected);
  const names = options.filter((o) => selectedSet.has(o.value)).map((o) => o.label);
  const summary = names.length === 0 ? anyText : names.length <= 2 ? names.join(", ") : `${names.length} chosen`;

  function toggle(value: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(value);
    else next.delete(value);
    onChange(options.map((o) => o.value).filter((v) => next.has(v)));
  }

  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={`${id}-trigger`}>{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button id={`${id}-trigger`} variant="outline" className="w-full justify-between font-normal">
            <span className={cn("truncate", names.length === 0 && "text-muted-foreground")}>{summary}</span>
            <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(92vw,20rem)] gap-2 p-3">
          {options.length === 0 ? <p className="text-sm text-muted-foreground">{emptyText}</p> : null}
          {options.length > 8 ? (
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Find ${label.toLowerCase()}…`}
              aria-label={`Find ${label.toLowerCase()}`}
              className="h-8"
            />
          ) : null}
          <div className="grid max-h-60 gap-1 overflow-y-auto pr-1">
            {shown.map((o, i) => {
              const cid = `${id}-${i}`;
              return (
                <label key={o.value} htmlFor={cid} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                  <Checkbox id={cid} checked={selectedSet.has(o.value)} onCheckedChange={(c) => toggle(o.value, c === true)} />
                  <span className="min-w-0 truncate">{o.label}</span>
                </label>
              );
            })}
            {q && shown.length === 0 ? <p className="text-sm text-muted-foreground">Nothing matches &ldquo;{query}&rdquo;.</p> : null}
          </div>
          {selected.length > 0 ? (
            <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => onChange([])}>
              Clear {label.toLowerCase()}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
