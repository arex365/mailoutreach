import { useEffect } from "react";

/**
 * Which editors in the company panel hold text that isn't saved yet (notes, personal lines,
 * inline fields). The panel's sheet asks "Discard your unsaved changes?" before it closes while
 * any are dirty, and the browser warns before the tab is closed or reloaded.
 * A plain module-level store: there is only one company panel on screen at a time.
 */

type Listener = () => void;

const dirtyKeys = new Set<string>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) l();
}

export const unsavedChanges = {
  /** Marks one editor (by a stable key) as holding unsaved text, or not. */
  mark(key: string, dirty: boolean): void {
    const had = dirtyKeys.has(key);
    if (dirty) dirtyKeys.add(key);
    else dirtyKeys.delete(key);
    if (had !== dirty) notify();
  },
  /** True while any editor holds unsaved text. */
  any(): boolean {
    return dirtyKeys.size > 0;
  },
  /** Forgets everything (after the person chose to discard). */
  clear(): void {
    if (dirtyKeys.size === 0) return;
    dirtyKeys.clear();
    notify();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Registers an editor's dirty state while it's on screen, and asks the browser to warn before leaving. */
export function useUnsavedChange(key: string, dirty: boolean): void {
  useEffect(() => {
    unsavedChanges.mark(key, dirty);
    return () => unsavedChanges.mark(key, false);
  }, [key, dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need a returnValue to show their "Leave site?" question.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
