import { pausedWithReason } from "@/core/sending/label";
import { CHECKLIST_ROW_TITLES, goLiveRowKeys } from "@/core/sending/mode-gates";
import { INBOX_CHECK_TEXTS } from "@/core/sending/own-mailbox";
import type { ChecklistRow } from "@/core/system-state";
import { plural } from "@/core/text";

/**
 * The dashboard's "Needs your attention" list (M6-DESIGN §4.2): one line per problem or piece of work, in a fixed
 * order (what stops or holds sending first, then SPEC §11's four, then the rest). Built from facts the page loader
 * (`src/app/(app)/dashboard/load.ts`) already read; every sentence that needs a time zone or component wording arrives
 * formatted, so this file only decides which items show and words them. A fact that is `null` means its source
 * couldn't be read: only that item is left out. Owner-only links are shown to the Owner; Members get "Ask the Owner to
 * fix this." in their place (or their own link or sentence where §4.2 gives one). Pure and browser-safe.
 */

export type AttentionKey =
  | "sending-paused"
  | "worker-down"
  | "restore-check"
  | "disk-low"
  | "replies-waiting"
  | "inbox-check"
  | "ai-lines"
  | "paused-campaigns"
  | "unconfirmed"
  | "outage-hold"
  | "missing-emails"
  | "backup-never"
  | "backup-old"
  | "backup-copy-failed"
  | "second-folder-missing"
  | "go-live-again"
  | "tunnel-down"
  | "mailgun-check"
  | "old-domain"
  | "checklist"
  | "checks-paused"
  | "ai-paused";

/** danger: sending has stopped; warning: something waits or may go wrong; info: work waiting for someone. */
export type AttentionTone = "danger" | "warning" | "info";

export type AttentionLink = { href: string; label: string };

export type AttentionItem = {
  key: AttentionKey;
  tone: AttentionTone;
  text: string;
  /** A second line (why, or what to do), or null. */
  detail: string | null;
  link: AttentionLink | null;
  /** Members, where the Owner gets an Owner-only link: "Ask the Owner to fix this."; else null. */
  note: string | null;
};

/**
 * One field per source of §4.2, all already loaded. `null` = the source failed (its item is left out); sentences that
 * need a time zone or component wording are already written (`workerDown`, `pausedLine`, `newestDay`, …).
 */
