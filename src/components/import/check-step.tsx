"use client";

import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { countryName } from "@/core/geo/display";
import { roundTripCheckLines } from "@/core/import/round-trip";
import type { CheckGroupView, CheckView, GroupChoice, ImportFlag, RowIssueTone } from "@/core/import/types";
import { plural } from "@/core/text";
import { cn } from "@/lib/utils";

function Flag({ flag }: { flag: ImportFlag }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-5 items-center rounded-full border px-1.5 text-[11px] leading-tight font-medium",
        flag.tone === "danger" && "border-destructive/40 text-destructive",
        flag.tone === "warning" && "border-warning/40 text-warning",
        flag.tone === "neutral" && "border-border text-muted-foreground",
      )}
    >
      {flag.text}
    </span>
  );
}

function Tile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="tabular text-2xl font-semibold">{value.toLocaleString("en-US")}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** What happens to a company. A round trip only adds people to companies that already exist. */
export function outcomeText(g: CheckGroupView, roundTrip = false): string {
  if (roundTrip) return g.peopleCount > 0 ? `Adds ${plural(g.peopleCount, "person", "people")}` : "Nothing to add";
  if (g.outcome === "create") return "New company";
  const code = g.existing ? `${g.existing.code} ${g.existing.name}` : "the existing company";
  if (g.decision?.kind === "restore" && g.decision.selected === "restore") {
    return g.outcome === "update" ? `Restore and update ${code}` : `Restore ${code}`;
  }
  return g.outcome === "update" ? `Update ${code}` : `Skip: ${code} already exists`;
}

