import { describe, expect, it } from "vitest";
import {
  evaluateReplyTest,
  mergeReplyTestAnswers,
  providerOf,
  readReplyTestPastes,
  REPLY_TEST_TEXTS,
  replyTestAnswerChange,
  replyTestAnswersFrom,
  replyTestAnswersKey,
  replyTestRoundChanged,
  replyTestRoundOf,
  type MailboxFacts,
  type ReplyTestAnswersInput,
  type ReplyTestRound,
} from "@/core/reply-test";
import { DEFAULT_UNSUBSCRIBE_TEST, type ReplyTestMailbox, type ReplyTestOriginal, type UnsubscribeTestSetting } from "@/core/setting-types";
import { testOriginal } from "./originals";

/**
 * The Owner's reply-test answers as the page saves them (review SECURITY-1, REPLIES-03): the page sends only the answer
 * that changed, with the value it replaced and the round it belongs to; the server keeps every other saved answer, never
 * lets a page that didn't show a DMARC answer read from a pasted original overwrite it, and refuses answers given for
 * another round. The section re-syncs from the saved answers whenever they change (`replyTestAnswersKey`).
 */

const D = "send.example.com";
const FROM = "contact@example.com";
const OUTLOOK = "t.outlook@outlook.com";
const GMAIL = "t.gmail@gmail.com";
const LIST = [OUTLOOK, GMAIL];
const ROUND: ReplyTestRound = { domain: D, from: FROM, setup: "A" };
const NONE = { auth: new Map(), dmarc: new Map() } as const;

function box(address: string, a: Partial<ReplyTestMailbox> = {}): ReplyTestMailbox {
  return { address, provider: providerOf(address), inboxOk: true, authOk: "pass", authFromHeaders: false, placementOk: true, dmarcOk: "pass", dmarcFromHeaders: false, ...a };
}

function setting(mailboxes: ReplyTestMailbox[], over: Partial<UnsubscribeTestSetting> = {}): UnsubscribeTestSetting {
  return { ...DEFAULT_UNSUBSCRIBE_TEST, mailboxes, headersOk: true, ...over };
}

function merged(s: UnsubscribeTestSetting, input: ReplyTestAnswersInput, reads: Parameters<typeof mergeReplyTestAnswers>[3] = NONE) {
  const res = mergeReplyTestAnswers(s, LIST, input, reads);
  if (!res.ok) throw new Error(res.error);
  return res;
}

describe("mergeReplyTestAnswers: only what changed (REPLIES-03)", () => {
  it("one changed answer keeps every other saved answer, of this mailbox and the others", () => {
    const s = setting([box(OUTLOOK, { placementOk: false }), box(GMAIL, { dmarcOk: "fail", dmarcFromHeaders: true })]);
    const res = merged(s, { mailboxes: [{ address: OUTLOOK, inboxOk: false }] });
    expect(res.setting.mailboxes).toEqual([box(OUTLOOK, { placementOk: false, inboxOk: false }), box(GMAIL, { dmarcOk: "fail", dmarcFromHeaders: true })]);
    expect(res.setting.headersOk).toBe(true);
  });

  it("the List-Unsubscribe answer alone: every mailbox stays as saved; absent keeps it, null clears it", () => {
    const s = setting([box(OUTLOOK), box(GMAIL)], { headersOk: null });
    expect(merged(s, { mailboxes: [], headersOk: false }).setting).toEqual({ ...s, headersOk: false });
    expect(merged({ ...s, headersOk: true }, { mailboxes: [] }).setting.headersOk).toBe(true);
    expect(merged({ ...s, headersOk: true }, { mailboxes: [], headersOk: null }).setting.headersOk).toBeNull();
  });

  it("per-person answers keep today's shape, answers for other addresses are dropped, and full entries still work", () => {
    const res = merged(setting([]), {
      mailboxes: [
        { address: "T.Outlook@Outlook.com", inboxOk: true, authOk: "pass" },
        { address: "not.listed@gmail.com", inboxOk: false, authOk: "fail" },
      ],
      headersOk: true,
    });
    expect(res.setting.mailboxes).toEqual([{ address: OUTLOOK, provider: "microsoft", inboxOk: true, authOk: "pass", authFromHeaders: false }]);
  });

  it("a mailbox no longer on the test list loses its answers", () => {
    const s = setting([box(OUTLOOK), box("old@yahoo.com")]);
    expect(merged(s, { mailboxes: [] }).setting.mailboxes.map((m) => m.address)).toEqual([OUTLOOK]);
  });
});

