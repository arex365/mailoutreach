"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const SHORTCUTS: Array<{ keys: string[]; what: string }> = [
  { keys: ["/"], what: "Search this view" },
  { keys: ["j"], what: "Move down to the next company" },
  { keys: ["k"], what: "Move up to the previous company" },
  { keys: ["x"], what: "Tick or untick the company you're on" },
  { keys: ["Enter"], what: "Open the company you're on" },
  { keys: ["Esc"], what: "Close the company panel or a dialog" },
  { keys: ["Ctrl", "K"], what: "Jump to any company, from any page" },
  { keys: ["?"], what: "Show this list" },
];

/** "?" lists every shortcut (PLAN.md A6 Keyboard). */
export function ShortcutHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single-key shortcuts don&apos;t work while you&apos;re typing in a field.</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-2">
          {SHORTCUTS.map((s) => (
            <div key={s.what} className="flex items-center justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{s.what}</dt>
              <dd className="flex shrink-0 gap-1">
                {s.keys.map((k) => (
                  <kbd key={k} className="min-w-6 rounded border border-border bg-muted px-1.5 py-0.5 text-center font-mono text-xs">
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