function DecisionSelect({
  group,
  disabled,
  onChoice,
}: {
  group: CheckGroupView;
  disabled: boolean;
  onChoice: (key: string, choice: GroupChoice) => void;
}) {
  const d = group.decision;
  if (!d) return null;
  if (d.kind === "restore") {
    return (
      <Select
        value={d.selected}
        disabled={disabled}
        onValueChange={(v) => onChoice(group.key, v === "restore" ? { action: "restore" } : { action: "new" })}
      >
        <SelectTrigger size="sm" className="w-full max-w-xs" aria-label={`What to do with ${group.name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="restore">{d.label.replace(/\?$/, "")}</SelectItem>
          <SelectItem value="new">Create a new company</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  return (
    <Select
      value={String(d.selected)}
      disabled={disabled}
      onValueChange={(v) => onChoice(group.key, v === "new" ? { action: "new" } : { action: "merge", companyId: Number(v) })}
    >
      <SelectTrigger size="sm" className="w-full max-w-xs" aria-label={`What to do with ${group.name}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="new">Create a new company</SelectItem>
        {d.candidates.map((c) => (
          <SelectItem key={c.id} value={String(c.id)}>
            Same as {c.code} {c.name}
            {c.country ? ` (${countryName(c.country)})` : ""}
            {c.deleted ? ", deleted" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const TONE_LABEL: Record<RowIssueTone, string> = {
  empty: "Empty",
  invalid: "Invalid email",
  problem: "Problem",
  duplicate: "Duplicate",
  note: "Note",
  "no-email": "No email",
};

export function CheckStep({
  view,
  busy,
  onChoice,
  onDefaults,
  onOnlyProblems,
}: {
  view: CheckView;
  busy: boolean;
  onChoice: (key: string, choice: GroupChoice) => void;
  onDefaults: (patch: { possibleDuplicates?: "new" | "merge"; deletedMatches?: "restore" | "new" }) => void;
  onOnlyProblems: (value: boolean) => void;
}) {
  const id = useId();
  const s = view.summary;
  const existing = s.updateCompanies + s.skipCompanies - s.restoreCompanies;
  const toLook = s.invalidEmails + s.problemRows + s.emptyRows;
  const hasRestoreDecisions = s.deletedFound > 0;
  const details = [
    s.alreadyEmailed ? `${plural(s.alreadyEmailed, "company was", "companies were")} already emailed` : null,
    s.possibleDuplicates ? `${plural(s.possibleDuplicates, "possible duplicate", "possible duplicates")} to choose` : null,
    s.restoreCompanies ? `${plural(s.restoreCompanies, "deleted company", "deleted companies")} to restore` : null,
    s.invalidEmails ? plural(s.invalidEmails, "invalid email", "invalid emails") : null,
    s.emptyRows ? plural(s.emptyRows, "empty row", "empty rows") : null,
    s.problemRows ? `${plural(s.problemRows, "row", "rows")} with a problem` : null,
    s.noteRows ? `${plural(s.noteRows, "row", "rows")} with a note` : null,
  ].filter(Boolean);

  const roundTrip = view.roundTrip;

  return (
    <div className="grid grid-cols-1 gap-6">
      {roundTrip ? (
        <section aria-label="Summary" className="grid gap-1 rounded-lg border border-border bg-card px-4 py-3">
          {roundTripCheckLines(s).map((line, i) => (
            <p key={i} className={i === 0 ? "text-base font-medium" : "text-sm text-muted-foreground"}>
              {line}
            </p>
          ))}
        </section>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="New companies" value={s.newCompanies} hint={`from ${plural(s.rows, "row", "rows")}`} />
            <Tile
              label="Already in Contacts"
              value={existing}
              hint={existing ? (view.duplicates === "update" ? "will be updated" : "will be skipped") : undefined}
            />
            <Tile label="People to add" value={s.peopleToAdd} />
            <Tile label="Rows to look at" value={toLook} hint={toLook ? "listed below" : undefined} />
          </div>
          {details.length ? <p className="text-sm text-muted-foreground">{details.join(" · ")}</p> : null}
        </>
      )}

      {!roundTrip && (s.possibleDuplicates > 0 || hasRestoreDecisions) ? (
        <div className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
          {s.possibleDuplicates > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-dups`}>Possible duplicates (same name, other country)</Label>
              <Select
                value={view.possibleDuplicates}
                disabled={busy}
                onValueChange={(v) => onDefaults({ possibleDuplicates: v as "new" | "merge" })}
              >
                <SelectTrigger id={`${id}-dups`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">Create new companies for all of them</SelectItem>
                  <SelectItem value="merge">Treat all of them as the existing company</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">You can still choose for each company below.</p>
            </div>
          ) : null}
          {hasRestoreDecisions ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-deleted`}>Companies that were deleted</Label>
              <Select
                value={view.deletedMatches}
                disabled={busy}
                onValueChange={(v) => onDefaults({ deletedMatches: v as "restore" | "new" })}
              >
                <SelectTrigger id={`${id}-deleted`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="restore">Restore all of them (keeps their email history)</SelectItem>
                  <SelectItem value="new">Create new companies instead</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Restoring keeps the 30-day rule and unsubscribes working for them.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby={`${id}-companies`} className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id={`${id}-companies`} className="text-base font-medium">
              Companies
            </h2>
            <p className="text-sm text-muted-foreground">
              {view.totalGroups > view.groups.length
                ? `Showing the first ${view.groups.length} of ${view.totalGroups.toLocaleString("en-US")}.`
                : `${plural(view.totalGroups, "company", "companies")}${view.onlyProblems ? " that need a look" : ""}.`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-only`}
              checked={view.onlyProblems}
              disabled={busy}
              onCheckedChange={(v) => onOnlyProblems(v === true)}
            />
            <Label htmlFor={`${id}-only`} className="font-normal">
              Only show what needs a look
            </Label>
          </div>
        </div>
        {view.groups.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            {view.onlyProblems
              ? "Nothing needs a look. You can import now."
              : roundTrip
                ? "None of the company IDs in this file belongs to a company in the app. Use the file exported with Export for Claude, and keep its company_id column as it is."
                : "No companies were found in these rows. Go back and check which columns hold the company name, website and email."}
          </p>
        ) : (
          <div className="rounded-lg border border-border">
            <Table scrollLabel="Companies">
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead className="hidden md:table-cell">Rows</TableHead>
                  <TableHead className="hidden md:table-cell">{roundTrip ? "People to add" : "People"}</TableHead>
                  <TableHead>What happens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.groups.map((g) => (
                  <TableRow key={g.key} className="align-top">
                    <TableCell className="max-w-72 whitespace-normal">
                      <div className="font-medium">
                        {roundTrip && g.existing ? <span className="tabular text-muted-foreground">{g.existing.code} </span> : null}
                        {g.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[g.website, g.country ? countryName(g.country) : null].filter(Boolean).join(" · ") || "No website or country"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground md:hidden">
                        {plural(g.rowCount, "row", "rows")} · {plural(g.peopleCount, "person", "people")}
                      </div>
                    </TableCell>
                    <TableCell className="tabular hidden text-muted-foreground md:table-cell">
                      {g.rowNumbers.join(", ")}
                      {g.rowCount > g.rowNumbers.length ? ` +${g.rowCount - g.rowNumbers.length}` : ""}
                    </TableCell>
                    <TableCell className="hidden max-w-60 whitespace-normal md:table-cell">
                      {g.people.length === 0 ? (
                        <span className="text-muted-foreground">{roundTrip ? "Nobody" : "No people"}</span>
                      ) : (
                        <ul className="grid gap-0.5 text-xs">
                          {g.people.map((p, i) => (
                            <li key={i} className="truncate" title={p.email ?? p.name}>
                              {p.name || p.email}
                              {p.name && p.email ? <span className="text-muted-foreground"> · {p.email}</span> : null}
                            </li>
                          ))}
                          {g.peopleCount > g.people.length ? (
                            <li className="text-muted-foreground">and {g.peopleCount - g.people.length} more</li>
                          ) : null}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell className="min-w-56 whitespace-normal">
                      <div className="grid gap-1.5">
                        <div className="text-sm">{outcomeText(g, roundTrip)}</div>
                        {roundTrip ? null : <DecisionSelect group={g} disabled={busy} onChoice={onChoice} />}
                        {g.flags.length ? (
                          <div className="flex flex-wrap gap-1">
                            {g.flags.map((f, i) => (
                              <Flag key={i} flag={f} />
                            ))}
                          </div>
                        ) : null}
                        {g.rowNotes.length ? (
                          <ul className="grid gap-0.5 text-xs text-muted-foreground">
                            {g.rowNotes.map((n, i) => (
                              <li key={i}>{n}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {view.totalRowIssues > 0 ? (
        <section aria-labelledby={`${id}-rows`} className="grid gap-3">
          <div>
            <h2 id={`${id}-rows`} className="text-base font-medium">
              Rows to look at
            </h2>
            <p className="text-sm text-muted-foreground">
              {view.totalRowIssues > view.rowIssues.length
                ? `Showing the first ${view.rowIssues.length} of ${view.totalRowIssues.toLocaleString("en-US")}. `
                : ""}
              {roundTrip
                ? "After the import you can download the rows with a problem, fix them and import them again."
                : "After the import you can download these rows, fix them and import them again."}
            </p>
          </div>
          <div className="rounded-lg border border-border">
            <Table scrollLabel="Rows to look at">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Row</TableHead>
                  <TableHead className="hidden w-32 sm:table-cell">Kind</TableHead>
                  <TableHead>What we found</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.rowIssues.map((r, i) => (
                  <TableRow key={`${r.rowNumber}-${i}`}>
                    <TableCell className="tabular align-top">{r.rowNumber}</TableCell>
                    <TableCell
                      className={cn(
                        "hidden align-top sm:table-cell",
                        r.tone === "invalid" || r.tone === "problem" ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {TONE_LABEL[r.tone]}
                    </TableCell>
                    <TableCell className="whitespace-normal">{r.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
