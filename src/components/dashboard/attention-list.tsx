import Link from "next/link";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ATTENTION_TEXTS, type AttentionItem, type AttentionTone } from "@/core/dashboard/attention";

/**
 * "Needs your attention" (M6-DESIGN §4.2): one row per item with its tone icon (never orange), the text, an optional
 * second line and the link (or, for Members, "Ask the Owner to fix this."). At most 15 rows, then "and 3 more".
 * Server component.
 */
export function AttentionList({ items, more }: { items: readonly AttentionItem[]; more: number }) {
  return (
    <section aria-labelledby="attention-heading" className="grid gap-3">
      <h2 id="attention-heading" className="text-base font-semibold">
        {ATTENTION_TEXTS.heading}
      </h2>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">{ATTENTION_TEXTS.empty}</p>
      ) : (
        <ul className="grid divide-y divide-border rounded-xl bg-card ring-1 ring-foreground/10">
          {items.map((item, i) => (
            <li key={`${item.key}-${i}`} data-attention={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
              <ToneIcon tone={item.tone} />
              <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
                <p className="text-sm break-words">{item.text}</p>
                {item.detail ? <p className="text-xs text-muted-foreground break-words">{item.detail}</p> : null}
              </div>
              {item.link ? (
                <Button asChild variant="ghost" size="sm" className="h-11 w-full justify-start sm:h-7 sm:w-auto">
                  <Link href={item.link.href}>{item.link.label}</Link>
                </Button>
              ) : item.note ? (
                <p className="w-full text-xs text-muted-foreground sm:w-auto sm:self-center">{item.note}</p>
              ) : null}
            </li>
          ))}
          {more > 0 ? <li className="px-4 py-3 text-sm text-muted-foreground">{ATTENTION_TEXTS.more(more)}</li> : null}
        </ul>
      )}
    </section>
  );
}

/** Red circle for what stopped sending, amber triangle for a warning, a neutral dot for work waiting. */
function ToneIcon({ tone }: { tone: AttentionTone }) {
  if (tone === "danger") return <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />;
  if (tone === "warning") return <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />;
  return (
    <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
      <span className="size-2 rounded-full bg-muted-foreground" />
    </span>
  );
}
