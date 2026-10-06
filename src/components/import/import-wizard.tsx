"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/forms/field";
import { isRoundTripMapping, mappingProblem, type ColumnMapping } from "@/core/import/column-matching";
import { ROUND_TRIP_OPTIONS } from "@/core/import/round-trip";
import {
  importSourceLabel,
  type CheckView,
  type GroupChoice,
  type ImportOptions,
  type ImportSessionView,
} from "@/core/import/types";
import { plural } from "@/core/text";
import { formatDateTime } from "@/core/time/format";
import {
  checkImportAction,
  discardImportAction,
  saveImportMappingAction,
  saveImportOptionsAction,
  setImportChoiceAction,
  setImportDefaultsAction,
  startImportAction,
} from "@/app/(app)/import/actions";
import { CheckStep } from "./check-step";
import { ImportProgress, ImportResult } from "./commit-step";
import { MappingStep } from "./mapping-step";
import { OptionsStep, RoundTripOptionsStep, type ListChoice } from "./options-step";
import { ImportStepper, type ImportStepNumber } from "./stepper";

type EditableOptions = Pick<ImportOptions, "list" | "startStatus" | "tag" | "duplicates" | "grouping">;

/** The Check step's primary button: what the import will do, in a few words. */
export function importButtonLabel(view: CheckView): string {
  const s = view.summary;
  if (view.roundTrip) return s.peopleToAdd > 0 ? `Add ${plural(s.peopleToAdd, "person", "people")}` : "Finish the import";
  const created = s.newCompanies;
  const changed = view.duplicates === "update" ? s.updateCompanies : 0;
  if (created && changed) return `Import ${plural(created, "new company", "new companies")} and update ${changed.toLocaleString("en-US")}`;
  if (created) return `Import ${plural(created, "new company", "new companies")}`;
  if (changed) return `Update ${plural(changed, "company", "companies")}`;
  return "Finish the import";
}