export type AttentionFacts = {
  /** Setting "practice.copy". */
  practiceCopy: boolean;
  /**
   * Go-live from the settings (§4.6): live on real data, the current sending domain (Setting "mailgun.domain") and the
   * domain go-live was switched on for (Setting "sending.goLiveDomain").
   *
   * Shared From address (SHARED-FROM-DESIGN §3.8), all optional (absent = the item and the row they add are left out):
   * `liveAt` Setting "sending.goLiveAt" (kept after go-live ended); `liveFrom` Setting "sending.goLiveFrom" (the shared
   * From address go-live was switched on with, null = per-person mode); `currentFrom` today's evidence From
   * (`loadTeamFrom().evidenceFrom`, MAIN-DOMAIN-DESIGN O15: the shared From, or the own From in own-mailbox mode; null =
   * per-person mode; absent = it couldn't be read).
   */
  goLive: {
    live: boolean;
    currentDomain: string | null;
    liveDomain: string | null;
    liveAt?: string | null;
    liveFrom?: string | null;
    currentFrom?: string | null;
  } | null;
  /** The global sending pause (getPauseState). */
  pause: { paused: boolean; reason: string; fixText: string } | null;
  /** `workerDownText(getWorkerStatus(now), now, zone)`: the sentence while the background sender is down, else null. */
  workerDown: string | null;
  /** A restore is being checked with Mailgun (restoreHoldActive, status pending or scanning). */
  restoreChecking: boolean | null;
  /** From backupStatus(): the newest app backup's age, its day in the viewer's zone, the copy and the disk space. */
  backup: {
    age: "ok" | "stale" | "never";
    /** "25 Sept" (formatShortDate of the newest backup), null without one. */
    newestDay: string | null;
    lastCopyFailed: boolean;
    secondFolder: string | null;
    /** `diskLowText(freeBytes)` while the disk is almost full, else null. */
    diskLowText: string | null;
  } | null;
  /** Setting "backups.secondFolder" is set (the practice copy never needs one). */
  secondFolderSet: boolean | null;
  /** `waitingRepliesLine(waitingReplyCountsByUser(), viewer.id)`: null when nothing waits. */
  waitingLine: string | null;
  /** AI lines waiting for review (aiQueueCounts().waiting). */
  aiWaiting: number | null;
  /** The newest paused campaigns (at most 3) with `pausedText(...)`, and how many are paused in all. */
  pausedCampaigns: { items: ReadonlyArray<{ id: number; name: string; pausedLine: string }>; total: number } | null;
  /** Emails that need Retry or Skip (unconfirmedEmails()). */
  unconfirmed: { count: number; firstCampaignId: number | null } | null;
  /**
   * The long-outage hold (outageHoldSummary): found, applied, and how many people it still holds. `days`: the days of
   * Mailgun logs the app counts on (`effectiveLogRetentionDays`, MAIN-DOMAIN-DESIGN O26) for "more than N days"; absent = 5.
   */
  outage: { detected: boolean; applied: boolean; people: number; days?: number } | null;
  /** Companies without an email address (the Missing email view's count). */
  missingEmails: number | null;
  /** Remote access: a public address is set and the tunnel or the public check is failing; `since` already written. */
  tunnel: { down: boolean; since: string | null } | null;
  /** mailgunConfigured(): real data, a sending domain and a saved key (no decryption). */
  mailgunConfigured: boolean | null;
  /**
   * The check with Mailgun (CatchUpState): failing, its line (catchUpStatusLine) and the times the grace uses (the last
   * success, else when it started failing, else the last start; `mailgunCheckOverdue`).
   */
  catchUp: {
    failing: boolean;
    line: string;
    lastSuccessAt: string | null;
    lastStartedAt: string | null;
    /** CatchUpState.failingSince (review DASHBOARD-1); missing = unknown (states written before it). */
    failingSince?: string | null;
  } | null;
  /** `oldDomainLines(catchUp, zone, now)`: older sending domains that couldn't be checked. */
  oldDomainLines: readonly string[] | null;
  /** The Domain checklist's rows for the current sending domain (empty when it was checked for another domain). */
  checklistRows: readonly ChecklistRow[] | null;
  /** The address check pause (getChecksPause). */
  checksPause: { paused: boolean; text: string } | null;
  /** The AI drafting pause (getAiPause). */
  aiPause: { paused: boolean; text: string } | null;
  /**
   * Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.9, `loadTeamFrom().replies`): `from` the mailbox replies go to (the own From,
   * else what is saved; null = none saved), `inboxCheckedToday` SystemState "sending.inboxCheck" lies in today's cap
   * day, `followUpsDue` LIVE follow-ups (step ≥ 1, QUEUED) due within the next 24 hours of running or paused campaigns,
   * `publicAddress` APP_PUBLIC_URL is set (the go-live rows then include webhooks and remote access). Null or absent =
   * app mode (or the source couldn't be read: the inbox-check item is left out).
   */
  ownMailbox?: { from: string | null; inboxCheckedToday: boolean; followUpsDue: number; publicAddress: boolean } | null;
};

/** At most this many items are shown; the rest become "and 3 more" (no link). */
export const ATTENTION_MAX = 15;

/** The check with Mailgun must have failed this long without a success before the dashboard says so (one hourly blip raises nothing). */
export const MAILGUN_CHECK_GRACE_MS = 2 * 60 * 60 * 1000;

const n = (v: number) => v.toLocaleString("en-US");

const SENDING: AttentionLink = { href: "/settings/sending", label: "Open Sending & Mailgun" };
const BACKUPS: AttentionLink = { href: "/settings/backups", label: "Backups" };

