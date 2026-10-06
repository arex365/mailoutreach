"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { outboxHref } from "./format";

const ALL = "all";

/** "Show emails from: All campaigns / Germany Q4 (120) / …" for the dry-run outbox. */
export function OutboxFilter({
  campaigns,
  campaignId,
}: {
  campaigns: Array<{ id: number; name: string; count: number }>;
  campaignId: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={pending || undefined}>
      <label htmlFor="outbox-campaign" className="text-sm text-muted-foreground">
        Show emails from
      </label>
      <Select
        value={campaignId ? String(campaignId) : ALL}
        onValueChange={(v) => {
          startTransition(() => {
            router.push(outboxHref({ campaignId: v === ALL ? null : Number(v) }), { scroll: false });
          });
        }}
      >
        <SelectTrigger id="outbox-campaign" className="min-w-56 max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All campaigns</SelectItem>
          {campaigns.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              {c.name} ({c.count.toLocaleString("en-US")})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