describe("mergeReplyTestAnswers: a DMARC answer read from a pasted original (SECURITY-1)", () => {
  // The Owner answered DMARC Yes by hand for both; then pasted Gmail's original, which says DMARC: FAIL (stored by the
  // server as Gmail dmarcOk "fail", dmarcFromHeaders true), and then Outlook.com's (pass), which replaced the original.
  const afterPastes = setting([box(OUTLOOK, { dmarcFromHeaders: true }), box(GMAIL, { dmarcOk: "fail", dmarcFromHeaders: true })], {
    original: { domain: D, from: FROM, address: OUTLOOK, testSendId: 2, returnPathDomain: D, returnPathOk: true, dmarc: "pass", dkimSigner: "example.com", mailtoDomain: D, mailtoOk: true, readAt: "2026-09-27T10:00:00Z" } satisfies ReplyTestOriginal,
  });
  const facts = new Map<string, MailboxFacts>(LIST.map((a, i) => [a, { testSendId: i + 1, sentAt: new Date("2026-09-27T09:00:00Z"), delivered: true, replyStored: true }]));

  it("the page's older 'Yes' is refused, the FAIL stays, and the verdict stays failed", () => {
    // What the old page sent before the fix: every mailbox, Gmail's DMARC as the page still showed it.
    const stale: ReplyTestAnswersInput = {
      mailboxes: LIST.map((address) => ({ address, inboxOk: true, authOk: "pass", placementOk: true, dmarcOk: "pass" })),
      headersOk: true,
    };
    expect(mergeReplyTestAnswers(afterPastes, LIST, stale, NONE)).toEqual({ ok: false, error: REPLY_TEST_TEXTS.dmarcReadMeanwhile(GMAIL) });
    // Also with `was` naming the value the stale page showed.
    const withWas = replyTestAnswerChange(GMAIL, "dmarcOk", "pass", { inboxOk: true, authOk: "pass", placementOk: true, dmarcOk: "unsure" }, ROUND);
    expect(mergeReplyTestAnswers(afterPastes, LIST, withWas, NONE)).toMatchObject({ ok: false });
    expect(REPLY_TEST_TEXTS.dmarcReadMeanwhile(GMAIL)).toBe(
      "t.gmail@gmail.com: the DMARC answer was just read from a pasted original, so nothing was saved. The page now shows it; change it again if it's wrong.",
    );
    expect(evaluateReplyTest(afterPastes, facts, true, { teamFrom: FROM, sendingDomain: D })).toMatchObject({
      status: "failed",
      missing: [REPLY_TEST_TEXTS.dmarcFailed(GMAIL)],
    });
  });

  it("another answer from the re-synced page leaves the FAIL alone", () => {
    const page = replyTestAnswersFrom(
      afterPastes.mailboxes.map((m) => ({ address: m.address, inboxOk: m.inboxOk, authOk: m.authOk, placementOk: m.placementOk, dmarcOk: m.dmarcOk })),
      true,
    );
    expect(page[GMAIL]?.dmarcOk).toBe("fail");
    const res = merged(afterPastes, replyTestAnswerChange(OUTLOOK, "placementOk", false, page[OUTLOOK], ROUND));
    expect(res.setting.mailboxes.find((m) => m.address === GMAIL)).toMatchObject({ dmarcOk: "fail", dmarcFromHeaders: true });
    expect(evaluateReplyTest(res.setting, facts, true, { teamFrom: FROM, sendingDomain: D }).status).toBe("failed");
  });

  it("the Owner may still change it on a page that showed it, and the same value changes nothing", () => {
    const shown = { inboxOk: true, authOk: "pass" as const, placementOk: true, dmarcOk: "fail" as const };
    const changed = merged(afterPastes, replyTestAnswerChange(GMAIL, "dmarcOk", "unsure", shown, ROUND));
    expect(changed.setting.mailboxes.find((m) => m.address === GMAIL)).toMatchObject({ dmarcOk: "unsure", dmarcFromHeaders: false });
    const same = merged(afterPastes, { mailboxes: [{ address: GMAIL, dmarcOk: "fail" }] });
    expect(same.setting.mailboxes.find((m) => m.address === GMAIL)).toMatchObject({ dmarcOk: "fail", dmarcFromHeaders: true });
  });

  it("an answer given by hand (not read from a paste) can be changed as before", () => {
    const byHand = setting([box(OUTLOOK), box(GMAIL, { dmarcOk: "pass", dmarcFromHeaders: false })]);
    expect(merged(byHand, { mailboxes: [{ address: GMAIL, dmarcOk: "fail" }] }).setting.mailboxes[1]).toMatchObject({ dmarcOk: "fail" });
  });

  it("a DMARC paste in the mailbox's own box sets the answer, also over one read before", () => {
    const pasted = testOriginal({ from: `Arslan <${FROM}>`, messageId: "pp.t.1.abc@send.example.com", to: GMAIL, dmarc: "pass" });
    const input: ReplyTestAnswersInput = { mailboxes: [{ address: GMAIL, dmarcPasted: pasted }], round: ROUND };
    const reads = readReplyTestPastes(input, "example.com");
    expect(reads.dmarc.get(GMAIL)).toBe("pass");
    const res = merged(afterPastes, input, reads);
    expect(res.dmarcFromHeaders).toEqual({ [GMAIL]: "pass" });
    expect(res.setting.mailboxes.find((m) => m.address === GMAIL)).toMatchObject({ dmarcOk: "pass", dmarcFromHeaders: true });
  });

  it("pasted headers set dkim/arc for that mailbox only, read before the save and never kept", () => {
    const headers = "Authentication-Results: mx.google.com;\n       dkim=pass header.i=@gmail.com header.s=x header.b=y\n";
    const input: ReplyTestAnswersInput = { mailboxes: [{ address: "T.Gmail@Gmail.com", pastedHeaders: headers }] };
    const reads = readReplyTestPastes(input, null);
    const res = merged(setting([box(OUTLOOK), box(GMAIL, { authOk: "unsure" })]), input, reads);
    expect(res.authFromHeaders).toEqual({ [GMAIL]: "pass" });
    expect(res.setting.mailboxes[1]).toMatchObject({ authOk: "pass", authFromHeaders: true, dmarcOk: "pass" });
    expect(JSON.stringify(res.setting)).not.toContain("mx.google.com");
  });
});

