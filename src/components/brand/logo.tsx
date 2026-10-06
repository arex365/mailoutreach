import { cn } from "@/lib/utils";

/** Low-poly palm mark. Neutral colour on purpose: orange is reserved for actions/selection. */
export function PalmMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-6 text-foreground", className)} fill="currentColor">
      {/* fronds */}
      <path d="M16 9 L3.5 7 L9.5 12.5 Z" opacity="0.95" />
      <path d="M16 9 L5.5 14.5 L11 15.2 Z" opacity="0.7" />
      <path d="M16 9 L28.5 7 L22.5 12.5 Z" opacity="0.85" />
      <path d="M16 9 L26.5 15 L21 15.2 Z" opacity="0.6" />
      <path d="M16 9 L11 1.8 L14.6 3.4 Z" opacity="0.8" />
      <path d="M16 9 L21.5 2 L17.8 4 Z" opacity="0.65" />
      {/* trunk */}
      <path d="M15 10.2 L17 10.2 L17.5 15 L15.2 15 Z" opacity="0.9" />
      <path d="M15.3 15.6 L17.7 15.6 L18.3 21 L15.8 21 Z" opacity="0.75" />
      <path d="M15.9 21.6 L18.4 21.6 L19.1 27.8 L16.2 27.8 Z" opacity="0.9" />
      {/* island */}
      <path d="M8.5 28.6 L23.5 28.6 L21.5 30.4 L10.5 30.4 Z" opacity="0.55" />
    </svg>
  );
}

export function Logo({ className, subtitle }: { className?: string; subtitle?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <PalmMark />
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold tracking-tight">Polygon Paradise</span>
        {subtitle ? <span className="text-xs text-muted-foreground">{subtitle}</span> : null}
      </span>
    </span>
  );
}
