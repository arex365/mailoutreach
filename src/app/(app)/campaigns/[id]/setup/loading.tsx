import { Skeleton } from "@/components/ui/skeleton";

/** Shown while a wizard step loads (a big audience takes a moment to check). */
export default function CampaignSetupLoading() {
  return (
    <div className="px-4 pt-6 md:px-6" aria-busy="true" aria-label="Loading this step">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-7 w-64 max-w-full" />
      <Skeleton className="mt-2 h-4 w-48" />
      <div className="mt-6 flex flex-wrap gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-full" />
        ))}
      </div>
      <div className="mt-8 grid gap-3">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <p className="sr-only" role="status">
        Loading…
      </p>
    </div>
  );
}
