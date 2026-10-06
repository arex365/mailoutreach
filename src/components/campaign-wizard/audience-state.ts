import { tickedPeopleWarning } from "@/core/rules/default-people";
import type { AudienceCompanyView, AudienceTotals } from "@/server/services/campaigns/audience";

/**
 * The Audience step updates one company at a time (ticks, put-back) without reloading 2,000
 * companies: the server answers with that company's fresh view and the totals move by the
 * difference. Pure and unit-tested.
 */

/** The company as it looks straight after a tick, before the server confirms it. */
export function withTick(view: AudienceCompanyView, personId: number, ticked: boolean): AudienceCompanyView {
  // A person without a row gets one when ticked, so "eligible and ticked" is what the server will say.
  const people = view.people.map((p) => (p.personId === personId ? { ...p, ticked, willGet: ticked && p.eligible } : p));
  const willGet = people.filter((p) => p.willGet).length;
  return {
    ...view,
    people,
    ticked: people.filter((p) => p.ticked).length,
    willGet,
    warning: tickedPeopleWarning(willGet),
  };
}

function contribution(v: AudienceCompanyView | null | undefined) {
  if (!v) return { people: 0, companies: 0, excluded: 0, included: 0, nobody: 0, all: 0 };
  const excluded = v.section === "excluded" ? 1 : 0;
  return {
    people: v.willGet,
    companies: v.willGet > 0 ? 1 : 0,
    excluded,
    included: 1 - excluded,
    nobody: v.section === "included" && v.willGet === 0 ? 1 : 0,
    all: 1,
  };
}

/** Totals after one company changed from `before` to `after` (either may be missing: added or removed). */
export function moveTotals(
  totals: AudienceTotals,
  before: AudienceCompanyView | null | undefined,
  after: AudienceCompanyView | null | undefined,
): AudienceTotals {
  const a = contribution(before);
  const b = contribution(after);
  return {
    people: totals.people - a.people + b.people,
    companies: totals.companies - a.companies + b.companies,
    excludedCompanies: totals.excludedCompanies - a.excluded + b.excluded,
    includedCompanies: totals.includedCompanies - a.included + b.included,
    nobodyTicked: totals.nobodyTicked - a.nobody + b.nobody,
    all: totals.all - a.all + b.all,
  };
}

/** "3 companies have nobody ticked" (or null). */
export function nobodyTickedText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 company has nobody ticked." : `${count.toLocaleString("en-US")} companies have nobody ticked.`;
}