/** Every fixed sentence of the list (the ones with numbers or names are the functions). */
export const ATTENTION_TEXTS = {
  heading: "Needs your attention",
  empty: "Nothing needs your attention right now.",
  askOwner: "Ask the Owner to fix this.",
  more: (count: number): string => `and ${n(count)} more`,
  restoreCheck: "Emails through Mailgun wait while the app checks Mailgun after the restore (about 35 minutes).",
  aiLines: (count: number): string => (count === 1 ? "1 AI line to review" : `${n(count)} AI lines to review`),
  campaignPaused: (name: string): string => `“${name}” is paused.`,
  morePaused: (count: number): string => (count === 1 ? "1 more paused campaign" : `${n(count)} more paused campaigns`),
  unconfirmed: (count: number): string =>
    count === 1
      ? "1 email needs a decision: the app isn't sure it was sent. Choose Retry or Skip."
      : `${n(count)} emails need a decision: the app isn't sure they were sent. Choose Retry or Skip.`,
  /** `days`: the days of Mailgun logs the app counts on (MAIN-DOMAIN-DESIGN O26; 5 when the setting is 5 and no plan). */
  outageHeld: (people: number, days: number): string =>
    `Follow-ups to ${plural(people, "person", "people")} are on hold: the PC was off for more than ${plural(days, "day", "days")}, so replies may have been missed. Emails you retried after that wait too.`,
  outageFound: (days: number): string =>
    `Some emails wait: the PC was off for more than ${plural(days, "day", "days")}, so replies may have been missed.`,
  /**
   * Own-mailbox mode (review REPLIES-09), instead of `outageFound`: no reply ever passes through the app there, so none
   * can be missed; what was lost is Mailgun's reports. Shown only until the (empty) hold is applied, minutes later.
   */
  outageFoundOwn: (days: number): string =>
    `Some emails wait a moment: the PC was off for more than ${plural(days, "day", "days")}, so Mailgun's reports of that time couldn't be read. Replies aren't affected: they go straight to your own mailbox.`,
  missingEmails: (count: number): string =>
    count === 1 ? "1 company has no email address." : `${n(count)} companies have no email address.`,
  backupNever: "No backup has been made yet. Click Back up now in Settings › Backups.",
  backupOld: (day: string | null): string =>
    day
      ? `The last backup is from ${day}, more than 36 hours ago. Check that the office PC and the background sender are on, or click Back up now.`
      : "The last backup is more than 36 hours old. Check that the office PC and the background sender are on, or click Back up now.",
  // Review SCREENS-03: a folder on this PC (OneDrive) fails until install-services.bat gives the background sender
  // permission, so the item names that fix too (as README "Warnings" does); the notification says which reason it was.
  backupCopyFailed: (folder: string): string =>
    `The last backup couldn't be copied to the second folder (${folder}). Check that the drive is plugged in. For a folder on this PC, run install-services.bat on the office PC, then click Back up now.`,
  secondFolderMissing:
    "No second backup folder yet. Choose one in Settings › Backups so a copy survives if this PC's disk fails.",
  goLiveAgainOwner: (domain: string): string =>
    `You changed the sending domain to ${domain}. Live campaigns only reach your test list until you go live on it.`,
  goLiveAgainMember: (domain: string): string =>
    `Live campaigns only reach the test list until the Owner goes live on ${domain}.`,
  /** SHARED-FROM-DESIGN §3.8: a From address change ended go-live (same sending domain). */
  goLiveAgainFromOwner:
    "You changed the From address. Live campaigns only reach your test list until you run the reply test and go live again.",
  goLiveAgainFromMember: "Live campaigns only reach the test list until the Owner goes live again with the new From address.",
  tunnelDown: (since: string | null): string =>
    `Remote access is down${since ? ` since ${since}` : ""}: remote staff and Mailgun can't reach the app. Check the office PC's internet connection, then run status.bat.`,
  checklist: (title: string, more: number): string =>
    `Something on the Domain checklist needs fixing: ${title}${more > 0 ? ` and ${n(more)} more` : ""}.`,
  checksPaused: "Address checks are paused.",
  aiPaused: "AI drafting is paused.",
} as const;

