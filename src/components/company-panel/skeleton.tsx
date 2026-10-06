import { Skeleton } from "@/components/ui/skeleton";

/** Loading placeholder for the company panel (the host's Suspense fallback). */
export function CompanyPanelSkeleton() {
  return (
    <div className="grid gap-6 p-4 md:p-6" aria-busy="true" aria-label="Loading the company">
      <div className="grid gap-3 pr-10">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
      <Skeleton className="h-12 w-full rounded-lg" />
      <div className="grid gap-3">
        <Skeleton className="h-4 w-24" />
        {[0, 1].map((i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-border p-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
      <div className="grid gap-3">
        <Skeleton className="h-4 w-24" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[8.5rem_1fr]">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
