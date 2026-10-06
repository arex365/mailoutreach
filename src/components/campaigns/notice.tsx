import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/** A short boxed message on a campaign screen ("Dry run: nothing leaves this PC…"). */
export function Notice({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "warning" | "danger";
  children: React.ReactNode;
  className?: string;
}) {
  const Icon = tone === "danger" ? CircleAlert : tone === "warning" ? TriangleAlert : Info;
  return (
    <div
      role={tone === "info" ? undefined : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm",
        tone === "info" && "border-border bg-card",
        tone === "warning" && "border-warning/40 bg-warning/5",
        tone === "danger" && "border-destructive/40 bg-destructive/10",
        className,
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "info" && "text-muted-foreground",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-destructive",
        )}
        aria-hidden
      />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}
