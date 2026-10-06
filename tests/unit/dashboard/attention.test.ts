import { describe, expect, it } from "vitest";
import {
  ATTENTION_MAX,
  ATTENTION_TEXTS,
  attentionItems,
  badGoLiveRows,
  capAttention,
  domainChangeEndedGoLive,
  fromChangeEndedGoLive,
  mailgunCheckOverdue,
  type AttentionFacts,
  type AttentionItem,
  type AttentionKey,
} from "@/core/dashboard/attention";
import type { ChecklistRow, ChecklistRowKey, CheckStatus } from "@/core/system-state";

/**
 * The dashboard's "Needs your attention" list (M6-DESIGN §4.2): every item's condition, exact text, tone, the Owner's
 * link against the Member's text, the display order, the 15 cap, and a failed source (a `null` fact) dropping only
 * its own item.
 */

const NOW = new Date("2026-09-23T10:00:00.000Z");
const OWNER = { id: 1, role: "OWNER" as const };
const MEMBER = { id: 2, role: "MEMBER" as const };
const ASK = "Ask the Owner to fix this.";

/** Everything fine: real data, not live, Mailgun set up, nothing waiting. */
function quiet(): AttentionFacts {
  return {
    practiceCopy: false,
    goLive: { live: false, currentDomain: "send.example.com", liveDomain: null },
    pause: { paused: false, reason: "", fixText: "" },
    workerDown: null,
    restoreChecking: false,
    backup: { age: "ok", newestDay: "23 Sept", lastCopyFailed: false, secondFolder: "D:\\Backups", diskLowText: null },
    secondFolderSet: true,
    waitingLine: null,
    aiWaiting: 0,
    pausedCampaigns: { items: [], total: 0 },
    unconfirmed: { count: 0, firstCampaignId: null },
    outage: { detected: false, applied: false, people: 0 },
    missingEmails: 0,
    tunnel: { down: false, since: null },
    mailgunConfigured: true,
    catchUp: { failing: false, line: "Last checked with Mailgun at 09:05.", lastSuccessAt: "2026-09-23T09:05:00.000Z", lastStartedAt: "2026-09-23T09:05:00.000Z" },
    oldDomainLines: [],
    checklistRows: [],
    checksPause: { paused: false, text: "" },
    aiPause: { paused: false, text: "" },
  };
}

function row(key: ChecklistRowKey, status: CheckStatus, title = `Row ${key}`): ChecklistRow {
  return { key, group: "dns", status, title, text: "", fix: null, records: [], detail: null };
}

const only = (facts: Partial<AttentionFacts>, viewer: { id: number; role: "OWNER" | "MEMBER" } = OWNER): AttentionItem[] =>
  attentionItems({ ...quiet(), ...facts }, viewer, NOW);
const keysOf = (items: readonly AttentionItem[]): AttentionKey[] => items.map((i) => i.key);

describe("attentionItems: nothing to do", () => {
  it("is empty when everything is fine", () => {
    expect(only({})).toEqual([]);
    expect(only({}, MEMBER)).toEqual([]);
  });
});

