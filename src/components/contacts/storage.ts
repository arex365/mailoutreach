"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Tiny browser-storage backed stores for per-viewer conveniences (ticked rows,
 * hidden sidebar, column choices). Storage can be missing or blocked (private
 * windows, old browsers on the office network), so every access is wrapped in
 * try/catch and the page works without it. The server snapshot is always the
 * fallback, so hydration never mismatches.
 */

type Listener = () => void;

export type Store<T> = {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (l: Listener) => () => void;
  serverSnapshot: () => T;
};

export function createStorageStore<T>(opts: {
  area: "local" | "session";
  key: string;
  fallback: T;
  parse: (raw: unknown) => T;
  serialize?: (value: T) => unknown;
}): Store<T> {
  let current: T | undefined;
  const listeners = new Set<Listener>();

  function storage(): Storage | null {
    try {
      if (typeof window === "undefined") return null;
      return opts.area === "local" ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  }

  function load(): T {
    try {
      const raw = storage()?.getItem(opts.key);
      if (raw == null) return opts.fallback;
      return opts.parse(JSON.parse(raw));
    } catch {
      return opts.fallback;
    }
  }

  function get(): T {
    if (typeof window === "undefined") return opts.fallback;
    if (current === undefined) current = load();
    return current;
  }

  function set(next: T | ((prev: T) => T)): void {
    const prev = get();
    const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
    if (Object.is(value, prev)) return;
    current = value;
    try {
      storage()?.setItem(opts.key, JSON.stringify(opts.serialize ? opts.serialize(value) : value));
    } catch {
      /* storage full or blocked: keep the in-memory value */
    }
    for (const l of listeners) l();
  }

  function subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }

  return { get, set, subscribe, serverSnapshot: () => opts.fallback };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, () => store.get(), store.serverSnapshot);
}

// ───────────────────────── stores used by the Contacts screen ─────────────────────────

export const SELECTION_LIMIT = 10_000;

const EMPTY_SELECTION: ReadonlySet<number> = new Set();

/** Ticked company ids. Kept for this browser tab so ticks survive paging and reloads. */
export const selectionStore = createStorageStore<ReadonlySet<number>>({
  area: "session",
  key: "pp.contacts.selection.v1",
  fallback: EMPTY_SELECTION,
  parse: (raw) =>
    Array.isArray(raw)
      ? new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, SELECTION_LIMIT))
      : EMPTY_SELECTION,
  serialize: (value) => [...value],
});

export const selection = {
  toggle(id: number) {
    selectionStore.set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < SELECTION_LIMIT) next.add(id);
      return next;
    });
  },
  setMany(ids: readonly number[], on: boolean) {
    selectionStore.set((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) {
          if (next.size >= SELECTION_LIMIT) break;
          next.add(id);
        } else next.delete(id);
      }
      return next;
    });
  },
  replace(ids: readonly number[]) {
    selectionStore.set(new Set(ids.slice(0, SELECTION_LIMIT)));
  },
  clear() {
    selectionStore.set(EMPTY_SELECTION);
  },
};

export function useSelection(): ReadonlySet<number> {
  return useStore(selectionStore);
}

/** Whether the list sidebar is hidden (per browser). */
export const sidebarHiddenStore = createStorageStore<boolean>({
  area: "local",
  key: "pp.contacts.sidebarHidden.v1",
  fallback: false,
  parse: (raw) => raw === true,
});

const EMPTY_OVERRIDES: Readonly<Record<string, boolean>> = {};

/** Columns the viewer switched on or off in the Columns chooser (absent = automatic). */
export const columnOverridesStore = createStorageStore<Readonly<Record<string, boolean>>>({
  area: "local",
  key: "pp.contacts.columns.v1",
  fallback: EMPTY_OVERRIDES,
  parse: (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_OVERRIDES;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "boolean") out[k] = v;
    return out;
  },
});

// ───────────────────────── container width ─────────────────────────

/**
 * True while the element is narrower than `threshold` px. False on the server and
 * until the first measurement, so the first paint matches the server HTML.
 */
export function useIsNarrower(ref: React.RefObject<HTMLElement | null>, threshold: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setNarrow(width > 0 && width < threshold);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return narrow;
}
