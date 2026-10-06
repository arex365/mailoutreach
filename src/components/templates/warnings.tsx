import { TriangleAlert } from "lucide-react";
import type { TemplateWarning } from "@/core/templates/types";
import { cn } from "@/lib/utils";

/**
 * Template warnings (unknown variables, broken braces, missing details) as a short list.
 * Warnings never block saving or sending; they say what's off and how to fix it.
 */
export function TemplateWarningList({
  warnings,
  title,
  className,
  id,
}: {
  warnings: readonly TemplateWarning[];
  /** Optional heading, e.g. "Missing for this person". */
  title?: string;
  className?: string;
  id?: string;
}) {
  if (warnings.length === 0) return null;
  return (
    <div id={id} className={cn("rounded-md border border-warning/30 bg-warning/5 px-3 py-2", className)}>
      {title ? <p className="mb-1 text-sm font-medium text-warning">{title}</p> : null}
      <ul className="grid gap-1 text-sm">
        {warnings.map((w, i) => (
          <li key={`${w.kind}-${w.where}-${w.variable ?? ""}-${i}`} className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <span>
              {w.where === "subject" ? <span className="text-muted-foreground">Subject: </span> : null}
              {w.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