describe("attentionItems: each item", () => {
  it("sending-paused: the reason, the fix as second line, the Owner's link and the Member's note", () => {
    const pause = { paused: true, reason: "7 of the last 200 emails bounced", fixText: "Open the bounced list, remove bad addresses, then click Resume." };
    expect(only({ pause })).toEqual([
      {
        key: "sending-paused",
        tone: "danger",
        text: "Sending is paused: 7 of the last 200 emails bounced.",
        detail: "Open the bounced list, remove bad addresses, then click Resume.",
        link: { href: "/settings/sending", label: "Open Sending & Mailgun" },
        note: null,
      },
    ]);
    expect(only({ pause }, MEMBER)[0]).toMatchObject({ link: null, note: ASK, detail: pause.fixText });
    // A pause by hand names who ("Paused by Arslan"), never "paused: by Arslan".
    expect(only({ pause: { paused: true, reason: "by Arslan", fixText: "" } })[0]).toMatchObject({ text: "Sending is paused by Arslan.", detail: null });
    expect(only({ pause: { paused: true, reason: "", fixText: "" } })[0]!.text).toBe("Sending is paused by the Owner.");
  });

  it("worker-down: the loader's sentence, danger, no link", () => {
    const text = "The background sender hasn't checked in since 14:02, so no emails are going out. Restart the PC or double-click start.bat.";
    expect(only({ workerDown: text })).toEqual([{ key: "worker-down", tone: "danger", text, detail: null, link: null, note: null }]);
    expect(only({ workerDown: text }, MEMBER)[0]).toMatchObject({ link: null, note: null });
  });

  it("restore-check: only while the restore is being checked", () => {
    expect(only({ restoreChecking: true })).toEqual([
      {
        key: "restore-check",
        tone: "warning",
        text: "Emails through Mailgun wait while the app checks Mailgun after the restore (about 35 minutes).",
        detail: null,
        link: { href: "/settings/sending", label: "Open Sending & Mailgun" },
        note: null,
      },
    ]);
    expect(only({ restoreChecking: true }, MEMBER)[0]).toMatchObject({ link: null, note: ASK });
  });

  it("disk-low: everyone gets the Backups link", () => {
    const text = "The office PC's disk is almost full (1.2 GB free). Backups and sending stop when it's full.";
    const backup = { ...quiet().backup!, diskLowText: text };
    for (const viewer of [OWNER, MEMBER]) {
      expect(only({ backup }, viewer)).toEqual([
        { key: "disk-low", tone: "warning", text, detail: null, link: { href: "/settings/backups", label: "Backups" }, note: null },
      ]);
    }
  });

  it("replies-waiting: the waiting line with Open replies", () => {
    expect(only({ waitingLine: "Replies waiting for an answer: You 3 · Ali 1" }, MEMBER)).toEqual([
      {
        key: "replies-waiting",
        tone: "info",
        text: "Replies waiting for an answer: You 3 · Ali 1",
        detail: null,
        link: { href: "/notifications#replies", label: "Open replies" },
        note: null,
      },
    ]);
  });

  it("ai-lines: singular and plural, only when some wait", () => {
    expect(only({ aiWaiting: 12 })).toEqual([
      { key: "ai-lines", tone: "info", text: "12 AI lines to review", detail: null, link: { href: "/ai-lines", label: "Review" }, note: null },
    ]);
    expect(only({ aiWaiting: 1 })[0]!.text).toBe("1 AI line to review");
    expect(only({ aiWaiting: 1_200 })[0]!.text).toBe("1,200 AI lines to review");
    expect(only({ aiWaiting: 0 })).toEqual([]);
  });

  it("paused-campaigns: one item per campaign with why, then the rest in one line", () => {
    const pausedLine = "Paused by Ali on 4 Oct 2026, 09:00. Nothing is sent until you resume it.";
    const items = only({
      pausedCampaigns: {
        items: [
          { id: 7, name: "Germany Q4", pausedLine },
          { id: 8, name: "Spain", pausedLine: "Paused on 3 Oct 2026, 10:00: sender switched off. Nothing is sent until you resume it." },
          { id: 9, name: "Italy", pausedLine: "" },
        ],
        total: 5,
      },
    }, MEMBER);
    expect(items[0]).toEqual({
      key: "paused-campaigns",
      tone: "warning",
      text: "“Germany Q4” is paused.",
      detail: pausedLine,
      link: { href: "/campaigns/7", label: "Open" },
      note: null,
    });
    expect(items[2]).toMatchObject({ text: "“Italy” is paused.", detail: null });
    expect(items[3]).toEqual({
      key: "paused-campaigns",
      tone: "warning",
      text: "2 more paused campaigns",
      detail: null,
      link: { href: "/campaigns?tab=paused", label: "Open" },
      note: null,
    });
    expect(only({ pausedCampaigns: { items: [{ id: 1, name: "A", pausedLine }], total: 2 } }).at(-1)!.text).toBe("1 more paused campaign");
    expect(only({ pausedCampaigns: { items: [{ id: 1, name: "A", pausedLine }], total: 1 } })).toHaveLength(1);
  });

  it("unconfirmed: plural and singular, Open goes to the oldest one's campaign", () => {
    expect(only({ unconfirmed: { count: 3, firstCampaignId: 12 } })).toEqual([
      {
        key: "unconfirmed",
        tone: "warning",
        text: "3 emails need a decision: the app isn't sure they were sent. Choose Retry or Skip.",
        detail: null,
        link: { href: "/campaigns/12", label: "Open" },
        note: null,
      },
    ]);
    expect(only({ unconfirmed: { count: 1, firstCampaignId: null } })[0]).toMatchObject({
      text: "1 email needs a decision: the app isn't sure it was sent. Choose Retry or Skip.",
      link: null,
    });
  });

  it("outage-hold: found and not applied, or people still held; the Member checks their inbox", () => {
    const found = only({ outage: { detected: true, applied: false, people: 0 } });
    expect(found).toEqual([
      {
        key: "outage-hold",
        tone: "warning",
        text: "Some emails wait: the PC was off for more than 5 days, so replies may have been missed.",
        detail: null,
        link: { href: "/settings/sending#outage", label: "Continue follow-ups" },
        note: null,
      },
    ]);
    expect(only({ outage: { detected: true, applied: true, people: 12 } })[0]!.text).toBe(
      "Follow-ups to 12 people are on hold: the PC was off for more than 5 days, so replies may have been missed. Emails you retried after that wait too.",
    );
    expect(only({ outage: { detected: true, applied: true, people: 1 } })[0]!.text).toContain("Follow-ups to 1 person are on hold");
    expect(only({ outage: { detected: true, applied: true, people: 3 } }, MEMBER)[0]).toMatchObject({
      link: { href: "/notifications", label: "Check your inbox" },
      note: null,
    });
    // Applied and nobody left on hold, or nothing found: no item.
    expect(only({ outage: { detected: true, applied: true, people: 0 } })).toEqual([]);
    expect(only({ outage: { detected: false, applied: false, people: 4 } })).toEqual([]);
  });

  it("missing-emails: plural and singular with the Missing email view", () => {
    expect(only({ missingEmails: 38 })).toEqual([
      {
        key: "missing-emails",
        tone: "info",
        text: "38 companies have no email address.",
        detail: null,
        link: { href: "/contacts?view=missing-email", label: "Missing email view" },
        note: null,
      },
    ]);
    expect(only({ missingEmails: 1 })[0]!.text).toBe("1 company has no email address.");
  });

  it("backup-never, backup-old and backup-copy-failed", () => {
    const b = quiet().backup!;
    const link = { href: "/settings/backups", label: "Backups" };
    expect(only({ backup: { ...b, age: "never", newestDay: null } }, MEMBER)).toEqual([
      { key: "backup-never", tone: "warning", text: "No backup has been made yet. Click Back up now in Settings › Backups.", detail: null, link, note: null },
    ]);
    expect(only({ backup: { ...b, age: "stale", newestDay: "25 Sept" } })).toEqual([
      {
        key: "backup-old",
        tone: "warning",
        text: "The last backup is from 25 Sept, more than 36 hours ago. Check that the office PC and the background sender are on, or click Back up now.",
        detail: null,
        link,
        note: null,
      },
    ]);
    expect(only({ backup: { ...b, age: "stale", newestDay: null } })[0]!.text).toBe(
      "The last backup is more than 36 hours old. Check that the office PC and the background sender are on, or click Back up now.",
    );
    expect(only({ backup: { ...b, lastCopyFailed: true } }, MEMBER)).toEqual([
      {
        key: "backup-copy-failed",
        tone: "warning",
        text: "The last backup couldn't be copied to the second folder (D:\\Backups). Check that the drive is plugged in. For a folder on this PC, run install-services.bat on the office PC, then click Back up now.",
        detail: null,
        link,
        note: null,
      },
    ]);
    expect(only({ backup: { ...b, lastCopyFailed: true, secondFolder: null } })).toEqual([]);
  });

  it("second-folder-missing: the Owner only, on real data after going live", () => {
    const live = { live: true, currentDomain: "send.example.com", liveDomain: "send.example.com" };
    expect(only({ goLive: live, secondFolderSet: false })).toEqual([
      {
        key: "second-folder-missing",
        tone: "info",
        text: "No second backup folder yet. Choose one in Settings › Backups so a copy survives if this PC's disk fails.",
        detail: null,
        link: { href: "/settings/backups", label: "Backups" },
        note: null,
      },
    ]);
    expect(only({ goLive: live, secondFolderSet: false }, MEMBER)).toEqual([]);
    // Before go-live "Get started" step 4 says it; the practice copy never needs one.
    expect(only({ secondFolderSet: false })).toEqual([]);
    expect(only({ goLive: live, secondFolderSet: false, practiceCopy: true })).toEqual([]);
  });

  it("go-live-again: after a domain change ended go-live, the Owner's and the Member's sentences", () => {
    const ended = { live: false, currentDomain: "send2.example.com", liveDomain: "send.example.com" };
    expect(only({ goLive: ended })).toEqual([
      {
        key: "go-live-again",
        tone: "warning",
        text: "You changed the sending domain to send2.example.com. Live campaigns only reach your test list until you go live on it.",
        detail: null,
        link: { href: "/settings/sending#go-live", label: "Open Go live" },
        note: null,
      },
    ]);
    expect(only({ goLive: ended }, MEMBER)).toEqual([
      {
        key: "go-live-again",
        tone: "warning",
        text: "Live campaigns only reach the test list until the Owner goes live on send2.example.com.",
        detail: null,
        link: null,
        note: null,
      },
    ]);
    // Never live, live, back on the same domain, no current domain, the practice copy: nothing.
    expect(only({ goLive: { live: false, currentDomain: "send2.example.com", liveDomain: null } })).toEqual([]);
    expect(only({ goLive: { live: true, currentDomain: "send2.example.com", liveDomain: "send.example.com" } })).toEqual([]);
    expect(only({ goLive: { live: false, currentDomain: "Send.Example.com", liveDomain: "send.example.com" } })).toEqual([]);
    expect(only({ goLive: { live: false, currentDomain: null, liveDomain: "send.example.com" } })).toEqual([]);
    expect(only({ goLive: ended, practiceCopy: true })).toEqual([]);
  });

  it("go-live-again: after a From address change ended go-live on the same domain (SHARED-FROM-DESIGN §3.8)", () => {
    const base = { live: false, currentDomain: "send.example.com", liveDomain: "send.example.com", liveAt: "2026-09-20T09:05:00.000Z" };
    const turnedOn = { ...base, liveFrom: null, currentFrom: "contact@example.com" };
    expect(only({ goLive: turnedOn })).toEqual([
      {
        key: "go-live-again",
        tone: "warning",
        text: "You changed the From address. Live campaigns only reach your test list until you run the reply test and go live again.",
        detail: null,
        link: { href: "/settings/sending#go-live", label: "Open Go live" },
        note: null,
      },
    ]);
    expect(only({ goLive: turnedOn }, MEMBER)).toEqual([
      {
        key: "go-live-again",
        tone: "warning",
        text: "Live campaigns only reach the test list until the Owner goes live again with the new From address.",
        detail: null,
        link: null,
        note: null,
      },
    ]);
    // Turned off, or changed to another address: the same item.
    expect(only({ goLive: { ...base, liveFrom: "contact@example.com", currentFrom: null } })[0]?.key).toBe("go-live-again");
    expect(only({ goLive: { ...base, liveFrom: "contact@example.com", currentFrom: "hello@example.com" } })[0]?.key).toBe("go-live-again");
    // Same From (case aside), still live, never live, today's From unknown, the practice copy: nothing.
    expect(only({ goLive: { ...base, liveFrom: "Contact@Example.com", currentFrom: "contact@example.com" } })).toEqual([]);
    expect(only({ goLive: { ...base, liveFrom: null, currentFrom: null } })).toEqual([]);
    expect(only({ goLive: { ...turnedOn, live: true } })).toEqual([]);
    expect(only({ goLive: { ...turnedOn, liveAt: null } })).toEqual([]);
    expect(only({ goLive: { ...base, liveFrom: "contact@example.com" } })).toEqual([]);
    expect(only({ goLive: turnedOn, practiceCopy: true })).toEqual([]);
    // A domain change as well: the domain's item, once (its sentence names the new domain).
    const both = only({ goLive: { ...turnedOn, currentDomain: "send2.example.com" } });
    expect(both).toHaveLength(1);
    expect(both[0]!.text).toBe("You changed the sending domain to send2.example.com. Live campaigns only reach your test list until you go live on it.");
  });

  it("tunnel-down: with and without the time", () => {
    expect(only({ tunnel: { down: true, since: "14:02" } })).toEqual([
      {
        key: "tunnel-down",
        tone: "warning",
        text: "Remote access is down since 14:02: remote staff and Mailgun can't reach the app. Check the office PC's internet connection, then run status.bat.",
        detail: null,
        link: { href: "/settings/system", label: "Open System" },
        note: null,
      },
    ]);
    expect(only({ tunnel: { down: true, since: null } }, MEMBER)[0]).toMatchObject({
      text: "Remote access is down: remote staff and Mailgun can't reach the app. Check the office PC's internet connection, then run status.bat.",
      link: null,
      note: ASK,
    });
  });

  it("mailgun-check: failing, Mailgun set up, and no success for more than 2 hours", () => {
    const line = "The app hasn't been able to check Mailgun since 07:00. Bounces and unsubscribes may be late.";
    const failing = { failing: true, line, lastSuccessAt: "2026-09-23T07:00:00.000Z", lastStartedAt: "2026-09-23T09:30:00.000Z" };
    expect(only({ catchUp: failing })).toEqual([
      { key: "mailgun-check", tone: "warning", text: line, detail: null, link: { href: "/settings/sending", label: "Open Sending & Mailgun" }, note: null },
    ]);
    expect(only({ catchUp: failing }, MEMBER)[0]).toMatchObject({ link: null, note: ASK });
    // One hourly blip: the last success is under 2 hours old.
    expect(only({ catchUp: { ...failing, lastSuccessAt: "2026-09-23T08:30:00.000Z" } })).toEqual([]);
    // Exactly 2 hours: still within the grace.
    expect(only({ catchUp: { ...failing, lastSuccessAt: "2026-09-23T08:00:00.000Z" } })).toEqual([]);
    // Never succeeded: counted from the last start.
    expect(only({ catchUp: { ...failing, lastSuccessAt: null, lastStartedAt: "2026-09-23T07:30:00.000Z" } })).toHaveLength(1);
    expect(only({ catchUp: { ...failing, lastSuccessAt: null, lastStartedAt: "2026-09-23T09:30:00.000Z" } })).toEqual([]);
    // Not failing, or Mailgun not set up (or unknown): nothing.
    expect(only({ catchUp: { ...failing, failing: false } })).toEqual([]);
    expect(only({ catchUp: failing, mailgunConfigured: false })).toEqual([]);
    expect(only({ catchUp: failing, mailgunConfigured: null })).toEqual([]);
  });

  it("old-domain: one item per line", () => {
    const lines = [
      "Mailgun's logs for the old domain mail.example.com haven't been checked since 25 Sept. Replies and bounces to its last emails may be missed.",
      "Mailgun's logs for the old domain old.example.com haven't been checked since 20 Sept. Replies and bounces to its last emails may be missed.",
    ];
    const items = only({ oldDomainLines: lines });
    expect(items.map((i) => [i.key, i.tone, i.text, i.link?.href])).toEqual([
      ["old-domain", "warning", lines[0], "/settings/sending"],
      ["old-domain", "warning", lines[1], "/settings/sending"],
    ]);
    expect(only({ oldDomainLines: lines }, MEMBER).every((i) => i.note === ASK && i.link === null)).toBe(true);
  });

  it("checklist: after go-live, the first bad go-live row and how many more", () => {
    const live = { live: true, currentDomain: "send.example.com", liveDomain: "send.example.com" };
    const rows = [row("spf", "ok"), row("dmarc", "bad", "DMARC policy"), row("postmaster", "bad"), row("webhooks", "bad", "Webhooks"), row("retention", "bad", "Message retention")];
    expect(only({ goLive: live, checklistRows: rows })).toEqual([
      {
        key: "checklist",
        tone: "warning",
        text: "Something on the Domain checklist needs fixing: DMARC policy and 2 more.",
        detail: null,
        link: { href: "/settings/domain", label: "Open the checklist" },
        note: null,
      },
    ]);
    expect(only({ goLive: live, checklistRows: [row("webhooks", "bad", "Webhooks")] }, MEMBER)[0]).toMatchObject({
      text: "Something on the Domain checklist needs fixing: Webhooks.",
      link: null,
      note: ASK,
    });
    // Only "bad" rows of the go-live list count (warn rows and optional rows don't); before go-live nothing.
    expect(only({ goLive: live, checklistRows: [row("dmarc", "warn"), row("postmaster", "bad"), row("domain-age", "bad")] })).toEqual([]);
    expect(only({ checklistRows: rows })).toEqual([]);
  });

  it("checklist: in shared-From mode the from-mx row is a go-live row too (SHARED-FROM-DESIGN §3.8)", () => {
    const live = { live: true, currentDomain: "send.example.com", liveDomain: "send.example.com" };
    const fromMx = row("from-mx", "bad", "Mail for example.com stays with your mail provider (MX)");
    const rows = [row("spf", "ok"), fromMx, row("from-spf", "bad", "example.com's SPF record (your everyday email)")];
    expect(only({ goLive: { ...live, liveFrom: "contact@example.com", currentFrom: "contact@example.com" }, checklistRows: rows })).toEqual([
      {
        key: "checklist",
        tone: "warning",
        text: "Something on the Domain checklist needs fixing: Mail for example.com stays with your mail provider (MX).",
        detail: null,
        link: { href: "/settings/domain", label: "Open the checklist" },
        note: null,
      },
    ]);
    // Per-person mode (or today's From unknown): the row isn't a go-live row; from-spf never is.
    expect(only({ goLive: { ...live, currentFrom: null }, checklistRows: rows })).toEqual([]);
    expect(only({ goLive: live, checklistRows: rows })).toEqual([]);
  });

  it("checks-paused and ai-paused: the pause's own sentence", () => {
    const checks = "Address checks are paused: Mailgun refused the key. Save a working key in Settings › Deliverability, then resume.";
    const ai = "AI drafting is paused: this month's limit of $20 is reached. It starts again on 1 Oct.";
    expect(only({ checksPause: { paused: true, text: checks }, aiPause: { paused: true, text: ai } })).toEqual([
      { key: "checks-paused", tone: "warning", text: checks, detail: null, link: { href: "/settings/deliverability#checks", label: "Open Deliverability" }, note: null },
      { key: "ai-paused", tone: "warning", text: ai, detail: null, link: { href: "/settings/ai", label: "Open AI settings" }, note: null },
    ]);
    expect(only({ checksPause: { paused: true, text: " " }, aiPause: { paused: true, text: "" } }, MEMBER).map((i) => [i.text, i.note])).toEqual([
      ["Address checks are paused.", ASK],
      ["AI drafting is paused.", ASK],
    ]);
  });
});

