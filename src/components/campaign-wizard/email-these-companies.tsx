"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createDraftFromCompaniesAction } from "@/app/(app)/campaigns/new/actions";

const OFFLINE = "Couldn't reach the app, so no campaign was started. Check your connection and try again.";

/**
 * Contacts bulk bar › "Email these companies": starts a draft campaign with exactly the ticked
 * companies (sent in the request body, so up to 10,000 work) and opens the wizard's Audience step.
 */
export function EmailTheseCompaniesButton({ selectedIds, disabled }: { selectedIds: readonly number[]; disabled?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function start() {
    startTransition(async () => {
      try {
        const res = await createDraftFromCompaniesAction({ companyIds: [...selectedIds] });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        router.push(res.data.href);
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={start} disabled={disabled || pending || selectedIds.length === 0}>
      <Mail className="size-3.5" aria-hidden />
      {pending ? "Starting…" : "Email these companies"}
    </Button>
  );
}
