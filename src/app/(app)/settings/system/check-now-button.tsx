"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { checkRemoteAccessAction } from "./actions";

const OFFLINE = "Couldn't reach the app. Check your connection and try again.";

/** "Check now" on the Remote access card: runs the remote-access checks right away, then shows the new results. */
export function CheckNowButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function check() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await checkRemoteAccessAction();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success("Remote access checked.");
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  return (
    <div className="grid justify-items-start gap-1">
      <Button type="button" variant="outline" size="sm" onClick={check} disabled={pending}>
        <RefreshCw className={pending ? "animate-spin" : undefined} aria-hidden />
        {pending ? "Checking…" : "Check now"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