/** The list, in display order (all of it: `capAttention` keeps the first 15 for the screen). */
export function attentionItems(
  facts: AttentionFacts,
  viewer: { id: number; role: "OWNER" | "MEMBER" },
  now: Date,
): AttentionItem[] {
  const owner = viewer.role === "OWNER";
  const items: AttentionItem[] = [];
  const add = (key: AttentionKey, tone: AttentionTone, text: string, opts: { detail?: string | null; link?: AttentionLink | null } = {}) =>
    items.push({ key, tone, text, detail: opts.detail ?? null, link: opts.link ?? null, note: null });
  /** An Owner-only link: the Owner gets it, a Member "Ask the Owner to fix this." instead. */
  const addOwnerFix = (key: AttentionKey, tone: AttentionTone, text: string, link: AttentionLink, detail: string | null = null) =>
    items.push({ key, tone, text, detail, link: owner ? link : null, note: owner ? null : ATTENTION_TEXTS.askOwner });

  // 1–4: what stops or holds sending.
  if (facts.pause?.paused) {
    addOwnerFix("sending-paused", "danger", `${pausedWithReason("Sending is paused", facts.pause.reason)}.`, SENDING, facts.pause.fixText.trim() || null);
  }
  if (facts.workerDown) add("worker-down", "danger", facts.workerDown);
  if (facts.restoreChecking === true) addOwnerFix("restore-check", "warning", ATTENTION_TEXTS.restoreCheck, SENDING);
  if (facts.backup?.diskLowText) add("disk-low", "warning", facts.backup.diskLowText, { link: BACKUPS });

  // 5–7: SPEC §11's work waiting for people. Own-mailbox mode (MAIN-DOMAIN-DESIGN §3.9): right after the replies, the
  // day's inbox check while nobody has done it and live follow-ups wait for it (everyone may do it).
  if (facts.waitingLine) add("replies-waiting", "info", facts.waitingLine, { link: { href: "/notifications#replies", label: "Open replies" } });
  const own = facts.ownMailbox;
  if (own && own.from && !own.inboxCheckedToday && own.followUpsDue > 0) {
    add("inbox-check", "warning", INBOX_CHECK_TEXTS.item(own.followUpsDue, own.from), {
      link: { href: "/notifications#inbox-check", label: INBOX_CHECK_TEXTS.itemLink },
    });
  }
  if (facts.aiWaiting !== null && facts.aiWaiting > 0) {
    add("ai-lines", "info", ATTENTION_TEXTS.aiLines(facts.aiWaiting), { link: { href: "/ai-lines", label: "Review" } });
  }
  if (facts.pausedCampaigns) {
    for (const c of facts.pausedCampaigns.items) {
      add("paused-campaigns", "warning", ATTENTION_TEXTS.campaignPaused(c.name), {
        detail: c.pausedLine || null,
        link: { href: `/campaigns/${c.id}`, label: "Open" },
      });
    }
    const more = facts.pausedCampaigns.total - facts.pausedCampaigns.items.length;
    if (more > 0) {
      add("paused-campaigns", "warning", ATTENTION_TEXTS.morePaused(more), { link: { href: "/campaigns?tab=paused", label: "Open" } });
    }
  }

  // 8–9: emails waiting for a decision or held.
  if (facts.unconfirmed && facts.unconfirmed.count > 0) {
    const first = facts.unconfirmed.firstCampaignId;
    add("unconfirmed", "warning", ATTENTION_TEXTS.unconfirmed(facts.unconfirmed.count), {
      link: first !== null ? { href: `/campaigns/${first}`, label: "Open" } : null,
    });
  }
  const outage = facts.outage;
  if (outage && outage.detected && (!outage.applied || outage.people > 0)) {
    const days = outage.days ?? 5;
    // Own-mailbox mode holds nobody (O27): people still held come only from an app-mode hold before a switch, and keep
    // today's sentence; the "found" line says what was really lost (review REPLIES-09).
    const text =
      outage.people > 0
        ? ATTENTION_TEXTS.outageHeld(outage.people, days)
        : own
          ? ATTENTION_TEXTS.outageFoundOwn(days)
          : ATTENTION_TEXTS.outageFound(days);
    add("outage-hold", "warning", text, {
      link: owner
        ? { href: "/settings/sending#outage", label: "Continue follow-ups" }
        : { href: "/notifications", label: "Check your inbox" },
    });
  }

  // 10: SPEC §11's missing emails.
  if (facts.missingEmails !== null && facts.missingEmails > 0) {
    add("missing-emails", "info", ATTENTION_TEXTS.missingEmails(facts.missingEmails), {
      link: { href: "/contacts?view=missing-email", label: "Missing email view" },
    });
  }

  // 11–13: backups (Settings › Backups is open to everyone).
  const backup = facts.backup;
  if (backup?.age === "never") add("backup-never", "warning", ATTENTION_TEXTS.backupNever, { link: BACKUPS });
  if (backup?.age === "stale") add("backup-old", "warning", ATTENTION_TEXTS.backupOld(backup.newestDay), { link: BACKUPS });
  if (backup?.lastCopyFailed && backup.secondFolder) {
    add("backup-copy-failed", "warning", ATTENTION_TEXTS.backupCopyFailed(backup.secondFolder), { link: BACKUPS });
  }
  const goLive = facts.goLive;
  if (owner && !facts.practiceCopy && goLive?.live && facts.secondFolderSet === false) {
    add("second-folder-missing", "info", ATTENTION_TEXTS.secondFolderMissing, { link: BACKUPS });
  }

  // 14: a sending-domain change ended go-live (G8); both sentences name the new domain. Else a From address change on
  // the same domain ended it (SHARED-FROM-DESIGN F13, §3.8).
  const change = goLive && !facts.practiceCopy ? domainChangeEndedGoLive(goLive) : null;
  const fromChange = goLive && !facts.practiceCopy && !change ? fromChangeEndedGoLive(goLive) : null;
  if (change) {
    if (owner) {
      add("go-live-again", "warning", ATTENTION_TEXTS.goLiveAgainOwner(change.current), {
        link: { href: "/settings/sending#go-live", label: "Open Go live" },
      });
    } else {
      add("go-live-again", "warning", ATTENTION_TEXTS.goLiveAgainMember(change.current));
    }
  } else if (fromChange) {
    if (owner) {
      add("go-live-again", "warning", ATTENTION_TEXTS.goLiveAgainFromOwner, {
        link: { href: "/settings/sending#go-live", label: "Open Go live" },
      });
    } else {
      add("go-live-again", "warning", ATTENTION_TEXTS.goLiveAgainFromMember);
    }
  }

  // 15–18: connections and the checklist.
  if (facts.tunnel?.down) {
    addOwnerFix("tunnel-down", "warning", ATTENTION_TEXTS.tunnelDown(facts.tunnel.since), { href: "/settings/system", label: "Open System" });
  }
  if (facts.mailgunConfigured === true && facts.catchUp && mailgunCheckOverdue(facts.catchUp, now)) {
    addOwnerFix("mailgun-check", "warning", facts.catchUp.line, SENDING);
  }
  for (const line of facts.oldDomainLines ?? []) addOwnerFix("old-domain", "warning", line, SENDING);
  if (goLive?.live && !facts.practiceCopy && facts.checklistRows) {
    // Shared-From mode: the from-mx row is a go-live row too (goLiveRowKeys(true)); own-mailbox mode uses its own keys.
    const bad = badGoLiveRows(
      facts.checklistRows,
      Boolean(goLive.currentFrom),
      own ? { ownMailbox: true, publicAddress: own.publicAddress } : {},
    );
    if (bad.length > 0) {
      addOwnerFix("checklist", "warning", ATTENTION_TEXTS.checklist(bad[0]!, bad.length - 1), {
        href: "/settings/domain",
        label: "Open the checklist",
      });
    }
  }

  // 19–20: the M5 pauses.
  if (facts.checksPause?.paused) {
    addOwnerFix("checks-paused", "warning", facts.checksPause.text.trim() || ATTENTION_TEXTS.checksPaused, {
      href: "/settings/deliverability#checks",
      label: "Open Deliverability",
    });
  }
  if (facts.aiPause?.paused) {
    addOwnerFix("ai-paused", "warning", facts.aiPause.text.trim() || ATTENTION_TEXTS.aiPaused, { href: "/settings/ai", label: "Open AI settings" });
  }
  return items;
}

