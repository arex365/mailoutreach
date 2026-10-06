import { GENERAL_INBOX_NAME } from "@/core/email-address";

/**
 * Who at a company gets the email by default (PLAN.md B6.4 step 1, SPEC §7): the first person with
 * a valid check; if nobody is checked yet, the first named person with an email; then the General
 * inbox. People who can't be emailed (eligible === false) are never picked. Pure and browser-safe.
 */

export type DefaultPickPerson = {
  id: number;
  name: string | null;
  isGeneric: boolean;
  emailNorm: string | null;
  verificationStatus: string | null;
  /** From the eligibility check; false = never pre-select. Undefined = not evaluated (allowed). */
  eligible?: boolean;
};

function isNamed(p: DefaultPickPerson): boolean {
  const name = (p.name ?? "").trim();
  return !p.isGeneric && name !== "" && name !== GENERAL_INBOX_NAME;
}

/** The one person to tick by default (people in display order), or null when nobody can be emailed. */
export function pickDefaultPerson(people: readonly DefaultPickPerson[]): number | null {
  const candidates = people.filter((p) => p.emailNorm && p.eligible !== false);
  const pick =
    candidates.find((p) => p.verificationStatus === "VALID") ??
    candidates.find((p) => isNamed(p)) ??
    candidates.find((p) => p.isGeneric || (p.name ?? "").trim() === GENERAL_INBOX_NAME) ??
    candidates[0];
  return pick ? pick.id : null;
}

/** pickDefaultPerson as a list: [] or [personId]. */
export function pickDefaultPeople(people: readonly DefaultPickPerson[]): number[] {
  const id = pickDefaultPerson(people);
  return id === null ? [] : [id];
}

/** The warning shown when more than one person at one company is ticked, else null. */
export function tickedPeopleWarning(tickedCount: number): string | null {
  if (tickedCount <= 1) return null;
  return `${tickedCount} people at this company are ticked. Each of them gets the emails.`;
}
