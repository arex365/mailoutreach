import { Skeleton } from "@/components/ui/skeleton";

/** Shown while the Contacts screen loads for the first time. */
export default function ContactsLoading() {
  return (
    <div className="flex" aria-busy="true" aria-label="Loading contacts">
      <aside className="hidden w-60 shrink-0 flex-col gap-2 border-r border-border px-3 py-4 md:flex">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="mt-4 h-3 w-12" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-5/6" />
        <Skeleton className="h-7 w-4/6" />
      </aside>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3 px-4 pt-6 pb-4 md:px-6">
          <Skeleton className="h-7 w-32" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-32" />
          </div>
        </div>
        <div className="flex gap-3 border-b border-border px-4 pb-2 md:px-6">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-6 w-20" />
          ))}
        </div>
        <div className="flex flex-wrap gap-2 px-4 py-3 md:px-6">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="ml-auto h-7 w-24" />
          <Skeleton className="h-7 w-24" />
        </div>
        <div className="grid gap-px px-4 md:px-6">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border py-3">
              <Skeleton className="size-4" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-6 w-24 rounded-full" />
              <Skeleton className="hidden h-4 w-28 sm:block" />
              <Skeleton className="hidden h-4 w-28 lg:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
