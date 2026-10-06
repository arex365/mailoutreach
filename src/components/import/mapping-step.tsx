"use client";

import { useId, useMemo } from "react";
import { Info } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  customMappingFor,
  ensureUniqueCustomKeys,
  isRoundTripMapping,
  mapRow,
  previewCell,
  previewColumns,
  retargetRoundTripColumns,
  sameColumnMapping as sameMapping,
  TARGET_FIELDS,
  type ColumnMapping,
  type Confidence,
  type TargetKey,
} from "@/core/import/column-matching";
import { ROUND_TRIP_COPY } from "@/core/import/round-trip";
import { cn } from "@/lib/utils";

function toValue(m: ColumnMapping): string {
  if (m.target === "ignore") return "ignore";
  if (m.target === "custom") return "custom";
  return `t:${m.target}`;
}

/**
 * The round-trip note (M5-DESIGN §6.10), as a neutral callout on the mapping and options steps.
 * `optOut` adds how to import the file the ordinary way (a Contacts export has a company_id column too).
 */
export function RoundTripNote({ optOut = false, className }: { optOut?: boolean; className?: string }) {
  return (
    <div role="note" className={cn("flex gap-2.5 rounded-lg border border-border bg-card px-4 py-3 text-sm", className)}>
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="grid gap-1">
        <p>{ROUND_TRIP_COPY.note}</p>
        {optOut ? <p className="text-muted-foreground">{ROUND_TRIP_COPY.optOut}</p> : null}
      </div>
    </div>
  );
}

function hintFor(m: ColumnMapping, suggested: ColumnMapping | undefined, confidence: Confidence | undefined): string {
  if (m.target === "custom") {
    const base = `Kept as a custom field, usable in templates as {{${m.key}}}`;
    return sameMapping(m, suggested) && confidence === "low" ? `No match found. ${base}.` : `${base}.`;
  }
  if (m.target === "ignore") return sameMapping(m, suggested) ? "Not needed, so it's ignored." : "Ignored.";
  if (!sameMapping(m, suggested)) return "Chosen by you.";
  return confidence === "high" ? "Matched automatically." : "Best guess, please check.";
}

const COMPANY_TARGETS = TARGET_FIELDS.filter((t) => t.section === "company");
/** "Notes about the person" is only written by a round trip, so it's offered only there (M5-DESIGN §4.2). */
const PERSON_TARGETS = TARGET_FIELDS.filter((t) => t.section === "person" && t.key !== "person_notes");
const ROUND_TRIP_PERSON_TARGETS = TARGET_FIELDS.filter((t) => t.section === "person");
/** Company columns a round trip doesn't read (the company stays as it is in the app). */
const COMPANY_ONLY_TARGETS: ReadonlySet<string> = new Set(
  TARGET_FIELDS.filter((t) => t.section === "company" && t.key !== "company_id" && t.key !== "company").map((t) => t.key),
);

/**
 * The mapping after one column changed: when the change turns the round trip on or off (a column set to,
 * or away from, Company ID), the source and note columns follow (`retargetRoundTripColumns`), and custom
 * field keys stay unique.
 */
export function nextMapping(
  headers: ReadonlyArray<string>,
  sampleRows: ReadonlyArray<ReadonlyArray<string>>,
  mapping: ReadonlyArray<ColumnMapping>,
  index: number,
  value: string,
): ColumnMapping[] {
  let next = [...mapping];
  if (value === "ignore") next[index] = { target: "ignore" };
  else if (value === "custom") next[index] = customMappingFor(headers[index]!, index);
  else next[index] = { target: value.slice(2) as TargetKey };
  const wasRoundTrip = isRoundTripMapping(mapping);
  const isRoundTrip = isRoundTripMapping(next);
  if (wasRoundTrip !== isRoundTrip) next = retargetRoundTripColumns(headers, sampleRows, next, isRoundTrip);
  // Two columns can't write into the same custom field.
  return ensureUniqueCustomKeys(next);
}

