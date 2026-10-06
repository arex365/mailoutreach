/**
 * Stable variation picks (PLAN.md B6.3): `{Hi|Hello}` picks one option per person with a
 * deterministic hash of (person, step, the option list text, the occurrence index). There is no
 * campaign or template id in it, so the template preview, Review and the sent email all agree
 * until the options themselves are edited.
 */

const encoder = new TextEncoder();

/** 32-bit FNV-1a over the UTF-8 bytes of `text`. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Final avalanche step (from MurmurHash3), so `hash % n` uses every bit of the input. */
function mix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

export type VariationKey = {
  /** The person the email is for (0 when there is none, e.g. a bare syntax check). */
  personId: number;
  /** 0 = first email, 1..3 = follow-ups. */
  step: number;
  /** The text between the braces, exactly as written, e.g. "Hi|Hello". */
  options: string;
  /** How many identical option lists came before this one in the same subject or body. */
  occurrence: number;
};

/** Which option (0-based) this person gets, out of `count`. */
export function variationIndex(key: VariationKey, count: number): number {
  if (count <= 1) return 0;
  const sep = "\u001f";
  const hash = mix32(fnv1a32(`${key.personId}${sep}${key.step}${sep}${key.options}${sep}${key.occurrence}`));
  return hash % count;
}
