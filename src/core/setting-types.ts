/**
 * Milestone 3 contract (docs/dev/M3-DESIGN.md §2.1): shapes of the new Owner-edited settings. Milestone 5 (M5-DESIGN
 * §5.9) appends the address check policy, the AI prices and the custom model. The shared From address
 * (SHARED-FROM-DESIGN §7.2) adds optional reply-test fields and `ReplyTestOriginal`; absent = per-person mode. Own-mailbox
 * mode (MAIN-DOMAIN-DESIGN §7.2) adds more optional reply-test fields; absent = app mode.
 */

/** Setting "sending.capOverride": the Owner's confirmed limit for ONE cap day. */
export type CapOverride = { capDay: string; cap: number; byUserId: number; at: string };

/**
 * Setting "sending.healthSinceGoLiveAt" (review REPLIES-02): since when bounces and complaints count on real data, the
 * first go-live on the sending domain go-live was last switched on for. Written only by goLive(), with the go-live it
 * belongs to: going live again on the same sending domain (a From address change ended go-live, F13) keeps `since`, so
 * the earlier live period's bounces and complaints still count; going live on another domain starts it again. It
 * applies only while `goLiveAt` is Setting "sending.goLiveAt" (read it with `healthGoLiveAt`,
 * @/core/sending/health-since); missing, unreadable or written for another go-live = count from "sending.goLiveAt".
 */
export type HealthSinceGoLive = {
  /** ISO: the first go-live on `domain`, where health counting starts. */
  since: string;
  /** ISO: the go-live that wrote this value (Setting "sending.goLiveAt" at that moment). */
  goLiveAt: string;
  /** The sending domain of that go-live (Setting "sending.goLiveDomain"), lowercase. */
  domain: string;
};

export type ReplyTestProvider = "gmail" | "microsoft" | "yahoo" | "other";
/**
 * The Owner's answers for one test mailbox. What the app sees itself (which test email, when, delivered, reply stored)
 * is derived from TestSend/MailEvent/InboundMessage rows by loadReplyTest, never stored here, so the worker never
 * writes this Owner-edited setting.
 */
export type ReplyTestMailbox = {
  address: string;
  provider: ReplyTestProvider;
  /** "Did the reply arrive in your reply inbox, not in spam?" */
  inboxOk: boolean | null;
  /** "Does its original say dkim=pass or arc=pass?" */
  authOk: "pass" | "fail" | "unsure" | null;
  /** authOk was read from pasted headers (parseAuthResults), not answered by hand. */
  authFromHeaders: boolean;
  /**
   * Shared-From mode (SHARED-FROM-DESIGN F12): "Did the test email arrive in this mailbox's inbox, not in spam or
   * junk?" A No never fails the test; it becomes a go-live recommendation and a required tick. Absent = not asked.
   */
  placementOk?: boolean | null;
  /** Shared-From mode (F12): "Does its original say DMARC: PASS?" Must be "pass" for the test to pass. Absent = not asked. */
  dmarcOk?: "pass" | "fail" | "unsure" | null;
  /** dmarcOk was read from a pasted original (parseDmarcResult or the stored original), not answered by hand. */
  dmarcFromHeaders?: boolean;
};

/**
 * Shared-From mode (SHARED-FROM-DESIGN F25): what the app read from one pasted original of a reply-test email. The
 * pasted text itself is never stored.
 */
