import Link from "next/link";
import { Mail } from "lucide-react";
import type { SessionUser } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { countryName } from "@/core/geo/display";
import { defaultTimeZoneFor, isValidTimeZone } from "@/core/geo/countries";
import { formatDate, formatTime } from "@/core/time/format";
import { cn } from "@/lib/utils";
import {
  getCompanyDetail,
  getCompanyTimeline,
  getPanelOptions,
  type CompanyDetail,
  type PersonDetail,
  type SequenceRow,
} from "@/server/services/companies/detail";
import { companyDraftState } from "@/server/services/ai/queue";
import { loadMarkRepliedFacts, type MarkRepliedFacts } from "@/server/services/companies/replied-by-hand";
import { realCheckProviders } from "@/server/services/eligibility";
import { priceFromSetting } from "@/server/services/verification/estimate";
import { getSettings } from "@/server/settings";
import type { PersonChecker } from "@/components/checks/types";
import { CompanyHeader, DeletedBanner } from "./company-header";
import { DetailsSection } from "./details-section";
import {
  checkedText,
  emailedSummary,
  personalLineSourceText,
  personFlags,
  pickSequence,
  type SequenceInfo,
} from "./emailed-text";
import { NotesSection } from "./notes-section";
import { PeopleSection } from "./people-section";
import { PersonalLineSection } from "./personal-line";
import { CompanyPanelSkeleton } from "./skeleton";
import { TimelineSection } from "./timeline";
import { toTimelineItemView, type TimelinePageView } from "./timeline-view";
import type { DetailsView, FlagView, HeaderView, PersonView, PersonalLineView } from "./types";

export { CompanyPanelSkeleton };

/**
 * Server component: everything about one company (header, emailed banner, people,
 * personal line, details, notes, timeline). Rendered by the Contacts page inside
 * its slide-over sheet when the URL has ?company=<id>. Single column, so it works
 * the same on a phone and in the laptop slide-over.
 */
export async function CompanyPanel({ companyId, user }: { companyId: number; user: SessionUser }) {
  const now = new Date();
  const detail = await getCompanyDetail(companyId, { now });
  if (!detail) return <CompanyNotFound />;

  const [options, timeline, draftState, checkSettings, markReplied] = await Promise.all([
    getPanelOptions(),
    getCompanyTimeline(detail.id, { filter: "all" }),
    companyDraftState(detail.id),
    getSettings(["practice.copy", "verification.pricePerCheck"] as const),
    // "They replied" (MAIN-DOMAIN-DESIGN O17): null in real per-person mode, for a deleted or Do not contact company.
    loadMarkRepliedFacts(detail.id),
  ]);
  const tz = user.timeZone;
  const deleted = Boolean(detail.deletedAt);
  const realProviders = realCheckProviders();
  // What the people rows' "Check" button says about the checker (M5-DESIGN §6.5).
  const checker: PersonChecker = {
    practiceCopy: checkSettings["practice.copy"] === true,
    pricePerCheck: priceFromSetting(checkSettings["verification.pricePerCheck"]),
  };

  const companySequence = pickSequence(detail.sequences.map(toSequenceInfo));
  const banner = emailedSummary(
    {
      lastEmailedAt: detail.lastEmailedAt,
      lastEmailedByName: detail.lastEmailedBy?.name ?? null,
      lastEmailedCampaignName: detail.lastEmailedCampaignName,
      lastEmailedStep: detail.lastEmailedStep,
      importedLastContactAt: detail.importedLastContactAt,
      sequence: companySequence,
      repliedAt: detail.repliedAt,
      testSend: detail.lastTestSend,
    },
    tz,
    now,
  );

  const initialTimeline: TimelinePageView = {
    items: timeline.entries.map((e) => toTimelineItemView(e, tz, now)),
    nextCursor: timeline.nextCursor,
  };

  return (
    <div className="grid min-w-0 gap-6 p-4 md:p-6" data-company-id={detail.id}>
      <CompanyHeader view={headerView(detail, now, markReplied)} />

      {deleted ? <DeletedBanner companyId={detail.id} text={deletedText(detail, tz)} /> : null}

      <div
        className={cn(
          "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm",
          // Dashed and muted only when nothing went out; a test email is something that happened.
          banner.emailed || banner.testOnly ? "border-border bg-card" : "border-dashed border-border text-muted-foreground",
        )}
      >
        <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 break-words">{banner.text}</p>
      </div>

      <PeopleSection
        companyId={detail.id}
        people={detail.people.map((p) => personView(p, tz, now, realProviders))}
        readOnly={deleted}
        checker={checker}
      />

      <PersonalLineSection view={personalLineView(detail, tz, now, draftState)} />

      <DetailsSection view={detailsView(detail, options, tz)} />

      <NotesSection companyId={detail.id} notes={detail.notes} readOnly={deleted} />

      <TimelineSection companyId={detail.id} initial={initialTimeline} />
    </div>
  );
}

function CompanyNotFound() {
  return (
    <div className="grid gap-3 p-4 pr-12 md:p-6">
      <h2 id="company-panel-title" className="text-lg font-semibold">
        This company doesn&apos;t exist any more.
      </h2>
      <p className="text-sm text-muted-foreground">The link may be old. Search for the company on Contacts instead.</p>
      <Button asChild variant="outline" size="sm" className="justify-self-start">
        <Link href="/contacts">Back to Contacts</Link>
      </Button>
    </div>
  );
}

