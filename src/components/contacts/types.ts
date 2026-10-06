import type { CompanyStatusValue, PriorityValue } from "@/core/labels";
import type { CreateCompanyResult } from "@/server/services/companies/create";

/** What "Add company" can answer (field problems come back as a normal action error). */
export type CreateCompanyOutcome = Exclude<CreateCompanyResult, { kind: "invalid" }>;

/** Serializable shapes passed from the Contacts page (server) to its client components. */

export type NamedId = { id: number; name: string };

export type ListSummary = { id: number; name: string; count: number };

export type ContactRow = {
  id: number;
  /** "C-1042" */
  code: string;
  name: string;
  /** Website host or profile ("acme.de", "instagram.com/acme"), for the small line under the name. */
  subline: string | null;
  status: CompanyStatusValue;
  priority: PriorityValue;
  countryCode: string | null;
  countryName: string | null;
  niche: string | null;
  peopleCount: number;
  emailCount: number;
  /** "Ali · 12 days ago", "Old tool · 3 months ago" or "Never" (whichever date is newer). */
  lastEmailedLabel: string;
  /** Full date/time in the viewer's time zone, for the tooltip. */
  lastEmailedTitle: string | null;
  addedLabel: string;
  tags: NamedId[];
  custom: Record<string, string>;
  /** "Waiting for follow-up 1 on 14 Oct", "Finished", "Stopped: replied"… (null: never in a campaign). */
  sequenceLabel?: string | null;
  /** The campaign behind it, for the tooltip. */
  sequenceTitle?: string | null;
};

export type FilterOptions = {
  tags: NamedId[];
  countries: Array<{ code: string; name: string }>;
  niches: string[];
  users: NamedId[];
  customColumns: Array<{ key: string; label: string }>;
};

export type Viewer = { id: number; name: string; role: "OWNER" | "MEMBER" };

/** Which empty state (PLAN.md A6) the table shows when nothing matches. */
export type EmptyKind = "none" | "no-companies" | "empty-list" | "deleted-list" | "no-missing" | "no-match";
