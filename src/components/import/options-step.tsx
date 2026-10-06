"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COMPANY_STATUS_LABELS, COMPANY_STATUSES, type CompanyStatusValue } from "@/core/labels";
import { LIST_NAME_MAX, TAG_NAME_MAX, type DuplicateMode, type GroupingMode, type ImportOptions, type ListOption } from "@/core/import/types";
import { cn } from "@/lib/utils";
import { RoundTripNote } from "./mapping-step";

/**
 * The Options step of the missing-emails round trip (M5-DESIGN §6.10): its fields are replaced by the
 * round-trip note. The wizard saves the default options unchanged (`ROUND_TRIP_OPTIONS`), so the Check
 * step works as for any import; the round-trip planner ignores them.
 */
export function RoundTripOptionsStep() {
  return (
    <div className="grid max-w-3xl gap-5">
      <RoundTripNote />
    </div>
  );
}

export type ListChoice = { id: number; name: string; count: number };

type Editable = Pick<ImportOptions, "list" | "startStatus" | "tag" | "duplicates" | "grouping">;

function Choice({ id, value, title, hint, disabled }: { id: string; value: string; title: string; hint?: string; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <RadioGroupItem value={value} id={id} className="mt-0.5" disabled={disabled} />
      <Label htmlFor={id} className={cn("grid gap-0.5 font-normal leading-snug", disabled && "opacity-60")}>
        <span className="font-medium text-foreground">{title}</span>
        {hint ? <span className="text-sm text-muted-foreground">{hint}</span> : null}
      </Label>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-3 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {hint ? <p className="-mt-1 text-sm text-muted-foreground">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

export function OptionsStep({
  options,
  lists,
  tags,
  hasStatusColumn,
  defaultListName,
  fieldErrors,
  onChange,
}: {
  options: Editable;
  lists: ListChoice[];
  tags: string[];
  hasStatusColumn: boolean;
  defaultListName: string;
  fieldErrors?: Record<string, string[] | undefined>;
  onChange: (options: Editable) => void;
}) {
  const id = useId();
  const set = (patch: Partial<Editable>) => onChange({ ...options, ...patch });
  const listMode = options.list.mode;
  const existingId = options.list.mode === "existing" ? String(options.list.listId) : "";
  const newName = options.list.mode === "new" ? options.list.name : "";
  const nameTaken =
    options.list.mode === "new" &&
    lists.find((l) => l.name.trim().toLowerCase() === newName.trim().toLowerCase() && newName.trim() !== "");

  function setListMode(mode: ListOption["mode"]) {
    if (mode === "none") set({ list: { mode: "none" } });
    else if (mode === "existing") set({ list: lists[0] ? { mode: "existing", listId: lists[0].id } : { mode: "none" } });
    else set({ list: { mode: "new", name: newName || defaultListName } });
  }

  const listError = fieldErrors?.list?.[0] ?? fieldErrors?.["list.name"]?.[0];
  const tagError = fieldErrors?.tag?.[0];

  return (
    <div className="grid max-w-3xl gap-5">
      <Section title="Add the companies to a list">
        <RadioGroup value={listMode} onValueChange={(v) => setListMode(v as ListOption["mode"])} className="gap-3">
          <Choice id={`${id}-list-new`} value="new" title="Create a new list" />
          {listMode === "new" ? (
            <div className="grid gap-1.5 pl-7">
              <Label htmlFor={`${id}-list-name`} className="sr-only">
                Name of the new list
              </Label>
              <Input
                id={`${id}-list-name`}
                value={newName}
                maxLength={LIST_NAME_MAX}
                onChange={(e) => set({ list: { mode: "new", name: e.target.value } })}
                aria-invalid={Boolean(listError)}
                className="max-w-sm"
              />
              {listError ? (
                <p className="text-sm text-destructive" role="alert">
                  {listError}
                </p>
              ) : nameTaken ? (
                <p className="text-sm text-muted-foreground">
                  A list called &ldquo;{nameTaken.name}&rdquo; already exists; the companies will be added to it.
                </p>
              ) : null}
            </div>
          ) : null}
          <Choice
            id={`${id}-list-existing`}
            value="existing"
            title="Add to an existing list"
            hint={lists.length ? undefined : "There are no lists yet. Create a new one instead."}
            disabled={lists.length === 0}
          />
          {listMode === "existing" && lists.length ? (
            <div className="pl-7">
              <Select value={existingId} onValueChange={(v) => set({ list: { mode: "existing", listId: Number(v) } })}>
                <SelectTrigger className="w-full max-w-sm" aria-label="List">
                  <SelectValue placeholder="Pick a list" />
                </SelectTrigger>
                <SelectContent>
                  {lists.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.name} ({l.count.toLocaleString("en-US")})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <Choice id={`${id}-list-none`} value="none" title="Don't add them to a list" hint="They still show under All companies." />
        </RadioGroup>
      </Section>

      <Section
        title="Starting status"
        hint={
          hasStatusColumn
            ? "Rows with a status in the file keep it (Hired becomes Client, Rejected becomes Not interested). This status is used for the rest."
            : "New companies start with this status."
        }
      >
        <Select value={options.startStatus} onValueChange={(v) => set({ startStatus: v as CompanyStatusValue })}>
          <SelectTrigger className="w-full max-w-sm" aria-label="Starting status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMPANY_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {COMPANY_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Section>

      <Section title="Tag for the whole import (optional)" hint="Every company in this import gets this tag, so you can find them later.">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-tag`} className="sr-only">
            Tag
          </Label>
          <Input
            id={`${id}-tag`}
            value={options.tag ?? ""}
            maxLength={TAG_NAME_MAX}
            placeholder="For example: trade fair 2026"
            list={`${id}-tags`}
            onChange={(e) => set({ tag: e.target.value })}
            aria-invalid={Boolean(tagError)}
            className="max-w-sm"
          />
          <datalist id={`${id}-tags`}>
            {tags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          {tagError ? (
            <p className="text-sm text-destructive" role="alert">
              {tagError}
            </p>
          ) : null}
        </div>
      </Section>

      <Section title="Companies that already exist">
        <RadioGroup value={options.duplicates} onValueChange={(v) => set({ duplicates: v as DuplicateMode })} className="gap-3">
          <Choice
            id={`${id}-dup-skip`}
            value="skip"
            title="Skip companies that already exist"
            hint="Their details stay as they are. They're still added to the list and the tag."
          />
          <Choice
            id={`${id}-dup-update`}
            value="update"
            title="Update companies that already exist"
            hint="Fills in and overwrites the matched columns and adds new people. Nothing is deleted; notes are added to the existing notes."
          />
        </RadioGroup>
      </Section>

      <Section title="Group rows into companies">
        <RadioGroup value={options.grouping} onValueChange={(v) => set({ grouping: v as GroupingMode })} className="gap-3">
          <Choice
            id={`${id}-group-both`}
            value="website-and-name"
            title="By website and name"
            hint="Rows with the same website, the same company email domain, or the same company name and country become one company with several people."
          />
          <Choice id={`${id}-group-name`} value="name" title="By name only" hint="Only rows with the same company name and country are joined." />
          <Choice
            id={`${id}-group-website`}
            value="website"
            title="By website only"
            hint="Only rows with the same website or company email domain are joined."
          />
        </RadioGroup>
        <p className="text-xs text-muted-foreground">
          Shared addresses such as gmail.com or instagram.com never join rows.
        </p>
      </Section>
    </div>
  );
}
