"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/action";

export const OFFLINE_MESSAGE = "Couldn't reach the app. Check your connection and try again.";

/**
 * Runs one of the campaign page's Server Actions in a transition: toasts the engine's message on
 * success and refreshes the page; keeps the plain error for the caller to show (and toasts it when
 * asked). Nothing is thrown at the person.
 */
export function useCampaignAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run<T>(
    call: () => Promise<ActionResult<T>>,
    opts: { onSuccess?: (data: T) => void; toastError?: boolean } = {},
  ) {
    setError(null);
    startTransition(async () => {
      let res: ActionResult<T>;
      try {
        res = await call();
      } catch {
        res = { ok: false, error: OFFLINE_MESSAGE };
      }
      if (!res.ok) {
        setError(res.error);
        if (opts.toastError) toast.error(res.error);
        return;
      }
      if (res.message) toast.success(res.message);
      opts.onSuccess?.(res.data);
      router.refresh();
    });
  }

  return { pending, error, setError, run };
}