describe("the round a page belongs to (REPLIES-03)", () => {
  it("is the view's domain, From address and setup", () => {
    expect(replyTestRoundOf({ domain: "Send.Example.com", teamFrom: " Contact@Example.com ", setup: "B" })).toEqual({ domain: D, from: FROM, setup: "B" });
    expect(replyTestRoundOf({ domain: D, setup: "A" })).toEqual({ domain: D, from: null, setup: "A" });
  });

  it("another From address, sending domain or setup is another round; the same one in other case is not", () => {
    expect(replyTestRoundChanged(ROUND, ROUND)).toBe(false);
    expect(replyTestRoundChanged({ domain: "SEND.example.com", from: "CONTACT@example.com", setup: "A" }, ROUND)).toBe(false);
    expect(replyTestRoundChanged(ROUND, { ...ROUND, from: "info@example.com" })).toBe(true);
    expect(replyTestRoundChanged(ROUND, { ...ROUND, from: null })).toBe(true);
    expect(replyTestRoundChanged({ ...ROUND, from: null }, ROUND)).toBe(true);
    expect(replyTestRoundChanged(ROUND, { ...ROUND, domain: "mail.example.com" })).toBe(true);
    expect(replyTestRoundChanged(ROUND, { ...ROUND, setup: "B" })).toBe(true);
    expect(replyTestRoundChanged(null, ROUND)).toBe(false);
    expect(replyTestRoundChanged(undefined, ROUND)).toBe(false);
  });

  it("per-person mode on both sides is never checked (exactly as before)", () => {
    const perPerson = { domain: D, from: null, setup: "A" as const };
    expect(replyTestRoundChanged(perPerson, { ...perPerson, domain: "mail.example.com" })).toBe(false);
    expect(replyTestRoundChanged(perPerson, { ...perPerson, setup: "B" })).toBe(false);
    // Even with the evidence times differing (a per-person page never sends one anyway).
    expect(replyTestRoundChanged({ ...perPerson, since: "2026-09-27T10:00:00.000Z" }, { ...perPerson, since: "2026-09-27T11:00:00.000Z" })).toBe(false);
  });

  it("the same From, domain and setup after a change and back (or a region-only move) is another round (since)", () => {
    const T1 = "2026-09-27T10:00:00.000Z";
    const T2 = "2026-09-27T11:00:00.000Z";
    // The view carries `roundSince` in shared-From mode only; the round then names it.
    expect(replyTestRoundOf({ domain: D, teamFrom: FROM, setup: "A", roundSince: T1 })).toEqual({ ...ROUND, since: T1 });
    expect(replyTestRoundOf({ domain: D, teamFrom: FROM, setup: "A", roundSince: null })).toEqual({ ...ROUND, since: null });
    expect(replyTestRoundChanged({ ...ROUND, since: T1 }, { ...ROUND, since: T2 })).toBe(true);
    expect(replyTestRoundChanged({ ...ROUND, since: T1 }, { ...ROUND, since: null })).toBe(true);
    expect(replyTestRoundChanged({ ...ROUND, since: T1 }, { ...ROUND, since: T1 })).toBe(false);
    // The same moment written another way is the same round.
    expect(replyTestRoundChanged({ ...ROUND, since: "2026-09-27T12:00:00+02:00" }, { ...ROUND, since: T1 })).toBe(false);
    // Compared only when both sides carry it (older pages and callers are checked as before).
    expect(replyTestRoundChanged(ROUND, { ...ROUND, since: T2 })).toBe(false);
    expect(replyTestRoundChanged({ ...ROUND, since: T1 }, ROUND)).toBe(false);
  });
});

