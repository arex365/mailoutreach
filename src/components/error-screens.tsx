"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleAlert, SearchX } from "lucide-react";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ERROR_SCREEN_COPY, errorDetails, notFoundCopy } from "./error-copy";

/**
 * The app's own "not found" and "something went wrong" screens (instead of Next's technical
 * defaults). Plain words, one next step, and the technical code only behind "Details".
 */

export function NotFoundScreen() {
  const copy = notFoundCopy(usePathname());
  return (
    <div className="px-4 py-10 md:px-6">
      <EmptyState
        icon={<SearchX className="size-6" aria-hidden />}
        title={copy.title}
        description={copy.description}
        actions={
          <Button variant="outline" asChild>
            <Link href={copy.next.href}>{copy.next.label}</Link>
          </Button>
        }
      />
    </div>
  );
}

export function ErrorScreen({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // Also in the browser console, for whoever helps to find the cause.
    console.error(error);
  }, [error]);
  const details = errorDetails(error);
  return (
    <div className="px-4 py-10 md:px-6">
      <div
        role="alert"
        className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center"
      >
        <CircleAlert className="size-6 text-muted-foreground" aria-hidden />
        <h2 className="text-base font-medium">{ERROR_SCREEN_COPY.title}</h2>
        <p className="text-sm text-muted-foreground">{ERROR_SCREEN_COPY.description}</p>
        <div className="mt-2">
          <Button variant="outline" onClick={() => retry()}>
            {ERROR_SCREEN_COPY.retry}
          </Button>
        </div>
        {details ? (
          <details className="w-full text-left text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
            <p className="mt-1 font-mono break-all text-muted-foreground">{details}</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}
