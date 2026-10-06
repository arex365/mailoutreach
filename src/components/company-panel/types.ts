import type { ActionResult } from "@/lib/action";
import type { CompanyStatusValue, PriorityValue } from "@/core/labels";
import { THEY_REPLIED_TEXTS } from "@/core/sending/own-mailbox";

/** A link shown next to an error, e.g. "Open C-1042 Acme GmbH". */
export type ErrorLink = { href: string; label: string };

/** Server Action result for the panel: the standard ActionResult plus an optional error link. */
export type PanelResult<T = null> = ActionResult<T> & { link?: ErrorLink };

export type NamedItem = { id: number; name: string };

export type FlagView = { label: string; tone: "neutral" | "danger" | "good"; title: string };

/** One person card, with every date already written out in the viewer's time zone. */
export type PersonView = {
  id: number;
  /** What the card shows as the name ("General inbox", the name, or the address). */
  displayName: string;
  name: string;
  role: string | null;
  email: string | null;
  isGeneric: boolean;
  verificationStatus: string | null;
  checkedText: string;
  flags: FlagView[];
  emailedText: string;
  emailed: boolean;
  personalLineOverride: string | null;
  notes: string;
  canUnsubscribe: boolean;
  /** The last address check's details (M5-DESIGN §6.5); optional until the panel fills it. */
  lastCheck?: {
    reasons: string[];
    didYouMean: string | null;
    isRole: boolean;
    checkedByRealProvider: boolean;
    checkedWithin24h: boolean;
  } | null;
};

export type HeaderView = {
  companyId: number;
  code: string;
  name: string;
  website: { url: string; host: string } | null;
  countryName: string | null;
  localTime: { zone: string; time: string; usesDefault: boolean } | null;
  status: CompanyStatusValue;
  priority: PriorityValue;
  deleted: boolean;
  /**
   * "They replied" next to the status picker (MAIN-DOMAIN-DESIGN O17, §3.8): shown in own-mailbox mode, shared-From
   * mode or the practice copy, for a company that isn't deleted or Do not contact; null = not shown (real per-person
   * mode never shows it). `countsAsReply`: the click would count as a real reply (the confirm dialog says whether the
   * status changes), the same rule the click uses (`loadMarkRepliedFacts`).
   */
  markReplied: { countsAsReply: boolean } | null;
};

/**
 * The They replied confirm dialog (§3.8), for the company panel and the campaign person panel (`person` set): the status
 * becomes Replied only when the click counts as a real reply and the company is Not contacted or Contacted; a click that
 * doesn't count (only test emails so far) says the status stays.
 */
export function theyRepliedConfirm(i: {
  company: string;
  person?: string | null;
  countsAsReply: boolean;
  status: CompanyStatusValue;
}): { title: string; body: string } {
  const statusChanges = i.countsAsReply && (i.status === "NOT_CONTACTED" || i.status === "CONTACTED");
  const main = !i.countsAsReply
    ? THEY_REPLIED_TEXTS.bodyTestOnly(i.company)
    : statusChanges
      ? THEY_REPLIED_TEXTS.bodyStatusChanges(i.company)
      : THEY_REPLIED_TEXTS.bodyStatusStays(i.company);
  return {
    title: i.person ? THEY_REPLIED_TEXTS.confirmTitlePerson(i.person) : THEY_REPLIED_TEXTS.confirmTitleCompany(i.company),
    body: i.person ? `${main} ${THEY_REPLIED_TEXTS.bodyPerson(i.person)}` : main,
  };
}

export type DetailsView = {
  companyId: number;
  readOnly: boolean;
  country: string | null;
  countryName: string | null;
  countryDefaultZone: string | null;
  timeZone: string | null;
  defaultTimeZone: string;
  /** The stored value, for editing. */
  website: string | null;
  /** A safe http(s) link for it, or null. */
  websiteUrl: string | null;
  websiteHost: string | null;
  websiteIsShared: boolean;
  instagram: string | null;
  niche: string | null;
  niches: string[];
  tags: NamedItem[];
  allTags: NamedItem[];
  lists: NamedItem[];
  allLists: NamedItem[];
  firstContacted: string;
  created: string;
  customFields: Array<{ key: string; label: string; value: string }>;
  customFieldDefs: Array<{ key: string; label: string }>;
};

export type PersonalLineView = {
  companyId: number;
  readOnly: boolean;
  line: string | null;
  sourceText: string;
  /** An AI draft for this company is being written or waits for review (M5-DESIGN §6.5); optional until filled. */
  draftState?: "drafting" | "waiting" | null;
};