export function ImportWizard({
  session,
  lists,
  tags,
  timeZone,
}: {
  session: ImportSessionView;
  lists: ListChoice[];
  tags: string[];
  timeZone: string;
}) {
  const router = useRouter();
  const running = session.status === "COMMITTING";
  const finished = session.status === "DONE" && session.summary;
  const [step, setStep] = useState<2 | 3 | 4>(2);
  const [mapping, setMapping] = useState<ColumnMapping[]>(session.mapping);
  const [options, setOptions] = useState<EditableOptions>({
    list: session.options.list,
    startStatus: session.options.startStatus,
    tag: session.options.tag,
    duplicates: session.options.duplicates,
    grouping: session.options.grouping,
  });
  const [check, setCheck] = useState<CheckView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined> | undefined>();
  const [pending, startTransition] = useTransition();
  const [started, setStarted] = useState<number | null>(null);
  const fileLabel = importSourceLabel(session.fileName, session.kind);
  const defaultListName = session.options.list.mode === "new" ? session.options.list.name : "";

  const header = (
    <p className="text-sm text-muted-foreground">
      {session.kind === "paste" ? "Pasted rows" : session.fileName}
      {session.sheet ? ` · sheet ${session.sheet}` : ""} · {plural(session.rowCount, "row", "rows")} · uploaded by{" "}
      {session.createdByName} on {formatDateTime(session.createdAt, timeZone)}
    </p>
  );

  if (finished) {
    return (
      <div className="grid grid-cols-1 gap-6">
        <ImportStepper current={5} />
        {header}
        <ImportResult sessionId={session.id} fileLabel={fileLabel} summary={session.summary!} />
      </div>
    );
  }
  if (running || started !== null) {
    return (
      <div className="grid grid-cols-1 gap-6">
        <ImportStepper current={5} />
        {header}
        <ImportProgress sessionId={session.id} jobId={started ?? session.jobId} fileLabel={fileLabel} />
      </div>
    );
  }

  const hasStatusColumn = mapping.some((m) => m.target === "status");
  const problem = mappingProblem(mapping);
  // The missing-emails round trip (a Company ID column): no options, people only (M5-DESIGN §6.10).
  const roundTrip = isRoundTripMapping(mapping);

  function goToOptions() {
    setError(null);
    if (problem) {
      setError(problem);
      return;
    }
    startTransition(async () => {
      const res = await saveImportMappingAction({ sessionId: session.id, mapping });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStep(3);
      window.scrollTo({ top: 0 });
    });
  }

  function goToCheck() {
    setError(null);
    setFieldErrors(undefined);
    startTransition(async () => {
      const saved = await saveImportOptionsAction({
        sessionId: session.id,
        // A round trip saves the defaults unchanged, so the check works as for any import.
        options: roundTrip ? ROUND_TRIP_OPTIONS : { ...options, tag: options.tag?.trim() ? options.tag : null },
      });
      if (!saved.ok) {
        setError(saved.error);
        setFieldErrors(saved.fieldErrors);
        return;
      }
      const res = await checkImportAction({ sessionId: session.id, onlyProblems: false });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCheck(res.data);
      setStep(4);
      window.scrollTo({ top: 0 });
    });
  }

  function onChoice(groupKey: string, choice: GroupChoice) {
    startTransition(async () => {
      const res = await setImportChoiceAction({ sessionId: session.id, groupKey, choice, onlyProblems: check?.onlyProblems });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setCheck(res.data);
    });
  }

  function onDefaults(patch: { possibleDuplicates?: "new" | "merge"; deletedMatches?: "restore" | "new" }) {
    startTransition(async () => {
      const res = await setImportDefaultsAction({ sessionId: session.id, ...patch, onlyProblems: check?.onlyProblems });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setCheck(res.data);
    });
  }

  function onOnlyProblems(value: boolean) {
    startTransition(async () => {
      const res = await checkImportAction({ sessionId: session.id, onlyProblems: value });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setCheck(res.data);
    });
  }

  function startImport() {
    setError(null);
    startTransition(async () => {
      const res = await startImportAction({ sessionId: session.id });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStarted(res.data.jobId);
      window.scrollTo({ top: 0 });
    });
  }

  function discard() {
    startTransition(async () => {
      const res = await discardImportAction({ sessionId: session.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      router.push("/import");
    });
  }

  const current: ImportStepNumber = step;

  // grid-cols-1 (minmax(0, 1fr)), not the implicit auto column: a long file value in the mapping step would otherwise
  // widen the whole page on a phone.
  return (
    <div className="grid grid-cols-1 gap-6">
      <ImportStepper current={current} />
      {header}
      {session.status === "FAILED" ? (
        <FormError message="The last attempt to import this file stopped before it wrote anything. Check the columns and options, then start it again." />
      ) : null}

      {step === 2 ? (
        <MappingStep
          headers={session.headers}
          sampleRows={session.sampleRows}
          mapping={mapping}
          suggested={session.suggestedMapping}
          confidence={session.confidence}
          onChange={(m) => {
            setMapping(m);
            setError(null);
          }}
        />
      ) : null}
      {step === 3 && roundTrip ? <RoundTripOptionsStep /> : null}
      {step === 3 && !roundTrip ? (
        <OptionsStep
          options={options}
          lists={lists}
          tags={tags}
          hasStatusColumn={hasStatusColumn}
          defaultListName={defaultListName}
          fieldErrors={fieldErrors}
          onChange={setOptions}
        />
      ) : null}
      {step === 4 && check ? (
        <CheckStep view={check} busy={pending} onChoice={onChoice} onDefaults={onDefaults} onOnlyProblems={onOnlyProblems} />
      ) : null}

      <FormError message={error} />

      <div className="sticky bottom-14 z-10 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:bottom-0 md:-mx-6 md:px-6">
        <div className="flex flex-wrap gap-2">
          {step === 2 ? (
            <Button type="button" variant="ghost" onClick={discard} disabled={pending}>
              Start over
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null);
                setStep(step === 4 ? 3 : 2);
              }}
            >
              Back
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pending ? <span className="text-sm text-muted-foreground">{step === 3 ? "Checking the rows…" : "Working…"}</span> : null}
          {step === 2 ? (
            <Button type="button" onClick={goToOptions} disabled={pending}>
              Next: options
            </Button>
          ) : null}
          {step === 3 ? (
            <Button type="button" onClick={goToCheck} disabled={pending}>
              {roundTrip ? "Continue" : "Next: check the rows"}
            </Button>
          ) : null}
          {step === 4 && check ? (
            <Button type="button" onClick={startImport} disabled={pending || check.summary.companies === 0}>
              {importButtonLabel(check)}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