/** Every item at once (the Owner after a domain change, so both go-live-again and the rest can show). */
function everything(): AttentionFacts {
  const q = quiet();
  return {
    ...q,
    pause: { paused: true, reason: "restored from a backup", fixText: "Check the restore report, then click Resume." },
    workerDown: "The background sender isn't running, so no emails are going out. Double-click start.bat on the office PC.",
    restoreChecking: true,
    backup: {
      age: "stale",
      newestDay: "20 Sept",
      lastCopyFailed: true,
      secondFolder: "E:\\Backups",
      diskLowText: "The office PC's disk is almost full (1.2 GB free). Backups and sending stop when it's full.",
    },
    waitingLine: "Replies waiting for an answer: You 3 · Ali 1",
    aiWaiting: 12,
    pausedCampaigns: { items: [{ id: 1, name: "Germany Q4", pausedLine: "Paused." }], total: 3 },
    unconfirmed: { count: 2, firstCampaignId: 4 },
    outage: { detected: true, applied: false, people: 0 },
    missingEmails: 8,
    goLive: { live: false, currentDomain: "send2.example.com", liveDomain: "send.example.com" },
    tunnel: { down: true, since: null },
    catchUp: { failing: true, line: "The app hasn't been able to check Mailgun yet. Bounces and unsubscribes may be late.", lastSuccessAt: null, lastStartedAt: "2026-09-22T10:00:00.000Z" },
    oldDomainLines: ["Mailgun's logs for the old domain mail.example.com haven't been checked since 25 Sept. Replies and bounces to its last emails may be missed."],
    checksPause: { paused: true, text: "Address checks are paused." },
    aiPause: { paused: true, text: "AI drafting is paused." },
  };
}

