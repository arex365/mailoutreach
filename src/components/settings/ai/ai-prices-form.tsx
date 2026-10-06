"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OFFLINE_TEXT } from "@/components/ai/phone-dialog";
import { saveAiPricesAction } from "@/app/(app)/settings/ai/actions";
import type { AiSettingsView } from "@/server/services/ai/settings";
import { AI_SETTINGS_PAGE, parseAmount } from "./texts";

type Row = AiSettingsView["prices"][number];

/** A price box that isn't a number at all (the server's own check says the same for numbers out of range). */
const AI_PRICES_ERROR = "Enter prices from $0.01 to $1,000 per million tokens.";

/**
 * Settings › AI › Prices (docs/dev/M5-DESIGN.md §6.9): "Claude Haiku 4.5 · input $ [1] · output $ [5]" per model (the
 * custom model too), dollars per million tokens, 0.01–1,000 each; "Save prices" (outline). Saving lets drafting that
 * paused for a missing price go on.
 */
export function AiPricesForm({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, { input: string; output: string }>>(() =>
    Object.fromEntries(
      rows.map((r) => [r.id, { input: r.inputPerMTok != null ? String(r.inputPerMTok) : "", output: r.outputPerMTok != null ? String(r.outputPerMTok) : "" }]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [badRows, setBadRows] = useState<ReadonlySet<string>>(new Set());
  const [pending, startTransition] = useTransition();

  function set(id: string, part: "input" | "output", v: string) {
    setValues((all) => ({ ...all, [id]: { ...(all[id] ?? { input: "", output: "" }), [part]: v } }));
  }

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBadRows(new Set());
    const prices = Object.fromEntries(
      rows.map((r) => [r.id, { inputPerMTok: parseAmount(values[r.id]?.input ?? ""), outputPerMTok: parseAmount(values[r.id]?.output ?? "") }]),
    );
    startTransition(async () => {
      try {
        const res = await saveAiPricesAction({ prices });
        if (!res.ok) {
          const fe = res.fieldErrors ?? {};
          setBadRows(new Set(rows.map((r) => r.id).filter((id) => fe[id])));
          setError(fe.prices?.[0] ?? (res.error.startsWith("Some details") ? AI_PRICES_ERROR : res.error));
          return;
        }
        toast.success(res.message ?? "Prices saved.");
        router.refresh();
      } catch {
        setError(OFFLINE_TEXT);
      }
    });
  }

  return (
    <form onSubmit={save} className="grid gap-3" noValidate>
      <ul className="grid gap-3">
        {rows.map((r) => {
          const invalid = badRows.has(r.id) ? true : undefined;
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
              <span className="min-w-40 font-medium">{r.label}</span>
              <span aria-hidden>· input $</span>
              <Input
                aria-label={`${r.label}: input price, dollars per million tokens`}
                inputMode="decimal"
                value={values[r.id]?.input ?? ""}
                onChange={(e) => set(r.id, "input", e.target.value)}
                className="h-8 w-20"
                aria-invalid={invalid}
              />
              <span aria-hidden>· output $</span>
              <Input
                aria-label={`${r.label}: output price, dollars per million tokens`}
                inputMode="decimal"
                value={values[r.id]?.output ?? ""}
                onChange={(e) => set(r.id, "output", e.target.value)}
                className="h-8 w-20"
                aria-invalid={invalid}
              />
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{AI_SETTINGS_PAGE.pricesNote}</p>
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          Save prices
        </Button>
      </div>
    </form>
  );
}
