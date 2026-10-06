"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FormError } from "@/components/forms/field";
import { countryOptions } from "@/core/geo/display";
import {
  COMPANY_STATUSES,
  COMPANY_STATUS_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  type CompanyStatusValue,
  type PriorityValue,
} from "@/core/labels";
import { createCompanyAction, restoreCompanyAction } from "@/app/(app)/contacts/actions";
import { useContacts } from "./contacts-provider";
import type { CreateCompanyOutcome, ListSummary } from "./types";

/** The one primary button of the Contacts screen. */
export function AddCompanyButton() {
  const { setAddOpen } = useContacts();
  return (
    <Button onClick={() => setAddOpen(true)}>
      <Plus className="size-4" aria-hidden />
      Add company
    </Button>
  );
}

type AddCompanyDialogProps = {
  lists: ListSummary[];
  niches: string[];
  /** Pre-selects the list being viewed. */
  defaultListId?: number;
};

export function AddCompanyDialog(props: AddCompanyDialogProps) {
  const { addOpen, setAddOpen } = useContacts();
  return (
    <Dialog open={addOpen} onOpenChange={setAddOpen}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        {/* Remounts on every open, so the form starts empty. */}
        {addOpen ? <AddCompanyForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

type Duplicate = Exclude<CreateCompanyOutcome, { kind: "created" }>;

function AddCompanyForm({ lists, niches, defaultListId }: AddCompanyDialogProps) {
  const id = useId();
  const { setAddOpen, openCompany } = useContacts();
  const countries = useMemo(() => countryOptions(), []);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [country, setCountry] = useState("none");
  const [niche, setNiche] = useState("");
  const [priority, setPriority] = useState<PriorityValue>("NORMAL");
  const [status, setStatus] = useState<CompanyStatusValue>("NOT_CONTACTED");
  const [listId, setListId] = useState(defaultListId && lists.some((l) => l.id === defaultListId) ? String(defaultListId) : "none");
  const [personName, setPersonName] = useState("");
  const [personEmail, setPersonEmail] = useState("");
  const [personRole, setPersonRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const [pending, startTransition] = useTransition();

  const fid = (k: string) => `${id}-${k}`;
  const fe = (k: string) => fieldErrors[k];
  const invalid = (k: string) =>
    fieldErrors[k]?.length ? { "aria-invalid": true as const, "aria-describedby": `${fid(k)}-error` } : {};

  /** Any edit clears the previous answer, so the next save checks again. */
  function edited() {
    if (duplicate) setDuplicate(null);
    if (error) setError(null);
  }

  function clearField(k: string) {
    if (fieldErrors[k]) setFieldErrors((prev) => ({ ...prev, [k]: undefined }));
    edited();
  }

  function save(force: boolean) {
    if (!name.trim()) {
      setFieldErrors((prev) => ({ ...prev, name: ["Type the company's name."] }));
      return;
    }
    startTransition(async () => {
      const res = await createCompanyAction({
        name,
        website: website || null,
        country: country === "none" ? null : country,
        niche: niche || null,
        priority,
        status,
        listId: listId === "none" ? null : Number(listId),
        person: personName || personEmail || personRole ? { name: personName, email: personEmail, role: personRole } : null,
        force,
      });
      if (!res.ok) {
        setError(res.error);
        setFieldErrors(res.fieldErrors ?? {});
        setDuplicate(null);
        return;
      }
      if (res.data.kind === "created") {
        toast.success(res.message ?? `Added ${res.data.companyName}.`);
        setAddOpen(false);
        openCompany(res.data.companyId);
        return;
      }
      setError(null);
      setFieldErrors({});
      setDuplicate(res.data);
    });
  }

  function openExisting(companyId: number) {
    setAddOpen(false);
    openCompany(companyId);
  }

  function restore(companyId: number) {
    startTransition(async () => {
      const res = await restoreCompanyAction({ id: companyId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message ?? "Restored.");
      setAddOpen(false);
      openCompany(companyId);
    });
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
      noValidate
    >
      <DialogHeader>
        <DialogTitle>Add a company</DialogTitle>
        <DialogDescription>Only the name is needed. You can add more people and details in the company panel afterwards.</DialogDescription>
      </DialogHeader>

      <FormError message={error} />
      {duplicate ? (
        <DuplicateNotice
          duplicate={duplicate}
          pending={pending}
          onOpen={openExisting}
          onRestore={restore}
          onCreateAnyway={() => save(true)}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name" htmlFor={fid("name")} error={fe("name")} className="sm:col-span-2">
          <Input
            id={fid("name")}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clearField("name");
            }}
            autoFocus
            required
            maxLength={200}
            autoComplete="off"
            {...invalid("name")}
          />
        </Field>
        <Field label="Website or profile" htmlFor={fid("website")} error={fe("website")} hint="For example acme.de or instagram.com/acme" className="sm:col-span-2">
          <Input
            id={fid("website")}
            value={website}
            onChange={(e) => {
              setWebsite(e.target.value);
              clearField("website");
            }}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            {...invalid("website")}
          />
        </Field>
        <Field label="Country" htmlFor={fid("country")} error={fe("country")}>
          <Select
            value={country}
            onValueChange={(v) => {
              setCountry(v);
              clearField("country");
            }}
          >
            <SelectTrigger id={fid("country")} className="w-full" {...invalid("country")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-72">
              <SelectItem value="none">Unknown</SelectItem>
              {countries.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Niche" htmlFor={fid("niche")} error={fe("niche")}>
          <Input
            id={fid("niche")}
            value={niche}
            onChange={(e) => {
              setNiche(e.target.value);
              clearField("niche");
            }}
            list={niches.length ? fid("niches") : undefined}
            placeholder="For example tabletop miniatures"
            maxLength={100}
            autoComplete="off"
            {...invalid("niche")}
          />
          {niches.length ? (
            <datalist id={fid("niches")}>
              {niches.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          ) : null}
        </Field>
        <Field label="Priority" htmlFor={fid("priority")}>
          <Select value={priority} onValueChange={(v) => setPriority(v as PriorityValue)}>
            <SelectTrigger id={fid("priority")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Status" htmlFor={fid("status")}>
          <Select value={status} onValueChange={(v) => setStatus(v as CompanyStatusValue)}>
            <SelectTrigger id={fid("status")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {COMPANY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {COMPANY_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Add to list" htmlFor={fid("list")} error={fe("listId")} className="sm:col-span-2">
          <Select
            value={listId}
            onValueChange={(v) => {
              setListId(v);
              clearField("listId");
            }}
          >
            <SelectTrigger id={fid("list")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-72">
              <SelectItem value="none">No list</SelectItem>
              {lists.map((l) => (
                <SelectItem key={l.id} value={String(l.id)}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <fieldset className="grid gap-4 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">
          First person <span className="font-normal text-muted-foreground">(optional)</span>
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor={fid("personName")} error={fe("personName")}>
            <Input
              id={fid("personName")}
              value={personName}
              onChange={(e) => {
                setPersonName(e.target.value);
                clearField("personName");
              }}
              autoComplete="off"
              maxLength={200}
              {...invalid("personName")}
            />
          </Field>
          <Field label="Role" htmlFor={fid("personRole")} error={fe("personRole")}>
            <Input
              id={fid("personRole")}
              value={personRole}
              onChange={(e) => {
                setPersonRole(e.target.value);
                clearField("personRole");
              }}
              placeholder="For example Product manager"
              autoComplete="off"
              maxLength={100}
              {...invalid("personRole")}
            />
          </Field>
          <Field
            label="Email"
            htmlFor={fid("personEmail")}
            error={fe("personEmail")}
            hint="An address like info@ becomes the company's General inbox."
            className="sm:col-span-2"
          >
            <Input
              id={fid("personEmail")}
              type="email"
              value={personEmail}
              onChange={(e) => {
                setPersonEmail(e.target.value);
                clearField("personEmail");
              }}
              autoComplete="off"
              spellCheck={false}
              {...invalid("personEmail")}
            />
          </Field>
        </div>
      </fieldset>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => setAddOpen(false)} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add company"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DuplicateNotice({
  duplicate,
  pending,
  onOpen,
  onRestore,
  onCreateAnyway,
}: {
  duplicate: Duplicate;
  pending: boolean;
  onOpen: (id: number) => void;
  onRestore: (id: number) => void;
  onCreateAnyway: () => void;
}) {
  const { match } = duplicate;
  const code = `C-${match.companyId}`;
  const hard = duplicate.kind === "duplicate";
  return (
    <div
      role="alert"
      className={
        hard
          ? "grid gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          : "grid gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
      }
    >
      <p className="flex gap-2">
        <AlertTriangle className={hard ? "mt-0.5 size-4 shrink-0 text-destructive" : "mt-0.5 size-4 shrink-0 text-warning"} aria-hidden />
        <span>{duplicate.message}</span>
      </p>
      <div className="flex flex-wrap gap-2 pl-6">
        {match.deleted ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onRestore(match.companyId)} disabled={pending}>
            Restore {code}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => onOpen(match.companyId)} disabled={pending}>
            Open {code}
          </Button>
        )}
        {!hard ? (
          <Button type="button" variant="secondary" size="sm" onClick={onCreateAnyway} disabled={pending}>
            Create anyway
          </Button>
        ) : null}
      </div>
    </div>
  );
}