/** The first `max` items for the screen, and how many are left for "and 3 more". */
export function capAttention(items: readonly AttentionItem[], max = ATTENTION_MAX): { items: AttentionItem[]; more: number } {
  return { items: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/**
 * A sending-domain change ended go-live (G8): not live, `sending.goLiveDomain` set, and a different current domain.
 * `was` is the domain go-live was on, `current` the new one. Null otherwise (never live, or back on the same domain).
 */
export function domainChangeEndedGoLive(g: {
  live: boolean;
  currentDomain: string | null;
  liveDomain: string | null;
}): { was: string; current: string } | null {
  if (g.live) return null;
  const was = (g.liveDomain ?? "").trim();
  const current = (g.currentDomain ?? "").trim();
  if (!was || !current || was.toLowerCase() === current.toLowerCase()) return null;
  return { was, current };
}

const sameAddress = (v: string | null | undefined): string | null => (v ?? "").trim().toLowerCase() || null;

/**
 * A From address change ended go-live (SHARED-FROM-DESIGN F13, §3.8): not live, `sending.goLiveAt` set, the same sending
 * domain as go-live's (`domainChangeEndedGoLive` covers a domain change), and today's shared From address differs from
 * the one go-live was switched on with (null = per-person mode on either side). `was`/`now` are those two addresses.
 * Null otherwise, and whenever today's From is unknown (`currentFrom` absent).
 */
export function fromChangeEndedGoLive(g: {
  live: boolean;
  currentDomain: string | null;
  liveDomain: string | null;
  liveAt?: string | null;
  liveFrom?: string | null;
  currentFrom?: string | null;
}): { was: string | null; now: string | null } | null {
  if (g.live || g.currentFrom === undefined || !(g.liveAt ?? "").trim()) return null;
  const liveDomain = (g.liveDomain ?? "").trim().toLowerCase();
  const currentDomain = (g.currentDomain ?? "").trim().toLowerCase();
  if (!liveDomain || liveDomain !== currentDomain) return null;
  const was = sameAddress(g.liveFrom);
  const now = sameAddress(g.currentFrom);
  return was === now ? null : { was, now };
}

/**
 * The check with Mailgun is failing and nothing succeeded for more than 2 hours, so one failed hourly run raises
 * nothing. Measured from the last success; when it never succeeded, from when it started failing (`failingSince`),
 * never from the last start alone: the retries move that every 20 minutes, so it would never look 2 hours old (review
 * DASHBOARD-1). The last start is only the fallback for a state without `failingSince` (written before it existed).
 */
export function mailgunCheckOverdue(
  c: { failing: boolean; lastSuccessAt: string | null; lastStartedAt: string | null; failingSince?: string | null },
  now: Date,
): boolean {
  if (!c.failing) return false;
  const since = Date.parse(c.lastSuccessAt ?? c.failingSince ?? c.lastStartedAt ?? "");
  if (!Number.isFinite(since)) return true;
  return now.getTime() - since > MAILGUN_CHECK_GRACE_MS;
}

/**
 * The titles of the go-live rows (`goLiveRowKeys(teamFrom, opts)`, in that order: GO_LIVE_ROW_KEYS, plus the from-mx row
 * in shared-From mode; own-mailbox mode's own list with `opts.ownMailbox`, MAIN-DOMAIN-DESIGN §3.4) that are "bad" on
 * the Domain checklist.
 */
export function badGoLiveRows(
  rows: readonly ChecklistRow[],
  teamFrom = false,
  opts: { ownMailbox?: boolean; publicAddress?: boolean } = {},
): string[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: string[] = [];
  for (const key of goLiveRowKeys(teamFrom, opts)) {
    const row = byKey.get(key);
    if (row?.status === "bad") out.push(row.title.trim() || CHECKLIST_ROW_TITLES[key]);
  }
  return out;
}