export function MappingStep({
  headers,
  sampleRows,
  mapping,
  suggested,
  confidence,
  onChange,
}: {
  headers: string[];
  sampleRows: string[][];
  mapping: ColumnMapping[];
  suggested: ColumnMapping[];
  confidence: Confidence[];
  onChange: (mapping: ColumnMapping[]) => void;
}) {
  const baseId = useId();
  const columns = useMemo(() => previewColumns(mapping), [mapping]);
  const preview = useMemo(() => sampleRows.map((cells) => mapRow(mapping, cells)), [mapping, sampleRows]);
  const roundTrip = isRoundTripMapping(mapping);
  // The automatic match as it would be now (a round trip sends source and note columns to the person).
  const suggestedNow = useMemo(
    () => (isRoundTripMapping(suggested) === roundTrip ? suggested : retargetRoundTripColumns(headers, sampleRows, suggested, roundTrip)),
    [headers, sampleRows, suggested, roundTrip],
  );

  function setColumn(index: number, value: string) {
    onChange(nextMapping(headers, sampleRows, mapping, index, value));
  }

  const examples = (i: number) =>
    sampleRows
      .map((r) => r[i] ?? "")
      .filter(Boolean)
      .slice(0, 3);

  return (
    <div className="grid grid-cols-1 gap-8">
      <section aria-labelledby={`${baseId}-cols`} className="grid grid-cols-1 gap-3">
        <div>
          <h2 id={`${baseId}-cols`} className="text-base font-medium">
            Match the columns
          </h2>
          <p className="text-sm text-muted-foreground">
            Each column of your file goes into one field. Columns we don&apos;t know are kept as custom fields, so nothing is lost.
          </p>
        </div>
        {roundTrip ? <RoundTripNote optOut /> : null}
        <div className="divide-y divide-border rounded-lg border border-border">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)] gap-4 px-3 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span>Column in your file</span>
            <span>Examples</span>
            <span>Goes into</span>
          </div>
          {headers.map((header, i) => {
            const m = mapping[i]!;
            const selectId = `${baseId}-col-${i}`;
            const personTargets = roundTrip || m.target === "person_notes" ? ROUND_TRIP_PERSON_TARGETS : PERSON_TARGETS;
            // A round trip reads only the company code (and the name, to spot a mix-up) of the company columns,
            // and keeps no custom fields.
            const unused = roundTrip && (COMPANY_ONLY_TARGETS.has(m.target) || m.target === "custom");
            return (
              <div
                key={`${i}-${header}`}
                className="grid grid-cols-1 gap-2 px-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)] md:items-start md:gap-4"
              >
                <label htmlFor={selectId} className="min-w-0 truncate text-sm font-medium" title={header}>
                  {header}
                </label>
                <div className="min-w-0 text-sm text-muted-foreground">
                  {examples(i).length ? (
                    examples(i).map((v, j) => (
                      <div key={j} className="truncate" title={v}>
                        {v}
                      </div>
                    ))
                  ) : (
                    <span className="italic">empty in the first rows</span>
                  )}
                </div>
                <div className="grid min-w-0 gap-1">
                  <Select value={toValue(m)} onValueChange={(v) => setColumn(i, v)}>
                    <SelectTrigger id={selectId} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Company</SelectLabel>
                        {COMPANY_TARGETS.map((t) => (
                          <SelectItem key={t.key} value={`t:${t.key}`}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>Person</SelectLabel>
                        {personTargets.map((t) => (
                          <SelectItem key={t.key} value={`t:${t.key}`}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>Other</SelectLabel>
                        <SelectItem value="custom">
                          {m.target === "custom" ? `Custom field: ${m.label}` : "Keep as custom field"}
                        </SelectItem>
                        <SelectItem value="ignore">Ignore this column</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <p
                    className={cn(
                      "text-xs",
                      !unused && sameMapping(m, suggestedNow[i]) && confidence[i] === "medium" && m.target !== "custom" && m.target !== "ignore"
                        ? "text-warning"
                        : "text-muted-foreground",
                    )}
                  >
                    {unused ? ROUND_TRIP_COPY.unusedColumn : hintFor(m, suggestedNow[i], confidence[i])}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby={`${baseId}-preview`} className="grid grid-cols-1 gap-3">
        <div>
          <h2 id={`${baseId}-preview`} className="text-base font-medium">
            Preview
          </h2>
          <p className="text-sm text-muted-foreground">
            The first {sampleRows.length} rows as they will be imported.
          </p>
        </div>
        {columns.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Every column is ignored. Pick a field for at least the company name, website or email.
          </p>
        ) : (
          <div className="rounded-lg border border-border">
            <Table scrollLabel="Preview">
              <TableHeader>
                <TableRow>
                  {columns.map((c) => (
                    <TableHead key={c.id}>{c.label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map((row, r) => (
                  <TableRow key={r}>
                    {columns.map((c) => {
                      const v = previewCell(row, c.id);
                      return (
                        <TableCell key={c.id} className="max-w-64 truncate" title={v}>
                          {v || <span className="text-muted-foreground">–</span>}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
