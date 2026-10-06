import { countryName } from "@/core/geo/display";
import { formatDate, formatDateTime, timeAgo } from "@/core/time/format";
import { plural } from "@/core/text";
import { companySequenceLabel, isTestListSequence } from "@/components/campaigns/format";
import type { CompanyListRow } from "@/server/services/companies/query";
import type { ContactRow } from "./types";

/**
 * Pure display helpers for the Contacts table. No React, no I/O: used by the page
 * (server) to pre-format rows, and unit-tested.
 */

/** Company id as shown everywhere: "C-1042". */
export function companyCode(id: number): string {
  return `C-${id}`;
}

export type LastEmailedInput = {
  lastEmailedAt: Date | null;
  lastEmailedByName: string | null;
  lastEmailedByViewer?: boolean;
  importedLastContactAt: Date | null;
  /** When the company last replied: the tooltip adds a line "Replied 2 days ago" (M4-DESIGN §6 row 6). */
  repliedAt?: Date | null;
  /**
   * The company's current sequence is a test-list send (a live campaign launched before go-live, M6-DESIGN §2.2): with
   * nothing emailed from this app, the tooltip says why the column reads "Never" (L18).
   */
  testListSequence?: boolean;
};

/** The "Last emailed" tooltip line for a test mailbox that only got test-list emails (M6-DESIGN §2.2, L18). */
export const TEST_LIST_NOT_EMAILED_TITLE = "Test emails before going live don't count as emailed.";

/**
 * Which date the "Last emailed" column shows: the newer of this app's last email ("app") and the
 * old tool's last-contacted date ("old"); the app's own email wins a tie. It's the same value the
 * column sorts by (Company.lastContactAt).
 */
export function lastContactSource(input: Pick<LastEmailedInput, "lastEmailedAt" | "importedLastContactAt">): "app" | "old" | null {
  const app = input.lastEmailedAt;
  const old = input.importedLastContactAt;
  if (app && old) return old.getTime() > app.getTime() ? "old" : "app";
  if (app) return "app";
  if (old) return "old";
  return null;
}

/** "You" / "Ali" / "A teammate" (lower-case "you" / "a teammate" inside a sentence). */
function senderName(input: LastEmailedInput, startOfSentence: boolean): string {
  if (input.lastEmailedByViewer) return startOfSentence ? "You" : "you";
  return input.lastEmailedByName?.trim() || (startOfSentence ? "A teammate" : "a teammate");
}

/**
 * "Ali · 12 days ago" (sent from this app), "Old tool · 12 days ago" (a date imported
 * from the old tool) or "Never", whichever is newer. The viewer sees "You" for their own emails.
 */
export function lastEmailedLabel(input: LastEmailedInput, now: Date = new Date()): string {
  const source = lastContactSource(input);
  if (source === "app" && input.lastEmailedAt) return `${senderName(input, true)} · ${timeAgo(input.lastEmailedAt, now)}`;
  if (source === "old" && input.importedLastContactAt) return `Old tool · ${timeAgo(input.importedLastContactAt, now)}`;
  return "Never";
}

/**
 * Tooltip for the "Last emailed" cell: the exact moments in the viewer's time zone, newest first; for a company this
 * app never emailed whose current sequence is a test-list send, "Test emails before going live don't count as
 * emailed." (L18); then a line "Replied 2 days ago" when the company replied (M4-DESIGN §6 row 6). Null when there is
 * nothing to say.
 */
export function lastEmailedTitle(input: LastEmailedInput, timeZone: string, now: Date = new Date()): string | null {
  const app = input.lastEmailedAt ? `Emailed by ${senderName(input, false)} on ${formatDateTime(input.lastEmailedAt, timeZone)}` : null;
  const old = input.importedLastContactAt
    ? `Last contacted on ${formatDate(input.importedLastContactAt, timeZone)} (from the old tool)`
    : null;
  const source = lastContactSource(input);
  const contact = source === "old" ? (app ? `${old}. ${app}` : old) : source === "app" ? app : null;
  const testList = !input.lastEmailedAt && input.testListSequence ? TEST_LIST_NOT_EMAILED_TITLE : null;
  const replied = input.repliedAt ? `Replied ${timeAgo(input.repliedAt, now)}` : null;
  const lines = [contact, testList, replied].filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : null;
}

/** "2 people · 1 email", or "No email" (shown in a muted warning style). */
export function peopleSummary(people: number, emails: number): { text: string; missingEmail: boolean } {
  if (emails <= 0) return { text: "No email", missingEmail: true };
  return { text: `${plural(people, "person", "people")} · ${plural(emails, "email", "emails")}`, missingEmail: false };
}

/** The small line under a company name: its website host, or its profile on a shared site. */
export function companySubline(website: string | null, profileKey: string | null): string | null {
  if (profileKey) return profileKey;
  if (!website) return null;
  try {
    const u = new URL(website.includes("://") ? website : `https://${website}`);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
    return host + path;
  } catch {
    return website;
  }
}

/** "Page 2 of 30 · 1,480 companies" */
export function pageSummary(page: number, pageCount: number, total: number): string {
  return `Page ${page.toLocaleString("en-US")} of ${pageCount.toLocaleString("en-US")} · ${plural(total, "company", "companies")}`;
}

/** Server → client row, with every label pre-formatted in the viewer's time zone. */
export function toContactRow(row: CompanyListRow, viewer: { timeZone: string }, now: Date = new Date()): ContactRow {
  const sequences = row.sequences ?? [];
  const sequence = companySequenceLabel(sequences, viewer.timeZone, now);
  return {
    id: row.id,
    code: companyCode(row.id),
    name: row.name,
    subline: companySubline(row.website, row.profileKey),
    status: row.status,
    priority: row.priority,
    countryCode: row.country,
    countryName: row.country ? countryName(row.country) : null,
    niche: row.niche,
    peopleCount: row.peopleCount,
    emailCount: row.emailCount,
    lastEmailedLabel: lastEmailedLabel(row, now),
    lastEmailedTitle: lastEmailedTitle({ ...row, testListSequence: isTestListSequence(sequences) }, viewer.timeZone, now),
    addedLabel: formatDate(row.createdAt, viewer.timeZone),
    tags: row.tags,
    custom: row.customFields,
    sequenceLabel: sequence?.text ?? null,
    sequenceTitle: sequence?.title ?? null,
  };
}
