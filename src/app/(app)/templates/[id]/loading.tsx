import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder while a template opens. */
export default function TemplateEditorLoading() {
  return (
    <div aria-busy="true" aria-label="Opening the template">
      <div className="grid gap-2 px-4 pt-6 pb-4 md:px-6">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="grid gap-6 px-4 md:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="grid content-start gap-4">
          <Skeleton className="h-9 w-full max-w-md" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}
