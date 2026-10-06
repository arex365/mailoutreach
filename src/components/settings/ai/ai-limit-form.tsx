"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OFFLINE_TEXT } from "@/components/ai/phone-dialog";
import { saveAiLimitAction } from "@/app/(app)/settings/ai/actions";
import { AI_SETTINGS_PAGE, parseAmount } from "./texts";

/**
 * Settings › AI › Monthly limit (docs/dev/M5-DESIGN.md §6.9): "$ [20] per month", what the limit does, this office
 * month's spend, and "Save limit" (outline). A limit above this month's spend lets drafting that stopped at the limit go
 * on at once.
 */
export function AiLimitForm({ usd, spentLine }: { usd: number; spentLine: string }) {
  const router = useRouter();
  const [value, setValue] = useState(String(usd));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await saveAiLimitAction({ usd: parseAmount(value) });
        if (!res.ok) {
          setError(res.fieldErrors?.usd?.[0] ?? res.error);
          return;
        }
        toast.success(res.message ?? "Limit saved.");
        router.refresh();
      } catch {
        setError(OFFLINE_TEXT);
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-3" noValidate>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
        <span aria-hidden>$</span>
        <Input
          aria-label="Monthly limit in dollars"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 w-24"
          aria-invalid={error ? true : undefined}
          aria-describedby="ai-limit-help"
        />
        <span>per month</span>
      </p>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <p id="ai-limit-help" className="text-sm text-muted-foreground">
        {AI_SETTINGS_PAGE.limitText}
      </p>
      <p className="text-sm">{spentLine}</p>
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          Save limit
        </Button>
      </div>
    </form>
  );
}