describe("attentionItems: order, the cap and failed sources", () => {
  it("keeps §4.2's display order", () => {
    expect(keysOf(attentionItems(everything(), OWNER, NOW))).toEqual([
      "sending-paused",
      "worker-down",
      "restore-check",
      "disk-low",
      "replies-waiting",
      "ai-lines",
      "paused-campaigns",
      "paused-campaigns",
      "unconfirmed",
      "outage-hold",
      "missing-emails",
      "backup-old",
      "backup-copy-failed",
      "go-live-again",
      "tunnel-down",
      "mailgun-check",
      "old-domain",
      "checks-paused",
      "ai-paused",
    ]);
    // After go-live: second-folder-missing and checklist take their places (13 and 18).
    const live = {
      ...everything(),
      goLive: { live: true, currentDomain: "send.example.com", liveDomain: "send.example.com" },
      secondFolderSet: false,
      checklistRows: [row("dmarc", "bad", "DMARC policy")],
    };
    const keys = keysOf(attentionItems(live, OWNER, NOW));
    expect(keys.slice(11, 14)).toEqual(["backup-old", "backup-copy-failed", "second-folder-missing"]);
    expect(keys.slice(-4)).toEqual(["old-domain", "checklist", "checks-paused", "ai-paused"]);
  });

  it("shows at most 15, then 'and N more'", () => {
    const all = attentionItems(everything(), OWNER, NOW);
    expect(all.length).toBeGreaterThan(ATTENTION_MAX);
    const capped = capAttention(all);
    expect(ATTENTION_MAX).toBe(15);
    expect(capped.items).toHaveLength(15);
    expect(capped.items).toEqual(all.slice(0, 15));
    expect(capped.more).toBe(all.length - 15);
    expect(capAttention(all.slice(0, 15))).toEqual({ items: all.slice(0, 15), more: 0 });
    expect(capAttention([])).toEqual({ items: [], more: 0 });
  });

  it("a source that failed (null) drops only its own item", () => {
    const full = keysOf(attentionItems(everything(), OWNER, NOW));
    const drop = (patch: Partial<AttentionFacts>, gone: AttentionKey[]) =>
      expect(keysOf(attentionItems({ ...everything(), ...patch }, OWNER, NOW))).toEqual(full.filter((k) => !gone.includes(k)));
    drop({ pause: null }, ["sending-paused"]);
    drop({ workerDown: null }, ["worker-down"]);
    drop({ restoreChecking: null }, ["restore-check"]);
    drop({ backup: null }, ["disk-low", "backup-old", "backup-copy-failed"]);
    drop({ waitingLine: null }, ["replies-waiting"]);
    drop({ aiWaiting: null }, ["ai-lines"]);
    drop({ pausedCampaigns: null }, ["paused-campaigns"]);
    drop({ unconfirmed: null }, ["unconfirmed"]);
    drop({ outage: null }, ["outage-hold"]);
    drop({ missingEmails: null }, ["missing-emails"]);
    drop({ goLive: null }, ["go-live-again"]);
    drop({ tunnel: null }, ["tunnel-down"]);
    drop({ catchUp: null }, ["mailgun-check"]);
    drop({ mailgunConfigured: null }, ["mailgun-check"]);
    drop({ oldDomainLines: null }, ["old-domain"]);
    drop({ checksPause: null }, ["checks-paused"]);
    drop({ aiPause: null }, ["ai-paused"]);
  });

  it("gives Members a note or their own words instead of every Owner-only link", () => {
    const items = attentionItems(everything(), MEMBER, NOW);
    const ownerOnly = new Set(["/settings/sending", "/settings/system", "/settings/domain", "/settings/deliverability#checks", "/settings/ai", "/settings/sending#go-live", "/settings/sending#outage"]);
    expect(items.some((i) => i.link && ownerOnly.has(i.link.href))).toBe(false);
    expect(items.filter((i) => i.note === ASK).map((i) => i.key)).toEqual([
      "sending-paused",
      "restore-check",
      "tunnel-down",
      "mailgun-check",
      "old-domain",
      "checks-paused",
      "ai-paused",
    ]);
    // No builder's words in any sentence.
    expect(JSON.stringify(items)).not.toMatch(/Milestone/);
  });
});