export type ReplyTestOriginal = {
  /** The sending domain and the shared From address this original belongs to (a reset or a change makes it stale). */
  domain: string;
  from: string;
  /** The test-list mailbox whose copy was pasted, and the TestSend it matched by Message-ID. */
  address: string;
  testSendId: number;
  /** The Return-Path (or smtp.mailfrom) domain; null when the original shows neither. */
  returnPathDomain: string | null;
  /** returnPathDomain is the sending domain or under it. False: the From domain or anything else. Null: not shown. */
  returnPathOk: boolean | null;
  dmarc: "pass" | "fail" | null;
  /** header.d of a passing DKIM signature of the From domain or a subdomain of it; null when none passed. */
  dkimSigner: string | null;
  /** The host of List-Unsubscribe's mailto:, null when there is none (or no header). */
  mailtoDomain: string | null;
  /** True: no mailto, or a mailto on or under the sending domain. False: anything else. Null: no List-Unsubscribe. */
  mailtoOk: boolean | null;
  readAt: string;
  /**
   * MAIN-DOMAIN-DESIGN §7.2: the scheme of List-Unsubscribe's web link; null = none; missing = read before this field
   * existed.
   */
  unsubscribeScheme?: "https" | "http" | null;
  /** MAIN-DOMAIN-DESIGN §7.2 (O13): the whole mailto: address of List-Unsubscribe, for the by-hand question; null = none. */
  mailtoAddress?: string | null;
  /**
   * Review SECURITY-03 (own-mailbox mode): List-Unsubscribe offers a `mailto:` whose address the app couldn't read, so
   * the unsubscribe-by-email question can't be asked and the test fails closed. Only stored when true; missing = no.
   */
  mailtoUnreadable?: boolean;
};

export type UnsubscribeSetup = "A" | "B" | "C";
/** Setting "mailgun.unsubscribeTest" (PLAN A4.5, B6.8). */
export type UnsubscribeTestSetting = {
  setup: UnsubscribeSetup;
  status: "untested" | "passed" | "failed";
  /** The sending domain the decision belongs to; a pass on another domain doesn't count. */
  domain: string | null;
  mailboxes: ReplyTestMailbox[];
  /** "Do you see List-Unsubscribe: <https://…> and List-Unsubscribe-Post?" */
  headersOk: boolean | null;
  decidedAt: string | null;
  decidedById: number | null;
  note: string | null;
  /**
   * SHARED-FROM-DESIGN F12: the shared From address the decision belongs to; missing or null = per-person mode. A pass
   * counts only for the same sending domain and the same From (`replyTestPassedFor`).
   */
  from?: string | null;
  /** SHARED-FROM-DESIGN F25: the pasted original of the current round (shared-From mode); resets clear it. */
  original?: ReplyTestOriginal | null;
  /**
   * The decision belongs to own-mailbox mode; missing = app mode (MAIN-DOMAIN-DESIGN O13). A stored pass counts only in
   * the mode it was decided in (`replyTestPassedFor`).
   */
  replies?: "own-mailbox";
  /**
   * Own-mailbox mode: did an email to the original's mailto: address reach a mailbox someone reads (O13); null/missing =
   * not answered. Resets (and a newly stored original) clear it.
   */
  mailtoArrived?: boolean | null;
  /**
   * Own-mailbox mode's last resort (review REPLIES-03), for a mail provider that can't catch Mailgun's `u+…@` address:
   * true = every own-mailbox email carries the app's own `List-Unsubscribe` with only Mailgun's web link, no `mailto:`
   * (`WEB_ONLY_LIST_UNSUBSCRIBE`, added by `MailgunClient.sendMessage`). Only stored when true; missing = Mailgun's own
   * header, as before. The reply test then passes only when a new original shows that link and no `mailto:`. Resets drop it.
   */
  leaveOutMailto?: boolean;
};
/** Unchanged by the shared From address: `from` and `original` are optional and absent here (per-person mode). */
export const DEFAULT_UNSUBSCRIBE_TEST: UnsubscribeTestSetting = {
  setup: "A",
  status: "untested",
  domain: null,
  mailboxes: [],
  headersOk: null,
  decidedAt: null,
  decidedById: null,
  note: null,
};

/** Setting "verification.policy" (M5-DESIGN §2.3). */
export type VerificationPolicySetting = {
  deliverableHighRisk: "send" | "block";
  catchAllLow: "send" | "block";
  catchAllMedium: "send" | "block";
  catchAllHigh: "send" | "block";
  disposable: "send" | "block";
  unknown: "recheck" | "block";
};
/** Setting "ai.prices": dollars per million tokens per model id. */
export type AiModelPrices = { inputPerMTok: number; outputPerMTok: number };
export type AiPrices = Record<string, AiModelPrices>;
/** Setting "ai.customModel": a model id checked with models.retrieve (M5-DESIGN §3.5.1). */
export type AiCustomModel = { id: string; label: string; maxTokens: number; effortLow: boolean; checkedAt: string };
