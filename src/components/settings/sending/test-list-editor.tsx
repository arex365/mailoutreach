"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveTestListAction } from "@/app/(app)/settings/sending/actions";
import { TEST_LIST_MAX } from "@/core/reply-test";
import { TEST_LIST_TEXTS } from "./texts";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/**
 * Settings › Sending & Mailgun › Test list (M3-DESIGN §5.2): up to 10 mailboxes that may receive real email before
 * go-live (after it, Test mode and the reply test still use them, M6-DESIGN §2.7). Each Add or Remove saves the whole
 * list at once; a teammate's reply inbox is accepted with a warning. The empty state has no button of its own: the "Add
 * a test mailbox" field and its Add address button sit right below it.
 */
export function TestListEditor({
  addresses,
  warnings,
  hint = TEST_LIST_TEXTS.hint,
  empty = TEST_LIST_TEXTS.empty,
}: {
  addresses: string[];
  warnings: string[];
  /** The hint under the field (before or after go-live, `testListTexts`). */
  hint?: string;
  /** The empty state (`testListTexts(…).empty`: own-mailbox mode's words, review SCREENS-11). */
  empty?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const full = addresses.length >= TEST_LIST_MAX;

  function save(next: string[], success: string) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await saveTestListAction({ addresses: next });
        if (!res.ok) {
          setError(res.fieldErrors?.address?.[0] ?? res.error);
          return;
        }
        setValue("");
        toast.success(success);
        for (const w of res.data.warnings) toast.warning(w);
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = value.trim();
    if (!v) {
      setError("Type an email address first, for example ana.test@gmail.com.");
      inputRef.current?.focus();
      return;
    }
    save([...addresses, v], `Added ${v.toLowerCase()} to the test list.`);
  }

  return (
    <div className="grid gap-4">
      {addresses.length === 0 ? (
        // The next step is the "Add a test mailbox" field right below, with its own Add address button.
        <div className="rounded-lg border border-dashed border-border px-4 py-5">
          <p className="text-sm">{empty}</p>
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">
            {addresses.length} of {TEST_LIST_MAX}
          </p>
          {/* grid-cols-1 (minmax(0, 1fr)) and min-w-0: a long address ends in "…" and Remove stays in the card on a phone. */}
          <ul className="grid grid-cols-1 gap-1" aria-label="Test list">
            {addresses.map((a) => (
              <li key={a} className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5">
                <span className="min-w-0 truncate font-mono text-sm" title={a}>
                  {a}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => save(addresses.filter((x) => x !== a), `Removed ${a} from the test list.`)}
                  aria-label={`Remove ${a}`}
                >
                  <X aria-hidden /> Remove
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {w}
        </p>
      ))}

      <form onSubmit={add} className="grid gap-1.5" noValidate>
        <Label htmlFor="test-address">Add a test mailbox</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            ref={inputRef}
            id="test-address"
            type="email"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="ana.test@gmail.com"
            autoComplete="off"
            className="w-full sm:w-80"
            disabled={full}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "test-address-error" : "test-address-hint"}
          />
          <Button type="submit" variant="outline" disabled={pending || full}>
            Add address
          </Button>
        </div>
        {error ? (
          <p id="test-address-error" className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : (
          <p id="test-address-hint" className="text-sm text-muted-foreground">
            {full ? `The test list is full (${TEST_LIST_MAX} addresses). Remove one to add another.` : hint}
          </p>
        )}
      </form>
    </div>
  );
}
