/**
 * The Message step saves on its own (debounced). When follow-ups are removed, the ones after move
 * up ("follow-up 3" becomes "follow-up 2"), so an email someone already edited for one person in
 * Review must move with its follow-up. The editor gives every step a stable key; comparing the
 * last saved picture with the current one tells the server how step numbers changed.
 * Pure and unit-tested.
 */

export type KeyedStep = { key: number; step: number };

/**
 * { oldStep: newStep } for steps that moved, { oldStep: null } for steps that were removed.
 * Steps that stayed where they were are left out. Empty when nothing moved.
 */
export function renumberMap(saved: readonly KeyedStep[], current: readonly KeyedStep[]): Record<number, number | null> {
  const now = new Map(current.map((s) => [s.key, s.step]));
  const out: Record<number, number | null> = {};
  for (const s of saved) {
    const next = now.get(s.key);
    if (next === undefined) out[s.step] = null;
    else if (next !== s.step) out[s.step] = next;
  }
  return out;
}

/** True when the map changes nothing. */
export function isEmptyRenumber(map: Record<number, number | null>): boolean {
  return Object.keys(map).length === 0;
}

/**
 * Checks a renumber map from the browser: old and new steps are 0..3, the first email never moves,
 * and no two old steps land on the same new step. Returns the cleaned map or null when it's unusable.
 */
export function cleanRenumberMap(input: unknown, maxStep = 3): Map<number, number | null> | null {
  if (input === null || input === undefined) return new Map();
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const out = new Map<number, number | null>();
  const targets = new Set<number>();
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const from = Number(k);
    if (!Number.isInteger(from) || from < 1 || from > maxStep) return null;
    if (v === null) {
      out.set(from, null);
      continue;
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > maxStep || targets.has(v)) return null;
    targets.add(v);
    out.set(from, v);
  }
  return out;
}
