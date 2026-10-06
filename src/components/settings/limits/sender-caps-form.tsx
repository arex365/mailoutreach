"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FormError } from "@/components/forms/field";
import { saveSenderCapsAction } from "@/app/(app)/settings/limits/actions";
import { senderAddressWords } from "@/core/sending/from-address";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { parseSenderCap } from "./limits-format";

const OFFLINE = "Couldn't reach the app, so nothing was saved. Check your connection and try again.";
const BAD_CAP = "Use a whole number from 1 to 10,000, or leave it empty for no limit of their own.";

export type SenderCapRow = { userId: number; name: string; address: string | null; dailyCap: number | null };

/**
 * Per-sender limits (M3-DESIGN §5.4): Name · Sending address · Daily limit (empty = "No limit of
 * their own"), saved together with "Save sender limits". `teamFrom`: shared-From mode, where the column and the
 * missing-address cell say "Reply address" (SHARED-FROM-DESIGN §3.6); absent = per-person mode. `ownMailbox`
 * (MAIN-DOMAIN-DESIGN §3.7): the column is "Emails show" and each row's `address` is the From line that person's emails
 * show (nobody has an address of their own).
 */
export function SenderCapsForm({
  senders,
  teamFrom = false,
  ownMailbox = false,
}: {
  senders: SenderCapRow[];
  teamFrom?: boolean;
  ownMailbox?: boolean;
}) {
  const words = senderAddressWords(teamFrom);
  const column = ownMailbox ? OWN_MAILBOX_TEXTS.limitsColumn : words.label;
  const router = useRouter();
  const [values, setValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(senders.map((s) => [s.userId, s.dailyCap === null ? "" : String(s.dailyCap)])),
  );
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const caps: Array<{ userId: number; dailyCap: number | null }> = [];
    const bad: Record<number, string> = {};
    for (const s of senders) {
      const parsed = parseSenderCap(values[s.userId] ?? "");
      if (parsed === undefined) bad[s.userId] = BAD_CAP;
      else caps.push({ userId: s.userId, dailyCap: parsed });
    }
    setErrors(bad);
    if (Object.keys(bad).length > 0) {
      setFormError("Some limits need fixing. Check the highlighted rows.");
      return;
    }
    setFormError(null);
    startTransition(async () => {
      try {
        const res = await saveSenderCapsAction({ caps });
        if (!res.ok) {
          const fe = res.fieldErrors ?? {};
          const rowErrors: Record<number, string> = {};
          for (const [key, list] of Object.entries(fe)) {
            const m = /^cap-(\d+)$/.exec(key);
            if (m && list?.[0]) rowErrors[Number(m[1])] = list[0];
          }
          setErrors(rowErrors);
          setFormError(res.error);
          return;
        }
        toast.success(res.message ?? "Sender limits saved.");
        router.refresh();
      } catch {
        setFormError(OFFLINE);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table scrollLabel="Per-sender limits">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">{column}</TableHead>
              <TableHead>Daily limit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {senders.map((s) => {
              const inputId = `sender-cap-${s.userId}`;
              const error = errors[s.userId];
              return (
                <TableRow key={s.userId}>
                  <TableCell className="font-medium">
                    <label htmlFor={inputId}>{s.name}</label>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {ownMailbox ? (s.address ?? "") : (s.address ?? words.noneYet)}
                  </TableCell>
                  <TableCell>
                    <Input
                      id={inputId}
                      inputMode="numeric"
                      className="w-28"
                      placeholder="No limit"
                      value={values[s.userId] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [s.userId]: e.target.value }))}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${inputId}-error` : undefined}
                    />
                    {error ? (
                      <p id={`${inputId}-error`} role="alert" className="mt-1 text-xs text-destructive">
                        {error}
                      </p>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-sm text-muted-foreground">Empty means no limit of their own: only the domain&apos;s daily limit applies.</p>
      <FormError message={formError} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save sender limits"}
        </Button>
      </div>
    </form>
  );
}
