"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createDraftAction } from "@/app/(app)/campaigns/new/actions";

const OFFLINE = "Couldn't reach the app, so no campaign was started. Check your connection and try again.";

/**
 * Starts a draft campaign with a click and opens the wizard at Audience. It always goes through a
 * Server Action (a POST the app checks comes from itself), never through a link: opening a link
 * must never create a draft (PLAN.md B10, "nothing changes on GET").
 */
export function useStartCampaign() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /** `replace`: the wizard takes the place of the current history entry (see useGuardedRun). */
  function start(opts: { listId?: number | null; loading?: string; replace?: boolean } = {}) {
    startTransition(async () => {
      const toastId = opts.loading ? toast.loading(opts.loading) : undefined;
      const sameToast = toastId === undefined ? undefined : { id: toastId };
      try {
        const res = await createDraftAction({ listId: opts.listId ?? null });
        if (!res.ok) {
          toast.error(res.error, sameToast);
          return;
        }
        if (toastId !== undefined) toast.dismiss(toastId);
        if (opts.replace) router.replace(res.data.href);
        else router.push(res.data.href);
      } catch {
        toast.error(OFFLINE, sameToast);
      }
    });
  }

  return { start, pending };
}

/** Campaigns › "New campaign" (the page's one primary button). */
export function NewCampaignButton() {
  const { start, pending } = useStartCampaign();
  return (
    <Button onClick={() => start()} disabled={pending}>
      <Plus aria-hidden />
      {pending ? "Starting…" : "New campaign"}
    </Button>
  );
}

/** The "Start a new campaign?" page's button (/campaigns/new, kept for old links and bookmarks). */
export function StartCampaignButton({ listId }: { listId: number | null }) {
  const { start, pending } = useStartCampaign();
  return (
    <Button onClick={() => start({ listId })} disabled={pending}>
      <Plus aria-hidden />
      {pending ? "Starting…" : "Start the campaign"}
    </Button>
  );
}
