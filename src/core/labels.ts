/**
 * Plain-language labels (sentence case) for enum values. Browser-safe.
 * Values mirror the Prisma enums in prisma/schema.prisma.
 */

export const COMPANY_STATUSES = [
  "NOT_CONTACTED",
  "CONTACTED",
  "REPLIED",
  "CLIENT",
  "NOT_INTERESTED",
  "DO_NOT_CONTACT",
] as const;
export type CompanyStatusValue = (typeof COMPANY_STATUSES)[number];

export const COMPANY_STATUS_LABELS: Record<CompanyStatusValue, string> = {
  NOT_CONTACTED: "Not contacted",
  CONTACTED: "Contacted",
  REPLIED: "Replied",
  CLIENT: "Client",
  NOT_INTERESTED: "Not interested",
  DO_NOT_CONTACT: "Do not contact",
};

/** Statuses that are never included in campaigns (SPEC §2). */
export const NEVER_EMAIL_STATUSES: ReadonlySet<CompanyStatusValue> = new Set([
  "CLIENT",
  "NOT_INTERESTED",
  "DO_NOT_CONTACT",
]);

export const PRIORITIES = ["HIGH", "NORMAL", "LOW"] as const;
export type PriorityValue = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<PriorityValue, string> = {
  HIGH: "High",
  NORMAL: "Normal",
  LOW: "Low",
};

export const VERIFICATION_LABELS: Record<string, string> = {
  VALID: "Valid",
  INVALID: "Invalid",
  RISKY: "Risky",
  CATCH_ALL: "Can't confirm",
  UNKNOWN: "Unknown",
  DO_NOT_SEND: "Do not send",
};

export const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner",
  MEMBER: "Member",
};

/** Old tool statuses → our statuses (SPEC §4). Keys are lowercased. */
export const OLD_TOOL_STATUS_MAP: Record<string, CompanyStatusValue> = {
  "not contacted": "NOT_CONTACTED",
  "not_contacted": "NOT_CONTACTED",
  contacted: "CONTACTED",
  replied: "REPLIED",
  hired: "CLIENT",
  client: "CLIENT",
  rejected: "NOT_INTERESTED",
  "not interested": "NOT_INTERESTED",
  "do not contact": "DO_NOT_CONTACT",
};