describe("helpers", () => {
  it("domainChangeEndedGoLive", () => {
    expect(domainChangeEndedGoLive({ live: false, currentDomain: " send2.example.com ", liveDomain: "send.example.com" })).toEqual({
      was: "send.example.com",
      current: "send2.example.com",
    });
    expect(domainChangeEndedGoLive({ live: true, currentDomain: "send2.example.com", liveDomain: "send.example.com" })).toBeNull();
    expect(domainChangeEndedGoLive({ live: false, currentDomain: "send.example.com", liveDomain: "SEND.example.com" })).toBeNull();
    expect(domainChangeEndedGoLive({ live: false, currentDomain: "", liveDomain: "send.example.com" })).toBeNull();
  });

  it("mailgunCheckOverdue", () => {
    expect(mailgunCheckOverdue({ failing: true, lastSuccessAt: null, lastStartedAt: null }, NOW)).toBe(true);
    expect(mailgunCheckOverdue({ failing: true, lastSuccessAt: "2026-09-23T07:59:59.000Z", lastStartedAt: null }, NOW)).toBe(true);
    expect(mailgunCheckOverdue({ failing: false, lastSuccessAt: null, lastStartedAt: null }, NOW)).toBe(false);
  });

  it("mailgunCheckOverdue: a check that never succeeded counts from when it started failing, not the last retry (review DASHBOARD-1)", () => {
    // Two days of failed runs, retried every 20 minutes: the last start is always recent.
    const never = { failing: true, lastSuccessAt: null, lastStartedAt: "2026-09-23T09:45:00.000Z", failingSince: "2026-09-21T10:00:00.000Z" };
    expect(mailgunCheckOverdue(never, NOW)).toBe(true);
    expect(only({ catchUp: { ...never, line: "The app hasn't been able to check Mailgun yet. Bounces and unsubscribes may be late." } })).toMatchObject([
      { key: "mailgun-check", text: "The app hasn't been able to check Mailgun yet. Bounces and unsubscribes may be late." },
    ]);
    // Failing for less than 2 hours: still within the grace.
    expect(mailgunCheckOverdue({ ...never, failingSince: "2026-09-23T08:30:00.000Z" }, NOW)).toBe(false);
    // A success counts first: failing since before it changes nothing.
    expect(mailgunCheckOverdue({ ...never, lastSuccessAt: "2026-09-23T09:00:00.000Z" }, NOW)).toBe(false);
    // A state written before `failingSince` still falls back to the last start.
    expect(mailgunCheckOverdue({ failing: true, lastSuccessAt: null, lastStartedAt: "2026-09-23T07:30:00.000Z" }, NOW)).toBe(true);
    expect(mailgunCheckOverdue({ ...never, failingSince: null }, NOW)).toBe(false);
  });

  it("badGoLiveRows: go-live rows in their order, with the fallback title", () => {
    expect(badGoLiveRows([row("webhooks", "bad", "Webhooks"), row("spf", "bad", "  "), row("postmaster", "bad")])).toEqual([
      "Mailgun may send for your domain (SPF)",
      "Webhooks",
    ]);
  });

  it("badGoLiveRows: the from-mx row counts only in shared-From mode, right after DMARC, with its fallback title", () => {
    const rows = [row("webhooks", "bad", "Webhooks"), row("from-mx", "bad", " "), row("dmarc", "bad", "DMARC policy"), row("from-spf", "bad")];
    expect(badGoLiveRows(rows)).toEqual(["DMARC policy", "Webhooks"]);
    expect(badGoLiveRows(rows, false)).toEqual(["DMARC policy", "Webhooks"]);
    expect(badGoLiveRows(rows, true)).toEqual(["DMARC policy", "Mail for your main domain stays with your mail provider (MX)", "Webhooks"]);
    expect(badGoLiveRows([row("from-mx", "warn"), row("from-mx", "ok")], true)).toEqual([]);
  });

  it("fromChangeEndedGoLive", () => {
    const base = { live: false, currentDomain: "send.example.com", liveDomain: "send.example.com", liveAt: "2026-09-20T09:05:00.000Z" };
    expect(fromChangeEndedGoLive({ ...base, liveFrom: null, currentFrom: " Contact@Example.com " })).toEqual({ was: null, now: "contact@example.com" });
    expect(fromChangeEndedGoLive({ ...base, liveFrom: "contact@example.com", currentFrom: null })).toEqual({ was: "contact@example.com", now: null });
    expect(fromChangeEndedGoLive({ ...base, liveFrom: "contact@example.com", currentFrom: "hello@example.com" })).toEqual({
      was: "contact@example.com",
      now: "hello@example.com",
    });
    // Nothing changed (case and spaces aside; empty means per-person mode).
    expect(fromChangeEndedGoLive({ ...base, liveFrom: "CONTACT@example.com", currentFrom: "contact@example.com" })).toBeNull();
    expect(fromChangeEndedGoLive({ ...base, liveFrom: " ", currentFrom: null })).toBeNull();
    expect(fromChangeEndedGoLive({ ...base, liveFrom: null, currentFrom: null })).toBeNull();
    // Still live; never live (no go-live time); today's From unknown; a domain change (its own item); no domain.
    expect(fromChangeEndedGoLive({ ...base, live: true, liveFrom: null, currentFrom: "contact@example.com" })).toBeNull();
    expect(fromChangeEndedGoLive({ ...base, liveAt: null, liveFrom: null, currentFrom: "contact@example.com" })).toBeNull();
    expect(fromChangeEndedGoLive({ ...base, liveAt: undefined, liveFrom: null, currentFrom: "contact@example.com" })).toBeNull();
    expect(fromChangeEndedGoLive({ ...base, liveFrom: null })).toBeNull();
    expect(fromChangeEndedGoLive({ ...base, currentDomain: "send2.example.com", liveFrom: null, currentFrom: "contact@example.com" })).toBeNull();
    expect(fromChangeEndedGoLive({ ...base, liveDomain: null, liveFrom: null, currentFrom: "contact@example.com" })).toBeNull();
    // The domain names are compared without case.
    expect(fromChangeEndedGoLive({ ...base, liveDomain: "SEND.example.com", liveFrom: null, currentFrom: "contact@example.com" })).not.toBeNull();
  });
});