// ───────────────────────── view models ─────────────────────────

function toSequenceInfo(s: SequenceRow): SequenceInfo {
  return {
    id: s.id,
    campaignId: s.campaignId,
    campaignName: s.campaignName,
    campaignMode: s.campaignMode,
    countsAsEmailed: s.countsAsEmailed,
    personId: s.personId,
    state: s.state,
    currentStep: s.currentStep,
    nextDueAt: s.nextDueAt,
    stopReason: s.stopReason,
    holdReason: s.holdReason,
    recheckAt: s.recheckAt,
    updatedAt: s.updatedAt,
  };
}

/** Only http(s) addresses become links (never javascript: or similar). */
function safeWebsite(url: string | null): { url: string; host: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { url: u.toString(), host: u.host.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "") };
  } catch {
    return null;
  }
}

function headerView(d: CompanyDetail, now: Date, markReplied: MarkRepliedFacts | null): HeaderView {
  const zone = d.timeZone && isValidTimeZone(d.timeZone) ? d.timeZone : d.defaultTimeZone;
  let time: string | null = null;
  try {
    time = formatTime(now, zone);
  } catch {
    time = null;
  }
  return {
    companyId: d.id,
    code: d.code,
    name: d.name,
    website: safeWebsite(d.website),
    countryName: d.country ? countryName(d.country) : null,
    localTime: time ? { zone, time, usesDefault: !d.timeZone } : null,
    status: d.status,
    priority: d.priority,
    deleted: Boolean(d.deletedAt),
    markReplied: markReplied && !d.deletedAt ? { countsAsReply: markReplied.countsAsReply } : null,
  };
}

function deletedText(d: CompanyDetail, tz: string): string {
  const on = d.deletedAt ? formatDate(d.deletedAt, tz) : "";
  return `This company was deleted on ${on}${d.deletedBy ? ` by ${d.deletedBy.name}` : ""}.`;
}

function personView(p: PersonDetail, tz: string, now: Date, realProviders: ReadonlySet<string>): PersonView {
  const sequence = pickSequence(p.sequences.map(toSequenceInfo));
  const summary = emailedSummary(
    {
      lastEmailedAt: p.lastEmailedAt,
      lastEmailedByName: p.lastEmailedBy?.name ?? null,
      lastEmailedCampaignName: p.lastEmailedCampaignName,
      lastEmailedStep: p.lastEmailedStep,
      sequence,
      testSend: p.lastTestSend,
    },
    tz,
    now,
  );
  const flags: FlagView[] = personFlags(p, tz, now);
  const displayName = p.isGeneric ? p.name || "General inbox" : p.name || p.email || "No name";
  return {
    id: p.id,
    displayName,
    name: p.name,
    role: p.role,
    email: p.email,
    isGeneric: p.isGeneric,
    verificationStatus: p.verificationStatus,
    checkedText: checkedText(p.verifiedAt, p.verificationProvider, tz, now, realProviders),
    flags,
    emailedText: summary.text,
    emailed: summary.emailed,
    personalLineOverride: p.personalLineOverride,
    notes: p.notes,
    canUnsubscribe: Boolean(p.email) && !(p.unsubscribedAt && p.suppressed),
    lastCheck: p.lastCheck,
  };
}

function personalLineView(
  d: CompanyDetail,
  tz: string,
  now: Date,
  draftState: PersonalLineView["draftState"],
): PersonalLineView {
  return {
    companyId: d.id,
    readOnly: Boolean(d.deletedAt),
    line: d.personalLine,
    sourceText: personalLineSourceText(d.personalLineSource, d.personalLineUpdatedBy?.name, d.personalLineUpdatedAt, tz, now),
    draftState: draftState ?? null,
  };
}

function detailsView(
  d: CompanyDetail,
  options: Awaited<ReturnType<typeof getPanelOptions>>,
  tz: string,
): DetailsView {
  const site = safeWebsite(d.website);
  const firstContacted = d.firstContactedBy
    ? `${d.firstContactedBy.name}${d.firstContactedAt ? ` on ${formatDate(d.firstContactedAt, tz)}` : ""}`
    : d.firstContactedAt
      ? formatDate(d.firstContactedAt, tz)
      : "Not contacted yet";
  return {
    companyId: d.id,
    readOnly: Boolean(d.deletedAt),
    country: d.country,
    countryName: d.country ? countryName(d.country) : null,
    countryDefaultZone: defaultTimeZoneFor(d.country),
    timeZone: d.timeZone,
    defaultTimeZone: d.defaultTimeZone,
    website: d.website,
    websiteUrl: site ? site.url : null,
    websiteHost: site ? site.host : null,
    websiteIsShared: Boolean(d.website) && !d.domain,
    instagram: d.instagram,
    niche: d.niche,
    niches: options.niches,
    tags: d.tags,
    allTags: options.tags,
    lists: d.lists,
    allLists: options.lists,
    firstContacted,
    created: `${formatDate(d.createdAt, tz)}${d.createdBy ? ` by ${d.createdBy.name}` : ""}`,
    customFields: d.customFields,
    customFieldDefs: options.customFields,
  };
}
