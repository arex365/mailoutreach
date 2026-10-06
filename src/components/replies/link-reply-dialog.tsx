"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormError } from "@/components/forms/field";
import { cn } from "@/lib/utils";
import type { QuickCompanyResult } from "@/server/services/companies/query";
import type { LinkCompanyView, WaitingReplyView } from "@/server/services/replies/waiting";
import { searchCompaniesAction } from "@/app/(app)/contacts/actions";
import { linkReplyAction, replyLinkCompanyAction } from "@/app/(app)/notifications/reply-actions";
import { tellBell } from "./tell-bell";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";
const NOT_ONE = "none";

/**
 * "Link this reply to a company" (M4-DESIGN §3.5 "Linking by hand", §9.1): search a company (the existing Ctrl+K search),
 * pre-selected with the domain hold's or the first same-domain company; pick the person the reply concerns ("Not one
 * of these people" = the person the company's latest email went to); add the sender as a person when they aren't a
 * contact (ticked by default); and, when the app wasn't sure it was a real reply, answer "Is it a real reply?". On a
 * phone the dialog opens full screen.
 */
export function LinkReplyDialog({
  reply,
  open,
  onOpenChange,
}: {
  reply: Pick<WaitingReplyView, "id" | "fromEmail" | "fromIsContact" | "whyLines" | "hintCompanyId">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-lg max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">
        {open ? <LinkForm reply={reply} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's form: mounted each time the dialog opens, so it always starts fresh. */
function LinkForm({
  reply,
  onClose,
}: {
  reply: Pick<WaitingReplyView, "id" | "fromEmail" | "fromIsContact" | "whyLines" | "hintCompanyId">;
  onClose: () => void;
}) {
  const router = useRouter();
  const ids = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickCompanyResult[]>([]);
  const [searched, setSearched] = useState("");
  const [company, setCompany] = useState<LinkCompanyView | null>(null);
  const [personValue, setPersonValue] = useState<string>(NOT_ONE);
  const [addPerson, setAddPerson] = useState(true);
  const [real, setReal] = useState<"yes" | "no">("yes");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);
  const possible = reply.whyLines.length > 0;

  // The hint company is picked when the dialog opens (the domain hold's, else the first same-domain company).
  useEffect(() => {
    const hint = reply.hintCompanyId;
    if (!hint) return;
    let live = true;
    void replyLinkCompanyAction({ companyId: hint })
      .then((res) => {
        if (live && res.ok) setCompany(res.data);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [reply.hintCompanyId]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function runSearch(q: string) {
    const id = ++requestId.current;
    startTransition(async () => {
      try {
        const res = await searchCompaniesAction({ q });
        if (id !== requestId.current) return; // a newer search has started
        setResults(res.ok ? res.data : []);
        setError(res.ok ? null : res.error);
        setSearched(q);
      } catch {
        if (id === requestId.current) setError(OFFLINE);
      }
    });
  }

  function onQueryChange(next: string) {
    setQuery(next);
    if (timer.current) clearTimeout(timer.current);
    const q = next.trim();
    if (!q) {
      requestId.current++;
      setResults([]);
      setSearched("");
      return;
    }
    timer.current = setTimeout(() => runSearch(q), 200);
  }

  function pick(companyId: number) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await replyLinkCompanyAction({ companyId });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setCompany(res.data);
        setPersonValue(NOT_ONE);
      } catch {
        setError(OFFLINE);
      }
    });
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!company) {
      setError("Pick a company first.");
      return;
    }
    startTransition(async () => {
      try {
        const res = await linkReplyAction({
          id: reply.id,
          companyId: company.id,
          personId: personValue === NOT_ONE ? null : Number(personValue),
          addPerson: !reply.fromIsContact && addPerson,
          real: possible ? real === "yes" : true,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.data.message);
        tellBell();
        onClose();
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  const q = query.trim();
  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Link this reply to a company</DialogTitle>
        <DialogDescription>From {reply.fromEmail}. Linking stops the right follow-ups and puts the reply on that company&apos;s timeline.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-company`}>Company</Label>
        <Input
          id={`${ids}-company`}
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search by name or website"
        />
        {company ? (
          <p className="text-sm">
            Picked: <span className="font-medium">{company.name}</span> <span className="text-muted-foreground">(C-{company.id})</span>
          </p>
        ) : null}
        {q && searched === q && results.length === 0 ? (
          <p className="text-sm text-muted-foreground">No companies match. Try part of the name or the website.</p>
        ) : null}
        {results.length > 0 ? (
          <ul className="grid max-h-56 gap-1 overflow-y-auto rounded-md border border-border p-1" aria-label="Matching companies">
            {results.map((r) => {
              const selected = company?.id === r.id;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => pick(r.id)}
                    aria-pressed={selected}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                      selected && "bg-accent",
                    )}
                  >
                    <Check className={cn("size-4 shrink-0", selected ? "text-brand" : "invisible")} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">C-{r.id}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {company ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-person`}>Person</Label>
          <Select value={personValue} onValueChange={setPersonValue}>
            <SelectTrigger id={`${ids}-person`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {company.people.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.label}
                </SelectItem>
              ))}
              <SelectItem value={NOT_ONE}>Not one of these people</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {!reply.fromIsContact ? (
        <div className="flex items-start gap-2">
          <Checkbox id={`${ids}-add`} checked={addPerson} onCheckedChange={(v) => setAddPerson(v === true)} className="mt-0.5" />
          <Label htmlFor={`${ids}-add`} className="font-normal">
            Add {reply.fromEmail} to this company as a person
          </Label>
        </div>
      ) : null}

      {possible ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Is it a real reply?</legend>
          <RadioGroup value={real} onValueChange={(v) => setReal(v === "no" ? "no" : "yes")}>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${ids}-yes`} value="yes" />
              <Label htmlFor={`${ids}-yes`} className="font-normal">
                Yes
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${ids}-no`} value="no" />
              <Label htmlFor={`${ids}-no`} className="font-normal">
                No, it was automatic
              </Label>
            </div>
          </RadioGroup>
        </fieldset>
      ) : null}

      <FormError message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Linking…" : "Link reply"}
        </Button>
      </DialogFooter>
    </form>
  );
}