/** MAIN-DOMAIN-DESIGN §3.9, §2.8 (O26): own-mailbox mode's items and the outage sentences' days. */
describe("own-mailbox mode", () => {
  const FROM = "contact@example.com";
  const own = (over: Partial<NonNullable<AttentionFacts["ownMailbox"]>> = {}): NonNullable<AttentionFacts["ownMailbox"]> => ({
    from: FROM,
    inboxCheckedToday: false,
    followUpsDue: 3,
    publicAddress: false,
    ...over,
  });
  const ITEM = {
    key: "inbox-check",
    tone: "warning",
    // Review REPLIES-05: Mark unsubscribed for removal requests and bounce notices.
    text: `3 follow-ups wait for today's check of contact@example.com. Whoever reads it: read its inbox and Spam folder, click They replied on every company that answered and ⋯ › Mark unsubscribed on the person for every removal request or "couldn't be delivered" notice, then click I've read contact@example.com.`,
    detail: null,
    link: { href: "/notifications#inbox-check", label: "Open the inbox check" },
    note: null,
  };

  it("inbox-check: a warning with the Notifications card's link, for the Owner and for a Member alike", () => {
    expect(only({ ownMailbox: own() })).toEqual([ITEM]);
    expect(only({ ownMailbox: own() }, MEMBER)).toEqual([ITEM]);
    expect(only({ ownMailbox: own({ followUpsDue: 1 }) })[0]!.text).toBe(
      `1 follow-up waits for today's check of contact@example.com. Whoever reads it: read its inbox and Spam folder, click They replied on every company that answered and ⋯ › Mark unsubscribed on the person for every removal request or "couldn't be delivered" notice, then click I've read contact@example.com.`,
    );
    expect(only({ ownMailbox: own({ followUpsDue: 1_200 }) })[0]!.text).toMatch(/^1,200 follow-ups wait for today's check/);
  });

  it("inbox-check: gone once someone read the mailbox today, with nothing due, without a From, and in app mode", () => {
    expect(only({ ownMailbox: own({ inboxCheckedToday: true }) })).toEqual([]);
    expect(only({ ownMailbox: own({ followUpsDue: 0 }) })).toEqual([]);
    expect(only({ ownMailbox: own({ from: null }) })).toEqual([]);
    expect(only({ ownMailbox: null })).toEqual([]);
    expect(only({})).toEqual([]);
  });

  it("inbox-check comes right after replies-waiting", () => {
    const keys = keysOf(attentionItems({ ...everything(), ownMailbox: own() }, OWNER, NOW));
    expect(keys.slice(4, 7)).toEqual(["replies-waiting", "inbox-check", "ai-lines"]);
    // Without the fact (app mode, or its source failed) the rest is as before.
    expect(keysOf(attentionItems({ ...everything(), ownMailbox: null }, OWNER, NOW))).toEqual(keysOf(attentionItems(everything(), OWNER, NOW)));
  });

  it("checklist: the own-mailbox go-live rows (from-mx counts, mx and the inbound rows don't; webhooks only with a public address)", () => {
    const live = { live: true, currentDomain: "example.com", liveDomain: "example.com", currentFrom: FROM, liveFrom: FROM };
    const rows = [
      row("mx", "bad", "Replies reach the app (MX)"),
      row("spam-filter", "bad"),
      row("retention", "bad"),
      row("https-links", "bad"),
      row("webhooks", "bad", "Webhooks"),
      row("from-mx", "bad", "Mail for example.com stays with your mail provider (MX)"),
    ];
    expect(only({ goLive: live, checklistRows: rows, ownMailbox: own({ inboxCheckedToday: true }) })).toEqual([
      {
        key: "checklist",
        tone: "warning",
        text: "Something on the Domain checklist needs fixing: Mail for example.com stays with your mail provider (MX).",
        detail: null,
        link: { href: "/settings/domain", label: "Open the checklist" },
        note: null,
      },
    ]);
    const withPublic = only({ goLive: live, checklistRows: rows, ownMailbox: own({ inboxCheckedToday: true, publicAddress: true }) });
    expect(withPublic[0]!.text).toBe("Something on the Domain checklist needs fixing: Mail for example.com stays with your mail provider (MX) and 1 more.");
  });

  it("badGoLiveRows: goLiveRowKeys' own-mailbox list, in its order", () => {
    const rows = [row("webhooks", "bad", "Webhooks"), row("mx", "bad"), row("from-mx", "bad", " "), row("dmarc", "bad", "DMARC policy"), row("remote-access", "bad", "Remote access")];
    expect(badGoLiveRows(rows, true, { ownMailbox: true })).toEqual(["DMARC policy", "Mail for your main domain stays with your mail provider (MX)"]);
    expect(badGoLiveRows(rows, false, { ownMailbox: true, publicAddress: true })).toEqual([
      "DMARC policy",
      "Mail for your main domain stays with your mail provider (MX)",
      "Webhooks",
      "Remote access",
    ]);
    // No options: today's list, unchanged.
    expect(badGoLiveRows(rows, false)).toEqual(["Row mx", "DMARC policy", "Webhooks", "Remote access"]);
  });

  it("the outage sentences take the days of logs the app counts on", () => {
    expect(ATTENTION_TEXTS.outageHeld(12, 1)).toBe(
      "Follow-ups to 12 people are on hold: the PC was off for more than 1 day, so replies may have been missed. Emails you retried after that wait too.",
    );
    expect(ATTENTION_TEXTS.outageFound(1)).toBe("Some emails wait: the PC was off for more than 1 day, so replies may have been missed.");
    expect(only({ outage: { detected: true, applied: false, people: 0, days: 1 } })[0]!.text).toBe(
      "Some emails wait: the PC was off for more than 1 day, so replies may have been missed.",
    );
    expect(only({ outage: { detected: true, applied: true, people: 2, days: 3 } })[0]!.text).toContain("the PC was off for more than 3 days");
    // App mode's sentences are unchanged (5 days: the setting's default without a plan, or the days left out).
    expect(ATTENTION_TEXTS.outageFound(5)).toBe("Some emails wait: the PC was off for more than 5 days, so replies may have been missed.");
    expect(only({ outage: { detected: true, applied: true, people: 1, days: 5 } })[0]!.text).toBe(
      "Follow-ups to 1 person are on hold: the PC was off for more than 5 days, so replies may have been missed. Emails you retried after that wait too.",
    );
  });

  it("own-mailbox mode: a found gap says Mailgun's reports were lost, never replies (review REPLIES-09)", () => {
    const found = only({ outage: { detected: true, applied: false, people: 0, days: 1 }, ownMailbox: own({ inboxCheckedToday: true }) });
    expect(found.map((i) => i.text)).toEqual([ATTENTION_TEXTS.outageFoundOwn(1)]);
    expect(ATTENTION_TEXTS.outageFoundOwn(1)).toBe(
      "Some emails wait a moment: the PC was off for more than 1 day, so Mailgun's reports of that time couldn't be read. Replies aren't affected: they go straight to your own mailbox.",
    );
    expect(found[0]!.text).not.toMatch(/replies may have been missed/);
    // People still held (an app-mode hold from before a switch) keep today's sentence.
    expect(only({ outage: { detected: true, applied: true, people: 2, days: 1 }, ownMailbox: own({ inboxCheckedToday: true }) })[0]!.text).toBe(
      ATTENTION_TEXTS.outageHeld(2, 1),
    );
  });
});
