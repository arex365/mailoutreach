/**
 * Small wording helpers shared by the rules, the sending engine and the campaign screens.
 * Pure and browser-safe.
 */

/** 0 → "first email", n → "follow-up n". */
export function stepName(step: number): string {
  return step <= 0 ? "first email" : `follow-up ${step}`;
}

/** 0 → "First email", n → "Follow-up n". */
export function stepTitle(step: number): string {
  const name = stepName(step);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** "Anna's" / "Klaus'" style possessive for a name (English: a trailing s just gets an apostrophe). */
export function possessive(name: string): string {
  const n = name.trim();
  if (!n) return "";
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}