describe("what the page sends and when it re-syncs", () => {
  const view = {
    domain: D,
    teamFrom: FROM,
    setup: "A" as const,
    headersOk: null,
    mailboxes: [
      { address: OUTLOOK, inboxOk: true, authOk: "pass" as const, placementOk: null, dmarcOk: null, delivered: true },
      { address: GMAIL, inboxOk: null, authOk: null, placementOk: true, dmarcOk: "pass" as const, delivered: false },
    ],
  };

  it("a click sends that one answer, the value it replaced and the round, nothing else", () => {
    const page = replyTestAnswersFrom(view.mailboxes, true);
    expect(replyTestAnswerChange(OUTLOOK, "dmarcOk", "fail", page[OUTLOOK], replyTestRoundOf(view))).toEqual({
      mailboxes: [{ address: OUTLOOK, dmarcOk: "fail", was: { dmarcOk: null } }],
      round: { domain: D, from: FROM, setup: "A" },
    });
    expect(replyTestAnswerChange(GMAIL, "inboxOk", true, undefined, replyTestRoundOf(view))).toEqual({
      mailboxes: [{ address: GMAIL, inboxOk: true, was: { inboxOk: null } }],
      round: { domain: D, from: FROM, setup: "A" },
    });
  });

  it("the page starts from the saved answers; per-person mode keeps two answers per mailbox", () => {
    expect(replyTestAnswersFrom(view.mailboxes, true)).toEqual({
      [OUTLOOK]: { inboxOk: true, authOk: "pass", placementOk: null, dmarcOk: null },
      [GMAIL]: { inboxOk: null, authOk: null, placementOk: true, dmarcOk: "pass" },
    });
    expect(replyTestAnswersFrom(view.mailboxes, false)).toEqual({
      [OUTLOOK]: { inboxOk: true, authOk: "pass" },
      [GMAIL]: { inboxOk: null, authOk: null },
    });
  });

  it("the re-sync key changes with a saved answer, the List-Unsubscribe answer or the round, not with the facts", () => {
    const key = replyTestAnswersKey(view);
    const withGmail = (dmarcOk: "pass" | "fail") => ({ ...view, mailboxes: [view.mailboxes[0]!, { ...view.mailboxes[1]!, dmarcOk }] });
    expect(replyTestAnswersKey(withGmail("fail"))).not.toBe(key);
    expect(replyTestAnswersKey({ ...view, headersOk: true })).not.toBe(key);
    expect(replyTestAnswersKey({ ...view, teamFrom: "info@example.com" })).not.toBe(key);
    expect(replyTestAnswersKey({ ...view, setup: "B" })).not.toBe(key);
    const since = { ...view, roundSince: "2026-09-27T10:00:00.000Z" };
    expect(replyTestAnswersKey({ ...since, roundSince: "2026-09-27T11:00:00.000Z" })).not.toBe(replyTestAnswersKey(since));
    expect(replyTestAnswersKey({ ...view, mailboxes: view.mailboxes.map((m) => ({ ...m, delivered: true })) })).toBe(key);
  });
});
